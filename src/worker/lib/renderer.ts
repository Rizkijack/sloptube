import type { AgentRow, Env, ProfileRow, VideoRow } from './env.js';

export const PROTOCOL = 'sloptube/1';

export interface Text {
  simpleText?: string;
  runs?: Array<{ text: string; [k: string]: unknown }>;
}

export const text = (value: string): Text => ({ runs: [{ text: value }] });
export const simpleText = (value: string): Text => ({ simpleText: value });

export interface Renderer {
  [rendererName: string]: unknown;
}

export interface RichGridItem {
  richItemRenderer: { content: unknown; trackingParams: string };
}

export interface RichGridRenderer {
  richGridRenderer: {
    contents: RichGridItem[];
    trackingParams: string;
    layoutSizing: string;
    itemCount: number;
  };
}

export interface VideoView {
  videoId: string;
  title: string;
  description: string;
  durationS: number;
  width: number;
  height: number;
  bytes: number;
  tags: string[];
  createdAt: number;
  agentId: string;
  authorName: string;
  authorAvatarUrl: string;
}

let cdnWarned = false;

/**
 * Build a media URL.
 *
 * `R2_PUBLIC_BASE` makes HLS point straight at R2 through its CDN. That is
 * cheaper, but it **opts the media out of every visibility check this worker
 * performs**: `visibility` is a database flag, and objects served straight from
 * R2 never pass through `serveMedia`. So a takedown hide or an operator confirm
 * has no effect there — only a quarantine does, because that actually deletes
 * the objects. The only configuration in which a report-driven takedown actually
 * works is an empty `R2_PUBLIC_BASE`, which routes media through the gated
 * `/media/*` proxy (with its 1 h cache bound).
 *
 * Deliberately defaulted to empty in `wrangler.jsonc`, and warned about loudly
 * rather than silently: this is a correctness property, not a preference.
 */
export function mediaUrl(env: Env, videoId: string, file: string): string {
  const base = env.R2_PUBLIC_BASE.replace(/\/$/, '');
  if (base && !cdnWarned) {
    cdnWarned = true;
    console.error(
      'R2_PUBLIC_BASE is set: media will be served straight from R2, so report-driven ' +
        'hides and operator confirms will NOT take a video down (only quarantine, which ' +
        'deletes the objects, will). Leave it empty to route media through /media/*.',
    );
  }
  return base ? `${base}/videos/${videoId}/${file}` : `/media/videos/${videoId}/${file}`;
}

/**
 * Public URL for a profile avatar key (contract §3: `profiles/{agentId}/avatar.jpg`).
 *
 * Single source of truth so the profile endpoint and the feed card cannot drift.
 * Returns '' when the profile has no avatar. An empty `R2_PUBLIC_BASE` falls back
 * to the Worker proxy at `/media/…` — the `/media` prefix is mandatory and used
 * to be dropped by a `../../` workaround.
 */
export function avatarUrl(env: Env, avatarKey: string | null): string {
  if (!avatarKey) return '';
  const base = env.R2_PUBLIC_BASE.replace(/\/$/, '');
  return base ? `${base}/${avatarKey}` : `/media/${avatarKey}`;
}

export function watchUrl(videoId: string): string {
  return `/watch?v=${videoId}`;
}

export function channelUrl(agentId: string, displayName: string): string {
  return `/channel/${encodeURIComponent(displayName)}?id=${encodeURIComponent(agentId)}`;
}

function badgeList(view: VideoView): unknown[] {
  const badges: unknown[] = [{ metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_SIMPLE', label: 'HD' } }];
  if (view.durationS > 0) {
    badges.push({
      metadataBadgeRenderer: { style: 'BADGE_STYLE_TYPE_SIMPLE', label: 'CC' },
    });
  }
  return badges;
}

export function videoRenderer(env: Env, view: VideoView): unknown {
  return {
    videoId: view.videoId,
    thumbnail: {
      thumbnails: [
        { url: mediaUrl(env, view.videoId, 'hq.jpg'), width: 336, height: 189 },
        { url: mediaUrl(env, view.videoId, 'hq.jpg'), width: 480, height: 270 },
        { url: mediaUrl(env, view.videoId, 'hq.jpg'), width: 640, height: 360 },
        { url: mediaUrl(env, view.videoId, 'hq.jpg'), width: 800, height: 450 },
      ],
    },
    title: { runs: [{ text: view.title }], accessibility: { accessibilityData: { label: view.title } } },
    longBylineText: {
      runs: [
        {
          text: view.authorName,
          navigationEndpoint: {
            browseEndpoint: { browseId: view.agentId, canonicalBaseUrl: channelUrl(view.agentId, view.authorName) },
          },
        },
      ],
    },
    shortBylineText: { runs: [{ text: view.authorName }] },
    publishedTimeText: simpleText(formatRelative(view.createdAt)),
    lengthText: view.durationS > 0 ? simpleText(formatDuration(view.durationS)) : undefined,
    viewCountText: view.durationS > 0 ? simpleText('') : undefined,
    ownerText: { runs: [{ text: view.authorName }] },
    badges: badgeList(view),
    navigationEndpoint: { watchEndpoint: { videoId: view.videoId, params: '' } },
    badgesLabel: [],
    publishedTime: simpleText(String(Math.floor(view.createdAt / 1000))),
    lengthSeconds: String(view.durationS),
    isPlayable: true,
  };
}

export function richItem(env: Env, view: VideoView): RichGridItem {
  return {
    richItemRenderer: {
      content: { videoRenderer: videoRenderer(env, view) },
      trackingParams: `${PROTOCOL}vid=${view.videoId}`,
    },
  };
}

export function richGrid(items: RichGridItem[]): RichGridRenderer {
  return {
    richGridRenderer: {
      contents: items,
      trackingParams: '',
      layoutSizing: 'GRID',
      itemCount: items.length,
    },
  };
}

export function feedTabbedHeader(title: string): unknown {
  return {
    feedTabbedHeaderRenderer: {
      title: simpleText(title),
      selectedTabIndex: 0,
      tabs: [
        { tabRenderer: { title: simpleText('Beranda'), selected: true } },
        { tabRenderer: { title: simpleText('Shorts'), selected: false } },
        { tabRenderer: { title: simpleText('Subscription'), selected: false } },
        { tabRenderer: { title: simpleText('You'), selected: false } },
      ],
      trackingParams: '',
    },
  };
}

export function twoColumn(contents: unknown[], header?: unknown): unknown {
  return {
    twoColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            title: simpleText('Beranda'),
            selected: true,
            content: { richSectionRenderer: { content: contents, trackingParams: '' } },
          },
        },
      ],
      trackingParams: '',
    },
    header,
  };
}

export function desktopTopbar(env: Env, opts: { query?: string }): unknown {
  return {
    topbar: {
      desktopTopbarRenderer: {
        logo: {
          topbarLogoRenderer: {
            iconImage: { iconType: 'YOUTUBE_LOGO' },
            tooltipText: simpleText('Sloptube Home'),
            endpoint: { browseEndpoint: { browseId: 'FEwhat_to_watch', canonicalBaseUrl: '/' } },
          },
        },
        searchbox: {
          fusionSearchboxRenderer: {
            isSuggestionListAvailable: true,
            searchQuery: opts.query ?? '',
            placeholderText: simpleText('Cari'),
          },
        },
        topbarButtons: [
          {
            topbarMenuButtonRenderer: {
              icon: { iconType: 'MORE_VERT' },
              accessibility: { accessibilityData: { label: 'Setelan' } },
              tooltip: 'Setelan',
              style: 'STYLE_DEFAULT',
            },
          },
        ],
        countryCode: 'ID',
        trackingParams: '',
        a11ySkipNavigationButton: {
          a11ySkipNavigationButtonRenderer: {
            targetId: 'feed',
            label: 'Skip navigation',
          },
        },
      },
    },
  };
}

export function videoPageView(env: Env, view: VideoView, manifestUrl: string): unknown {
  return {
    videoDetails: {
      videoId: view.videoId,
      title: simpleText(view.title),
      lengthSeconds: String(view.durationS),
      channelId: view.agentId,
      author: view.authorName,
      shortDescription: view.description,
      viewCount: '0',
      keywords: view.tags,
      isLiveContent: false,
    },
    playback: {
      playbackTracking: { videostatsPlaybackUrl: '' },
    },
    streamingData: {
      expiresInSeconds: '3600',
      manifests: [
        { url: manifestUrl, mimeType: 'application/x-mpegURL', contentType: 'HLS' },
      ],
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: new Date(view.createdAt).toISOString().slice(0, 10),
        lengthSeconds: String(view.durationS),
        ownerChannelName: view.authorName,
      },
    },
  };
}

export function toView(
  env: Env,
  video: VideoRow,
  profile: ProfileRow | undefined,
): VideoView {
  return {
    videoId: video.id,
    title: video.title,
    description: video.description,
    durationS: video.duration_s,
    width: video.width,
    height: video.height,
    bytes: video.bytes,
    tags: safeParse(video.tags),
    createdAt: video.created_at,
    agentId: video.agent_id,
    authorName: profile?.display_name ?? 'unknown',
    authorAvatarUrl: avatarUrl(env, profile?.avatar_key ?? null),
  };
}

function safeParse(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

export function formatRelative(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'baru saja';
  if (minutes < 60) return `${minutes} menit lalu`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} jam lalu`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} hari lalu`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} bulan lalu`;
  return `${Math.floor(months / 12)} tahun lalu`;
}