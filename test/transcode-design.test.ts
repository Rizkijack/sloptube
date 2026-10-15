import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Locks in the transcode design that was arrived at by measurement.
 *
 * The per-segment design (one container job per segment, each seeking with
 * `-ss` before `-i`) looks reasonable and is silently broken: independently
 * encoded fragments restart their timeline at zero and carry different init
 * segments, so the assembled stream decodes only the first segment. These tests
 * fail if anyone reintroduces it.
 */

const ROOT = resolve(import.meta.dirname, '..');
const MEDIA_SH = resolve(ROOT, 'container', 'media.sh');
const FIXTURES = resolve(ROOT, 'test', 'fixtures', 'transcode-guard');

function have(bin: string): boolean {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const FFMPEG = have('ffmpeg') && have('ffprobe');

describe('container/media.sh — transcode design invariants', () => {
  const source = readFileSync(MEDIA_SH, 'utf8');
  const transcodeBody = source.slice(source.indexOf('op_transcode()'), source.indexOf('op_scan()'));

  it('transcodes the whole file in a single ffmpeg pass', () => {
    // Exactly one encode (`-f hls`) and exactly one decode self-check (`-f null`).
    expect(transcodeBody.match(/-f hls\b/g)?.length).toBe(1);
    expect(transcodeBody.match(/-f null\b/g)?.length).toBe(1);
    expect(transcodeBody).toContain('-hls_segment_type fmp4');
    expect(transcodeBody).toContain('master.m3u8');
  });

  it('never seeks per segment (no -ss before -i)', () => {
    expect(transcodeBody).not.toMatch(/-ss\s+"?\$from_s/);
    expect(transcodeBody).not.toMatch(/\bfrom_s\b/);
    expect(transcodeBody).not.toMatch(/\bto_s\b/);
  });

  it('runs ffmpeg with cwd set to the work dir so relative URIs stay relative', () => {
    // Without this, ffmpeg writes init.mp4 into the process cwd and bakes an
    // absolute path into EXT-X-MAP, which no player can resolve.
    expect(transcodeBody).toMatch(/\(\s*cd\s+"\$work"\s*&&/);
    expect(transcodeBody).toContain('-hls_fmp4_init_filename init.mp4');
    expect(transcodeBody).not.toMatch(/-hls_fmp4_init_filename\s+"?\$/);
  });

  it('self-checks by decoding the whole playlist before uploading', () => {
    expect(transcodeBody).toMatch(/-i master\.m3u8 -f null -/);
  });

  it('uploads init and every segment, and reports the segment list', () => {
    expect(transcodeBody).toContain('init.mp4');
    expect(transcodeBody).toMatch(/seg_\*\.m4s/);
    expect(transcodeBody).toContain('segments:');
    expect(transcodeBody).toContain('segCount:');
  });

  it('stays POSIX-sh parseable', () => {
    // `sh -n` is the cheapest guard against a shell syntax regression.
    const sh = ['sh', '/bin/sh', 'C:\\Program Files\\Git\\bin\\sh.exe'].find((candidate) => {
      try {
        execFileSync(candidate, ['-c', 'exit 0'], { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });
    if (!sh) return; // no POSIX shell on this host; skip rather than false-pass
    execFileSync(sh, ['-n', MEDIA_SH], { stdio: 'pipe' });
  });

  it('writes no CR characters (the image is Linux)', () => {
    expect(source.includes('\r')).toBe(false);
  });
});

describe('container/media.sh — ffmpeg invocation hardening', () => {
  const source = readFileSync(MEDIA_SH, 'utf8');

  const opBody = (from: string, to: string) =>
    source.slice(source.indexOf(from), source.indexOf(to));

  /**
   * One entry per shell command, with backslash continuations joined, so a
   * multi-line ffmpeg invocation is inspected as a single command.
   */
  function commands(body: string): string[] {
    const out: string[] = [];
    for (const raw of body.split('\n')) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue; // full-line comments only
      const last = out.at(-1);
      if (last !== undefined && last.endsWith('\\')) {
        out[out.length - 1] = `${last.slice(0, -1).trim()} ${line}`;
      } else {
        out.push(line);
      }
    }
    return out;
  }

  /** Quoted text removed, so `"ffmpeg failed: ..."` in an error is not a launch. */
  function unquoted(command: string): string {
    return command
      .replace(/\$\([^)]*\)/g, '') // substitution first: it may itself contain quotes
      .replace(/"[^"]*"/g, '')
      .replace(/'[^']*'/g, '');
  }

  function ffmpegCalls(body: string): string[] {
    return commands(body).filter((command) => /\b(?:ffmpeg|ffprobe)\b/.test(unquoted(command)));
  }

  const probe = opBody('op_probe()', 'op_transcode()');
  const transcode = opBody('op_transcode()', 'op_scan()');
  const all = [...ffmpegCalls(probe), ...ffmpegCalls(transcode)];

  it('carries -protocol_whitelist file,pipe on every ffmpeg/ffprobe launch', () => {
    // Counted explicitly, so a FIFTH launch without the flag fails here — and a
    // fifth launch at all has to be a visible, deliberate change rather than a
    // silent fifth hole in the same invariant.
    expect(ffmpegCalls(probe)).toHaveLength(1);
    expect(ffmpegCalls(transcode)).toHaveLength(3);
    expect(all).toHaveLength(4);
    for (const call of all) {
      expect(call).toMatch(/-protocol_whitelist file,pipe(?=\s|$)/);
    }
  });

  it('keeps the whitelist on the end-to-end self-check decode, not only the encode', () => {
    // The launch the audit found unguarded. Its input is master.m3u8, a local
    // file ffmpeg wrote moments earlier, so the whitelist costs it nothing.
    const decode = all.find((call) => /-f null\b/.test(call));
    expect(decode).toBeDefined();
    expect(decode).toContain('-protocol_whitelist file,pipe');
    expect(decode).toContain('-i master.m3u8');
  });

  it('only ever reads container-created files, never a URL or an agent path', () => {
    // This is what makes the whitelist sound rather than lucky: every input is
    // $work/source (written by curl from a signed R2 GET) or $work/master.m3u8
    // (written by ffmpeg). No agent-supplied path or URL ever reaches ffmpeg.
    for (const call of all) {
      expect(call).not.toMatch(/https?:/);
      expect(call).toMatch(/"\$src"|master\.m3u8/);
    }
  });
});

describe('playlist contract', () => {
  const contract = readFileSync(resolve(ROOT, 'docs', 'API-CONTRACT.md'), 'utf8');

  it('requires EXT-X-MAP with a relative URI', () => {
    expect(contract).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(contract).toContain('mandatory');
  });
});

describe.skipIf(!FFMPEG)('CMAF end-to-end (real ffmpeg)', () => {
  const SEG = 6;
  const SOURCE_SECONDS = 18;

  beforeAll(() => {
    rmSync(FIXTURES, { recursive: true, force: true });
    mkdirSync(FIXTURES, { recursive: true });
    execFileSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', String(SOURCE_SECONDS),
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', resolve(FIXTURES, 'source.mp4'),
    ], { stdio: 'pipe' });
  }, 120_000);

  afterAll(() => {
    rmSync(FIXTURES, { recursive: true, force: true });
  });

  function singlePass(): string {
    // Exactly the shape container/media.sh uses: cwd = out dir, relative names.
    execFileSync('ffmpeg', [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-i', 'source.mp4',
      '-map', '0:v:0', '-map', '0:a:0',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
      '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
      '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
      '-f', 'hls', '-hls_time', String(SEG), '-hls_segment_type', 'fmp4',
      '-hls_fmp4_init_filename', 'init.mp4',
      '-hls_flags', 'independent_segments',
      '-hls_segment_filename', 'seg_%06d.m4s',
      '-hls_playlist_type', 'vod', '-hls_list_size', '0',
      'master.m3u8',
    ], { cwd: FIXTURES, stdio: 'pipe' });
    return readFileSync(resolve(FIXTURES, 'master.m3u8'), 'utf8');
  }

  function countFrames(target: string, cwd: string): number {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0', '-show_packets', '-of', 'csv=p=0', target,
    ], { cwd, encoding: 'utf8' });
    return out.split('\n').filter(Boolean).length;
  }

  /** Frames the decoder can actually produce, which is the property that matters. */
  function decodedFrames(target: string, cwd: string): number {
    // spawnSync, not execFileSync: ffmpeg writes its progress line to stderr and
    // execFileSync only returns stdout.
    const res = spawnSync('ffmpeg', ['-nostdin', '-stats', '-i', target, '-f', 'null', '-'], {
      cwd,
      encoding: 'utf8',
    });
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    const matches = [...out.matchAll(/frame=\s*(\d+)/g)];
    const last = matches.at(-1)?.[1];
    return last ? Number(last) : 0;
  }

  it('produces one init, N segments and a relative EXT-X-MAP', () => {
    const playlist = singlePass();
    expect(playlist).toContain('#EXT-X-MAP:URI="init.mp4"');
    expect(playlist).not.toMatch(/#EXT-X-MAP:URI="[A-Za-z]:/);
    expect(playlist.match(/seg_\d{6}\.m4s/g)?.length).toBe(3);
    expect(existsSync(resolve(FIXTURES, 'init.mp4'))).toBe(true);
  });

  it('keeps every frame across segment boundaries', () => {
    const expected = SOURCE_SECONDS * 24;
    expect(countFrames('master.m3u8', FIXTURES)).toBe(expected);
    // The decisive property: the decoder produces all of them, not just the first
    // segment's worth.
    expect(decodedFrames('master.m3u8', FIXTURES)).toBe(expected);
  });

  it('decodes the full playlist without error', () => {
    const stderr = execFileSync('ffmpeg', [
      '-nostdin', '-v', 'error', '-i', 'master.m3u8', '-f', 'null', '-',
    ], { cwd: FIXTURES, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(stderr.trim()).toBe('');
  });

  it('would have truncated under the rejected per-segment design', () => {
    // Reproduce the old scheme and assert it is broken, so this guard cannot be
    // dismissed as theoretical: this is the regression being prevented.
    const legacy = resolve(FIXTURES, 'legacy');
    mkdirSync(legacy, { recursive: true });
    const parts: string[] = [];
    for (let n = 0; n < 3; n++) {
      const dir = resolve(legacy, `s${n}`);
      mkdirSync(dir, { recursive: true });
      execFileSync('ffmpeg', [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(n * SEG), '-i', resolve(FIXTURES, 'source.mp4'), '-t', String(SEG),
        '-map', '0:v:0', '-map', '0:a:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-profile:v', 'main', '-pix_fmt', 'yuv420p',
        '-force_key_frames', `expr:gte(t,n_forced*${SEG})`,
        '-c:a', 'aac', '-b:a', '128k', '-ar', '48000',
        '-f', 'hls', '-hls_time', String(SEG), '-hls_segment_type', 'fmp4',
        '-hls_fmp4_init_filename', resolve(dir, 'init.mp4'),
        '-hls_flags', 'independent_segments',
        '-hls_segment_filename', resolve(dir, 'seg_%06d.m4s'),
        '-hls_playlist_type', 'vod', '-hls_list_size', '0',
        resolve(dir, 'playlist.m3u8'),
      ], { stdio: 'pipe' });
      parts.push(resolve(dir, 'seg_000000.m4s'));
    }

    const joined = resolve(legacy, 'joined.mp4');
    writeFileSync(joined, Buffer.concat([
      readFileSync(resolve(legacy, 's0', 'init.mp4')),
      ...parts.map((p) => readFileSync(p)),
    ]));

    const expected = SOURCE_SECONDS * 24;
    // Every packet survives the byte-concatenation...
    expect(countFrames(joined, legacy)).toBe(expected);
    // ...but the decoder stops at the first segment boundary. That is the silent
    // truncation this design prevents.
    expect(decodedFrames(joined, legacy)).toBe(SEG * 24);
    expect(decodedFrames(joined, legacy)).toBeLessThan(expected);
  }, 120_000);
});
