#!/usr/bin/env node
/**
 * Build-time asset fetcher for Sloptube UI.
 *
 * Pulls the public YouTube stylesheets referenced by a logged-out homepage and
 * stores them in ui/vendor/. Regex-only extraction — no DOM library, no jsdom.
 *
 * Contract:
 *  - Every <link rel="stylesheet"> href found in the page HTML is downloaded.
 *  - The /s/_/ytmainappweb/_/ss/… kevlar bundle is always included.
 *  - The icon/font stylesheet is included and labelled with role "icon-font".
 *  - ui/vendor/tokens.css is ALWAYS written (mandatory fallback): the light
 *    `--yt-*` design tokens scraped from the vendor CSS, wrapped in `:root`.
 *    If every fetch fails, tokens.css + app.css alone still render YouTube.
 *
 * Usage: npm run assets:prepare
 */
import { mkdir, writeFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'ui', 'vendor');

const PAGE_URL = process.env.SLOPTUBE_ASSETS_URL || 'https://www.youtube.com/';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const HEADERS = {
  'User-Agent': UA,
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
};

/** Cap required by the brief. */
const MAX_TOKENS = 2000;

/**
 * Light-theme baseline. Applied *before* scraped values so vendor tokens win,
 * but if YouTube rotates the build and every fetch fails these still render a
 * recognisable YouTube. Values are the current YouTube light theme.
 */
const BASELINE = {
  'font-size': '10px',
  'font-family': '"YouTube Sans", Roboto, Arial, sans-serif',
  '--yt-deprecated-white': 'hsl(0,0%,100%)',
  '--yt-deprecated-black': 'hsl(0,0%,0%)',
  '--yt-deprecated-grey': 'hsl(0,0%,50%)',
  '--yt-brand-text-solid': 'hsl(0,0%,3%)',
  '--yt-spec-text-primary': 'hsl(0,0%,3%)',
  '--yt-spec-base-background': 'hsl(0,0%,100%)',
  '--yt-spec-general-background-a': 'hsl(0,0%,100%)',
  '--yt-spec-general-background-b': 'hsl(0,0%,98.5%)',
  '--yt-spec-general-background-c': 'hsl(0,0%,96%)',
  '--yt-spec-badge-chip-background': 'hsl(0,0%,90%)',
  '--yt-spec-button-chip-background': 'hsl(0,0%,90%)',
  '--yt-spec-touch-response': 'hsl(0,0%,50%)',
  '--yt-spec-10-percent-layer': 'hsla(0,0%,50%,0.1)',
  '--yt-spec-static-overlay-background-solid': 'hsl(0,0%,3%)',
  '--yt-spec-static-overlay-background-brand': 'hsl(0,0%,3%)',
  '--yt-spec-wordmark-text': 'hsl(0,0%,3%)',
  '--yt-spec-inverted-background': 'hsl(0,0%,3%)',
  '--yt-spec-icon-inactive': 'hsl(0,0%,3%)',
  '--yt-spec-call-to-action-button-background': 'hsl(0,0%,3%)',
  '--yt-spec-call-to-action-button-hover-background': 'hsl(0,0%,0%)',
  '--yt-spec-call-to-action-button-text': 'hsl(0,0%,100%)',
  '--yt-spec-call-to-action-button-text-inverse': 'hsl(0,0%,100%)',
  '--yt-spec-textual-link-inactive': 'hsl(0,0%,3%)',
  '--yt-spec-text-link': 'hsl(0,0%,3%)',
  '--yt-spec-raised-background': 'hsl(0,0%,100%)',
  '--yt-spec-menu-background': 'hsl(0,0%,100%)',
  '--yt-spec-menu-item-text-hover-background': 'hsla(0,0%,3%,0.1)',
  '--yt-spec-searchbox-background': 'hsl(0,0%,100%)',
  '--yt-spec-searchbox-text': 'hsl(0,0%,3%)',
  '--yt-spec-searchbox-placeholder': 'hsl(0,0%,41%)',
  '--yt-spec-topbar-background': 'hsl(0,0%,100%)',
  '--yt-spec-guide-background': 'hsl(0,0%,100%)',
  '--yt-spec-scrim': 'hsla(0,0%,3%,0.6)',
  '--ytd-grid-base': '103px',
  '--ytd-margin-base': '4px',
  '--ytd-avatar-size': '32px',
  '--ytd-toolbar-height': '56px',
  '--ytd-margin-2x': '8px',
  '--ytd-margin-3x': '12px',
  '--ytd-margin-4x': '16px',
  '--ytd-margin-5x': '20px',
  '--ytd-margin-6x': '24px',
  '--ytd-margin-8x': '32px',
  '--ytd-margin-9x': '36px',
  '--ytd-margin-10x': '40px',
  '--ytd-margin-11x': '44px',
  '--ytd-margin-12x': '48px',
  '--ytd-margin-14x': '56px',
  '--ytd-margin-16x': '64px',
};

/** ---- small helpers ------------------------------------------------------ */

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function absolutise(href) {
  const url = href.replace(/&amp;/g, '&').trim();
  if (/^https?:\/\//i.test(url)) return url;
  if (/^\/\//.test(url)) return 'https:' + url;
  return new URL(url, PAGE_URL).href;
}

/** Sanitise a URL into a stable, readable, filesystem-safe filename. */
function filenameFor(url, index, taken) {
  let base;
  const kevlar = url.match(/\/s\/_\/ytmainappweb\/_\/ss\/k=([a-z0-9._-]+?)\./i);
  if (kevlar) {
    base = 'kevlar-' + kevlar[1];
  } else if (/fonts\.(googleapis|gstatic)\.com/i.test(url)) {
    base = 'icon-fonts';
  } else {
    let p;
    try {
      p = decodeURIComponent(new URL(url).pathname);
    } catch {
      p = url;
    }
    base = p.split('/').filter(Boolean).pop() || `sheet-${index}`;
    base = base.replace(/\.(css|min\.css)$/i, '');
  }
  base = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (base.length > 80) base = base.slice(0, 80).replace(/-+$/, '');
  if (!base) base = `sheet-${index}`;
  let name = `${base}.css`;
  let n = 2;
  while (taken.has(name)) name = `${base}-${n++}.css`;
  taken.add(name);
  return name;
}

function roleFor(url) {
  if (/fonts\.(googleapis|gstatic)\.com/i.test(url)) return 'icon-font';
  if (/\/s\/_\/ytmainappweb\/_\/ss\//.test(url)) return 'vendor-main';
  if (/watch-page-skeleton/.test(url)) return 'page-skeleton-watch';
  if (/home-page-skeleton/.test(url)) return 'page-skeleton-home';
  return 'vendor';
}

/**
 * Scrape the light-theme `--yt-*` custom properties.
 *
 * Only rules whose selector is a root-scope selector are considered, and any
 * selector containing `[dark` is skipped — otherwise dark-mode values would be
 * baked into :root and light mode would render wrong.
 */
const ROOT_SCOPE = /^(?::root|html|body|yt-app|ytd-app|ytd-browse|ytd-masthead|yt-browse-hairline)$/;

function scrapeTokens(css, sink) {
  const ruleRe = /(?:^|[};])\s*([^{};]{1,200}?)\s*\{([^{}]*)\}/g;
  let m;
  while ((m = ruleRe.exec(css))) {
    const selector = m[1].trim();
    if (/\[dark/i.test(selector)) continue;
    // A rule may list several selectors; keep only the fully-root ones.
    if (!selector.split(',').every((s) => ROOT_SCOPE.test(s.trim()))) continue;
    const body = m[2];
    const declRe = /(--yt[a-z0-9_-]+)\s*:\s*([^;{}]+);/g;
    let d;
    while ((d = declRe.exec(body))) {
      const value = d[2].replace(/\s+/g, ' ').trim();
      if (!value || value.length > 400) continue;
      sink.set(d[1], value);
    }
  }
}

// ---- main ------------------------------------------------------------------

async function main() {
  await mkdir(VENDOR, { recursive: true });

  const findings = { files: [], failures: [], htmlBytes: 0 };
  const tokens = new Map(Object.entries(BASELINE));
  const parts = [];
  const taken = new Set();

  console.log(`\nsloptube · assets:prepare\n  page  ${PAGE_URL}`);

  let html = '';
  try {
    const res = await fetch(PAGE_URL, { headers: HEADERS, redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
    findings.htmlBytes = Buffer.byteLength(html);
  } catch (err) {
    findings.htmlFails = true;
    console.log(`  html  FAILED (${err.message}) — continuing with token fallback only`);
  }

  const urls = [];
  const push = (href, { requireCss = false } = {}) => {
    if (!href) return;
    let abs;
    try {
      abs = absolutise(href);
    } catch {
      return;
    }
    if (requireCss && !/\.css(\?|$)/i.test(abs)) return;
    if (!urls.includes(abs)) urls.push(abs);
  };

  if (html) {
    // 1. every <link rel="stylesheet" href="…">, in any attribute order.
    //    No extension check: the kevlar bundle and the font sheet have none.
    const linkRe = /<link\b[^>]*>/gi;
    let tag;
    while ((tag = linkRe.exec(html))) {
      const t = tag[0];
      if (!/rel\s*=\s*["']?stylesheet/i.test(t)) continue;
      const href = t.match(/href\s*=\s*["']([^"']+)["']/i);
      push(href && href[1]);
    }
    // 2. the ytmainappweb kevlar bundle, even if the link tag is malformed
    const kevlarRe = /((?:https?:)?\/\/www\.youtube\.com\/s\/_\/ytmainappweb\/_\/ss\/[^"'\\\s)]+)/gi;
    let k;
    while ((k = kevlarRe.exec(html))) push(k[1], { requireCss: true });
    // 3. the icon/font stylesheet, if it is linked outside a rel=stylesheet tag
    const iconRe = /((?:https?:)?\/\/[^"'\\\s)]*icon[^"'\\\s)]*\.css)/gi;
    let ic;
    while ((ic = iconRe.exec(html))) push(ic[1], { requireCss: true });
  }

  if (!urls.length) {
    console.log('  css   no stylesheet URLs discovered');
  }

  for (const [index, url] of urls.entries()) {
    const file = filenameFor(url, index, taken);
    try {
      const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const bytes = Buffer.byteLength(text);
      if (!bytes) throw new Error('empty body');
      await writeFile(join(VENDOR, file), text, 'utf8');
      parts.push(text.replace(/^﻿/, '').replace(/^@charset\s+["'][^"']*["']\s*;/i, ''));
      scrapeTokens(text, tokens);
      findings.files.push({
        url,
        file,
        role: roleFor(url),
        bytes,
        sha256: sha256(Buffer.from(text, 'utf8')),
      });
    } catch (err) {
      findings.failures.push({ url, error: err.message });
    }
  }

  // Single concatenated bundle so index.html needs exactly one <link>.
  // (Individual files stay on disk for inspection.)
  const bundle = parts.length
    ? `/* sloptube vendor bundle — generated by scripts/prepare.mjs. Do not edit. */\n${parts.join('\n')}\n`
    : '';
  if (bundle) {
    await writeFile(join(VENDOR, 'vendor.css'), bundle, 'utf8');
  } else {
    // Nothing succeeded: drop any bundle left by an earlier run, otherwise the
    // stale file would mask the failure and tokens.css would never be exercised.
    const bundlePath = join(VENDOR, 'vendor.css');
    if (existsSync(bundlePath)) await rm(bundlePath);
    const stale = (await readdir(VENDOR)).filter((f) => f.endsWith('.css') && f !== 'tokens.css');
    for (const f of stale) await rm(join(VENDOR, f));
  }

  // Mandatory fallback: light `--yt-*` tokens in `:root`.
  const entries = [...tokens.entries()].filter(([k]) => k.startsWith('--yt'));
  const kept = entries.slice(0, MAX_TOKENS);
  const dropped = entries.length - kept.length;
  const tokenCss = [
    '/*',
    ' * sloptube fallback design tokens — generated by scripts/prepare.mjs. Do not edit.',
    ` * ${kept.length} light-theme --yt-* custom properties${dropped ? ` (${dropped} over cap)` : ''}.`,
    ' * Guarantees a recognisable YouTube even when ui/vendor/vendor.css is absent.',
    ' */',
    ':root {',
    ...kept.map(([k, v]) => `  ${k}: ${v};`),
    '}',
    '',
  ].join('\n');
  await writeFile(join(VENDOR, 'tokens.css'), tokenCss, 'utf8');

  const fetchedAt = new Date().toISOString();
  await writeFile(
    join(VENDOR, 'manifest.json'),
    JSON.stringify({ fetchedAt, pageUrl: PAGE_URL, files: findings.files, failures: findings.failures }, null, 2),
    'utf8',
  );

  // ---- report ----
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`  files ${findings.files.length} ok, ${findings.failures.length} failed, html ${findings.htmlBytes} B`);
  if (findings.files.length) {
    console.log(`  ${pad('role', 24)}${pad('file', 46)}bytes`);
    for (const f of findings.files) {
      console.log(`  ${pad(f.role, 24)}${pad(f.file, 46)}${f.bytes}`);
    }
  }
  for (const f of findings.failures) console.log(`  ${pad('FAILED ' + f.error, 24)}${pad(f.file || '', 46)}0`);
  const total = findings.files.reduce((a, f) => a + f.bytes, 0);
  if (bundle) {
    const bundleBytes = Buffer.byteLength(bundle);
    console.log(`  ${pad('bundle', 24)}${pad('vendor/vendor.css', 46)}${bundleBytes}`);
    console.log(`  ${pad('fallback', 24)}${pad('vendor/tokens.css', 46)}${Buffer.byteLength(tokenCss)} (${kept.length} tokens)`);
    console.log(`  total vendor bytes: ${total}`);
  }
  const usedFallback = findings.files.length === 0;
  console.log(`  fallback: ${usedFallback ? 'YES — vendor bundle empty, tokens.css carries the theme' : 'no — token file still written as backup'}`);

  if (usedFallback) {
    console.log('  RESULT: every stylesheet fetch failed. tokens.css alone must carry the theme.\n');
    process.exitCode = 1;
  } else {
    console.log('  RESULT: ok\n');
  }
}

await main();