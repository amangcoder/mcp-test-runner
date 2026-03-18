/**
 * Content hasher for the test-runner MCP server.
 *
 * Computes a SHA-256 hash over the sorted contents of all source and test files
 * matching the given options, providing a stable cache key for test result caching.
 *
 * Features:
 *  - Deterministic: paths sorted lexicographically before hashing
 *  - Config-change-aware: configContent hashed first (REQ-016)
 *  - Mtime fast-path: skips re-reading files when no mtimes have changed
 *  - OOM guard: throws ExecutionError when more than 50,000 files are discovered
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';

import type { HashOptions } from './types.js';
import { ExecutionError } from './errors.js';

/** Maximum number of files allowed before throwing an OOM guard error. */
const MAX_FILES = 50_000;

/**
 * Glob ignore patterns applied unconditionally to every discovery call.
 * These directories/files are never hashed regardless of sourcePatterns.
 */
const IGNORE_PATTERNS: readonly string[] = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/__pycache__/**',
  '**/*.pyc',
  '**/.mcp-test-runner-cache.json',
];

/**
 * Shape of a single mtime cache entry.
 * Stores the per-file mtimes recorded during the last hash computation
 * and the resulting hash value.
 */
interface MtimeCacheEntry {
  /** Map of absolute file path → mtimeMs at the time of the last hash. */
  mtimes: Record<string, number>;
  /** The SHA-256 hex digest produced during the last hash computation. */
  hash: string;
}

/**
 * Module-level mtime cache keyed by a stable scope identifier.
 *
 * The scope identifier encodes all the parameters that determine which files
 * are discovered so that different call signatures never share a cache entry.
 * The cache is intentionally module-level (process lifetime) — it is not
 * persisted to disk and is automatically cleared on process restart.
 */
const mtimeCache = new Map<string, MtimeCacheEntry>();

/**
 * Build a stable, JSON-serialised scope identifier from the given HashOptions.
 *
 * The identifier includes every field that affects which files are discovered
 * (projectRoot, testDir, sourcePatterns, filter, testFile) as well as
 * configContent so that a configuration change always produces a new scope key
 * and therefore never accidentally returns a stale fast-path result.
 *
 * sourcePatterns is sorted before serialisation to ensure two callers that
 * pass the same patterns in different order get the same scope key.
 */
function buildScopeId(options: HashOptions): string {
  return JSON.stringify({
    projectRoot: options.projectRoot,
    testDir: options.testDir,
    sourcePatterns: [...options.sourcePatterns].sort(),
    filter: options.filter ?? null,
    testFile: options.testFile ?? null,
    configContent: options.configContent ?? null,
  });
}

/**
 * Resolve the set of absolute file paths that should contribute to the hash.
 *
 * When options.testFile is present only that single file is returned (no
 * globbing performed).  Otherwise fast-glob is used to expand
 * options.sourcePatterns and options.testDir, apply the hardcoded ignore list,
 * and optionally apply a client-side substring filter if options.filter is set.
 *
 * Throws ExecutionError if more than MAX_FILES files are discovered.
 */
async function discoverFiles(options: HashOptions): Promise<string[]> {
  const { projectRoot, testDir, sourcePatterns, filter, testFile } = options;

  // --- Single-file mode (run_single_test) ---
  if (testFile !== undefined && testFile.length > 0) {
    const resolved = path.isAbsolute(testFile)
      ? testFile
      : path.resolve(projectRoot, testFile);
    return [resolved];
  }

  // --- Multi-file mode: glob sourcePatterns + testDir ---

  // Normalise testDir to a path relative to projectRoot so that fast-glob
  // (which operates with cwd=projectRoot) can use it as a glob base.
  const testDirRel = path.isAbsolute(testDir)
    ? path.relative(projectRoot, testDir)
    : testDir;

  // Combine caller-supplied source patterns with a recursive pattern rooted
  // at the test directory.  fast-glob deduplicates results internally.
  const patterns: string[] = [...sourcePatterns, `${testDirRel}/**`];

  const discovered: string[] = await fg(patterns, {
    cwd: projectRoot,
    absolute: true,
    ignore: IGNORE_PATTERNS as string[],
    // dot: true so that hidden files (other than those excluded by ignore
    // patterns) are included when explicitly targeted by sourcePatterns.
    dot: true,
    followSymbolicLinks: false,
  });

  if (discovered.length > MAX_FILES) {
    throw new ExecutionError(
      `Content hasher discovered ${discovered.length} files, which exceeds the ` +
        `${MAX_FILES.toLocaleString()}-file limit. ` +
        'Narrow your sourcePatterns or testDir to reduce the file count.',
    );
  }

  // Client-side filter: when options.filter is provided, keep only paths
  // whose basename (lowercased) contains the filter string (lowercased).
  // This is intentionally simple substring matching — the filter is primarily
  // used to scope the hash to a subset of tests, not as a strict glob.
  if (filter !== undefined && filter.length > 0) {
    const needle = filter.toLowerCase();
    return discovered.filter((fp) => fp.toLowerCase().includes(needle));
  }

  return discovered;
}

/**
 * Compute a SHA-256 content hash over the project's source and test files.
 *
 * Steps:
 *  1. Discover matching files via fast-glob (or use testFile directly).
 *  2. Sort absolute paths lexicographically for determinism.
 *  3. Stat every file.  If all mtimes match the cached entry for this scope,
 *     return the previously computed hash (mtime fast-path — no file reads).
 *  4. If options.configContent is non-empty, feed it into the hash first
 *     so that any config change always produces a different digest (REQ-016).
 *  5. Feed each file's content into the hash incrementally (no concatenation)
 *     keyed by `"${absolutePath}:${content}"` to prevent cross-file collisions.
 *  6. Store the new mtimes + digest in the module-level cache and return the
 *     64-character hex digest.
 *
 * @param options - Scope and configuration for file discovery and hashing.
 * @returns A 64-character lowercase hexadecimal SHA-256 digest.
 * @throws {ExecutionError} When more than 50,000 files match the glob patterns.
 */
export async function computeHash(options: HashOptions): Promise<string> {
  // ── Step 1 & 2: Discover and sort files ──────────────────────────────────
  const filePaths = (await discoverFiles(options)).sort();

  // ── Step 3: Mtime fast-path ───────────────────────────────────────────────
  // Stat all discovered files in parallel to check whether any have changed
  // since the last call with the same scope.
  const statResults = await Promise.all(
    filePaths.map(async (fp) => {
      try {
        const stat = await fs.stat(fp);
        return { fp, mtime: stat.mtimeMs };
      } catch {
        // File disappeared between glob and stat — treat as unknown (mtime -1)
        // so that the fast-path is never incorrectly used for missing files.
        return { fp, mtime: -1 };
      }
    }),
  );

  const currentMtimes: Record<string, number> = {};
  for (const { fp, mtime } of statResults) {
    currentMtimes[fp] = mtime;
  }

  const scopeId = buildScopeId(options);
  const cached = mtimeCache.get(scopeId);

  if (cached !== undefined) {
    const cachedKeys = Object.keys(cached.mtimes);
    const currentKeys = Object.keys(currentMtimes);

    // Fast-path: all files present, all mtimes identical → return cached hash.
    if (
      currentKeys.length === cachedKeys.length &&
      currentKeys.every((k) => currentMtimes[k] === cached.mtimes[k])
    ) {
      return cached.hash;
    }
  }

  // ── Step 4 & 5: Compute hash incrementally ───────────────────────────────
  const hash = createHash('sha256');

  // Config content is hashed FIRST so that any change to .mcp-test-runner.json
  // invalidates the cache even when no source/test files have changed (REQ-016).
  const { configContent } = options;
  if (configContent != null && configContent.length > 0) {
    hash.update(`config:${configContent}`);
  }

  // Read and hash each file's content incrementally.
  // Using `filePath + ':' + content` as the update string ensures that two
  // files with identical content but different paths produce different hashes.
  // Never accumulate all content into a single string (OOM prevention).
  for (const fp of filePaths) {
    const content = await fs.readFile(fp, 'utf8');
    hash.update(`${fp}:${content}`);
  }

  // ── Step 6: Finalise and cache ────────────────────────────────────────────
  const digest = hash.digest('hex');

  mtimeCache.set(scopeId, { mtimes: currentMtimes, hash: digest });

  return digest;
}
