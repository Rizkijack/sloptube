/**
 * A DOM small enough to run `ui/app.js` in Node.
 *
 * Deliberately not a full implementation: it supports exactly the surface the
 * app uses (createElement / createElementNS / text nodes / append / attributes /
 * classList / a minimal querySelector). Anything the app does not touch is
 * absent, so the test fails loudly rather than silently passing on a stub.
 */

export class ShimNode {
  readonly nodeType: number;
  readonly nodeName: string;
  parent: ShimNode | null = null;
  children: ShimNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  className = '';
  id = '';
  title = '';
  value = '';
  listeners = new Map<string, Array<(ev: unknown) => void>>();
  /**
   * Real `dataset` is a live proxy onto `data-*` attributes. Mirroring that
   * matters: app.js sets `dataset.hydrated` and the test reads it back through
   * `getAttribute`, so a plain object would silently break the assertion.
   */
  dataset: Record<string, string>;
  private text = '';

  constructor(tag: string, nodeType = 1) {
    this.nodeType = nodeType;
    this.nodeName = nodeType === 1 ? tag.toUpperCase() : '#text';
    this.dataset = new Proxy({} as Record<string, string>, {
      get: (_t, prop: string) => {
        const attr = 'data-' + prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        return this.attributes.get(attr) ?? undefined;
      },
      set: (_t, prop: string, value: unknown) => {
        const attr = 'data-' + prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        this.attributes.set(attr, String(value));
        return true;
      },
      has: (_t, prop: string) => {
        const attr = 'data-' + prop.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
        return this.attributes.has(attr);
      },
    });
  }

  get tagName(): string {
    return this.nodeName;
  }

  get classList() {
    const self = this;
    return {
      add(...names: string[]) {
        const set = new Set(self.className.split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        self.className = [...set].join(' ');
        self.attributes.set('class', self.className);
      },
      contains(name: string) {
        return self.className.split(/\s+/).includes(name);
      },
      remove(name: string) {
        self.className = self.className
          .split(/\s+/)
          .filter((c) => c && c !== name)
          .join(' ');
      },
    };
  }

  set textContent(value: string) {
    this.text = String(value);
    this.children = [];
  }

  get textContent(): string {
    if (this.nodeType === 3) return this.text;
    return this.text + this.children.map((c) => c.textContent).join('');
  }

  setAttribute(name: string, value: unknown) {
    const v = value === true ? '' : String(value);
    this.attributes.set(name, v);
    if (name === 'id') this.id = v;
    if (name === 'class') this.className = v;
    if (name === 'title') this.title = v;
    if (name.startsWith('data-')) {
      this.attributes.set(name, v);
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string) {
    this.attributes.delete(name);
  }

  append(...items: unknown[]) {
    for (const item of items) {
      const node = item instanceof ShimNode ? item : new ShimNode(String(item), 3);
      node.parent = this;
      this.children.push(node);
    }
  }

  appendChild(item: ShimNode) {
    this.append(item);
    return item;
  }

  replaceChildren(...items: unknown[]) {
    this.children = [];
    this.append(...items);
  }

  remove() {
    if (!this.parent) return;
    this.parent.children = this.parent.children.filter((c) => c !== this);
    this.parent = null;
  }

  replaceWith(...items: unknown[]) {
    const parent = this.parent;
    if (!parent) return;
    const index = parent.children.indexOf(this);
    const replacement: ShimNode[] = [];
    for (const item of items) {
      replacement.push(item instanceof ShimNode ? item : new ShimNode(String(item), 3));
    }
    for (const node of replacement) node.parent = parent;
    parent.children.splice(index, 1, ...replacement);
    this.parent = null;
  }

  get nextSibling(): ShimNode | null {
    const parent = this.parent;
    if (!parent) return null;
    const index = parent.children.indexOf(this);
    return parent.children[index + 1] ?? null;
  }

  get childNodes(): ShimNode[] {
    return this.children;
  }

  get lastChild(): ShimNode | null {
    return this.children[this.children.length - 1] ?? null;
  }

  addEventListener(type: string, fn: (ev: unknown) => void) {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  removeEventListener() {
    /* no-op */
  }

  /** Supports `#id`, `tag`, `.class` and comma-separated lists of those. */
  querySelector(selector: string): ShimNode | null {
    for (const part of selector.split(',').map((s) => s.trim())) {
      const hit = this.search(part);
      if (hit) return hit;
    }
    return null;
  }

  querySelectorAll(selector: string): ShimNode[] {
    const out: ShimNode[] = [];
    for (const part of selector.split(',').map((s) => s.trim())) {
      this.walk((n) => {
        if (matches(n, part)) out.push(n);
      });
    }
    return out;
  }

  get firstChild(): ShimNode | null {
    return this.children[0] ?? null;
  }

  get firstElementChild(): ShimNode | null {
    return this.children.find((c) => c.nodeType === 1) ?? null;
  }

  get lastElementChild(): ShimNode | null {
    return [...this.children].reverse().find((c) => c.nodeType === 1) ?? null;
  }

  closest(selector: string): ShimNode | null {
    let node: ShimNode | null = this;
    while (node) {
      if (matches(node, selector)) return node;
      node = node.parent;
    }
    return null;
  }

  set innerHTML(_value: string) {
    throw new Error('innerHTML is not supported — the UI must not use it');
  }

  private search(selector: string): ShimNode | null {
    let found: ShimNode | null = null;
    this.walk((n) => {
      if (!found && matches(n, selector)) found = n;
    });
    return found;
  }

  walk(visit: (n: ShimNode) => void) {
    visit(this);
    for (const child of this.children) child.walk(visit);
  }
}

function matches(node: ShimNode, selector: string): boolean {
  if (node.nodeType !== 1) return false;
  if (selector.startsWith('#')) return node.id === selector.slice(1);
  if (selector.startsWith('.')) return node.className.split(/\s+/).includes(selector.slice(1));
  return node.nodeName === selector.toUpperCase();
}

class ShimText extends ShimNode {
  constructor(value: string) {
    super('#text', 3);
    this.textContent = value;
  }
}

class ShimFragment extends ShimNode {
  constructor() {
    super('#fragment', 11);
  }
}

export interface ShimGlobal {
  document: ShimNode & {
    createElement: (tag: string) => ShimNode;
    createElementNS: (ns: string, tag: string) => ShimNode;
    createTextNode: (value: string) => ShimNode;
    createDocumentFragment: () => ShimNode;
    body: ShimNode;
    head: ShimNode;
    documentElement: ShimNode;
    title: string;
  };
  window: ShimNode;
}

/** Install the shim on globalThis and return the document for traversal. */
export function installDom(): ShimGlobal {
  const body = new ShimNode('body');
  const head = new ShimNode('head');
  const documentElement = new ShimNode('html');

  /**
   * Mirrors ui/index.html exactly. app.js hydrates into these hosts by id and
   * tag name, so a shim that omits them would silently skip every mount.
   */
  const mkEl = (tag: string, id?: string, cls?: string) => {
    const n = new ShimNode(tag);
    if (id) n.setAttribute('id', id);
    if (cls) n.setAttribute('class', cls);
    return n;
  };

  const masthead = mkEl('header', 'masthead', 'masthead');
  const mastheadStart = mkEl('div', undefined, 'masthead-start');
  const guideButton = mkEl('button', 'guide-button', 'icon-button');
  guideButton.setAttribute('aria-label', 'Guide');
  const menuBtnRenderer = mkEl('ytd-topbar-menu-button-renderer');
  const guideTooltip = mkEl('tp-yt-paper-tooltip');
  guideTooltip.append(guideButton, mkEl('span', undefined, 'tooltip-label'));
  menuBtnRenderer.append(guideTooltip);
  mastheadStart.append(menuBtnRenderer);

  const topbarLogo = mkEl('ytd-topbar-logo-renderer', 'topbar-logo-slot');

  const mastheadCenter = mkEl('div', undefined, 'masthead-center');
  const searchbox = mkEl('yt-searchbox', 'topbar-search-slot');
  mastheadCenter.append(searchbox);

  const signIn = mkEl('button', 'signin-button', 'signin-button');
  signIn.setAttribute('aria-label', 'Sign in');
  const settingsButton = mkEl('button', 'settings-button', 'icon-button');
  settingsButton.setAttribute('aria-label', 'Settings');
  const countryButton = mkEl('button', 'country-button', 'country-button');
  countryButton.setAttribute('aria-label', 'ID');
  const settingsTooltip = mkEl('tp-yt-paper-tooltip');
  settingsTooltip.append(settingsButton);
  const mastheadEnd = mkEl('div', undefined, 'masthead-end');
  const topbarActions = mkEl('ytd-topbar-actions', 'topbar-actions-slot');
  topbarActions.append(signIn, settingsTooltip, countryButton);
  mastheadEnd.append(topbarActions);

  masthead.append(mastheadStart, topbarLogo, mastheadCenter, mastheadEnd);

  const ytdMasthead = mkEl('ytd-masthead');
  ytdMasthead.append(masthead);

  const miniGuide = mkEl('nav', 'mini-guide', 'mini-guide');
  const miniGuideRenderer = mkEl('ytd-mini-guide-renderer');
  miniGuideRenderer.append(miniGuide);
  const drawer = mkEl('tp-yt-app-drawer', 'guide');
  drawer.append(miniGuideRenderer);

  const feed = mkEl('div', 'feed', 'page-content');
  const browse = mkEl('ytd-browse');
  browse.append(feed);
  const pageManager = mkEl('ytd-page-manager');
  pageManager.append(browse);

  const app = mkEl('ytd-app');
  app.append(ytdMasthead, drawer, pageManager);

  const skipLink = mkEl('a', undefined, 'skip-link');
  skipLink.setAttribute('href', '#feed');
  skipLink.textContent = 'Lewati navigasi';

  body.append(skipLink, app);

  const doc = body as unknown as ShimGlobal['document'];
  doc.createElement = (tag: string) => new ShimNode(tag);
  doc.createElementNS = (_ns: string, tag: string) => new ShimNode(tag);
  doc.createTextNode = (value: string) => new ShimText(value);
  doc.createDocumentFragment = () => new ShimFragment();
  doc.body = body;
  doc.head = head;
  doc.documentElement = documentElement;
  doc.title = '';
  doc.setAttribute = body.setAttribute.bind(body);

  const win = new ShimNode('window') as ShimNode & Record<string, unknown>;
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  win.addEventListener = (type: string, fn: (ev: unknown) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  };
  win.removeEventListener = () => undefined;
  (win as unknown as { location: unknown }).location = {
    href: 'http://127.0.0.1:5173/',
    origin: 'http://127.0.0.1:5173',
    pathname: '/',
    search: '',
};

  const g = globalThis as unknown as Record<string, unknown>;
  g.document = doc;
  g.window = win;
  g.Node = ShimNode;
  g.location = (win as unknown as { location: unknown }).location;
  g.history = { pushState: () => undefined, replaceState: () => undefined };
  g.matchMedia = () => ({ matches: false, addEventListener: () => undefined });
  g.localStorage = {
    store: new Map<string, string>(),
    getItem(key: string) {
      return (this as { store: Map<string, string> }).store.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      (this as { store: Map<string, string> }).store.set(key, String(value));
    },
    removeItem(key: string) {
      (this as { store: Map<string, string> }).store.delete(key);
    },
  };
  // Every network call fails: this exercises the seed.json / empty-state path,
  // which is what a first-run visitor actually sees.
  g.fetch = async () => new Response('{}', { status: 503 });

  return { document: doc, window: win as unknown as ShimNode };
}

/**
 * Accessible names, computed the way a browser does it: aria-label wins, then
 * `title`, then the element's own text content for anything focusable or
 * interactive. Matching only aria-label would miss the skip link, whose name
 * comes from its visible text.
 */
export function accessibleNames(root: ShimNode): string[] {
  const NAMED_BY_TEXT = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'LABEL', 'H1', 'H2', 'H3', 'NAV']);
  const names: string[] = [];
  root.walk((node) => {
    if (node.nodeType !== 1) return;
    const label = node.getAttribute('aria-label');
    if (label) {
      names.push(label);
      return;
    }
    const title = node.getAttribute('title');
    if (title) {
      names.push(title);
      return;
    }
    if (node.getAttribute('aria-hidden') === 'true') return;
    if (NAMED_BY_TEXT.has(node.nodeName)) {
      const own = node.getAttribute('placeholder') ?? node.textContent.trim();
      if (own) names.push(own);
    }
  });
  return names;
}

export function allText(root: ShimNode): string {
  const parts: string[] = [];
  root.walk((node) => {
    if (node.nodeType === 1 && node.children.length === 0 && node.textContent.trim()) {
      parts.push(node.textContent.trim());
    }
  });
  return parts.join('\n');
}