/**
 * CacheManager: LRU in-memory cache with 24-hour TTL and JSON persistence.
 *
 * Uses JavaScript Map insertion-order semantics for O(1) LRU eviction:
 *   - Least-recently-used = first key in Map
 *   - Most-recently-used  = last key in Map
 *
 * Bounded at MAX_SIZE (100) entries. Entries expire after TTL_MS (24 hours).
 */

import { promises as fs } from 'node:fs';
import type { CachedResult, NormalizedResult } from './types.js';

/** Maximum number of entries the cache may hold at once. */
const MAX_SIZE = 100;

/** Time-to-live in milliseconds: 24 hours. */
const TTL_MS = 86_400_000;

/**
 * LRU cache keyed by content hash.
 * Thread safety: Node.js is single-threaded; no locking is needed.
 */
export class CacheManager {
  private readonly cache: Map<string, CachedResult> = new Map();

  /**
   * Look up a cached result by content hash.
   *
   * Returns `undefined` when:
   *   - The hash is not present.
   *   - The entry's timestamp is older than 24 hours (entry is deleted).
   *
   * On a cache hit the entry is deleted then re-inserted so that it becomes
   * the most-recently-used (last) entry in the Map.
   */
  get(hash: string): CachedResult | undefined {
    const entry = this.cache.get(hash);
    if (entry === undefined) {
      return undefined;
    }

    // Evict expired entries on access.
    if (Date.now() - Date.parse(entry.timestamp) > TTL_MS) {
      this.cache.delete(hash);
      return undefined;
    }

    // Re-insert to mark as most-recently-used.
    this.cache.delete(hash);
    this.cache.set(hash, entry);

    return entry;
  }

  /**
   * Store a NormalizedResult in the cache under the given hash.
   *
   * If the cache already holds MAX_SIZE entries the least-recently-used entry
   * (the first key in Map insertion order) is evicted before inserting.
   *
   * If the hash already exists in the cache the existing entry is replaced and
   * the new entry becomes the most-recently-used.
   */
  set(hash: string, result: NormalizedResult): void {
    // Remove an existing entry first so the new one lands at the end (MRU).
    if (this.cache.has(hash)) {
      this.cache.delete(hash);
    } else if (this.cache.size >= MAX_SIZE) {
      // Evict the oldest (least-recently-used) entry.
      const lruKey = this.cache.keys().next().value as string;
      this.cache.delete(lruKey);
    }

    const entry: CachedResult = {
      result,
      timestamp: new Date().toISOString(),
      hash,
    };

    this.cache.set(hash, entry);
  }

  /**
   * Populate the in-memory cache from a JSON file written by `persistToDisk`.
   *
   * Error handling:
   *   - ENOENT         → silently returns (first run, no cache file yet).
   *   - Other read err → logs to stderr, returns with empty cache.
   *   - Corrupt JSON   → logs warning to stderr, returns with empty cache.
   *   - Wrong shape    → logs warning to stderr, returns with empty cache.
   *
   * Entries that are older than TTL_MS (24 h) at load time are skipped.
   * Entries missing required fields (result, timestamp, hash) are skipped.
   */
  async loadFromDisk(filePath: string): Promise<void> {
    let raw: string;

    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch (err) {
      if (isNodeError(err) && err.code === 'ENOENT') {
        // No cache file yet — this is the normal cold-start case.
        return;
      }
      process.stderr.write(
        `[CacheManager] Warning: could not read cache file "${filePath}": ${String(err)}\n`,
      );
      return;
    }

    let entries: unknown;
    try {
      entries = JSON.parse(raw);
    } catch (err) {
      process.stderr.write(
        `[CacheManager] Warning: corrupt cache file "${filePath}" (invalid JSON) — ` +
          `starting with empty cache. Detail: ${String(err)}\n`,
      );
      return;
    }

    if (!Array.isArray(entries)) {
      process.stderr.write(
        `[CacheManager] Warning: cache file "${filePath}" does not contain a JSON array — ` +
          `starting with empty cache.\n`,
      );
      return;
    }

    const now = Date.now();
    for (const entry of entries) {
      if (!isValidCachedResult(entry)) {
        continue; // Skip malformed entries silently.
      }
      if (now - Date.parse(entry.timestamp) > TTL_MS) {
        continue; // Skip entries that already expired.
      }
      // Preserve the original insertion order from the persisted file.
      this.cache.set(entry.hash, entry as CachedResult);
    }
  }

  /**
   * Persist all current cache entries to disk as a JSON array.
   *
   * Uses an atomic write pattern to prevent partial-write corruption:
   *   1. Serialize entries to JSON.
   *   2. Write to `filePath + '.tmp'`.
   *   3. Rename `.tmp` → `filePath` (atomic on POSIX via `rename(2)`).
   *
   * A SIGKILL between steps 2 and 3 leaves the old file intact.
   */
  async persistToDisk(filePath: string): Promise<void> {
    const entries = Array.from(this.cache.values());
    const json = JSON.stringify(entries, null, 2);
    const tmpPath = `${filePath}.tmp`;

    await fs.writeFile(tmpPath, json, 'utf-8');
    await fs.rename(tmpPath, filePath);
  }
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Type guard: returns true when `entry` has the minimum required shape for a
 * CachedResult — a non-null object with string `hash`, string `timestamp`,
 * and object `result`.  Full deep validation is intentionally omitted to keep
 * recovery fast; downstream consumers treat NormalizedResult as trusted data
 * after it is retrieved from the cache.
 */
function isValidCachedResult(entry: unknown): entry is CachedResult {
  if (typeof entry !== 'object' || entry === null) {
    return false;
  }
  const e = entry as Record<string, unknown>;
  return (
    typeof e['hash'] === 'string' &&
    e['hash'].length > 0 &&
    typeof e['timestamp'] === 'string' &&
    e['timestamp'].length > 0 &&
    typeof e['result'] === 'object' &&
    e['result'] !== null
  );
}

/**
 * Type guard: narrows `err` to a Node.js `ErrnoException` so callers can
 * safely access `.code` without a cast.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

// Dual export: named (for tree-shaking / explicit imports) + default (for
// convenience in orchestrator code).
export default CacheManager;
