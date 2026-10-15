import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PROTOCOL,
  channelUrl,
  feedTabbedHeader,
  formatDuration,
  formatRelative,
  mediaUrl,
  richGrid,
  richItem,
  simpleText,
  text,
  toView,
  twoColumn,
  videoRenderer,
  watchUrl,
} from '../src/worker/lib/renderer.js';
import type { Env, ProfileRow, VideoRow } from '../src/worker/lib/env.js';

const env = (base: string) => ({ R2_PUBLIC_BASE: base }) as Env;

const VIEW = {
  videoId: 'vid_1',
  title: 'A video',
  description: 'desc',
  durationS: 125,
  width: 1920,
  height: 1080,
  bytes: 1234,
  tags: ['a'],
  createdAt: 1_700_000_000_000,
  agentId: 'agt_1',
  authorName: 'someone',
  authorAvatarUrl: '',
};

describe('formatDuration', () => {
  it('formats under an hour as m:ss', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(9)).toBe('0:09');
    expect(formatDuration(59)).toBe('0:59');
    expect(formatDuration(60)).toBe('1:00');
    expect(formatDuration(125)).toBe('2:05');
    expect(formatDuration(599)).toBe('9:59');
    expect(formatDuration(3599)).toBe('59:59');
  });

  it('formats an hour or more as h:mm:ss', () => {
    expect(formatDuration(3600)).toBe('1:00:00');
    expect(formatDuration(3661)).toBe('1:01:01');
    expect(formatDuration(36000)).toBe('10:00:00');
  });

  it('truncates fractional seconds rather than rounding', () => {
    expect(formatDuration(59.9)).toBe('0:59');
    expect(formatDuration(125.7)).toBe('2:05');
  });

  it('clamps negatives to zero', () => {
    expect(formatDuration(-1)).toBe('0:00');
    expect(formatDuration(-3600)).toBe('0:00');
  });

  it('always yields at least one minute digit', () => {
    for (const s of [0, 5, 61, 3600, 86_400]) {
      expect(formatDuration(s).split(':').length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('formatRelative', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-15T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());

  const ago = (ms: number) => Date.now() - ms;
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;

  it('reports sub-minute ages as just now', () => {
    expect(formatRelative(Date.now())).toBe('baru saja');
    expect(formatRelative(ago(59_000))).toBe('baru saja');
  });

  it('reports minutes, hours, days', () => {
    expect(formatRelative(ago(MIN))).toBe('1 menit lalu');
    expect(formatRelative(ago(59 * MIN))).toBe('59 menit lalu');
    expect(formatRelative(ago(HOUR))).toBe('1 jam lalu');
    expect(formatRelative(ago(23 * HOUR))).toBe('23 jam lalu');
    expect(formatRelative(ago(DAY))).toBe('1 hari lalu');
    expect(formatRelative(ago(29 * DAY))).toBe('29 hari lalu');
  });

  it('reports months and years', () => {
    expect(formatRelative(ago(30 * DAY))).toBe('1 bulan lalu');
    expect(formatRelative(ago(330 * DAY))).toBe('11 bulan lalu');
    // The implementation rolls over at months === 12, so a full year reports
    // as one year rather than twelve months.
    expect(formatRelative(ago(360 * DAY))).toBe('1 tahun lalu');
    expect(formatRelative(ago(361 * DAY))).toBe('1 tahun lalu');
    expect(formatRelative(ago(800 * DAY))).toBe('2 tahun lalu');
  });

  it('clamps a future timestamp to "just now"', () => {
    expect(formatRelative(Date.now() + 10 * MIN)).toBe('baru saja');
  });
});

describe('mediaUrl', () => {
  it('uses R2_PUBLIC_BASE when configured', () => {
    expect(mediaUrl(env('https://cdn.example'), 'vid_1', 'hq.jpg')).toBe(
      'https://cdn.example/videos/vid_1/hq.jpg',
    );
  });

  it('strips a trailing slash from the base', () => {
    expect(mediaUrl(env('https://cdn.example/'), 'vid_1', 'master.m3u8')).toBe(
      'https://cdn.example/videos/vid_1/master.m3u8',
    );
  });

  it('falls back to the worker proxy when the base is empty', () => {
    expect(mediaUrl(env(''), 'vid_1', 'hq.jpg')).toBe('/media/videos/vid_1/hq.jpg');
  });

  it('matches the R2 layout in the contract', () => {
    const base = env('https://cdn.example');
    expect(mediaUrl(base, 'vid_1', 'init.mp4')).toBe('https://cdn.example/videos/vid_1/init.mp4');
    expect(mediaUrl(base, 'vid_1', 'seg_000003.m4s')).toBe(
      'https://cdn.example/videos/vid_1/seg_000003.m4s',
    );
  });
});

describe('watchUrl / channelUrl', () => {
  it('builds a watch url', () => {
    expect(watchUrl('vid_1')).toBe('/watch?v=vid_1');
  });

  it('encodes both parts of a channel url', () => {
    expect(channelUrl('agt_1', 'a b&c')).toBe('/channel/a%20b%26c?id=agt_1');
  });
});

describe('videoRenderer', () => {
  it('produces the ytInitialData-shaped card', () => {
    const r = videoRenderer(env('https://cdn.example'), VIEW) as Record<string, unknown>;
    expect(r.videoId).toBe('vid_1');
    expect(r.lengthSeconds).toBe('125');
    expect(r.isPlayable).toBe(true);
    expect((r.title as { runs: { text: string }[] }).runs[0]!.text).toBe('A video');
    expect((r.navigationEndpoint as { watchEndpoint: { videoId: string } }).watchEndpoint.videoId)
      .toBe('vid_1');
    expect((r.shortBylineText as { runs: { text: string }[] }).runs[0]!.text).toBe('someone');
  });

  it('offers four thumbnail widths all pointing at hq.jpg', () => {
    const r = videoRenderer(env('https://cdn.example'), VIEW) as {
      thumbnail: { thumbnails: { url: string; width: number }[] };
    };
    expect(r.thumbnail.thumbnails).toHaveLength(4);
    for (const t of r.thumbnail.thumbnails) {
      expect(t.url).toBe('https://cdn.example/videos/vid_1/hq.jpg');
    }
    expect(r.thumbnail.thumbnails.map((t) => t.width)).toEqual([336, 480, 640, 800]);
  });

  it('sets lengthText for a known duration and omits it otherwise', () => {
    const withDur = videoRenderer(env(''), VIEW) as Record<string, unknown>;
    expect((withDur.lengthText as { simpleText: string }).simpleText).toBe('2:05');

    const noDur = videoRenderer(env(''), { ...VIEW, durationS: 0 }) as Record<string, unknown>;
    expect(noDur.lengthText).toBeUndefined();
  });

  it('links the byline to the author channel', () => {
    const r = videoRenderer(env(''), VIEW) as {
      longBylineText: { runs: { navigationEndpoint: { browseEndpoint: Record<string, string> } }[] };
    };
    const endpoint = r.longBylineText.runs[0]!.navigationEndpoint.browseEndpoint;
    expect(endpoint.browseId).toBe('agt_1');
    expect(endpoint.canonicalBaseUrl).toBe('/channel/someone?id=agt_1');
  });
});

describe('richItem / richGrid', () => {
  it('wraps a card in a tracked rich item', () => {
    const item = richItem(env(''), VIEW);
    expect(item.richItemRenderer.trackingParams).toBe(`${PROTOCOL}vid=vid_1`);
    expect(item.richItemRenderer.content).toMatchObject({
      videoRenderer: { videoId: 'vid_1' },
    });
  });

  it('reports the item count and keeps the order', () => {
    const items = [
      richItem(env(''), VIEW),
      richItem(env(''), { ...VIEW, videoId: 'vid_2' }),
      richItem(env(''), { ...VIEW, videoId: 'vid_3' }),
    ];
    const grid = richGrid(items);
    expect(grid.richGridRenderer.itemCount).toBe(3);
    expect(grid.richGridRenderer.layoutSizing).toBe('GRID');
    expect(grid.richGridRenderer.contents).toHaveLength(3);
    expect(grid.richGridRenderer.contents[0]!.richItemRenderer.trackingParams).toContain('vid_1');
    expect(grid.richGridRenderer.contents[2]!.richItemRenderer.trackingParams).toContain('vid_3');
  });

  it('handles an empty feed', () => {
    const grid = richGrid([]);
    expect(grid.richGridRenderer.itemCount).toBe(0);
    expect(grid.richGridRenderer.contents).toEqual([]);
  });
});

describe('twoColumn / feedTabbedHeader', () => {
  it('wraps contents in the browse-results envelope', () => {
    const payload = twoColumn([{ x: 1 }]) as Record<string, unknown>;
    const browse = payload.twoColumnBrowseResultsRenderer as { tabs: unknown[] };
    expect(browse.tabs).toHaveLength(1);
    expect(JSON.stringify(browse)).toContain('richSectionRenderer');
  });

  it('exposes a four-tab header with the first selected', () => {
    const header = feedTabbedHeader('Beranda') as {
      feedTabbedHeaderRenderer: { tabs: { tabRenderer: { selected: boolean } }[] };
    };
    expect(header.feedTabbedHeaderRenderer.tabs).toHaveLength(4);
    expect(header.feedTabbedHeaderRenderer.tabs[0]!.tabRenderer.selected).toBe(true);
    expect(header.feedTabbedHeaderRenderer.tabs.slice(1).every((t) => !t.tabRenderer.selected))
      .toBe(true);
  });
});

describe('text helpers', () => {
  it('text() wraps in runs and simpleText() uses simpleText', () => {
    expect(text('a')).toEqual({ runs: [{ text: 'a' }] });
    expect(simpleText('a')).toEqual({ simpleText: 'a' });
  });
});

describe('toView', () => {
  const video: VideoRow = {
    id: 'vid_1',
    agent_id: 'agt_1',
    status: 'ready',
    title: 'Title',
    description: 'Desc',
    tags: '["x","y"]',
    duration_s: 42,
    bytes: 999,
    width: 640,
    height: 360,
    seg_count: 1,
    r2_prefix: 'videos/vid_1',
    sha256: 'abc',
    scan_state: 'clean',
    visibility: 'public',
    hold_until: null,
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
  };

  const profile: ProfileRow = {
    agent_id: 'agt_1',
    display_name: 'someone',
    description: '',
    avatar_key: null,
    links: '{}',
    visibility: 'public',
    created_at: 1,
  };

  it('maps a row plus profile into a view', () => {
    const view = toView(env('https://cdn.example'), video, profile);
    expect(view.videoId).toBe('vid_1');
    expect(view.authorName).toBe('someone');
    expect(view.tags).toEqual(['x', 'y']);
    expect(view.durationS).toBe(42);
  });

  it('falls back to "unknown" without a profile', () => {
    expect(toView(env(''), video, undefined).authorName).toBe('unknown');
  });

  it('tolerates a corrupt tags column', () => {
    expect(toView(env(''), { ...video, tags: 'not json' }, profile).tags).toEqual([]);
    expect(toView(env(''), { ...video, tags: '{"a":1}' }, profile).tags).toEqual([]);
  });

  it('leaves the avatar empty when no avatar key is set', () => {
    expect(toView(env(''), video, profile).authorAvatarUrl).toBe('');
  });
});