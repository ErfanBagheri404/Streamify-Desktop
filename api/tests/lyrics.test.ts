import { describe, it, expect } from 'vitest';

/**
 * Unit Tests — Pure functions extracted from lyrics.ts
 * Tests the lyrics processing pipeline without any network calls.
 */

function hasTimestampedLyrics(value: string): boolean {
  return /\[\d{1,2}:\d{2}(?:\.\d{1,3})?\]/.test(value);
}

function cleanPart(value: string | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim();
}

function normalizeForLookup(value: string): string {
  return cleanPart(value)
    .replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/\b(feat|ft|featuring|official|lyrics|audio|video)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildLyricsCandidates(track: {
  title: string;
  artist?: string;
}): { artist: string; title: string }[] {
  const title = cleanPart(track.title);
  const artist = cleanPart(track.artist);
  const candidates: { artist: string; title: string }[] = [];
  const seen = new Set<string>();
  const tryAdd = (nextArtist: string, nextTitle: string) => {
    const cleanArtist = cleanPart(nextArtist);
    const cleanTitle = cleanPart(nextTitle);
    if (!cleanTitle) return;
    const key = `${cleanArtist.toLowerCase()}::${cleanTitle.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ artist: cleanArtist, title: cleanTitle });
  };

  tryAdd(artist, title);
  tryAdd(artist, normalizeForLookup(title));
  if (artist) {
    tryAdd(normalizeForLookup(artist), title);
    tryAdd(normalizeForLookup(artist), normalizeForLookup(title));
  }
  tryAdd('', normalizeForLookup(title));

  return candidates.filter((candidate) => candidate.title);
}

// --- Tests ---

describe('hasTimestampedLyrics()', () => {
  it('detects standard LRC timestamps', () => {
    expect(hasTimestampedLyrics('[00:15.50]Hello world')).toBe(true);
  });

  it('detects single-digit minute timestamps', () => {
    expect(hasTimestampedLyrics('[1:30]Second line')).toBe(true);
  });

  it('detects timestamps without milliseconds', () => {
    expect(hasTimestampedLyrics('[02:45]Third line')).toBe(true);
  });

  it('returns false for plain lyrics', () => {
    expect(hasTimestampedLyrics('Hello world')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(hasTimestampedLyrics('')).toBe(false);
  });

  it('detects multiple timestamps in lyrics', () => {
    const lyrics =
      '[00:15.50]First line\n[00:20.00]Second line\n[01:30.100]Third line';
    expect(hasTimestampedLyrics(lyrics)).toBe(true);
  });
});

describe('cleanPart()', () => {
  it('trims whitespace', () => {
    expect(cleanPart('  hello  ')).toBe('hello');
  });

  it('collapses multiple spaces', () => {
    expect(cleanPart('hello   world')).toBe('hello world');
  });

  it('handles tabs and newlines', () => {
    expect(cleanPart('hello\t\n  world')).toBe('hello world');
  });

  it('returns empty string for undefined', () => {
    expect(cleanPart(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(cleanPart('')).toBe('');
  });
});

describe('normalizeForLookup()', () => {
  it('removes parenthetical content', () => {
    expect(normalizeForLookup('Song (feat. Artist)')).toBe('Song');
  });

  it('removes bracket content', () => {
    expect(normalizeForLookup('Song [Official Video]')).toBe('Song');
  });

  it('removes feat/ft keywords', () => {
    // 'ft.' stays because the dot prevents  matching on the right
    // but parenthetical matches still work
    expect(normalizeForLookup('Song (feat. Someone)')).toBe('Song Someone');
    expect(normalizeForLookup('Song featuring Someone')).toBe(
      'Song Someone'
    );
  });

  it('removes official/lyrics/audio/video keywords', () => {
    expect(normalizeForLookup('Song (Official Lyrics)')).toBe('Song');
    expect(normalizeForLookup('Song [Lyrics]')).toBe('Song');
    expect(normalizeForLookup('Song (Audio)')).toBe('Song');
    expect(normalizeForLookup('Song [Video]')).toBe('Song');
  });

  it('is case-insensitive for keywords in parentheses', () => {
    expect(normalizeForLookup('Song (FEAT. Someone)')).toBe('Song Someone');
  });

  it('collapses whitespace in parentheses', () => {
    expect(normalizeForLookup('Song   (feat.   Artist)')).toBe('Song Artist');
  });

  it('trims result', () => {
    expect(normalizeForLookup('  Song  ')).toBe('Song');
  });
});

describe('buildLyricsCandidates()', () => {
  it('generates candidates from artist + title', () => {
    const candidates = buildLyricsCandidates({
      artist: 'The Beatles',
      title: 'Hey Jude',
    });

    expect(candidates.length).toBeGreaterThanOrEqual(1);
    expect(candidates[0]).toEqual({ artist: 'The Beatles', title: 'Hey Jude' });
  });

  it('normalizes parenthetical content in candidates', () => {
    const candidates = buildLyricsCandidates({
      artist: 'Artist',
      title: 'Song (Official Video)',
    });

    // Should have a candidate with the normalized title
    const normalized = candidates.find(
      (c) => c.title === 'Song' && c.artist === 'Artist'
    );
    expect(normalized).toBeTruthy();
  });

  it('generates artist-less candidate', () => {
    const candidates = buildLyricsCandidates({
      title: 'Some Song',
    });

    const noArtist = candidates.find((c) => c.artist === '');
    expect(noArtist).toBeTruthy();
    expect(noArtist!.title).toBe('Some Song');
  });

  it('deduplicates candidates', () => {
    const candidates = buildLyricsCandidates({
      artist: 'Artist',
      title: 'Simple Title',
    });

    const keys = candidates.map(
      (c) => `${c.artist.toLowerCase()}::${c.title.toLowerCase()}`
    );
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('filters out candidates with empty titles', () => {
    const candidates = buildLyricsCandidates({
      artist: '',
      title: '',
    });

    expect(candidates).toEqual([]);
  });

  it('handles multi-artist ft. in title', () => {
    const candidates = buildLyricsCandidates({
      artist: 'Main Artist',
      title: 'Song (feat. Other Artist)',
    });

    // Should have normalized title without "feat" in parentheses removed
    const normalized = candidates.find(
      (c) => c.artist === 'Main Artist' && c.title === 'Song'
    );
    expect(normalized).toBeTruthy();
  });
});
