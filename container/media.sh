#!/bin/sh
# Sloptube media container — POSIX sh entrypoint.
#
# Two modes:
#   media.sh                 start the HTTP server (container ENTRYPOINT)
#   media.sh <op> <json>     run one operation and print one JSON object
#
# Operations: probe | transcode | scan
#
# Design notes that matter (read before editing):
#
# * CMAF layout. ONE `init.mp4` for the whole video plus `seg_NNNNNN.m4s` media
#   segments, produced by a SINGLE ffmpeg pass over the whole source.
#
#   Per-segment transcoding was tried first and REJECTED on measured evidence
#   (ffmpeg 8.1.1): seeking to each segment restarts output timestamps at zero,
#   and `init.mp4` differs per run (1336 vs 1348 bytes). Stitching those
#   fragments yields a file whose 432 video packets are all present but which
#   decodes only 144 frames — playback silently truncates at the first segment
#   boundary. A single pass gives one init and one continuous timeline, and
#   decodes 432/432. Do not reintroduce per-segment transcoding.
#
# * ffmpeg runs with cwd set to the work directory and relative output names.
#   This is load-bearing twice: an absolute `-hls_fmp4_init_filename` makes
#   ffmpeg write the init file into the process cwd instead of the work dir,
#   AND bakes that absolute path into `#EXT-X-MAP`, which no player can resolve.
#
# * master.m3u8 is written by the Worker (contract §2), NOT here: the Worker
#   takes the segment list this operation returns and emits EXTINF lines. The
#   playlist it writes MUST carry `#EXT-X-MAP:URI="init.mp4"` or playback fails.
#
# * EVERY ffmpeg/ffprobe launch below — all FOUR of them, not just the happy
#   path — carries `-protocol_whitelist file,pipe` (contract §7.12): the ffprobe
#   in op_probe, the single transcode pass, the end-to-end decode self-check,
#   and the thumbnail pass. A fifth launch without the flag fails
#   test/transcode-design.test.ts.
#
#   That whitelist is a sound restriction, not a lucky one, because every input
#   is a local file this container created itself: `$work/source`, written by
#   curl from a SigV4-signed R2 GET, and `$work/master.m3u8`, written by ffmpeg
#   moments earlier. No ffmpeg or ffprobe input is ever an agent-supplied path
#   or URL — the JSON body only ever supplies a bucket/key prefix, which becomes
#   part of an HTTPS URL handled by curl, never an ffmpeg input. Denying network,
#   concat, crypto, data and every other protocol therefore costs the happy path
#   nothing while removing the file's ability to fetch or nest a second source.
#
# * Credentials arrive per-request in the JSON body. Nothing is baked into the
#   image and nothing is cached between requests.
#
# * ffmpeg is only ever run here, never in the Worker (contract §7.5).

set -eu
umask 077

APP_DIR=${APP_DIR:-/app}
WORK_ROOT=${WORK_ROOT:-/tmp/sloptube}
HARD_TIMEOUT=${MEDIA_TIMEOUT:-600}

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

# One JSON field out of a JSON document. Callers pass the `// ""` fallback so a
# missing field never yields the literal string "null".
jget() {
    printf '%s' "$1" | jq -r "$2" 2>/dev/null || printf ''
}

# fail_json <reason-code> [human-readable detail]
# `reason` is the stable machine code the HTTP layer maps to a status code;
# `detail` is for the log, never for parsing.
fail_json() {
    jq -n --arg reason "$1" --arg detail "${2:-}" \
        '{ok:false, reason:$reason, detail:$detail}'
    exit 1
}

# R2 key hardening. The key reaches a URL, so reject anything that could escape
# the bucket path or smuggle a second request.
#
# A `case` whitelist, not `grep -Eq`: grep succeeds when ANY line matches, so a
# key containing a newline (`videos/x/source\n--proto=file`) used to pass and the
# newline then injected a line into curl's config file.
valid_key() {
    case "$1" in
        ''|*'..'|*/*/*/*) return 1 ;;
        *[!A-Za-z0-9._/-]*) return 1 ;;
        [!A-Za-z0-9]*) return 1 ;;
    esac
    return 0
}

r2_url() {
    # path-style addressing is mandatory for R2 (no virtual-host style).
    printf 'https://%s.r2.cloudflarestorage.com/%s/%s' "$1" "$2" "$3"
}

new_workdir() {
    mkdir -p "$WORK_ROOT"
    mktemp -d "$WORK_ROOT/$1.XXXXXX"
}

# $1 curlrc  $2 url  $3 dest
s3_get() {
    timeout "$HARD_TIMEOUT" curl -K "$1" \
        --fail --silent --show-error \
        --proto '=https' --proto-redir '=https' --max-redirs 0 \
        --retry 2 --retry-delay 1 \
        -o "$3" "$2"
}

# $1 curlrc  $2 url  $3 file
s3_put() {
    timeout "$HARD_TIMEOUT" curl -K "$1" \
        --fail --silent --show-error \
        --proto '=https' --proto-redir '=https' --max-redirs 0 \
        --retry 2 --retry-delay 1 \
        -T "$3" "$2"
}

require_field() {
    [ -n "$2" ] || fail_json invalid_request "$1 is required"
}

# Offsets land in a shell arithmetic expansion and in the ffmpeg filter string,
# so anything non-numeric must be rejected before it is used, not after.
require_uint() {
    case "$2" in
        '' | *[!0-9]*) fail_json invalid_request "$1 must be a non-negative integer" ;;
    esac
}

# ---------------------------------------------------------------------------
# op: probe
# ---------------------------------------------------------------------------

op_probe() {
    body=$1
    key=$(jget "$body" '.r2Key // ""')
    account=$(jget "$body" '.account // ""')
    bucket=$(jget "$body" '.bucket // ""')
    akid=$(jget "$body" '.accessKeyId // ""')
    secret=$(jget "$body" '.secret // ""')
    region=$(jget "$body" '.region // "auto"')

    require_field r2Key "$key"
    require_field account "$account"
    require_field bucket "$bucket"
    require_field accessKeyId "$akid"
    require_field secret "$secret"
    valid_key "$key" || fail_json invalid_key "r2Key contains disallowed characters"

    work=$(new_workdir probe)
    trap 'rm -rf "$work"' EXIT INT TERM
    src="$work/source"
    curlrc="$work/curlrc"
    url=$(r2_url "$account" "$bucket" "$key")

    SLOPTUBE_AK="$akid" SLOPTUBE_SK="$secret" python3 "$APP_DIR/sigv4.py" "$curlrc" GET "$url" - "$region" \
        || fail_json sign_failed "could not sign the R2 request"

    s3_get "$curlrc" "$url" "$src" || fail_json download_failed "could not download $key"

    bytes=$(wc -c <"$src" | tr -d ' ')
    sha=$(sha256sum "$src" | cut -d' ' -f1)

    probe_json="$work/probe.json"
    if ! timeout "$HARD_TIMEOUT" ffprobe -v error -protocol_whitelist file,pipe -print_format json \
        -show_format -show_streams "$src" >"$probe_json" 2>"$work/ffprobe.err"; then
        fail_json ffprobe_failed "ffprobe could not read the object"
    fi

    vcodec=$(jget "$probe_json" '[.streams[]? | select(.codec_type=="video")][0].codec_name // ""')
    acodec=$(jget "$probe_json" '[.streams[]? | select(.codec_type=="audio")][0].codec_name // ""')
    width=$(jget "$probe_json" '[.streams[]? | select(.codec_type=="video")][0].width // 0')
    height=$(jget "$probe_json" '[.streams[]? | select(.codec_type=="video")][0].height // 0')
    dur=$(jget "$probe_json" '.format.duration // "0"')

    # An audio-only or undecodable object is a probe rejection, not a crash.
    if [ -z "$vcodec" ]; then
        jq -n --arg sha "$sha" --argjson bytes "$bytes" \
            '{ok:false, reason:"no_video_stream", sha256:$sha, bytes:$bytes,
              durationS:0, width:0, height:0, videoCodec:"", audioCodec:""}'
        exit 0
    fi

    jq -n --arg sha "$sha" --argjson bytes "$bytes" --arg dur "$dur" \
        --arg w "$width" --arg h "$height" --arg vc "$vcodec" --arg ac "$acodec" \
        '{ok:true, reason:"ok", sha256:$sha, bytes:$bytes,
          durationS:($dur|tonumber? // 0),
          width:($w|tonumber? // 0), height:($h|tonumber? // 0),
          videoCodec:$vc, audioCodec:$ac}'
}

# ---------------------------------------------------------------------------
# op: transcode
# ---------------------------------------------------------------------------

op_transcode() {
    body=$1
    key=$(jget "$body" '.r2Key // ""')
    prefix=$(jget "$body" '.r2Prefix // ""')
    seg_seconds=$(jget "$body" '.segSeconds // 300')
    account=$(jget "$body" '.account // ""')
    bucket=$(jget "$body" '.bucket // ""')
    akid=$(jget "$body" '.accessKeyId // ""')
    secret=$(jget "$body" '.secret // ""')
    region=$(jget "$body" '.region // "auto"')

    require_field r2Key "$key"
    require_field r2Prefix "$prefix"
    require_field account "$account"
    require_field bucket "$bucket"
    require_field accessKeyId "$akid"
    require_field secret "$secret"
    valid_key "$key" || fail_json invalid_key "r2Key contains disallowed characters"
    valid_key "$prefix" || fail_json invalid_key "r2Prefix contains disallowed characters"

    require_uint segSeconds "$seg_seconds"

    work=$(new_workdir transcode)
    trap 'rm -rf "$work"' EXIT INT TERM
    src="$work/source"
    getrc="$work/get.rc"
    putrc="$work/put.rc"

    url=$(r2_url "$account" "$bucket" "$key")
    SLOPTUBE_AK="$akid" SLOPTUBE_SK="$secret" python3 "$APP_DIR/sigv4.py" "$getrc" GET "$url" - "$region" \
        || fail_json sign_failed "could not sign the download request"
    s3_get "$getrc" "$url" "$src" || fail_json download_failed "could not download $key"

    # ONE ffmpeg pass for the whole file.
    #
    # Per-segment transcoding was measured and rejected: seeking to each segment
    # restarts output timestamps at zero, and init.mp4 comes out different per
    # run (1336 vs 1348 bytes). Stitching those fragments produced a file whose
    # packets were all present but which decoded only the FIRST segment — 144 of
    # 432 frames — so playback silently truncated. A single pass is what the HLS
    # fMP4 muxer is actually built for: one init, one continuous timeline.
    #
    # ffmpeg runs with cwd=$work and RELATIVE output names. That is load-bearing
    # twice over: an absolute -hls_fmp4_init_filename makes ffmpeg write the file
    # to the process cwd instead of the work dir, and it bakes that absolute path
    # into #EXT-X-MAP, which no player can resolve.
    if ! ( cd "$work" && timeout "$HARD_TIMEOUT" ffmpeg -nostdin -hide_banner -loglevel error -y \
        -protocol_whitelist file,pipe \
        -i "$src" \
        -map 0:v:0 -map 0:a:0 \
        -c:v libx264 -preset veryfast -profile:v main -pix_fmt yuv420p \
        -force_key_frames "expr:gte(t,n_forced*$seg_seconds)" \
        -c:a aac -b:a 128k -ar 48000 \
        -f hls -hls_time "$seg_seconds" -hls_segment_type fmp4 \
        -hls_fmp4_init_filename init.mp4 \
        -hls_flags independent_segments \
        -hls_segment_filename "seg_%06d.m4s" \
        -hls_playlist_type vod -hls_list_size 0 \
        master.m3u8 2>ffmpeg.err ); then
        fail_json transcode_failed "ffmpeg failed: $(tr -d '\r\n' <"$work/ffmpeg.err" | cut -c1-300)"
    fi

    [ -f "$work/init.mp4" ] || fail_json transcode_failed "ffmpeg produced no init segment"
    [ -f "$work/master.m3u8" ] || fail_json transcode_failed "ffmpeg produced no playlist"

    seg_count=$(find "$work" -maxdepth 1 -name 'seg_*.m4s' | wc -l | tr -d ' ')
    [ "$seg_count" -gt 0 ] || fail_json transcode_failed "ffmpeg produced no media segment"

    # End-to-end self-check: decode the playlist exactly as a player would. This
    # is the assertion that would have caught the per-segment regression, so it
    # must exercise the whole playlist rather than one segment.
    #
    # `-protocol_whitelist file,pipe` here for the same reason as the encode: the
    # input is master.m3u8, a local file ffmpeg just wrote, so the restriction
    # costs nothing. A missing flag on this one launch is what let a playlist
    # pull in something it should not have been able to read.
    if ! ( cd "$work" && timeout "$HARD_TIMEOUT" ffmpeg -nostdin -v error \
        -protocol_whitelist file,pipe \
        -i master.m3u8 -f null - >/dev/null 2>decode.err ); then
        fail_json transcode_failed \
            "produced playlist does not decode: $(tr -d '\r\n' <"$work/decode.err" | cut -c1-200)"
    fi

    # Upload the init once, then every media segment. A failure here is retryable:
    # the whole job re-runs and overwrites.
    init_url=$(r2_url "$account" "$bucket" "$prefix/init.mp4")
    SLOPTUBE_AK="$akid" SLOPTUBE_SK="$secret" python3 "$APP_DIR/sigv4.py" "$putrc" PUT "$init_url" "$work/init.mp4" \
        "$region" || fail_json sign_failed "could not sign the init upload"
    s3_put "$putrc" "$init_url" "$work/init.mp4" || fail_json upload_failed "could not upload init.mp4"
    init_bytes=$(wc -c <"$work/init.mp4" | tr -d ' ')

    # Segment durations are read from the playlist ffmpeg just wrote, because
    # that is the only place the real durations exist — the Worker needs them for
    # EXTINF/TARGETDURATION, and a plan-derived guess is wrong for non-aligned or
    # variable-frame-rate input.
    #
    # sed/grep rather than jq: fewer moving parts for a one-column extract, and it
    # stays testable outside the image.
    durations_txt="$work/durations.txt"
    grep '^#EXTINF:' "$work/master.m3u8" | sed 's/^#EXTINF://; s/,.*$//' >"$durations_txt" || true
    dur_lines=$(wc -l <"$durations_txt" | tr -d ' ')
    if [ "$dur_lines" -ne "$seg_count" ]; then
        fail_json transcode_failed \
            "playlist has $dur_lines EXTINF entries for $seg_count segments"
    fi

    segments_json="$work/segments.json"
    : >"$segments_json"
    idx=1
    for part in "$work"/seg_*.m4s; do
        [ -f "$part" ] || continue
        name=$(basename "$part")
        n=$(printf '%s' "$name" | sed 's/^seg_//; s/\.m4s$//' | sed 's/^0*//')
        [ -n "$n" ] || n=0
        seg_key="$prefix/$name"
        seg_url=$(r2_url "$account" "$bucket" "$seg_key")
        seg_rc="$work/put-seg.rc"
        SLOPTUBE_AK="$akid" SLOPTUBE_SK="$secret" python3 "$APP_DIR/sigv4.py" "$seg_rc" PUT "$seg_url" "$part" "$region" \
            || fail_json sign_failed "could not sign the upload of $seg_key"
        s3_put "$seg_rc" "$seg_url" "$part" || fail_json upload_failed "could not upload $seg_key"
        seg_dur=$(sed -n "${idx}p" "$durations_txt")
        case "$seg_dur" in '' | *[!0-9.]*) seg_dur=0 ;; esac
        jq -c --argjson n "$n" --arg key "$seg_key" --argjson dur "$seg_dur" \
            --argjson bytes "$(wc -c <"$part" | tr -d ' ')" \
            '{n:$n, r2Key:$key, bytes:$bytes, durationS:$dur}' >>"$segments_json"
        idx=$((idx + 1))
    done

    # Thumbnail: the feed advertises one per video, so it has to exist. One frame
    # from the source we already downloaded — no second pass over the media.
    thumb_url=$(r2_url "$account" "$bucket" "$prefix/hq.jpg")
    if timeout "$HARD_TIMEOUT" ffmpeg -nostdin -hide_banner -loglevel error -y \
        -protocol_whitelist file,pipe \
        -i "$src" -frames:v 1 -vf "scale=640:-2" "$work/hq.jpg" 2>"$work/thumb.err"; then
        SLOPTUBE_AK="$akid" SLOPTUBE_SK="$secret" python3 "$APP_DIR/sigv4.py" "$work/put-thumb.rc" PUT "$thumb_url" "$work/hq.jpg" \
            "$region" || fail_json sign_failed "could not sign the thumbnail upload"
        s3_put "$work/put-thumb.rc" "$thumb_url" "$work/hq.jpg" \
            || fail_json upload_failed "could not upload the thumbnail"
        thumb_bytes=$(wc -c <"$work/hq.jpg" | tr -d ' ')
    else
        # A missing thumbnail is cosmetic; it must not fail an otherwise good video.
        thumb_bytes=0
    fi

    jq -s --argjson initBytes "$init_bytes" --argjson count "$seg_count" \
        --argjson thumbBytes "$thumb_bytes" \
        '{ok:true, reason:"ok", initBytes:$initBytes, segCount:$count, thumbBytes:$thumbBytes,
          segments:(sort_by(.n))}' "$segments_json"
}

# ---------------------------------------------------------------------------
# op: scan
# ---------------------------------------------------------------------------

op_scan() {
    body=$1
    key=$(jget "$body" '.r2Key // ""')
    account=$(jget "$body" '.account // ""')
    bucket=$(jget "$body" '.bucket // ""')
    akid=$(jget "$body" '.accessKeyId // ""')
    secret=$(jget "$body" '.secret // ""')
    region=$(jget "$body" '.region // "auto"')

    require_field r2Key "$key"
    require_field account "$account"
    require_field bucket "$bucket"
    require_field accessKeyId "$akid"
    require_field secret "$secret"
    valid_key "$key" || fail_json invalid_key "r2Key contains disallowed characters"

    work=$(new_workdir scan)
    trap 'rm -rf "$work"' EXIT INT TERM
    src="$work/source"
    curlrc="$work/curlrc"
    url=$(r2_url "$account" "$bucket" "$key")

    SLOPTUBE_AK="$akid" SLOPTUBE_SK="$secret" python3 "$APP_DIR/sigv4.py" "$curlrc" GET "$url" - "$region" \
        || fail_json sign_failed "could not sign the R2 request"
    s3_get "$curlrc" "$url" "$src" || fail_json download_failed "could not download $key"

    # clamscan rather than clamdscan: no second daemon to supervise, no socket to
    # race on, and no per-request file-permission dance. The cost is reloading
    # the signature database on every scan — see README "Known limitations".
    set +e
    timeout "$HARD_TIMEOUT" clamscan --no-summary --infected --stdout \
        "$src" >"$work/scan.out" 2>"$work/scan.err"
    rc=$?
    set -e
    # clamscan: 0 = clean, 1 = virus found, 2 = error. 124 = our own timeout.
    if [ "$rc" -eq 124 ]; then
        fail_json scan_timeout "clamscan exceeded ${HARD_TIMEOUT}s"
    fi

    case "$rc" in
        0) jq -n '{ok:true, reason:"clean", verdict:"clean", signature:""}' ;;
        1) sig=$(tr -d '\r' <"$work/scan.out" | sed -n 's/.*: \(.*\) FOUND[[:space:]]*$/\1/p' | head -n 1)
            jq -n --arg sig "$sig" '{ok:true, reason:"infected", verdict:"infected", signature:$sig}' ;;
        *) fail_json scan_failed "clamscan error rc=$rc: $(tr -d '\r\n' <"$work/scan.err" | cut -c1-300)" ;;
    esac
}

# ---------------------------------------------------------------------------
# dispatch
# ---------------------------------------------------------------------------

if [ $# -ge 1 ]; then
    # The JSON body arrives on STDIN, not argv: argv is world-readable via
    # /proc/<pid>/cmdline, and the body carries R2 credentials that the ffmpeg
    # child (same user) could otherwise read.
    op=$1
    payload=$(cat)
    case "$op" in
        probe) op_probe "$payload" ;;
        transcode) op_transcode "$payload" ;;
        scan) op_scan "$payload" ;;
        *) fail_json unknown_operation "unknown operation: $op" ;;
    esac
    exit 0
fi

# No arguments: serve HTTP. server.py shells back into this script per request.
exec python3 "$APP_DIR/server.py"