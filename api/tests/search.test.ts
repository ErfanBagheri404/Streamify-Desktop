import { describe, it, expect } from 'vitest';

/**
 * Unit Tests — Pure functions extracted from search.ts
 * These functions are NOT exported, so we test them indirectly
 * or replicate the logic here to document expected behavior.
 *
 * Since these are not exported, we test the BEHAVIOR that depends on them
 * via integration tests. But we document the expected logic here.
 */

// Replicate the pure functions for unit testing (they aren't exported)
function extractYouTubeVideoId(value: string): string {
  const rawValue = value.trim();
  if (!rawValue) return '';

  const watchMatch = rawValue.match(/[?&]v=([^&]+)/);
  if (watchMatch?.[1]) return watchMatch[1];

  const shortMatch = rawValue.match(/youtu\.be\/([^?]+)/);
  if (shortMatch?.[1]) return shortMatch[1];

  const pathMatch = rawValue.match(/\/watch\/([^/?#]+)/);
  if (pathMatch?.[1]) return pathMatch[1];

  return '';
}

function normalizeBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function mapFilterToInvidiousType(filter: string): string | null {
  const normalized = (filter || '').toLowerCase();
  if (!normalized || normalized === 'all') return null;
  if (normalized === 'videos' || normalized === 'video') return 'video';
  if (normalized === 'playlists' || normalized === 'playlist')
    return 'playlist';
  if (
    normalized === 'channels' ||
    normalized === 'channel' ||
    normalized === 'artists' ||
    normalized === 'artist'
  ) {
    return 'channel';
  }
  return null;
}

function musicFilterMap(filter: string): string {
  const map: Record<string, string> = {
    songs: 'music_songs',
    videos: 'music_videos',
    albums: 'music_albums',
    playlists: 'music_playlists',
    channels: 'music_artists',
    '': 'music_songs',
  };
  return map[filter] || filter;
}

function upgradeSoundCloudImage(url: string): string {
  if (!url) return '';
  return url
    .replace('-large.', '-t500x500.')
    .replace('large.jpg', 't500x500.jpg')
    .replace('large.png', 't500x500.png');
}

// --- Tests ---

describe('extractYouTubeVideoId()', () => {
  it('extracts from standard watch URL', () => {
    expect(
      extractYouTubeVideoId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts from youtu.be short URL', () => {
    expect(extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ')).toBe(
      'dQw4w9WgXcQ'
    );
  });

  it('extracts from youtu.be with extra params', () => {
    expect(
      extractYouTubeVideoId('https://youtu.be/dQw4w9WgXcQ?si=abc123')
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts from /watch/ path', () => {
    expect(
      extractYouTubeVideoId('https://www.youtube.com/watch/dQw4w9WgXcQ')
    ).toBe('dQw4w9WgXcQ');
  });

  it('extracts from URL with multiple params', () => {
    expect(
      extractYouTubeVideoId(
        'https://www.youtube.com/watch?v=abc123&list=PLxyz&index=5'
      )
    ).toBe('abc123');
  });

  it('returns empty string for non-YouTube URL', () => {
    expect(extractYouTubeVideoId('https://example.com/video')).toBe('');
  });

  it('returns empty string for empty input', () => {
    expect(extractYouTubeVideoId('')).toBe('');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(extractYouTubeVideoId('   ')).toBe('');
  });
});

describe('normalizeBaseUrl()', () => {
  it('strips trailing slashes', () => {
    expect(normalizeBaseUrl('https://api.example.com/')).toBe(
      'https://api.example.com'
    );
    expect(normalizeBaseUrl('https://api.example.com///')).toBe(
      'https://api.example.com'
    );
  });

  it('leaves clean URL unchanged', () => {
    expect(normalizeBaseUrl('https://api.example.com')).toBe(
      'https://api.example.com'
    );
  });
});

describe('mapFilterToInvidiousType()', () => {
  it('returns null for empty/all', () => {
    expect(mapFilterToInvidiousType('')).toBeNull();
    expect(mapFilterToInvidiousType('all')).toBeNull();
    expect(mapFilterToInvidiousType('ALL')).toBeNull();
  });

  it('maps videos/video to video', () => {
    expect(mapFilterToInvidiousType('videos')).toBe('video');
    expect(mapFilterToInvidiousType('video')).toBe('video');
    expect(mapFilterToInvidiousType('VIDEOS')).toBe('video');
  });

  it('maps playlists/playlist to playlist', () => {
    expect(mapFilterToInvidiousType('playlists')).toBe('playlist');
    expect(mapFilterToInvidiousType('playlist')).toBe('playlist');
  });

  it('maps channels/channel/artists/artist to channel', () => {
    expect(mapFilterToInvidiousType('channels')).toBe('channel');
    expect(mapFilterToInvidiousType('channel')).toBe('channel');
    expect(mapFilterToInvidiousType('artists')).toBe('channel');
    expect(mapFilterToInvidiousType('artist')).toBe('channel');
  });

  it('returns null for unknown filter', () => {
    expect(mapFilterToInvidiousType('songs')).toBeNull();
    expect(mapFilterToInvidiousType('albums')).toBeNull();
  });
});

describe('musicFilterMap()', () => {
  it('maps known filters', () => {
    expect(musicFilterMap('songs')).toBe('music_songs');
    expect(musicFilterMap('videos')).toBe('music_videos');
    expect(musicFilterMap('albums')).toBe('music_albums');
    expect(musicFilterMap('playlists')).toBe('music_playlists');
    expect(musicFilterMap('channels')).toBe('music_artists');
  });

  it('maps empty string to music_songs', () => {
    expect(musicFilterMap('')).toBe('music_songs');
  });

  it('passes unknown filters through', () => {
    expect(musicFilterMap('custom_filter')).toBe('custom_filter');
  });
});

describe('upgradeSoundCloudImage()', () => {
  it('upgrades -large.jpg to -t500x500.jpg', () => {
    expect(
      upgradeSoundCloudImage('https://i1.sndcdn.com/foo-large.jpg')
    ).toBe('https://i1.sndcdn.com/foo-t500x500.jpg');
  });

  it('upgrades large.jpg at end', () => {
    expect(
      upgradeSoundCloudImage('https://i1.sndcdn.com/foo_large.jpg')
    ).toBe('https://i1.sndcdn.com/foo_t500x500.jpg');
  });

  it('upgrades large.png', () => {
    expect(
      upgradeSoundCloudImage('https://i1.sndcdn.com/foo-large.png')
    ).toBe('https://i1.sndcdn.com/foo-t500x500.png');
  });

  it('returns empty string for empty input', () => {
    expect(upgradeSoundCloudImage('')).toBe('');
  });

  it('does not change already-high-res images', () => {
    const url = 'https://i1.sndcdn.com/foo-t500x500.jpg';
    expect(upgradeSoundCloudImage(url)).toBe(url);
  });
});
