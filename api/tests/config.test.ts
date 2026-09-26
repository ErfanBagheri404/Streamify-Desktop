import { describe, it, expect } from 'vitest';
import { buildProviderUrlCandidates } from '../src/config';

/**
 * Unit Tests — buildProviderUrlCandidates from config.ts
 * This is an exported pure function for building fallback URL arrays.
 */
describe('buildProviderUrlCandidates()', () => {
  it('returns empty array for empty base', () => {
    expect(buildProviderUrlCandidates('')).toEqual([]);
  });

  it('returns just the cleaned base when no path variants', () => {
    const result = buildProviderUrlCandidates('https://api.example.com/');
    expect(result).toEqual(['https://api.example.com']);
  });

  it('appends path variants to base', () => {
    const result = buildProviderUrlCandidates(
      'https://api.example.com/search',
      ['v2/search', 'api/search']
    );
    expect(result).toEqual([
      'https://api.example.com/search/v2/search',
      'https://api.example.com/search/api/search',
      'https://api.example.com/search',
    ]);
  });

  it('adds query params', () => {
    const result = buildProviderUrlCandidates(
      'https://api.example.com/search',
      ['v2/search'],
      { q: 'hello', limit: 10 }
    );
    expect(result[0]).toContain('q=hello');
    expect(result[0]).toContain('limit=10');
  });

  it('skips null/empty query values', () => {
    const result = buildProviderUrlCandidates(
      'https://api.example.com/search',
      ['v2'],
      { q: 'hello', empty: '', skip: null as any }
    );
    // Only non-null/non-empty params should be in the URL
    expect(result[0]).toContain('q=hello');
    expect(result[0]).not.toContain('empty=');
    expect(result[0]).not.toContain('skip=');
  });

  it('deduplicates identical path variants', () => {
    const result = buildProviderUrlCandidates(
      'https://api.example.com',
      ['v2/search', 'v2/search']
    );
    // Same path variant twice → should be deduped
    expect(result).toEqual([
      'https://api.example.com/v2/search',
      'https://api.example.com',
    ]);
  });

  it('strips trailing slashes from base', () => {
    const result = buildProviderUrlCandidates('https://api.example.com///');
    expect(result[0]).toBe('https://api.example.com');
  });

  it('strips leading slashes from path variants', () => {
    const result = buildProviderUrlCandidates('https://api.example.com', [
      '/v2/search',
    ]);
    expect(result[0]).toBe('https://api.example.com/v2/search');
  });
});
