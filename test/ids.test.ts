import { describe, expect, it } from 'vitest';
import { newId, parseJsonArray, parseJsonObject, cleanDisplayName, cleanTag, cleanTags, cleanText, now } from '../src/worker/lib/ids.js';

describe('newId', () => {
  it('prefixes a 12-character lowercase base32 id', () => {
    const id = newId('vid');
    expect(id).toMatch(/^vid_[a-z2-7]{12}$/);
  });

  it('is url-safe and never collides in a small batch', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newId('vid')));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).not.toMatch(/[^A-Za-z0-9_]/);
  });

  it('uses the prefix verbatim', () => {
    expect(newId('agt').startsWith('agt_')).toBe(true);
  });
});

describe('now', () => {
  it('is a plausible unix-ms timestamp', () => {
    const t = now();
    expect(Number.isInteger(t)).toBe(true);
    expect(t).toBeGreaterThan(1_600_000_000_000);
  });
});

describe('cleanText', () => {
  it('keeps ordinary text unchanged', () => {
    expect(cleanText('Halo dunia', 100)).toBe('Halo dunia');
  });

  it('trims surrounding whitespace', () => {
    expect(cleanText('   spaced out   ', 100)).toBe('spaced out');
  });

  it('returns the fallback when the value is too short', () => {
    expect(cleanText('   ', 100, 'fallback')).toBe('fallback');
    expect(cleanText('', 100, 'fallback')).toBe('fallback');
  });

  it('returns the fallback for non-string input', () => {
    expect(cleanText(undefined, 100, 'x')).toBe('x');
    expect(cleanText(null, 100, 'x')).toBe('x');
    expect(cleanText(42, 100, 'x')).toBe('x');
    expect(cleanText({ toString: () => 'evil' }, 100, 'x')).toBe('x');
    expect(cleanText(['a'], 100, 'x')).toBe('x');
  });

  it('defaults the fallback to the empty string', () => {
    expect(cleanText(null, 100)).toBe('');
  });

  it('truncates to the requested maximum', () => {
    expect(cleanText('abcdefghij', 4)).toBe('abcd');
    expect(cleanText('abcdefghij', 0)).toBe('');
  });

  it('strips control characters', () => {
    expect(cleanText('a\u0000b\u001Fc\u007Fd', 100)).toBe('abcd');
    expect(cleanText('line\nbreak\ttab', 100)).toBe('linebreaktab');
  });

  it('preserves newlines? no — it removes them, so a title cannot smuggle layout', () => {
    const title = 'a'.repeat(10) + '\n\n' + 'b'.repeat(10);
    expect(cleanText(title, 100)).not.toContain('\n');
  });
});

describe('cleanTag', () => {
  it('lowercases and keeps the allowed separators', () => {
    expect(cleanTag('Music')).toBe('music');
    expect(cleanTag('Lo-Fi')).toBe('lo-fi');
    expect(cleanTag('a_b-c')).toBe('a_b-c');
  });

  it('drops spaces and every other disallowed character', () => {
    expect(cleanTag('tag with spaces')).toBe('tagwithspaces');
    expect(cleanTag('a/b')).toBe('ab');
  });

  it('strips anything outside [a-z0-9_-]', () => {
    expect(cleanTag('<script>')).toBe('script');
    expect(cleanTag('emoji🎵')).toBe('emoji');
    expect(cleanTag('../../etc/passwd')).toBe('etcpasswd');
  });

  it('bounds the length to 32', () => {
    expect(cleanTag('a'.repeat(100))).toHaveLength(32);
  });

  it('returns the empty string for unusable input', () => {
    expect(cleanTag('')).toBe('');
    expect(cleanTag(null)).toBe('');
    expect(cleanTag('!!!')).toBe('');
    expect(cleanTag('💥')).toBe('');
  });
});

describe('cleanTags', () => {
  it('accepts an array and normalises each entry', () => {
    expect(cleanTags(['Music', 'lo-fi', 'Rock'])).toEqual(['music', 'lo-fi', 'rock']);
  });

  it('accepts a comma-separated string', () => {
    expect(cleanTags('music,rock , jazz')).toEqual(['music', 'rock', 'jazz']);
  });

  it('drops duplicates after normalisation', () => {
    expect(cleanTags(['Music', 'music', 'MUSIC'])).toEqual(['music']);
  });

  it('drops entries that normalise to nothing', () => {
    expect(cleanTags(['ok', '!!!', '💥', 'fine'])).toEqual(['ok', 'fine']);
  });

  it('caps the list length', () => {
    const many = Array.from({ length: 50 }, (_, i) => `tag${i}`);
    expect(cleanTags(many)).toHaveLength(10);
    expect(cleanTags(many, 3)).toHaveLength(3);
  });

  it('returns an empty list for unusable input', () => {
    expect(cleanTags(undefined)).toEqual([]);
    expect(cleanTags(null)).toEqual([]);
    expect(cleanTags(42)).toEqual([]);
    expect(cleanTags({})).toEqual([]);
  });

  it('neutralises an injection attempt', () => {
    const hostile = ['"><script>alert(1)</script>', "' OR 1=1--"];
    const tags = cleanTags(hostile);
    expect(tags).toEqual(['scriptalert1script', 'or11--'].map((t) => cleanTag(t)));
    for (const tag of tags) {
      expect(tag).not.toMatch(/[<>"'()]/);
      expect(tag).toMatch(/^[a-z0-9_-]*$/);
    }
  });
});

describe('cleanDisplayName', () => {
  it('slugs a normal name', () => {
    expect(cleanDisplayName('Slop Tube')).toBe('slop-tube');
    expect(cleanDisplayName('Agent_Smith-01')).toBe('agent_smith-01');
  });

  it('collapses runs of separators', () => {
    expect(cleanDisplayName('a    b')).toBe('a-b');
    expect(cleanDisplayName('a---b')).toBe('a-b');
  });

  it('trims leading and trailing dashes', () => {
    expect(cleanDisplayName('-lead')).toBe('lead');
    expect(cleanDisplayName('trail-')).toBe('trail');
  });

  it('bounds the length to 40 characters', () => {
    expect(cleanDisplayName('a'.repeat(80))).toHaveLength(40);
  });

  it('rejects a name shorter than two characters', () => {
    expect(() => cleanDisplayName('a')).toThrow();
    expect(() => cleanDisplayName('')).toThrow();
    expect(() => cleanDisplayName('   ')).toThrow();
    expect(() => cleanDisplayName('!!!')).toThrow();
  });

  it('throws an HttpError with status 400 and a stable code', () => {
    try {
      cleanDisplayName('a');
      throw new Error('expected cleanDisplayName to throw');
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: 'invalid_display_name' });
    }
  });

  it('strips path traversal so the name is safe as a URL segment', () => {
    const slug = cleanDisplayName('../../etc/passwd');
    expect(slug).toBe('etcpasswd');
    expect(slug).not.toContain('/');
    expect(slug).not.toContain('..');
  });

  it('strips markup from an injection attempt', () => {
    const slug = cleanDisplayName('<b>Bold</b> Name');
    // Only characters outside [a-z0-9 _-] are dropped, so the letter b that
    // surrounded the markup survives; what matters is that no markup does.
    expect(slug).toBe('bboldb-name');
    expect(slug).not.toMatch(/[<>&/]/);
  });

  it('accepts exactly two characters at the lower bound', () => {
    expect(cleanDisplayName('ab')).toBe('ab');
  });
});

describe('parseJsonArray', () => {
  it('parses a string array', () => {
    expect(parseJsonArray('["a","b"]')).toEqual(['a', 'b']);
  });

  it('filters out non-strings', () => {
    expect(parseJsonArray('["a",1,null,{"x":1},"b"]')).toEqual(['a', 'b']);
  });

  it('returns an empty array for invalid or non-array JSON', () => {
    expect(parseJsonArray('{"a":1}')).toEqual([]);
    expect(parseJsonArray('broken')).toEqual([]);
    expect(parseJsonArray('')).toEqual([]);
  });
});

describe('parseJsonObject', () => {
  it('parses a string-valued object', () => {
    expect(parseJsonObject('{"site":"https://a.example"}')).toEqual({
      site: 'https://a.example',
    });
  });

  it('drops non-string values', () => {
    expect(parseJsonObject('{"a":"1","b":2,"c":null}')).toEqual({ a: '1' });
  });

  it('rejects arrays', () => {
    expect(parseJsonObject('["a"]')).toEqual({});
  });

  it('returns an empty object for invalid JSON', () => {
    expect(parseJsonObject('nope')).toEqual({});
    expect(parseJsonObject('null')).toEqual({});
  });
});