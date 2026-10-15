import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { accessibleNames, installDom, type ShimGlobal } from './dom-shim.js';

/**
 * Renders the shipped UI through its real boot path in a DOM shim.
 *
 * `globalThis.fetch` is stubbed to fail, so this is exactly the first-run
 * visitor experience: no backend, no published videos, empty-state nudge.
 * The assertion set is the acceptance criterion from the build plan — the
 * accessible names the real YouTube homepage exposes.
 */

const UI = resolve(import.meta.dirname, '..', 'ui');
const seed = JSON.parse(readFileSync(resolve(UI, 'seed.json'), 'utf8'));
const INDEX_HTML = readFileSync(resolve(UI, 'index.html'), 'utf8');

let dom: ShimGlobal;

/** The names a logged-out YouTube homepage (id/ID locale) exposes. */
const REQUIRED_NAMES = [
  'Guide',
  'Search',
  'Search with your voice',
  'Settings',
  'Sign in',
  'Skip navigation',
  'YouTube Home',
  'Home',
  'Shorts',
  'Subscriptions',
  'You',
  'ID',
];

beforeAll(async () => {
  dom = installDom();
  await import('../ui/app.js');
  // Let the async boot chain (seed load → renderRoute) settle.
  await new Promise((r) => setTimeout(r, 50));
});

describe('ui boot', () => {
  it('renders without throwing', () => {
    expect(dom.document.body).toBeTruthy();
  });

  it('exposes every accessible name the real homepage has', () => {
    const names = accessibleNames(dom.document.body);
    const haystack = names.join(' | ');
    const missing = REQUIRED_NAMES.filter((n) => !haystack.includes(n));
    expect(missing, `missing accessible names: ${missing.join(', ')}`).toEqual([]);
  });

  it('hydrates the masthead, guide and feed hosts', () => {
    for (const selector of ['#feed', '#mini-guide', '#masthead', 'ytd-masthead', 'yt-searchbox', '.searchbox-input', '.mini-guide-entry']) {
      expect(dom.document.body.querySelector(selector), `${selector} missing`).toBeTruthy();
    }
    const masthead = dom.document.body.querySelector('ytd-masthead');
    expect(masthead?.getAttribute('data-hydrated')).toBe('true');
  });

  it('renders the four guide entries like the real page', () => {
    const labels = dom.document.body
      .querySelectorAll('.mini-guide-entry')
      .map((n) => n.getAttribute('aria-label'));
    expect(labels).toEqual(['Home', 'Shorts', 'Subscriptions', 'You']);
  });

  it('renders the Indonesian empty-state strings when the feed is empty', () => {
    const text = dom.document.body.textContent;
    expect(text).toContain('Coba telusuri untuk memulai');
    expect(text).toContain('Mulailah menonton video untuk membantu kami membuat feed berisi video yang Anda sukai.');
    expect(text).toContain('Lewati navigasi');
    expect(text).toContain('Masuk');
  });

  it('leaves no unhandled renderers', () => {
    const win = dom.window as unknown as { __unhandledRenderers: string[]; __renderErrors: unknown[] };
    expect(win.__unhandledRenderers).toEqual([]);
    expect(win.__renderErrors).toEqual([]);
  });

  it('ships a seed fixture in the /api/browse contract shape', () => {
    expect(seed.contents.twoColumnBrowseResultsRenderer.tabs.length).toBeGreaterThan(0);
    const json = JSON.stringify(seed);
    expect(json).toContain('videoRenderer');
    expect(json).toContain('desktopTopbarRenderer');
  });
});

describe('safe URL handling', () => {
  let safeUrl: (v: unknown) => string | null;

  beforeAll(async () => {
    ({ safeUrl } = (await import('../ui/app.js')) as { safeUrl: (v: unknown) => string | null });
  });

  it('rejects script and data URLs', () => {
    for (const evil of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox',
      '//evil.example/x',
      'file:///etc/passwd',
      'blob:http://x/y',
    ]) {
      expect(safeUrl(evil), `should reject ${evil}`).toBeNull();
    }
  });

  it('accepts relative and http(s) URLs', () => {
    expect(safeUrl('/watch?v=abc')).toBe('/watch?v=abc');
    expect(safeUrl('https://cdn.example/a.m3u8')).toBe('https://cdn.example/a.m3u8');
    expect(safeUrl('http://127.0.0.1:5173/x')).toBe('http://127.0.0.1:5173/x');
  });

  it('rejects control characters', () => {
    expect(safeUrl('/watch\u0000')).toBeNull();
    expect(safeUrl('\u0000/watch')).toBeNull();
  });

  it('treats a scheme-like string after a leading slash as a path, not a scheme', () => {
    // trim() runs before the control-char check, so this collapses to the
    // same-origin path `/javascript:1` — a path, not the javascript: scheme.
    expect(safeUrl('\n/javascript:1')).toBe('/javascript:1');
  });

  it('rejects non-strings', () => {
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(42)).toBeNull();
    expect(safeUrl({})).toBeNull();
  });
});

describe('never uses innerHTML', () => {
  it('has no innerHTML assignment in the shipped module', () => {
    const source = readFileSync(resolve(UI, 'app.js'), 'utf8');
    const assignments = source.match(/\.innerHTML\s*=/g) ?? [];
    expect(assignments).toEqual([]);
    expect(source).not.toMatch(/insertAdjacentHTML/);
  });
});

describe('vendor CSS is load-async, never render-blocking', () => {
  /** Every <link …> tag outside <noscript>: the ones JS-capable browsers will
   *  actually apply during load. The noscript fallback is intentionally
   *  blocking and checked separately below. */
  const linkTags = (
    INDEX_HTML.replace(/<noscript>[\s\S]*?<\/noscript>/g, '').match(/<link\b[^>]*>/g) ?? []
  ).map((tag) => tag);
  const vendorLink = (tag: string) => /href="vendor\/vendor\.css"/.test(tag);
  const blockingLink = (tag: string) => !/\bmedia=/.test(tag);

  it('has no render-blocking <link> for vendor/vendor.css', () => {
    const blocking = linkTags.filter((t) => vendorLink(t) && blockingLink(t));
    expect(blocking, `blocking vendor.css link found: ${blocking.join(' | ')}`).toEqual([]);
  });

  it('loads vendor.css through the media-swap trick with an onload swap-in', () => {
    // 3+ MB bundle must skip render blocking: media="print" doesn't contend
    // with FCP, and onload flips it to all.
    expect(INDEX_HTML).toMatch(
      /<link\b[^>]*href="vendor\/vendor\.css"[^>]*media="print"[^>]*onload="this\.media='all'"/,
    );
  });

  it('keeps a <noscript> fallback so non-JS clients still get the theme', () => {
    expect(INDEX_HTML).toMatch(
      /<noscript>\s*<link rel="stylesheet" href="vendor\/vendor\.css"/,
    );
  });

  it('keeps the tiny critical shell render-blocking on purpose', () => {
    // The flip side: tokens.css + app.css must NOT accidentally inherit the
    // async treatment — they are the whole theme when the vendor bundle 404s.
    expect(linkTags.some((t) => /href="vendor\/tokens\.css"/.test(t) && blockingLink(t))).toBe(
      true,
    );
    expect(linkTags.some((t) => /href="app\.css"/.test(t) && blockingLink(t))).toBe(true);
  });
});
