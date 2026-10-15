# Sloptube media container.
#
# Built by `wrangler deploy` from ./container (see the `containers` block in
# wrangler.jsonc), so this must stay a plain public Docker Hub image: no build
# context outside this directory, no secrets, no registry login.

FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    APP_DIR=/app \
    PORT=8080 \
    MEDIA_TIMEOUT=600

# clamav-freshclam's postinst tries to start a daemon, which hangs a build with
# no init. policy-rc.d is the standard way to tell dpkg to skip service start.
# python3 is not decoration: server.py is the HTTP front-end and sigv4.py does
# SigV4 (HMAC in POSIX sh would be both slower and far more fragile).
# adduser/passwd provide the non-root account created below.
RUN printf '#!/bin/sh\nexit 101\n' >/usr/sbin/policy-rc.d \
 && chmod +x /usr/sbin/policy-rc.d \
 && apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      coreutils \
      curl \
      jq \
      tini \
      ffmpeg \
      clamav \
      clamav-freshclam \
      python3 \
      adduser \
      passwd \
 && rm -f /usr/sbin/policy-rc.d \
 && rm -rf /var/lib/apt/lists/*

# No login shell, no home directory, and after the chmods below the only writable
# path in the whole image is /tmp/sloptube.
RUN adduser --system --group --no-create-home \
      --home /nonexistent \
      --shell /usr/sbin/nologin \
      --disabled-password \
      slop \
 && install -d -m 0700 -o slop -g slop /app /tmp/sloptube \
 && chown root:root /var/lib/clamav \
 && chmod 0755 /var/lib/clamav \
 && chmod 0755 /tmp \
 && chmod 0555 /var/tmp

# Writable-path policy: /tmp/sloptube is the ONLY writable path the runtime needs.
#
# /app is 0700 slop — writable by slop alone, and nothing outside it may enter.
# /tmp itself is root-owned 0755 rather than the stock 1777: `mktemp -d` in
# media.sh creates INSIDE /tmp/sloptube, so it needs write+search on that
# directory, not on /tmp. /var/tmp goes to 0555 for the same reason. A
# compromised ffmpeg or clamscan therefore has nowhere to stage a file except the
# per-request work dir, which the EXIT trap removes when the op ends.
#
# TMPDIR is set below (after the apt layer — dpkg must never see a TMPDIR that
# does not exist yet) so ffmpeg, clamscan and python all take their scratch
# space from that same dir instead of failing.
#
# NOT verified: Docker is not installed on the host these modes were written on,
# so they are checked by inspection plus the build-time assertions below — never
# by running the image. /dev/shm is a tmpfs mounted BY THE RUNTIME and stays
# world-writable whatever this image declares; it cannot be closed from in here.

COPY media.sh server.py sigv4.py /app/

# 0755 on all three: media.sh is the entrypoint, the two .py files are exec'd.
RUN chmod 0755 /app/media.sh /app/server.py /app/sigv4.py

# Set after the apt layer on purpose: dpkg runs above and must not see a TMPDIR
# pointing at a directory this image has not created yet.
ENV TMPDIR=/tmp/sloptube

USER slop

# Runs as slop, so this also proves the ordering above is what it claims: every
# process in the container — tini, media.sh, server.py, ffmpeg, ffprobe, clamscan
# — inherits this uid. There is no USER switch further down and nothing in the
# tree calls setuid/sudo, so "non-root" is now a build failure if it stops being
# true, rather than an assumption in a comment. The path modes are asserted the
# same way, and setpriv is asserted to exist because ENTRYPOINT depends on it.
RUN set -eu; \
    test "$(id -u)" -ne 0; \
    test "$(id -un)" = slop; \
    test "$(stat -c '%U:%G %a' /app)" = 'slop:slop 700'; \
    test "$(stat -c '%U:%G %a' /tmp/sloptube)" = 'slop:slop 700'; \
    test "$(stat -c '%U:%G %a' /tmp)" = 'root:root 755'; \
    test "$(stat -c '%U:%G %a' /var/tmp)" = 'root:root 555'; \
    test -n "$(command -v setpriv)" || { echo 'setpriv missing' >&2; exit 1; }

WORKDIR /app

EXPOSE 8080

# /healthz answers as soon as the listener is up; it does not touch R2 or ClamAV.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8080/healthz || exit 1

# ---------------------------------------------------------------------------
# What this image CANNOT set, and why   (audit finding, Major)
#
# Most of the hardening the design assumes is a property of the CONTAINER
# RUNTIME, not of the image. No Dockerfile instruction sets a capability set, a
# seccomp profile or a read-only root filesystem, and the `containers` block in
# wrangler.jsonc exposes no field for them either — so they have to be passed
# where the container is started, and this file can only record the gap. Named
# explicitly so it stays visible rather than implied:
#
#   --cap-drop=ALL                  RUNTIME ONLY, not emulated below. There is
#                                   nothing to drop for a non-root process:
#                                   uid!=0 already has empty permitted and
#                                   effective capability sets. The BOUNDING set
#                                   still holds them, which is exactly why
#                                   no-new-privileges matters — see ENTRYPOINT.
#   --security-opt=no-new-privileges
#                                   RUNTIME ONLY, but EMULATED below. For a
#                                   non-root container the two are equivalent
#                                   in effect: no_new_privs is what stops a
#                                   compromised ffmpeg from regaining
#                                   bounding-set capabilities by exec'ing a
#                                   setuid binary shipped in this image.
#   --security-opt seccomp=<json>   RUNTIME ONLY. Whether any profile is applied
#                                   at all is decided by the runtime, not by
#                                   this image; Docker's default profile is the
#                                   usual baseline and anything stricter is a
#                                   start flag. Unverifiable from here.
#   --read-only                     RUNTIME ONLY, and deliberately NOT enabled.
#                                   The ops still need a writable
#                                   /tmp/sloptube and a writable /app, so a
#                                   read-only rootfs only works if both are
#                                   supplied at start as --tmpfs — a combination
#                                   that cannot be exercised without a Docker
#                                   daemon. What is done here instead is the
#                                   part that survives without the flag: every
#                                   path the container never writes to is already
#                                   non-writable by slop (modes above), so the
#                                   flag would add just those two mounts.
#
# Egress: the container must reach R2 over HTTPS on every probe, transcode and
# scan. No network namespace change is attempted — `--net=none`, a network
# override or a seccomp filter that blocks connect() would each break uploads,
# and none can be tested from a host with no Docker. R2 access is the whole of
# the egress surface in any case: ffmpeg and clamscan are offline by
# construction, which is what the -protocol_whitelist note in media.sh buys.
# ---------------------------------------------------------------------------

# setpriv FIRST, then tini. setpriv exec's tini (no extra process, no extra
# layer) and sets no_new_privs before PID 1 exists, so the flag is inherited by
# every descendant: tini, media.sh, server.py and each ffmpeg/ffprobe/clamscan
# child. Writing `tini -- setpriv ...` instead would leave tini itself — and
# anything that outlived it — outside the restriction. tini must stay PID 1 to
# keep reaping the short-lived op subprocesses.
ENTRYPOINT ["/usr/bin/setpriv","--no-new-privileges","/usr/bin/tini","--","/app/media.sh"]