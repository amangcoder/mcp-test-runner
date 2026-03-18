/**
 * Unit tests for CacheManager (src/cache.ts).
 *
 * Coverage targets (matching acceptance criteria):
 *   AC-1  get() hit / miss
 *   AC-2  get() TTL expiry
 *   AC-3  set() LRU eviction at capacity
 *   AC-4  LRU ordering — accessed entries survive eviction
 *   AC-5  persistToDisk atomic write
 *   AC-6  loadFromDisk corrupt-file recovery
 *   AC-7  loadFromDisk skips expired entries
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CacheManager } from '../cache.js';
import type { NormalizedResult } from '../types.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build a minimal valid NormalizedResult for testing. */
function makeResult(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    summary: { total: 1, passed: 1, failed: 0, skipped: 0, duration: 0.1 },
    tests: [],
    fromCache: false,
    framework: 'jest',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** ISO-8601 timestamp shifted by `ms` milliseconds relative to now. */
function timestampAgo(ms: number): string {
  return new Date(Date.now() - ms).toISOString();
}

/** Create a temp directory that is removed after each test. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cache-test-'));
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('CacheManager', () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager();
  });

  // ── AC-1: get() hit / miss ─────────────────────────────────────────────────

  describe('get()', () => {
    it('returns undefined for an unknown hash', () => {
      expect(cache.get('nonexistent')).toBeUndefined();
    });

    it('returns the stored CachedResult for a known hash', () => {
      const result = makeResult();
      cache.set('abc123', result);
      const hit = cache.get('abc123');
      expect(hit).toBeDefined();
      expect(hit!.hash).toBe('abc123');
      expect(hit!.result).toEqual(result);
      expect(typeof hit!.timestamp).toBe('string');
    });

    it('returns undefined for a second get() after an expired entry is evicted', () => {
      const result = makeResult();
      cache.set('abc123', result);
      // First call — not yet expired, should hit.
      expect(cache.get('abc123')).toBeDefined();
      // Manually patch the entry timestamp to simulate expiry.
      // We reach into the private map via a cast only in tests.
      const privateCache = (cache as unknown as { cache: Map<string, { result: NormalizedResult; timestamp: string; hash: string }> }).cache;
      const entry = privateCache.get('abc123')!;
      entry.timestamp = timestampAgo(86_400_001); // 24 h + 1 ms ago
      // Now get() should expire it.
      expect(cache.get('abc123')).toBeUndefined();
      // The entry should have been deleted.
      expect(privateCache.has('abc123')).toBe(false);
    });
  });

  // ── AC-2: get() TTL expiry ─────────────────────────────────────────────────

  describe('TTL eviction', () => {
    it('does not evict an entry that is exactly at the TTL boundary (< 24 h)', () => {
      cache.set('fresh', makeResult());
      const privateCache = (cache as unknown as { cache: Map<string, { timestamp: string }> }).cache;
      // 23 h 59 m 59 s ago — should still be valid.
      privateCache.get('fresh')!.timestamp = timestampAgo(86_399_000);
      expect(cache.get('fresh')).toBeDefined();
    });

    it('evicts an entry whose timestamp is older than 24 hours', () => {
      cache.set('stale', makeResult());
      const privateCache = (cache as unknown as { cache: Map<string, { timestamp: string }> }).cache;
      privateCache.get('stale')!.timestamp = timestampAgo(86_400_001);
      expect(cache.get('stale')).toBeUndefined();
    });
  });

  // ── AC-3: set() LRU eviction at capacity ──────────────────────────────────

  describe('set() capacity eviction', () => {
    it('evicts the oldest entry when the cache reaches 100 entries', () => {
      // Fill cache to capacity.
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${i}`, makeResult());
      }
      // 'key-0' is the oldest (first inserted).
      expect(cache.get('key-0')).toBeDefined(); // still present before eviction

      // Re-create fresh cache to avoid LRU re-ordering from the get() above.
      cache = new CacheManager();
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${i}`, makeResult());
      }

      // Insert one more entry — should evict 'key-0'.
      cache.set('key-100', makeResult());

      expect(cache.get('key-0')).toBeUndefined(); // evicted
      expect(cache.get('key-1')).toBeDefined();   // still present
      expect(cache.get('key-100')).toBeDefined(); // newly inserted
    });

    it('does not exceed 100 entries after many insertions', () => {
      for (let i = 0; i < 200; i++) {
        cache.set(`key-${i}`, makeResult());
      }
      const privateCache = (cache as unknown as { cache: Map<unknown, unknown> }).cache;
      expect(privateCache.size).toBeLessThanOrEqual(100);
    });
  });

  // ── AC-4: LRU ordering ────────────────────────────────────────────────────

  describe('LRU ordering', () => {
    it('re-orders an accessed entry to MRU position so it survives when capacity is exceeded', () => {
      // Insert 99 entries.
      for (let i = 0; i < 99; i++) {
        cache.set(`key-${i}`, makeResult());
      }
      // 'key-0' is currently the LRU candidate.
      // Access it so it becomes MRU.
      cache.get('key-0');

      // Fill to capacity with one new entry — should evict 'key-1' (new LRU).
      cache.set('key-99', makeResult());
      expect(cache.get('key-1')).toBeUndefined(); // key-1 is now LRU, evicted

      // key-99 triggered the eviction, so we have 99 entries now. Add one more.
      cache.set('key-100', makeResult());
      // 'key-0' should still be in the cache (it was promoted to MRU).
      expect(cache.get('key-0')).toBeDefined();
    });

    it('updating an existing key moves it to MRU', () => {
      for (let i = 0; i < 100; i++) {
        cache.set(`key-${i}`, makeResult());
      }
      // Re-set key-0 — it should move to MRU position.
      cache.set('key-0', makeResult({ framework: 'vitest' }));
      // Now key-1 is the new LRU.
      cache.set('key-new', makeResult());
      expect(cache.get('key-1')).toBeUndefined(); // key-1 evicted
      expect(cache.get('key-0')).toBeDefined();   // key-0 survived
    });
  });

  // ── AC-5: persistToDisk atomic write ──────────────────────────────────────

  describe('persistToDisk()', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await makeTmpDir();
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('writes a valid JSON array that round-trips back to the original entries', async () => {
      const r1 = makeResult({ framework: 'jest' });
      const r2 = makeResult({ framework: 'pytest' });
      cache.set('hash-a', r1);
      cache.set('hash-b', r2);

      const filePath = path.join(tmpDir, 'cache.json');
      await cache.persistToDisk(filePath);

      const raw = await fs.readFile(filePath, 'utf-8');
      const parsed: Array<{ hash: string; result: NormalizedResult; timestamp: string }> =
        JSON.parse(raw);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(2);

      const hashes = parsed.map((e) => e.hash);
      expect(hashes).toContain('hash-a');
      expect(hashes).toContain('hash-b');

      const entryA = parsed.find((e) => e.hash === 'hash-a')!;
      expect(entryA.result.framework).toBe('jest');
    });

    it('does NOT leave a .tmp file behind after a successful write', async () => {
      cache.set('x', makeResult());
      const filePath = path.join(tmpDir, 'cache.json');
      await cache.persistToDisk(filePath);

      await expect(fs.access(`${filePath}.tmp`)).rejects.toThrow();
    });

    it('persists an empty cache as an empty JSON array', async () => {
      const filePath = path.join(tmpDir, 'empty.json');
      await cache.persistToDisk(filePath);
      const raw = await fs.readFile(filePath, 'utf-8');
      expect(JSON.parse(raw)).toEqual([]);
    });
  });

  // ── AC-6: loadFromDisk corrupt-file recovery ───────────────────────────────

  describe('loadFromDisk()', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await makeTmpDir();
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('returns without error when the cache file does not exist (ENOENT)', async () => {
      await expect(
        cache.loadFromDisk(path.join(tmpDir, 'no-such-file.json')),
      ).resolves.toBeUndefined();
    });

    it('recovers from a corrupt (non-JSON) file: logs to stderr and starts empty', async () => {
      const filePath = path.join(tmpDir, 'corrupt.json');
      await fs.writeFile(filePath, 'not valid json }{', 'utf-8');

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(cache.loadFromDisk(filePath)).resolves.toBeUndefined();
        expect(stderrSpy).toHaveBeenCalled();
        // Stderr message should mention the file and indicate it's a warning.
        const msg = String(stderrSpy.mock.calls[0][0]);
        expect(msg).toMatch(/corrupt/i);
        expect(msg).toMatch(/corrupt\.json/);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('recovers from a JSON file that is not an array: logs to stderr and starts empty', async () => {
      const filePath = path.join(tmpDir, 'object.json');
      await fs.writeFile(filePath, JSON.stringify({ not: 'an array' }), 'utf-8');

      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(cache.loadFromDisk(filePath)).resolves.toBeUndefined();
        expect(stderrSpy).toHaveBeenCalled();
      } finally {
        stderrSpy.mockRestore();
      }

      // Cache should be empty.
      expect(cache.get('anything')).toBeUndefined();
    });

    // ── AC-7: loadFromDisk skips expired entries ────────────────────────────

    it('skips entries whose timestamp is older than 24 hours', async () => {
      const filePath = path.join(tmpDir, 'expired.json');
      const entries = [
        {
          hash: 'fresh-hash',
          timestamp: new Date().toISOString(),
          result: makeResult(),
        },
        {
          hash: 'stale-hash',
          timestamp: timestampAgo(86_400_001), // expired
          result: makeResult(),
        },
      ];
      await fs.writeFile(filePath, JSON.stringify(entries), 'utf-8');

      await cache.loadFromDisk(filePath);

      expect(cache.get('fresh-hash')).toBeDefined();
      expect(cache.get('stale-hash')).toBeUndefined();
    });

    it('skips entries with missing required fields', async () => {
      const filePath = path.join(tmpDir, 'invalid-entries.json');
      const entries = [
        { hash: 'good', timestamp: new Date().toISOString(), result: makeResult() },
        { hash: 'missing-result', timestamp: new Date().toISOString() }, // no result
        { timestamp: new Date().toISOString(), result: makeResult() },   // no hash
        { hash: '', timestamp: new Date().toISOString(), result: makeResult() }, // empty hash
        null,
        42,
        'string',
      ];
      await fs.writeFile(filePath, JSON.stringify(entries), 'utf-8');

      await cache.loadFromDisk(filePath);

      expect(cache.get('good')).toBeDefined();
      expect(cache.get('missing-result')).toBeUndefined();
    });

    it('round-trips through persistToDisk then loadFromDisk', async () => {
      const r1 = makeResult({ framework: 'vitest' });
      const r2 = makeResult({ framework: 'pytest' });
      cache.set('h1', r1);
      cache.set('h2', r2);

      const filePath = path.join(tmpDir, 'roundtrip.json');
      await cache.persistToDisk(filePath);

      const cache2 = new CacheManager();
      await cache2.loadFromDisk(filePath);

      const hit1 = cache2.get('h1');
      const hit2 = cache2.get('h2');

      expect(hit1).toBeDefined();
      expect(hit1!.result.framework).toBe('vitest');
      expect(hit2).toBeDefined();
      expect(hit2!.result.framework).toBe('pytest');
    });
  });
});

// ─── TASK-010: Acceptance criteria tests ──────────────────────────────────────
//
// These tests map directly to the acceptance criteria stated in TASK-010.
// They complement the broader CacheManager tests above with explicit,
// strict-equality checks for the exact scenarios called out in the task spec.

describe('CacheManager — TASK-010 acceptance criteria', () => {
  let cache: CacheManager;

  beforeEach(() => {
    cache = new CacheManager();
  });

  // ── LRU eviction: 101 inserts → size===100 and oldest entry gone ───────────

  it('LRU eviction: after 101 inserts, cache size is exactly 100', () => {
    for (let i = 0; i < 101; i++) {
      cache.set(`t10-lru-key-${i}`, makeResult());
    }
    const privateCache = (cache as unknown as { cache: Map<unknown, unknown> }).cache;
    expect(privateCache.size).toBe(100);
  });

  it('LRU eviction: after 101 inserts, the first-inserted entry is no longer retrievable', () => {
    for (let i = 0; i < 101; i++) {
      cache.set(`t10-lru-key-${i}`, makeResult());
    }
    // key-0 was the first inserted and should have been evicted
    expect(cache.get('t10-lru-key-0')).toBeUndefined();
    // key-1 (the new LRU) should still be present
    expect(cache.get('t10-lru-key-1')).toBeDefined();
    // key-100 (most-recently inserted) should be present
    expect(cache.get('t10-lru-key-100')).toBeDefined();
  });

  // ── TTL expiry via vi.spyOn(Date, 'now') ──────────────────────────────────

  it('TTL: get() returns undefined when Date.now() is mocked to return +90_000_000ms (25h) in the future', () => {
    cache.set('ttl-spy-hash', makeResult());

    // Simulate 25 hours passing by mocking Date.now to return a value 90 000 000 ms
    // ahead of the entry's timestamp.
    const futureSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 90_000_000);
    try {
      expect(cache.get('ttl-spy-hash')).toBeUndefined();
    } finally {
      futureSpy.mockRestore();
    }
  });

  it('TTL: get() returns the entry when Date.now() is only +1h in the future (within TTL)', () => {
    cache.set('ttl-fresh-hash', makeResult());

    const oneHourAheadSpy = vi.spyOn(Date, 'now').mockReturnValue(
      Date.now() + 3_600_000, // 1 hour ahead — well within the 24h TTL
    );
    try {
      expect(cache.get('ttl-fresh-hash')).toBeDefined();
    } finally {
      oneHourAheadSpy.mockRestore();
    }
  });

  // ── Disk persistence ───────────────────────────────────────────────────────

  describe('TASK-010 disk persistence tests', () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cache-t10-'));
    });

    afterEach(async () => {
      await fs.rm(tmpDir, { recursive: true, force: true });
    });

    it('corrupt file: loadFromDisk does not throw and cache size remains 0', async () => {
      const tmpPath = path.join(tmpDir, 'corrupt.json');
      await fs.writeFile(tmpPath, 'not json', 'utf-8');

      // Suppress expected stderr warning to keep test output clean
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      try {
        await expect(cache.loadFromDisk(tmpPath)).resolves.toBeUndefined();
        const privateCache = (cache as unknown as { cache: Map<unknown, unknown> }).cache;
        expect(privateCache.size).toBe(0);
      } finally {
        stderrSpy.mockRestore();
      }
    });

    it('persistToDisk/loadFromDisk round-trip in os.tmpdir() preserves all entries', async () => {
      const r1 = makeResult({ framework: 'jest' });
      const r2 = makeResult({ framework: 'vitest' });
      cache.set('t10-roundtrip-a', r1);
      cache.set('t10-roundtrip-b', r2);

      const filePath = path.join(tmpDir, 't10-roundtrip.json');
      await cache.persistToDisk(filePath);

      const newCache = new CacheManager();
      await newCache.loadFromDisk(filePath);

      const hit1 = newCache.get('t10-roundtrip-a');
      const hit2 = newCache.get('t10-roundtrip-b');

      expect(hit1).toBeDefined();
      expect(hit1!.result.framework).toBe('jest');
      expect(hit2).toBeDefined();
      expect(hit2!.result.framework).toBe('vitest');
    });

    it('expired entries with timestamp 25h ago are not loaded from disk', async () => {
      const filePath = path.join(tmpDir, 't10-expired.json');

      // Build a fixture with one fresh entry and one 25-hour-old entry
      const twentyFiveHoursAgo = new Date(Date.now() - 90_000_000).toISOString();
      const entries = [
        {
          hash: 't10-fresh-hash',
          timestamp: new Date().toISOString(),
          result: makeResult(),
        },
        {
          hash: 't10-expired-hash',
          timestamp: twentyFiveHoursAgo,
          result: makeResult(),
        },
      ];
      await fs.writeFile(filePath, JSON.stringify(entries), 'utf-8');

      await cache.loadFromDisk(filePath);

      expect(cache.get('t10-fresh-hash')).toBeDefined();
      expect(cache.get('t10-expired-hash')).toBeUndefined();
    });
  });
});
