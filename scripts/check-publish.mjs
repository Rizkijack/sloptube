#!/usr/bin/env node
// Pre-publication guard. Run before committing or pushing anything public.
//
//   node scripts/check-publish.mjs           # working tree + what is staged
//   node scripts/check-publish.mjs --staged # only what the index would publish
//
// Exits non-zero on any finding, so it can gate a pre-push hook.
//
// Why shape-based and not a list of known prefixes: a real credential pasted
// into a comment usually has NO recognisable prefix. Known-prefix matching would
// pass it silently. This reports every high-entropy string with its context and
// lets a human judge, plus hard-fails the two things that are unambiguous.

import { execSync } from 'node:child_process';
import { readFileSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const stagedOnly = process.argv.includes('--staged');

const problems = [];
const warnings = [];

function git(args) {
  return execSync(`git ${args}`, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
}

const files = stagedOnly
  ? (() => {
      // Only paths the index would actually publish.
      const out = git('diff --cached --name-only --diff-filter=ACMR');
      const list = out.split('\n').filter(Boolean);
      if (list.length > 0) return list;
      return git('ls-files').split('\n').filter(Boolean);
    })()
  : git('ls-files --cached --others --exclude-standard').split('\n').filter(Boolean);

// ---------------------------------------------------------------------------
// 1. Hard rules — these are never acceptable, no judgement call.
// ---------------------------------------------------------------------------

const BINARY = new Set(['.png', '.jpg', '.jpeg', '.gif', '.ico', '.woff', '.woff2', '.mp4', '.m4s', '.bin', '.db', '.sqlite']);
const MAX_TEXT_BYTES = 4_000_000;

/** Host-absolute paths that break for anyone who clones. Container-internal
 *  paths like /tmp/sloptube are configuration, not leakage, so they pass. */
const HOST_PATH = [
  { re: /\b[A-Za-z]:[\\/](?:Users|PROJECT|ProgramData)[^\s"'`,)]*/g, name: 'absolute Windows host path' },
  { re: /(?:^|[\s"'`(=])\/(?:home|Users|root|mnt\/c|var\/folders)\/[^\s"'`,)]+/g, name: 'absolute POSIX host path' },
];

/** Paths that must never be committed, whatever they contain. */
const FORBIDDEN_PREFIXES = ['node_modules/', '.wrangler/', 'ui/vendor/', 'dist/', '.env', '.dev.vars'];

for (const file of files) {
  const norm = file.replace(/\\/g, '/');

  if (FORBIDDEN_PREFIXES.some((p) => norm === p || norm.startsWith(p) || norm.endsWith(`/${p}`))) {
    problems.push(`${file}: forbidden path — secrets, build output and vendor CSS must never be committed`);
    continue;
  }
  if (BINARY.has(extname(norm).toLowerCase())) continue;

  const abs = join(ROOT, file);
  if (!existsSync(abs)) continue;
  if (statSync(abs).size > MAX_TEXT_BYTES) continue;

  const text = readFileSync(abs, 'utf8');
  for (const { re, name } of HOST_PATH) {
    const rx = new RegExp(re.source, re.flags);
    const hit = text.match(rx);
    if (hit) problems.push(`${file}: ${name} -> ${hit[0].trim().slice(0, 100)}`);
  }
}

// ---------------------------------------------------------------------------
// 2. Shape-based entropy scan — reported, not auto-failed, except JWTs.
// ---------------------------------------------------------------------------

const SUSPECT = [
  { name: 'private key block', re: /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----/g, hard: true },
  { name: 'AWS access key id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, hard: true },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, hard: true },
  { name: 'GitHub fine-grained PAT', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, hard: true },
  { name: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{20,}\b/g, hard: true },
  { name: 'Cloudflare API token', re: /\b[A-Za-z0-9_-]{40}\b/g, hard: false },
  { name: 'basic-auth in URL', re: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]+@/gi, hard: true },
  { name: 'long hex literal', re: /\b[0-9a-fA-F]{24,}\b/g, hard: false },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, hard: true },
];

/** Values that are definitionally not credentials. */
const BENIGN = [
  /^integrity"?\s*:\s*"?/i,
  /sha(256|384|512)-/i,
  /^REPLACE_WITH/,
  /^https?:\/\/(www\.)?(github\.com|npmjs\.org|registry\.npmjs\.org|json-schema\.org|www\.w3\.org|youtube\.com|youtu\.be|cdn\.jsdelivr\.net|unpkg\.com|developers\.cloudflare\.com|nodejs\.org|vitest\.dev|stackoverflow\.com|developer\.mozilla\.org|127\.0\.0\.1|localhost)/,
  /users\.noreply\.github\.com$/i,
  /^(example|test|demo|localhost|127\.0\.0\.1)$/i,
  // Well-known SHA-256 test vectors used by the auth tests.
  /^(e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855|ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad)$/,
];

for (const file of files) {
  if (BINARY.has(extname(file).toLowerCase())) continue;
  const abs = join(ROOT, file);
  if (!existsSync(abs) || statSync(abs).size > MAX_TEXT_BYTES) continue;

  const lines = readFileSync(abs, 'utf8').split('\n');
  for (const { name, re, hard } of SUSPECT) {
    const rx = new RegExp(re.source, re.flags);
    lines.forEach((line, i) => {
      for (const m of line.match(rx) ?? []) {
        if (BENIGN.some((b) => b.test(m) || b.test(line.trim()))) continue;
        if (/^[A-Za-z][A-Za-z\s]+$/.test(m)) continue; // prose
        // A 40-char run is not a token if it is a CSS custom property or a
        // kebab-case identifier: `--yt-spec-call-to-action-button-background`
        // matches the shape and is nothing of the sort.
        if (/--[\w-]+$/.test(line.slice(0, line.indexOf(m)))) continue;
        if (/^[a-z][a-z0-9-]*$/.test(m)) continue;
        const msg = `${file}:${i + 1}: ${name} -> ${m.slice(0, 60)}`;
        if (hard) problems.push(msg);
        else warnings.push(msg);
      }
    });
  }
}

// ---------------------------------------------------------------------------
// 3. Verify .gitignore actually bites, rather than trusting that it does.
// ---------------------------------------------------------------------------

const IGNORE_PROBES = [
  '.env',
  '.dev.vars',
  '.env.production',
  'ui/vendor/vendor.css',
  'node_modules/x.js',
  '.wrangler/state',
  'dist/index.js',
  'debug.log',
  'test/fixtures/out/x.m4s',
  'test/fixtures/transcode-guard/x',
];
for (const probe of IGNORE_PROBES) {
  try {
    execSync(`git check-ignore -q -- "${probe}"`, { cwd: ROOT, stdio: 'ignore' });
  } catch {
    problems.push(`.gitignore does NOT cover "${probe}" — it would be committed`);
  }
}

// ---------------------------------------------------------------------------
// 4. Placeholders must stay placeholders.
// ---------------------------------------------------------------------------

const wranglerPath = join(ROOT, 'wrangler.jsonc');
if (existsSync(wranglerPath)) {
  const w = readFileSync(wranglerPath, 'utf8');
  for (const key of ['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'ADMIN_TOKEN', 'REPORTER_SALT', 'TURNSTILE_SECRET_KEY']) {
    if (!w.includes(key)) continue;
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"]*)"`).exec(w);
    if (m && m[1] && !/^REPLACE_WITH/.test(m[1])) {
      problems.push(`wrangler.jsonc: ${key} has a literal value — it must be a wrangler secret, not a var`);
    }
  }
}

// ---------------------------------------------------------------------------

// 5. R2_PUBLIC_BASE must stay empty in production: a populated value routes
// media straight from R2 and disables report-driven takedowns and holds.
if (existsSync(wranglerPath)) {
  const w2 = readFileSync(wranglerPath, 'utf8');
  const wm = new RegExp(`"ENVIRONMENT"\\\\s*:\\\\s*"([^"]*)"`).exec(w2);
  const rb = new RegExp(`"R2_PUBLIC_BASE"\\\\s*:\\\\s*"([^"]*)"`).exec(w2);
  if (wm && wm[1] === 'production' && rb && rb[1].trim() !== '') {
    problems.push('wrangler.jsonc: R2_PUBLIC_BASE must be empty in production (takedowns disabled otherwise)');
  }
}

console.log(`checked ${files.length} file(s)${stagedOnly ? ' (staged only)' : ''}`);
if (warnings.length) {
  console.log(`\n${warnings.length} low-confidence string(s) — eyeball these:`);
  for (const w of warnings.slice(0, 15)) console.log(`  ? ${w}`);
  if (warnings.length > 15) console.log(`  ... +${warnings.length - 15} more`);
}
if (problems.length) {
  console.error(`\n${problems.length} BLOCKING issue(s):`);
  for (const p of problems) console.error(`  x ${p}`);
  process.exit(1);
}
console.log('\nOK — nothing that should not be published.');