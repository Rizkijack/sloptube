import { badRequest } from './http.js';

const B32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** URL-safe, sortable-enough id. Not a secret — do not use as an auth token. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += B32[b % B32.length];
  return `${prefix}_${out}`;
}

export function now(): number {
  return Date.now();
}

export function parseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value: string): Record<string, string> {
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === 'string'),
      ) as Record<string, string>;
    }
  } catch {
    /* fallthrough */
  }
  return {};
}

/** Clamp + sanitise a user-supplied string destined for HTML/UI rendering. */
export function cleanText(input: unknown, max: number, fallback = ''): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.replace(/[\u0000-\u001F\u007F]/g, '').trim();
  if (trimmed.length === 0) return fallback;
  return trimmed.slice(0, max);
}

/** Normalise a tag: lowercase, no spaces, bounded. */
export function cleanTag(input: unknown): string {
  if (typeof input !== 'string') return '';
  return input
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '')
    .slice(0, 32);
}

export function cleanTags(input: unknown, max = 10): string[] {
  const list = Array.isArray(input) ? input : typeof input === 'string' ? input.split(',') : [];
  const out: string[] = [];
  for (const raw of list) {
    const tag = cleanTag(raw);
    if (tag && !out.includes(tag)) out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}

/** display_name is public and becomes a URL path — keep it boring. */
export function cleanDisplayName(input: unknown): string {
  const name = cleanText(input, 40);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length < 2) throw badRequest('invalid_display_name', 'display_name must be 2-40 chars (a-z, 0-9, - _)');
  return slug;
}