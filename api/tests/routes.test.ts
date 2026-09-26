import { describe, it, expect } from 'vitest';

/**
 * Unit Tests — Route-level pure functions
 * Tests functions extracted from the route handlers.
 * These functions aren't exported, so we replicate + test the logic.
 */

// --- artist.ts functions ---
function extractChannelId(input: string): string {
  const trimmed = input.trim();

  // Already a channel ID
  if (/^UC[\w-]{22}$/.test(trimmed)) return trimmed;

  // YouTube channel URL patterns
  const patterns = [
    /youtube\.com\/channel\/(UC[\w-]{22})/,
    /youtube\.com\/c\/[\w-]+/,
    /youtube\.com\/@[\w-]+/,
    /youtu\.be\/([\w-]+)/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) return match[1];
  }

  return trimmed;
}

function formatFollowerCount(count: number | null | undefined): string {
  if (count == null) return '';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

// --- itunes.ts / deezer.ts functions ---
function buildSearchQuery(
  query: string,
  filter?: string
): string {
  const base = query.trim();
  if (filter && filter !== 'all') {
    return `${base} ${filter}`.trim();
  }
  return base;
}

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

// --- audio-proxy.ts functions ---
function isAllowedAudioHost(
  url: string,
  allowedHosts: string[]
): boolean {
  try {
    const hostname = new URL(url).hostname;
    return allowedHosts.some(
      (host) => hostname === host || hostname.endsWith('.' + host)
    );
  } catch {
    return false;
  }
}

function parseRangeHeader(range: string): { start: number; end?: number } | null {
  const match = range.match(/^bytes=(\d+)-(\d*)$/);
  if (!match) return null;

  const start = parseInt(match[1], 10);
  const end = match[2] ? parseInt(match[2], 10) : undefined;
  return { start, end };
}

// --- Tests ---

describe('extractChannelId()', () => {
  it('extracts from /channel/UC... URL', () => {
    // UC + 22 chars = 24 total
    expect(
      extractChannelId(
        'https://www.youtube.com/channel/UCx123456789012345678901234'
      )
    ).toBe('UCx123456789012345678901234');
  });

  it('returns raw ID if already UC...', () => {
    expect(extractChannelId('UCx123456789012345678901234')).toBe(
      'UCx123456789012345678901234'
    );
  });

  it('returns input for unknown format', () => {
    expect(extractChannelId('some-random-text')).toBe('some-random-text');
  });
});

describe('formatFollowerCount()', () => {
  it('formats millions', () => {
    expect(formatFollowerCount(1_500_000)).toBe('1.5M');
    expect(formatFollowerCount(10_000_000)).toBe('10.0M');
  });

  it('formats thousands', () => {
    expect(formatFollowerCount(1_500)).toBe('1.5K');
    expect(formatFollowerCount(99_999)).toBe('100.0K');
  });

  it('returns raw number for small values', () => {
    expect(formatFollowerCount(500)).toBe('500');
    expect(formatFollowerCount(0)).toBe('0');
  });

  it('returns empty for null/undefined', () => {
    expect(formatFollowerCount(null)).toBe('');
    expect(formatFollowerCount(undefined)).toBe('');
  });
});

describe('buildSearchQuery()', () => {
  it('returns query as-is when no filter', () => {
    expect(buildSearchQuery('hello world')).toBe('hello world');
  });

  it('appends filter when provided', () => {
    expect(buildSearchQuery('hello', 'track')).toBe('hello track');
  });

  it('ignores "all" filter', () => {
    expect(buildSearchQuery('hello', 'all')).toBe('hello');
  });

  it('trims whitespace', () => {
    expect(buildSearchQuery('  hello  ', 'track')).toBe('hello track');
  });
});

describe('truncateText()', () => {
  it('returns text as-is when shorter than max', () => {
    expect(truncateText('hello', 10)).toBe('hello');
  });

  it('truncates and adds ... when longer', () => {
    expect(truncateText('hello world this is long', 10)).toBe('hello w...');
  });

  it('returns ... for maxLen=3', () => {
    expect(truncateText('hello', 3)).toBe('...');
  });
});

describe('isAllowedAudioHost()', () => {
  const hosts = ['googlevideo.com', 'sndcdn.com'];

  it('allows exact host match', () => {
    expect(isAllowedAudioHost('https://googlevideo.com/video.mp4', hosts)).toBe(
      true
    );
  });

  it('allows subdomain match', () => {
    expect(
      isAllowedAudioHost('https://r4---sn-abc.googlevideo.com/video.mp4', hosts)
    ).toBe(true);
  });

  it('rejects unrelated host', () => {
    expect(isAllowedAudioHost('https://evil.com/video.mp4', hosts)).toBe(false);
  });

  it('rejects malformed URL', () => {
    expect(isAllowedAudioHost('not-a-url', hosts)).toBe(false);
  });
});

describe('parseRangeHeader()', () => {
  it('parses bytes=0-', () => {
    expect(parseRangeHeader('bytes=0-')).toEqual({ start: 0 });
  });

  it('parses bytes=0-1023', () => {
    expect(parseRangeHeader('bytes=0-1023')).toEqual({ start: 0, end: 1023 });
  });

  it('parses bytes=500-', () => {
    expect(parseRangeHeader('bytes=500-')).toEqual({ start: 500 });
  });

  it('returns null for invalid range', () => {
    expect(parseRangeHeader('invalid')).toBeNull();
    expect(parseRangeHeader('bytes=')).toBeNull();
  });
});
