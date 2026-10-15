/**
 * sloptube UI — generic renderer engine.
 *
 * The Worker emits a ytInitialData-shaped tree (see src/worker/lib/renderer.ts
 * and docs/API-CONTRACT.md §4.1). This file hydrates that tree the way YouTube
 * does: walk the object, and for every `*Renderer` / `*ViewModel` key dispatch to
 * a factory registered in RENDERERS. Unknown renderers are collected in
 * `window.__unhandledRenderers` and skipped — they never throw.
 *
 * Hard requirement: every string coming from the server reaches the DOM through
 * `textContent`, `setAttribute` or `safeUrl`. There is no innerHTML in this file.
 */

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/**
 * Accessible names are a UI contract, not server data: a hostile or buggy
 * backend must not be able to spoof, translate or erase a label. Visible text
 * is localised (id-ID); accessible names match the real logged-out page.
 */
const A11Y = Object.freeze({
  guide: 'Guide',
  logo: 'YouTube Home',
  country: 'ID',
  skipNavigation: 'Skip navigation',
  search: 'Search',
  searchSubmit: 'Cari',
  searchWithVoice: 'Search with your voice',
  signIn: 'Sign in',
  settings: 'Settings',
  home: 'Home',
  shorts: 'Shorts',
  subscriptions: 'Subscriptions',
  you: 'You',
  report: 'Report',
});

const ID = Object.freeze({
  logo: 'Sloptube',
  signIn: 'Masuk',
  searchPlaceholder: 'Cari',
  tabs: { home: 'Beranda', shorts: 'Shorts', subscriptions: 'Subscription', you: 'Anda' },
  emptyTitle: 'Coba telusuri untuk memulai',
  emptyBody:
    'Mulailah menonton video untuk membantu kami membuat feed berisi video yang Anda sukai.',
  emptySearchTitle: 'Tidak ada hasil untuk',
});

/** Sidebar entries — no server payload for the guide, it is app chrome. */
const GUIDE_ENTRIES = Object.freeze([
  { label: ID.tabs.home, aria: A11Y.home, href: '/', icon: 'home', current: true },
  { label: ID.tabs.shorts, aria: A11Y.shorts, href: '/feed/shorts', icon: 'shorts' },
  { label: ID.tabs.subscriptions, aria: A11Y.subscriptions, href: '/feed/subscriptions', icon: 'subscriptions' },
  { label: ID.tabs.you, aria: A11Y.you, href: '/feed/you', icon: 'you' },
]);

/**
 * hls.js is pinned to an exact version AND verified with a Subresource Integrity
 * hash. A floating major (`hls.js@1`) plus no integrity is third-party script
 * execution in our origin: whatever the CDN serves runs here. Bump the version
 * and the hash together; the hash is sha384 of the exact bytes jsdelivr serves
 * at that versioned path.
 */
const HLS_CDN = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.3/dist/hls.min.js';
const HLS_INTEGRITY = 'sha384-cciJ0zi8d1uMKC2zJd7jvPY4HQt7W4ByUI/FlMkltvBi31aW61rcpVBhpmW8/NwX';

/** Set when no topbar payload is available; built by the same factory. */
const DEFAULT_TOPBAR = Object.freeze({
  topbar: {
    desktopTopbarRenderer: {
      logo: {
        topbarLogoRenderer: {
          iconImage: { iconType: 'YOUTUBE_LOGO' },
          tooltipText: { simpleText: ID.logo },
          endpoint: { browseEndpoint: { browseId: 'FEwhat_to_watch', canonicalBaseUrl: '/' } },
        },
      },
      searchbox: {
        fusionSearchboxRenderer: {
          searchQuery: '',
          placeholderText: { simpleText: ID.searchPlaceholder },
        },
      },
      topbarButtons: [
        {
          topbarMenuButtonRenderer: {
            icon: { iconType: 'MORE_VERT' },
            accessibility: { accessibilityData: { label: ID.settings } },
            tooltip: ID.settings,
            style: 'STYLE_DEFAULT',
          },
        },
      ],
      countryCode: ID.country ? 'ID' : 'ID',
      a11ySkipNavigationButton: {
        a11ySkipNavigationButtonRenderer: { targetId: 'feed', label: A11Y.skipNavigation },
      },
    },
  },
});

/** Empty state, built by the same feedNudgeRenderer factory the Worker uses. */
const EMPTY_FEED = Object.freeze({
  feedNudgeRenderer: {
    title: { runs: [{ text: ID.emptyTitle }] },
    subtitle: { runs: [{ text: ID.emptyBody }] },
    applyModernizedStyle: true,
    trackingParams: '',
    contentsLocation: 'FEED_NUDGE_CONTENTS_LOCATION_UNKNOWN',
  },
});

/* ------------------------------------------------------------------ *
 * Diagnostics — inspected by the verification step.
 * ------------------------------------------------------------------ */

window.__unhandledRenderers = [];
window.__renderErrors = [];

/* ------------------------------------------------------------------ *
 * DOM helpers (safe construction only)
 * ------------------------------------------------------------------ */

const BOOL_ATTR = new Set([
  'allowfullscreen', 'autofocus', 'autoplay', 'checked', 'controls', 'disabled',
  'hidden', 'loop', 'muted', 'open', 'playsinline', 'readonly', 'required',
  'selected',
]);

/**
 * Whitelist for URLs that reach href/src. `javascript:`, `data:`, `vbscript:`
 * and protocol-relative `//host` are rejected outright; only same-origin paths
 * and http(s) absolute URLs survive.
 */
function safeUrl(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || /[\u0000-\u001f]/.test(v)) return null;
  if (/^(javascript|data|vbscript|file|blob):/i.test(v)) return null;
  if (v.startsWith('//')) return null;
  if (v.startsWith('/') || v.startsWith('./') || v.startsWith('../')) return v;
  if (/^https?:\/\//i.test(v)) return v;
  return null;
}

/** Flatten a contract `Text` node ({simpleText} | {runs[]}) to a plain string. */
function runText(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  if (typeof value.simpleText === 'string') return value.simpleText;
  if (Array.isArray(value.runs)) {
    return value.runs.map((r) => (r && typeof r.text === 'string' ? r.text : '')).join('');
  }
  return '';
}

/**
 * A thumbnail lives at `key: { thumbnails: [...] }`, so the factory is reached
 * by handing renderNode a wrapper keyed with the payload's own key name.
 */
function renderThumbnail(value) {
  if (!value || typeof value !== 'object') return null;
  return renderNode({ thumbnail: value });
}

/** Scope class YouTube's Polymer build emits for each element (`ytd-x` → `.ytd-x`). */
function scopeClass(tag) {
  return tag.startsWith('ytd-') ? tag.slice(4) : '';
}

/**
 * createElement wrapper. Values are set as attributes (never as HTML source).
 * `text` assigns via textContent; `class` merges the Polymer scope class.
 */
function el(tag, props, children) {
  const node = document.createElement(tag);
  const scope = scopeClass(tag);
  for (const [key, raw] of Object.entries(props || {})) {
    if (raw === null || raw === undefined || raw === false) continue;
    if (key === 'text') {
      node.textContent = String(raw);
    } else if (key === 'class') {
      const list = [scope, String(raw)].filter(Boolean).join(' ');
      node.setAttribute('class', list);
    } else if (key === 'dataset') {
      for (const [dk, dv] of Object.entries(raw)) {
        if (dv === null || dv === undefined || dv === false) continue;
        node.setAttribute('data-' + dk, dv === true ? '' : String(dv));
      }
    } else if (typeof raw === 'function' && key.startsWith('on')) {
      node.addEventListener(key.slice(2).toLowerCase(), raw);
    } else {
      node.setAttribute(key, BOOL_ATTR.has(key) ? (raw === true ? '' : String(raw)) : String(raw));
    }
  }
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  if (scope) node.classList.add(scope);
  return node;
}

function frag(children) {
  const f = document.createDocumentFragment();
  for (const child of [].concat(children || [])) {
    if (child === null || child === undefined || child === false) continue;
    f.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return f;
}

/** Depth-limited search for a renderer key anywhere in the payload. */
function findNode(root, name, depth = 0) {
  if (!root || typeof root !== 'object' || depth > 12) return undefined;
  if (Object.prototype.hasOwnProperty.call(root, name)) return root[name];
  for (const value of Object.values(root)) {
    if (value && typeof value === 'object') {
      const hit = findNode(value, name, depth + 1);
      if (hit !== undefined) return hit;
    }
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * Icons — SVG built through createElementNS, never parsed from a string.
 * ------------------------------------------------------------------ */

const SVG_NS = 'http://www.w3.org/2000/svg';

const ICON_PATHS = {
  menu: 'M21 6H3V5h18v1zm0 5H3v1h18v-1zm0 6H3v1h18v-1z',
  search: 'M20.87 20.17l-5.59-5.59A6.96 6.96 0 0 0 16 9.5 6.96 6.96 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l5.59 5.59.8-.8zM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  mic: 'M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.3-3c0 3-2.54 5.1-5.3 5.1S6.7 14 6.7 11H5c0 3.41 2.72 6.23 6 6.72V21h2v-3.28c3.28-.49 6-3.31 6-6.72h-1.7z',
  settings:
    'M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.62l-1.92-3.32a.49.49 0 0 0-.6-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54A.49.49 0 0 0 13.9 2h-3.84a.49.49 0 0 0-.49.42l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.6.22L2.7 8.86a.49.49 0 0 0 .12.62l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.62l1.92 3.32c.13.22.39.31.6.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.04.24.25.42.49.42h3.84c.24 0 .46-.18.49-.42l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.49.49 0 0 0-.12-.62l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 15.6 12 3.6 3.6 0 0 1 12 15.6z',
  home: 'M4 21V9l8-6 8 6v12h-6v-7h-4v7H4z',
  shorts:
    'M10 14.65v-5.3L15 12l-5 2.65zm7.77-4.33-1.2-.5L18 9.06c1.84-.96 2.53-3.23 1.56-5.06s-3.24-2.53-5.07-1.56L6 6.94a3.5 3.5 0 0 0-2 3.49c0 1.28.68 2.4 1.75 3.03l.27.12L6 14.93a3.5 3.5 0 0 0 .5 5.06 3.5 3.5 0 0 0 5.07-1.56l8.5-4.5a3.5 3.5 0 0 0 .57-6.61z',
  subscriptions: 'M10 18v-6l5 3-5 3zm7-17H7v1h10V1zm3 3H4v1h16V4zm2 3H2v12h20V7z',
  you: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
  play: 'M6 4l14 8-14 8z',
  flag: 'M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z',
  searchOff:
    'M15.5 14h-.79l-.28-.27A6.96 6.96 0 0 0 16 9.5 6.96 6.96 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l5.59 5.59.8-.8zM9.5 14C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
};

/** @param {string} name key of ICON_PATHS */
function icon(name, className) {
  const d = ICON_PATHS[name];
  const node = el('yt-icon', { class: className || '', 'aria-hidden': 'true' });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('focusable', 'false');
  if (d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  node.append(svg);
  return node;
}

/** The YouTube wordmark, geometry only — matches the real masthead closely. */
function wordmark() {
  const node = el('yt-icon', { 'aria-hidden': 'true' });
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 90 20');
  svg.setAttribute('focusable', 'false');
  const plate = document.createElementNS(SVG_NS, 'rect');
  plate.setAttribute('x', '0');
  plate.setAttribute('y', '2');
  plate.setAttribute('width', '28');
  plate.setAttribute('height', '16');
  plate.setAttribute('rx', '5');
  plate.setAttribute('fill', '#f00');
  svg.append(plate);
  const mark = document.createElementNS(SVG_NS, 'path');
  mark.setAttribute('d', 'M12 7l5 3-5 3z');
  mark.setAttribute('fill', '#fff');
  svg.append(mark);
  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', '32');
  text.setAttribute('y', '15.5');
  text.setAttribute('font-family', 'Roboto, Arial, sans-serif');
  text.setAttribute('font-size', '15.5');
  text.setAttribute('font-weight', '700');
  text.setAttribute('fill', 'currentColor');
  text.textContent = 'YouTube';
  svg.append(text);
  node.append(svg);
  return node;
}

function tooltip(label, control) {
  return el('tp-yt-paper-tooltip', {}, [
    control,
    el('span', { class: 'tooltip-label', 'aria-hidden': 'true', text: label }),
  ]);
}

/* ------------------------------------------------------------------ *
 * renderNode — the hydrator
 * ------------------------------------------------------------------ */

const RENDERER_KEY = /(?:Renderer|ViewModel)$/;
/** Payload keys that are factories despite not ending in `Renderer`. */
const EXTRA_FACTORY_KEYS = new Set(['thumbnail']);
const RENDERERS = {};

/**
 * @param {unknown} obj a `{ someRenderer: {...} }` node, an array of them, or
 *   a plain container object.
 * @returns {Node|null} a Node, a DocumentFragment, or null when nothing was
 *   dispatched (unknown renderers, empty objects).
 */
function renderNode(obj) {
  if (obj === null || obj === undefined || typeof obj === 'boolean') return null;
  if (obj instanceof Node) return obj;

  if (typeof obj === 'string' || typeof obj === 'number') {
    return document.createTextNode(String(obj));
  }
  if (Array.isArray(obj)) {
    const children = obj.map(renderNode).filter(Boolean);
    return children.length ? frag(children) : null;
  }
  if (typeof obj !== 'object') return null;

  for (const [key, data] of Object.entries(obj)) {
    if (!RENDERER_KEY.test(key) && !EXTRA_FACTORY_KEYS.has(key)) continue;
    const factory = RENDERERS[key];
    if (!factory) {
      // Unknown renderer: collect it and skip (see the header contract at :7-8).
      // Falling through to generic hydration would contradict that and could
      // render an unknown node's raw payload.
      window.__unhandledRenderers.push(key);
      return null;
    }
    try {
      const out = factory(data ?? {}, obj);
      if (out) return out;
    } catch (err) {
      window.__renderErrors.push({ renderer: key, message: String(err && err.message) });
    }
    return null;
  }

  // Not a renderer node: treat as a container and hydrate the children.
  // Primitives are deliberately skipped — ytInitialData is full of bare strings
  // and numbers (trackingParams, thumbnail widths) that must never become text.
  const children = [];
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const child = renderNode(value);
      if (child) children.push(child);
    }
  }
  return children.length ? frag(children) : null;
}

/* ------------------------------------------------------------------ *
 * Factories
 * ------------------------------------------------------------------ */

/** thumbnail → ytd-thumbnail with the largest available image. */
RENDERERS.thumbnail = function thumbnail(data) {
  const list = Array.isArray(data.thumbnails) ? data.thumbnails : [];
  let best = null;
  for (const candidate of list) {
    const url = safeUrl(candidate && candidate.url);
    if (!url) continue;
    const width = Number(candidate.width) || 0;
    if (!best || width > best.width) best = { url, width };
  }
  const node = el('ytd-thumbnail', {}, []);
  if (!best) {
    node.classList.add('is-placeholder');
    return node;
  }
  node.append(el('img', { class: 'yt-core-image', src: best.url, alt: '', loading: 'lazy', decoding: 'async' }));
  return node;
};

/** videoRenderer → ytd-rich-item-renderer > ytd-video-renderer card. */
RENDERERS.videoRenderer = function videoRenderer(data) {
  const videoId = typeof data.videoId === 'string' ? data.videoId : '';
  const href = videoId ? safeUrl(`/watch?v=${encodeURIComponent(videoId)}`) : null;

  const title = runText(data.title) || videoId || 'Video';
  const author = runText(data.longBylineText) || runText(data.ownerText) || '';
  const authorShort = runText(data.shortBylineText) || author;
  const channel = findNode(data.longBylineText, 'browseEndpoint');
  const agentId =
    (channel && typeof channel.browseId === 'string' && channel.browseId) ||
    (typeof data.authorId === 'string' && data.authorId) ||
    '';
  const channelHref = safeUrl(
    (channel && channel.canonicalBaseUrl) ||
      (agentId ? `/channel/${encodeURIComponent(authorShort || agentId)}?id=${encodeURIComponent(agentId)}` : ''),
  );

  const duration = runText(data.lengthText);
  const published = runText(data.publishedTimeText);
  const views = runText(data.viewCountText);

  // --- media -------------------------------------------------------------
  const thumbNode = renderThumbnail(data.thumbnail) || el('ytd-thumbnail', { class: 'is-placeholder' });
  if (duration) {
    thumbNode.append(el('span', { class: 'duration-badge', 'aria-hidden': 'true', text: duration }));
  }
  const media = el('a', { class: 'rich-grid-media', href: href || '#', 'aria-label': `${title}${authorShort ? ` — ${authorShort}` : ''}` }, [
    thumbNode,
    el('span', { class: 'play-overlay', 'aria-hidden': 'true' }, [icon('play')]),
  ]);

  // --- details -----------------------------------------------------------
  const avatar = el('ytd-thumbnail', { id: 'avatar', class: 'is-placeholder' }, []);
  const avatarUrl = safeUrl(
    findNode(data, 'authorAvatarUrl') || (Array.isArray(data.authorAvatarThumbnails) ? (data.authorAvatarThumbnails[0] || {}).url : ''),
  );
  if (avatarUrl) {
    avatar.classList.remove('is-placeholder');
    avatar.append(el('img', { class: 'yt-core-image', src: avatarUrl, alt: '', loading: 'lazy' }));
  }

  const metaLine = [views, published].filter(Boolean).join(' · ');
  const details = el('div', { class: 'video-details' }, [
    channelHref
      ? el('a', { class: 'avatar-link', href: channelHref, 'aria-label': authorShort || undefined, tabindex: '-1' }, [avatar])
      : avatar,
    el('div', { class: 'video-meta' }, [
      el('a', { class: 'video-title-link', href: href || '#' }, [
        el('h3', { class: 'video-title' }, [el('yt-formatted-string', { text: title })]),
      ]),
      channelHref
        ? el('a', { class: 'channel-name', href: channelHref }, [el('yt-formatted-string', { text: authorShort })])
        : el('yt-formatted-string', { class: 'channel-name', text: authorShort }),
      metaLine ? el('yt-formatted-string', { class: 'metadata-line', text: metaLine }) : null,
    ]),
  ]);

  return el('ytd-rich-item-renderer', {}, [
    el('ytd-video-renderer', {}, [media, details]),
  ]);
};

/** richItemRenderer → unwrap `content` and hydrate it. */
RENDERERS.richItemRenderer = function richItemRenderer(data) {
  return renderNode(data.content);
};

/** richGridRenderer → ytd-rich-grid-renderer holding its richItems. */
RENDERERS.richGridRenderer = function richGridRenderer(data) {
  const contents = Array.isArray(data.contents) ? data.contents : [];
  const items = [];
  for (const item of contents) {
    const node = renderNode(item);
    if (!node) continue;
    if (node.nodeType === 1 && !node.hasAttribute('role')) node.setAttribute('role', 'listitem');
    items.push(node);
  }
  // The vendor sheet owns `ytd-rich-grid-renderer` and `ytd-rich-item-renderer`
  // (it hard-codes column widths and margins for Polymer's flex grid), so the
  // actual column layout lives in a plain div it has no selectors for.
  return el('ytd-rich-grid-renderer', {}, [el('div', { class: 'slop-grid', role: 'list' }, items)]);
};

/**
 * richSectionRenderer → ytd-rich-section-renderer delegating its items to the
 * grid factory, which is how YouTube nests a shelf inside a section.
 */
RENDERERS.richSectionRenderer = function richSectionRenderer(data) {
  const content = Array.isArray(data.content) ? data.content : [];
  const grid = renderNode({ richGridRenderer: { contents: content, itemCount: content.length } });
  return el('ytd-rich-section-renderer', {}, grid ? [grid] : []);
};

/** tabRenderer → a tab panel when it carries content, a tab button otherwise. */
RENDERERS.tabRenderer = function tabRenderer(data) {
  const label = runText(data.title);
  if (data.content) {
    const body = renderNode(data.content);
    return el('div', { class: 'tab-panel', role: 'tabpanel', 'aria-label': label || undefined }, body ? [body] : []);
  }
  if (label) return tabButton(label, data.selected === true);
  return null;
};

function tabButton(label, selected) {
  return el('a', {
    class: 'tab',
    role: 'tab',
    href: '#',
    'aria-selected': selected ? 'true' : 'false',
    tabindex: selected ? '0' : '-1',
    text: label,
  });
}

/** feedTabbedHeaderRenderer → ytd-feed-tabbed-header-renderer with a tablist. */
RENDERERS.feedTabbedHeaderRenderer = function feedTabbedHeaderRenderer(data) {
  const tabs = Array.isArray(data.tabs) ? data.tabs : [];
  const list = el('div', { class: 'tabs', role: 'tablist', 'aria-label': runText(data.title) || 'Feed' }, []);
  for (const entry of tabs) {
    const node = renderNode(entry);
    if (node) list.append(node);
  }
  return el('ytd-feed-tabbed-header-renderer', {}, [list]);
};

/** feedNudgeRenderer → the empty state. */
RENDERERS.feedNudgeRenderer = function feedNudgeRenderer(data) {
  const title = runText(data.title);
  const subtitle = runText(data.subtitle);
  return el('ytd-feed-nudge-renderer', {}, [
    icon('searchOff'),
    title ? el('h2', { class: 'nudge-title', text: title }) : null,
    subtitle ? el('p', { class: 'nudge-subtitle', text: subtitle }) : null,
  ]);
};

/** twoColumnBrowseResultsRenderer → header + every tab's content. */
RENDERERS.twoColumnBrowseResultsRenderer = function twoColumnBrowseResultsRenderer(data) {
  const out = el('ytd-two-column-browse-results-renderer', {}, []);
  const header = renderNode(data.header);
  if (header) {
    const bar = el('div', { class: 'browse-header' }, [header]);
    out.append(bar);
  }
  for (const tab of Array.isArray(data.tabs) ? data.tabs : []) {
    const node = renderNode(tab);
    if (node) out.append(node);
  }
  return out;
};

/** topbarLogoRenderer → the wordmark link. */
RENDERERS.topbarLogoRenderer = function topbarLogoRenderer(data) {
  const endpoint = data.endpoint && data.endpoint.browseEndpoint;
  const href = safeUrl((endpoint && endpoint.canonicalBaseUrl) || '/');
  const tooltipText = runText(data.tooltipText) || ID.logo;
  return el('a', {
    class: 'logo',
    href: href || '/',
    'aria-label': A11Y.logo,
    title: tooltipText,
  }, [wordmark()]);
};

/** topbarMenuButtonRenderer → icon button inside a tooltip shim. */
RENDERERS.topbarMenuButtonRenderer = function topbarMenuButtonRenderer(data) {
  const label = A11Y.settings;
  const iconName = data.icon && data.icon.iconType === 'MORE_VERT' ? 'settings' : 'menu';
  return el('ytd-topbar-menu-button-renderer', {}, [
    tooltip(data.tooltip || label, el('button', {
      class: 'icon-button',
      type: 'button',
      'aria-label': label,
    }, [icon(iconName)])),
  ]);
};

/** fusionSearchboxRenderer → yt-searchbox with form, input, submit and mic. */
RENDERERS.fusionSearchboxRenderer = function fusionSearchboxRenderer(data) {
  const query = typeof data.searchQuery === 'string' ? data.searchQuery : '';
  const placeholder = runText(data.placeholderText) || ID.searchPlaceholder;

  const input = el('input', {
    class: 'searchbox-input',
    type: 'text',
    'aria-label': A11Y.search,
    placeholder: placeholder,
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: 'false',
    value: query,
  });

  const form = el('form', { class: 'searchbox-form', role: 'search', novalidate: 'novalidate' }, [
    input,
    el('button', { class: 'searchbox-submit', type: 'submit', 'aria-label': A11Y.searchSubmit }, [icon('search')]),
  ]);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const q = input.value.trim();
    if (q) navigate(`/results?search_query=${encodeURIComponent(q)}`);
    else navigate('/');
  });

  return el('yt-searchbox', {}, [
    form,
    el('button', {
      class: 'searchbox-mic',
      type: 'button',
      'aria-label': A11Y.searchWithVoice,
      disabled: 'disabled',
    }, [icon('mic')]),
  ]);
};

/** a11ySkipNavigationButtonRenderer → the skip link. */
RENDERERS.a11ySkipNavigationButtonRenderer = function a11ySkipNavigationButtonRenderer(data) {
  const targetId = typeof data.targetId === 'string' ? data.targetId : 'feed';
  return el('a', {
    class: 'skip-link',
    href: `#${targetId}`,
    'aria-label': A11Y.skipNavigation,
    text: ID.tabs.home === 'Beranda' ? 'Lewati navigasi' : 'Skip navigation',
  });
};

/** desktopTopbarRenderer → the complete masthead. */
RENDERERS.desktopTopbarRenderer = function desktopTopbarRenderer(data) {
  const out = el('ytd-masthead-content', {}, []);

  const guide = el('ytd-topbar-menu-button-renderer', {}, [
    tooltip(A11Y.guide, el('button', {
      id: 'guide-button',
      class: 'icon-button',
      type: 'button',
      'aria-label': A11Y.guide,
      'aria-expanded': 'true',
      'aria-controls': 'guide',
    }, [icon('menu')])),
  ]);

  const logo = el('div', { class: 'masthead-start' }, []);
  logo.append(guide, renderNode(data.logo) || '');

  const search = el('div', { class: 'masthead-center' }, [renderNode(data.searchbox) || '']);

  const end = el('div', { class: 'masthead-end' }, []);
  end.append(
    el('button', { class: 'signin-button', type: 'button', 'aria-label': A11Y.signIn, text: ID.signIn }),
  );
  for (const button of Array.isArray(data.topbarButtons) ? data.topbarButtons : []) {
    const node = renderNode(button);
    if (node) end.append(node);
  }
  const country = typeof data.countryCode === 'string' && data.countryCode ? data.countryCode : A11Y.country;
  end.append(
    tooltip(country, el('button', {
      id: 'country-button',
      class: 'country-button',
      type: 'button',
      'aria-label': country,
      text: country,
    })),
  );

  out.append(el('div', { class: 'masthead' }, [logo, search, end]));
  return out;
};

/* ------------------------------------------------------------------ *
 * Chrome rendering
 * ------------------------------------------------------------------ */

function mountTopbar(payload) {
  const rendered = renderNode(payload && payload.topbar ? payload.topbar : payload);
  const header = document.querySelector('#masthead');
  const host = document.querySelector('ytd-masthead');
  const shell = rendered && rendered.nodeType === 1 ? rendered.firstElementChild : null;

  if (shell) {
    header.replaceChildren(...shell.childNodes);
    header.className = shell.className;
  }

  const skipPayload = payload && payload.topbar && payload.topbar.desktopTopbarRenderer
    ? payload.topbar.desktopTopbarRenderer.a11ySkipNavigationButton
    : payload && payload.desktopTopbarRenderer && payload.desktopTopbarRenderer.a11ySkipNavigationButton;
  if (skipPayload) {
    const skip = renderNode(skipPayload);
    const existing = document.querySelector('.skip-link');
    if (skip && existing) existing.replaceWith(skip);
  }

  const guideButton = document.querySelector('#guide-button');
  if (guideButton) {
    guideButton.addEventListener('click', toggleGuide);
  }
  const settingsButton = document.querySelector('#settings-button, #masthead .icon-button[aria-label="Settings"]');
  if (settingsButton) settingsButton.addEventListener('click', toggleTheme);
  const signIn = document.querySelector('#signin-button, #masthead .signin-button');
  if (signIn) signIn.addEventListener('click', () => navigate('/feed/you'));
  if (host) host.dataset.hydrated = 'true';
}

function mountGuide() {
  const nav = document.querySelector('#mini-guide');
  if (!nav) return;
  const current = routeName();
  const path = normalisePath(currentPath());
  nav.replaceChildren(
    ...GUIDE_ENTRIES.map((entry) => {
      const href = safeUrl(entry.href) || '/';
      const target = normalisePath(new URL(href, location.href).pathname);
      const isCurrent = target === '/' ? current === 'feed' : path.startsWith(target);
      return el('ytd-mini-guide-entry-renderer', {}, [
        el('a', {
          class: 'mini-guide-entry',
          href,
          'aria-label': entry.aria,
          'aria-current': isCurrent ? 'page' : undefined,
        }, [icon(entry.icon), el('span', { class: 'mini-guide-label', text: entry.label })]),
      ]);
    }),
  );
}

function toggleGuide() {
  const app = document.querySelector('ytd-app');
  if (!app) return;
  const collapsed = app.classList.toggle('guide-collapsed');
  const button = document.querySelector('#guide-button');
  if (button) button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function toggleTheme() {
  const html = document.documentElement;
  const dark = html.getAttribute('dark') !== null;
  if (dark) {
    html.removeAttribute('dark');
    html.removeAttribute('data-theme');
  } else {
    html.setAttribute('dark', '');
    html.setAttribute('data-theme', 'dark');
  }
}

/* ------------------------------------------------------------------ *
 * Data loading
 * ------------------------------------------------------------------ */

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  return res.json();
}

/** /api/browse → seed.json → empty state. Seed exists so the UI works with no backend. */
async function loadFeed() {
  const isSearch = routeName() === 'results';
  // currentSearch(), not location.search: when pushState is rejected (file://)
  // the query lives only in syntheticRoute.
  const query = new URLSearchParams(currentSearch()).get('search_query') || '';
  const primary = isSearch
    ? `/api/search?q=${encodeURIComponent(query)}&limit=24`
    : '/api/browse?limit=24';
  try {
    const data = await getJson(primary);
    return { data, source: primary };
  } catch (err) {
    try {
      const seed = await getJson('seed.json');
      if (isSearch) filterSeed(seed, query);
      return { data: seed, source: 'seed.json' };
    } catch {
      return { data: null, source: 'empty', error: String(err && err.message) };
    }
  }
}

/** Narrow the seed fixture to a query so /results stays verifiable offline. */
function filterSeed(seed, query) {
  const needle = query.toLowerCase();
  const twoColumn = findNode(seed, 'twoColumnBrowseResultsRenderer');
  const tabSection = twoColumn && Array.isArray(twoColumn.tabs) && twoColumn.tabs[0]
    ? findNode(twoColumn.tabs[0], 'richSectionRenderer')
    : undefined;
  if (!tabSection || !Array.isArray(tabSection.content)) return;
  tabSection.content = tabSection.content.filter((item) =>
    JSON.stringify(item).toLowerCase().includes(needle),
  );
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

async function renderFeedRoute() {
  const host = document.querySelector('#feed');
  if (!host) return;
  const { data, source, error } = await loadFeed();
  if (!data) {
    const nudge = renderNode(EMPTY_FEED);
    host.replaceChildren(nudge);
    host.dataset.source = 'empty';
    if (error) host.dataset.error = error;
    return;
  }

  // findNode returns the renderer's *value*, so re-key it before dispatching —
  // renderNode dispatches on the key name.
  const browse = findNode(data.contents || data, 'twoColumnBrowseResultsRenderer');
  // The tab bar ships either beside `contents` or inside the browse renderer
  // (renderer.ts puts it wherever the route composes the object), so locate it
  // anywhere and hand it to the factory.
  const tabHeader = findNode(data, 'feedTabbedHeaderRenderer');
  if (browse && tabHeader && !browse.header) browse.header = { feedTabbedHeaderRenderer: tabHeader };
  const node = browse
    ? renderNode({ twoColumnBrowseResultsRenderer: browse })
    : renderNode(data.contents || data);

  host.replaceChildren(node || renderNode(EMPTY_FEED));
  host.dataset.source = source;
}

async function renderWatchRoute(videoId) {
  const host = document.querySelector('#feed');
  if (!host) return;
  if (!videoId) {
    host.replaceChildren(el('p', { class: 'notice', text: 'Video tidak ditemukan.' }));
    return;
  }

  let payload = null;
  try {
    payload = await getJson(`/api/video/${encodeURIComponent(videoId)}`);
  } catch {
    try {
      const seed = await getJson('seed.json');
      const watch = seed && seed.watch;
      if (watch && watch.videoDetails && watch.videoDetails.videoId === videoId) payload = watch;
    } catch {
      payload = null;
    }
  }
  if (!payload) {
    host.replaceChildren(
      el('p', { class: 'notice', text: `Video "${videoId}" tidak dapat dimuat.` }),
    );
    return;
  }

  host.replaceChildren(watchPage(payload));
  host.dataset.source = 'watch';
}

function watchPage(payload) {
  const details = payload.videoDetails || {};
  const manifest =
    (payload.streamingData && Array.isArray(payload.streamingData.manifests)
      ? payload.streamingData.manifests[0]
      : null) || {};
  const manifestUrl = safeUrl(manifest.url);

  const video = el('video', {
    controls: 'controls',
    playsinline: 'playsinline',
    preload: 'metadata',
    'aria-label': runText(details.title) || 'Player',
  });

  const author = runText(details.author);
  const channelId = typeof details.channelId === 'string' ? details.channelId : '';
  const description = runText(details.shortDescription);
  const published = payload.microformat && payload.microformat.playerMicroformatRenderer
    ? payload.microformat.playerMicroformatRenderer.publishDate
    : '';

  const avatar = el('ytd-thumbnail', { id: 'avatar', class: 'is-placeholder' }, []);
  const primary = el('ytd-video-primary-info-renderer', {}, [
    el('h1', { class: 'watch-title' }, [
      el('yt-formatted-string', { text: runText(details.title) || 'Video' }),
    ]),
    published ? el('yt-formatted-string', { class: 'metadata-line', text: String(published) }) : null,
  ]);

  const owner = el('ytd-video-owner-renderer', {}, [
    el('a', {
      class: 'avatar-link',
      href: `/channel/${encodeURIComponent(author || channelId)}?id=${encodeURIComponent(channelId)}`,
      tabindex: '-1',
    }, [avatar]),
    el('a', { class: 'channel-name', href: `/channel/${encodeURIComponent(author || channelId)}?id=${encodeURIComponent(channelId)}` }, [
      el('yt-formatted-string', { text: author }),
    ]),
    el('button', { class: 'report-button', type: 'button', 'aria-label': A11Y.report, text: 'Laporkan' }),
    el('span', { class: 'report-status', role: 'status', 'aria-live': 'polite' }),
  ]);

  const status = owner.querySelector('.report-status');
  const reportButton = owner.querySelector('.report-button');
  reportButton.addEventListener('click', async () => {
    reportButton.disabled = true;
    status.textContent = 'Mengirim laporan…';
    try {
      const res = await fetch('/api/report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ videoId: details.videoId, reason: 'other', detail: '' }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // A report is only recorded. Hiding needs a 3-reporter quorum, then a
      // 7-day hold an operator confirms — so do not promise review is underway.
      status.textContent = 'Laporan tercatat. Laporan ditinjau oleh operator.';
    } catch {
      status.textContent = 'Laporan gagal terkirim.';
      reportButton.disabled = false;
    }
  });

  const page = el('ytd-watch-flexy', {}, [
    el('div', {}, [
      el('div', { class: 'player-shell' }, [video]),
      primary,
      owner,
      description ? el('p', { class: 'watch-description', text: description }) : null,
    ]),
  ]);

  if (manifestUrl) attachPlayer(video, manifestUrl);
  return page;
}

/** hls.js from CDN, native <video> fallback when Hls.isSupported() is false. */
async function attachPlayer(video, url) {
  if (video.canPlayType('application/vnd.apple.mpegurl') && !window.MediaSource) {
    video.src = url;
    return;
  }
  try {
    const Hls = await loadHls();
    if (Hls && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true });
      hls.loadSource(url);
      hls.attachMedia(video);
      return;
    }
  } catch (err) {
    window.__renderErrors.push({ renderer: 'hls', message: String(err && err.message) });
  }
  if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = url;
}

let hlsPromise = null;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (!hlsPromise) {
    hlsPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = HLS_CDN;
      script.async = true;
      script.crossOrigin = 'anonymous';
      script.integrity = HLS_INTEGRITY;
      script.addEventListener('load', () =>
        window.Hls ? resolve(window.Hls) : reject(new Error('hls.js did not define window.Hls')),
      );
      script.addEventListener('error', () => reject(new Error('hls.js CDN unreachable')));
      document.head.append(script);
    }).catch((err) => {
      hlsPromise = null;
      throw err;
    });
  }
  return hlsPromise;
}

async function renderChannelRoute(agentId, slug) {
  const host = document.querySelector('#feed');
  if (!host) return;
  if (!agentId) {
    host.replaceChildren(el('p', { class: 'notice', text: 'Kanal tidak ditemukan.' }));
    return;
  }

  let profile = null;
  try {
    profile = await getJson(`/api/profile/${encodeURIComponent(agentId)}`);
  } catch {
    try {
      const seed = await getJson('seed.json');
      if (seed && seed.profile && seed.profile.agentId === agentId) profile = seed.profile;
    } catch {
      profile = null;
    }
  }
  if (!profile) {
    host.replaceChildren(el('p', { class: 'notice', text: `Profil "${agentId}" tidak dapat dimuat.` }));
    return;
  }

  const displayName = typeof profile.displayName === 'string' ? profile.displayName : slug || agentId;
  const avatar = el('ytd-thumbnail', { id: 'avatar', class: 'is-placeholder' }, []);
  // `GET /api/profile/{agentId}` returns `avatar` as a plain URL string
  // (contract §4.1); wrap it in the thumbnail payload the factory understands.
  const avatarValue =
    typeof profile.avatar === 'string' ? { thumbnails: [{ url: profile.avatar }] } : profile.avatar;
  const avatarNode = renderThumbnail(avatarValue);
  if (avatarNode && avatarNode.nodeType === 1) {
    avatar.replaceChildren(...avatarNode.childNodes);
    avatar.classList.remove('is-placeholder');
  }

  const header = el('div', { class: 'channel-header' }, [
    avatar,
    el('div', {}, [
      el('h1', { class: 'channel-name', text: displayName }),
      profile.description
        ? el('p', { class: 'channel-description', text: String(profile.description) })
        : null,
    ]),
  ]);

  const videos = Array.isArray(profile.videos) ? profile.videos : [];
  const grid = renderNode({ richGridRenderer: { contents: videos, itemCount: videos.length } });
  host.replaceChildren(header, grid || renderNode(EMPTY_FEED));
  host.dataset.source = 'profile';
}

/* ------------------------------------------------------------------ *
 * Router (history API, degrades to in-memory on file://)
 * ------------------------------------------------------------------ */

/**
 * Normalise a pathname for route matching.
 *
 * On a file: origin the URL parser resolves `/watch` to `/G:/watch`, because the
 * drive letter is just a path segment there — comparing against `/watch`
 * directly would silently fall through to the feed.
 */
function normalisePath(raw) {
  let p = String(raw || '/').replace(/\\/g, '/');
  p = p.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '');
  p = p.replace(/^\/[a-z]:\//i, '/');
  p = p.replace(/\/index\.html$/i, '/');
  p = p.replace(/\/+$/, '');
  return p || '/';
}

let syntheticRoute = null;

function currentPath() {
  if (syntheticRoute !== null) return syntheticRoute.path;
  return location.pathname || '/';
}

function currentSearch() {
  if (syntheticRoute !== null) return syntheticRoute.search;
  return location.search || '';
}

function routeName() {
  const path = normalisePath(currentPath());
  if (path === '/watch') return 'watch';
  if (path.startsWith('/channel/')) return 'channel';
  if (path === '/results') return 'results';
  return 'feed';
}

function navigate(href) {
  const target = new URL(href, location.href);
  const next = { path: target.pathname, search: target.search };
  try {
    history.pushState(next, '', target.pathname + target.search);
    syntheticRoute = null;
  } catch {
    // file:// and other opaque origins reject pushState — keep rendering.
    syntheticRoute = next;
  }
  renderRoute();
}

function parseRoute() {
  const path = normalisePath(currentPath());
  const params = new URLSearchParams(currentSearch());
  if (path === '/watch') return { name: 'watch', videoId: params.get('v') || '' };
  if (path.startsWith('/channel/')) {
    return { name: 'channel', agentId: params.get('id') || '', slug: decodeURIComponent(path.slice('/channel/'.length)) };
  }
  if (path === '/results') return { name: 'results', query: params.get('search_query') || '' };
  return { name: 'feed' };
}

async function renderRoute() {
  const route = parseRoute();
  const host = document.querySelector('#feed');
  if (host) host.dataset.route = route.name;
  mountGuide();
  document.title = route.name === 'watch' ? 'Sloptube' : ID.logo;

  if (route.name === 'watch') return renderWatchRoute(route.videoId);
  if (route.name === 'channel') return renderChannelRoute(route.agentId, route.slug);
  return renderFeedRoute();
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

function onDocumentClick(event) {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
  const link = event.target.closest && event.target.closest('a[href]');
  if (!link || link.target === '_blank' || link.hasAttribute('download')) return;
  const href = link.getAttribute('href');
  if (!href || href.startsWith('#') || /^[a-z]+:/i.test(href)) return;
  const target = new URL(href, location.href);
  if (target.origin !== location.origin) return;
  event.preventDefault();
  navigate(target.pathname + target.search);
}

async function boot() {
  // 1. chrome: masthead from the payload's desktopTopbarRenderer (contract shape)
  const chrome = { payload: DEFAULT_TOPBAR, seed: null };
  try {
    const seed = await getJson('seed.json');
    chrome.seed = seed;
    const topbar = findNode(seed, 'desktopTopbarRenderer');
    if (topbar) chrome.payload = { topbar: { desktopTopbarRenderer: topbar } };
  } catch {
    /* no fixture — DEFAULT_TOPBAR still carries every accessible name */
  }
  mountTopbar(chrome.payload);
  mountGuide();

  // 2. routes
  window.addEventListener('popstate', () => {
    syntheticRoute = null;
    renderRoute();
  });
  document.addEventListener('click', onDocumentClick);
  await renderRoute();
}

boot();

/* Test hooks: the browser ignores these; the Node render test drives the same
 * functions through a DOM shim, so what is asserted is what ships. */
export { renderNode, el, safeUrl, runText, filterSeed, parseRoute, RENDERERS };