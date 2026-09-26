import { describe, it, expect } from 'vitest';
import {
  json,
  getAllowedOrigin,
  isAuthorizedApiRequest,
  buildWorkerUrl,
  absolutizeUrl,
  toRecord,
  toArray,
  toNumber,
  parseJsonText,
  withTimeout,
} from '../src/http';

/**
 * Unit Tests — Pure functions from http.ts
 * No network calls. No API. Fast. Reliable.
 */

describe('normalizeOrigin', () => {
  // Note: normalizeOrigin is not exported, but we test it via getAllowedOrigin
  // GET /health doesn't have origin → should return null
  it('getAllowedOrigin returns null when no origin header', () => {
    const req = new Request('http://localhost');
    const config = { api: { allowedOrigins: [] } };

    expect(getAllowedOrigin(req, config)).toBeNull();
  });
});

describe('json()', () => {
  it('creates a Response with JSON body', async () => {
    const res = json({ hello: 'world' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.hello).toBe('world');
    expect(res.headers.get('Content-Type')).toBe('application/json');
  });

  it('allows custom status code', async () => {
    const res = json({ error: 'not found' }, { status: 404 });
    expect(res.status).toBe(404);
  });

  it('allows custom headers', async () => {
    const res = json({}, { headers: { 'X-Custom': 'test' } });
    expect(res.headers.get('X-Custom')).toBe('test');
  });

  it('does not overwrite Content-Type if already set', async () => {
    const res = json({}, { headers: { 'Content-Type': 'text/plain' } });
    expect(res.headers.get('Content-Type')).toBe('text/plain');
  });
});

describe('getAllowedOrigin()', () => {
  it('returns origin when allowedOrigins is empty (allow all)', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://example.com' },
    });
    const config = { api: { allowedOrigins: [] } };

    expect(getAllowedOrigin(req, config)).toBe('https://example.com');
  });

  it('returns origin when it matches allowedOrigins', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://allowed.com' },
    });
    const config = { api: { allowedOrigins: ['https://allowed.com'] } };

    expect(getAllowedOrigin(req, config)).toBe('https://allowed.com');
  });

  it('returns null when origin is not in allowedOrigins', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://evil.com' },
    });
    const config = { api: { allowedOrigins: ['https://allowed.com'] } };

    expect(getAllowedOrigin(req, config)).toBeNull();
  });

  it('falls back to Referer header when Origin is missing', () => {
    const req = new Request('http://localhost', {
      headers: { Referer: 'https://page.com/page' },
    });
    const config = { api: { allowedOrigins: [] } };

    expect(getAllowedOrigin(req, config)).toBe('https://page.com');
  });

  it('returns null for malformed origin', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'not-a-url' },
    });
    const config = { api: { allowedOrigins: [] } };

    expect(getAllowedOrigin(req, config)).toBeNull();
  });
});

describe('isAuthorizedApiRequest()', () => {
  it('returns true with valid server secret', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-streamify-server-secret': 'my-secret' },
    });
    const config = { api: { allowedOrigins: [] } };

    expect(isAuthorizedApiRequest(req, config, 'my-secret')).toBe(true);
  });

  it('returns false with wrong secret', () => {
    const req = new Request('http://localhost', {
      headers: { 'x-streamify-server-secret': 'wrong' },
    });
    const config = { api: { allowedOrigins: [] } };

    expect(isAuthorizedApiRequest(req, config, 'my-secret')).toBe(false);
  });

  it('returns true when origin matches allowed list', () => {
    const req = new Request('http://localhost', {
      headers: { Origin: 'https://allowed.com' },
    });
    const config = { api: { allowedOrigins: ['https://allowed.com'] } };

    expect(isAuthorizedApiRequest(req, config)).toBe(true);
  });

  it('returns false with no origin and no secret', () => {
    const req = new Request('http://localhost');
    const config = { api: { allowedOrigins: ['https://allowed.com'] } };

    expect(isAuthorizedApiRequest(req, config)).toBe(false);
  });
});

describe('buildWorkerUrl()', () => {
  const baseReq = new Request('https://helloify-api.hf.space/search?q=test');

  it('replaces pathname', () => {
    const url = buildWorkerUrl(baseReq, '/api/search');
    expect(url).toContain('/api/search');
  });

  it('appends search params from object', () => {
    const url = buildWorkerUrl(baseReq, '/api', { q: 'hello', limit: 10 });
    expect(url).toContain('q=hello');
    expect(url).toContain('limit=10');
  });

  it('appends search params from URLSearchParams', () => {
    const params = new URLSearchParams();
    params.append('q', 'hello');
    params.append('page', '2');
    const url = buildWorkerUrl(baseReq, '/api', params);
    expect(url).toContain('q=hello');
    expect(url).toContain('page=2');
  });

  it('clears existing search params', () => {
    const url = buildWorkerUrl(baseReq, '/api');
    expect(url).not.toContain('q=test');
  });
});

describe('absolutizeUrl()', () => {
  const base = 'https://cdn.example.com';

  it('returns empty string as-is', () => {
    expect(absolutizeUrl('', base)).toBe('');
  });

  it('returns absolute HTTPS URL as-is', () => {
    expect(absolutizeUrl('https://other.com/img.png', base)).toBe(
      'https://other.com/img.png'
    );
  });

  it('returns absolute HTTP URL as-is', () => {
    expect(absolutizeUrl('http://other.com/img.png', base)).toBe(
      'http://other.com/img.png'
    );
  });

  it('prepends https: to protocol-relative URLs', () => {
    expect(absolutizeUrl('//cdn.com/img.png', base)).toBe(
      'https://cdn.com/img.png'
    );
  });

  it('prepends base to relative URLs', () => {
    expect(absolutizeUrl('/images/photo.jpg', base)).toBe(
      'https://cdn.example.com/images/photo.jpg'
    );
  });

  it('returns plain strings as-is', () => {
    expect(absolutizeUrl('img.png', base)).toBe('img.png');
  });
});

describe('toRecord()', () => {
  it('returns object as-is', () => {
    expect(toRecord({ a: 1 })).toEqual({ a: 1 });
  });

  it('returns empty object for null', () => {
    expect(toRecord(null)).toEqual({});
  });

  it('returns empty object for array', () => {
    expect(toRecord([1, 2, 3])).toEqual({});
  });

  it('returns empty object for string', () => {
    expect(toRecord('hello')).toEqual({});
  });
});

describe('toArray()', () => {
  it('returns array as-is', () => {
    expect(toArray([1, 2])).toEqual([1, 2]);
  });

  it('returns empty array for non-array', () => {
    expect(toArray('hello')).toEqual([]);
    expect(toArray(null)).toEqual([]);
    expect(toArray(123)).toEqual([]);
  });
});

describe('toNumber()', () => {
  it('returns number as-is', () => {
    expect(toNumber(42)).toBe(42);
  });

  it('parses numeric string', () => {
    expect(toNumber('42')).toBe(42);
  });

  it('parses decimal string', () => {
    expect(toNumber('3.14')).toBe(3.14);
  });

  it('returns undefined for non-numeric string', () => {
    expect(toNumber('hello')).toBeUndefined();
  });

  it('returns undefined for null', () => {
    expect(toNumber(null)).toBeUndefined();
  });

  it('returns undefined for Infinity', () => {
    expect(toNumber(Infinity)).toBeUndefined();
  });

  it('returns undefined for NaN', () => {
    expect(toNumber(NaN)).toBeUndefined();
  });
});

describe('parseJsonText()', () => {
  it('parses valid JSON', () => {
    expect(parseJsonText('{"a": 1}')).toEqual({ a: 1 });
  });

  it('handles BOM prefix', () => {
    expect(parseJsonText('\uFEFF{"a": 1}')).toEqual({ a: 1 });
  });

  it('handles extra whitespace', () => {
    expect(parseJsonText('  {"a": 1}  ')).toEqual({ a: 1 });
  });

  it('returns null for empty string', () => {
    expect(parseJsonText('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseJsonText('   ')).toBeNull();
  });

  it('recovers from surrounding text (HTML wrapper)', () => {
    const html = '<html>{"data": 1}</html>';
    expect(parseJsonText(html)).toEqual({ data: 1 });
  });

  it('recovers from prefix noise', () => {
    const noisy = 'noise [{"a": 1}]';
    expect(parseJsonText(noisy)).toEqual([{ a: 1 }]);
  });

  it('throws on completely invalid input', () => {
    expect(() => parseJsonText('not json at all')).toThrow();
  });

  it('custom error message', () => {
    expect(() => parseJsonText('bad', 'Custom error')).toThrow('Custom error');
  });
});

describe('withTimeout()', () => {
  it('returns AbortSignal that aborts after timeout', async () => {
    const signal = withTimeout(undefined, 50);

    expect(signal.aborted).toBe(false);

    await new Promise((r) => setTimeout(r, 60));

    expect(signal.aborted).toBe(true);
  });

  it('aborts immediately if parent signal is already aborted', () => {
    const parent = AbortSignal.abort();
    const signal = withTimeout(parent, 5000);

    expect(signal.aborted).toBe(true);
  });

  it('cascades parent abort to child', async () => {
    const controller = new AbortController();
    const signal = withTimeout(controller.signal, 10000);

    expect(signal.aborted).toBe(false);

    controller.abort();

    expect(signal.aborted).toBe(true);
  });
});
