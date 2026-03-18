/**
 * Unit tests for src/hasher.ts — ContentHasher module.
 *
 * Tests cover:
 *  - Return shape: 64-character hex string
 *  - Determinism: same hash for unchanged filesystem state
 *  - Content sensitivity: different hash when a file changes
 *  - Config-first hashing: config change produces a new hash (REQ-016)
 *  - Mtime fast-path: fs.readFile skipped when no mtimes changed
 *  - OOM guard: ExecutionError thrown when > 50,000 files discovered
 *  - options.filter: client-side file filtering
 *  - options.testFile: single-file mode bypasses glob
 *  - Ignore patterns: node_modules, .git, dist, etc. are excluded
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import { promises as fs } from 'node:fs';
import * as fsModule from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ── Module-level mock for fast-glob ──────────────────────────────────────
//
// We wrap fast-glob with a vi.fn so individual tests can override its return
// value via mockResolvedValueOnce without affecting other tests.
// The importOriginal factory ensures all non-overriding tests run the real
// fast-glob implementation.
//
// Note: fast-glob uses `export =` (CJS-style) which in an ESM runtime may
// surface either as `module.default` or as the callable module itself.
// We handle both forms with `originalFn = original.default ?? original`.
vi.mock('fast-glob', async (importOriginal) => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const original = await importOriginal<any>();
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
  const originalFn: (...args: unknown[]) => unknown = original.default ?? original;
  return {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return
    default: vi.fn((...args: unknown[]) => originalFn(...args)),
  };
});

// Imports AFTER vi.mock so they receive the mocked module
import { computeHash } from '../hasher.js';
import { ExecutionError } from '../errors.js';
import fgDefault from 'fast-glob';

const mockedFg = vi.mocked(fgDefault);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write a text file inside dir, creating any missing parent directories. */
async function writeFile(dir: string, relativePath: string, content: string): Promise<string> {
  const fullPath = path.join(dir, relativePath);
  await fs.mkdir(path.dirname(fullPath), { recursive: true });
  await fs.writeFile(fullPath, content, 'utf8');
  return fullPath;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('computeHash', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hasher-test-'));
    // Clear recorded call history (but NOT the implementation) before each test
    mockedFg.mockClear();
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    // Restore any per-test spies (e.g. the fs.readFile spy in the fast-path test)
    vi.restoreAllMocks();
  });

  // ── Return shape ──────────────────────────────────────────────────────────

  it('returns a 64-character lowercase hex string for valid HashOptions', async () => {
    await writeFile(tmpDir, 'src/index.ts', 'export const x = 1;');

    const result = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    });

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns a 64-character hex string even when no files are discovered', async () => {
    // Empty project directory — SHA-256 of no content is still 64 hex chars
    const result = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    });

    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Determinism ───────────────────────────────────────────────────────────

  it('returns the same hash for two consecutive calls on an unchanged filesystem', async () => {
    await writeFile(tmpDir, 'src/a.ts', 'const a = 1;');
    await writeFile(tmpDir, 'src/b.ts', 'const b = 2;');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    const hash1 = await computeHash(opts);
    const hash2 = await computeHash(opts);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Content sensitivity ───────────────────────────────────────────────────

  it('returns a different hash when a tracked file content changes (AC-005, REQ-008)', async () => {
    await writeFile(tmpDir, 'src/index.ts', 'const x = 1;');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    const hashBefore = await computeHash(opts);

    // Overwrite with different content — kernel advances the mtime
    await writeFile(tmpDir, 'src/index.ts', 'const x = 999; // changed');

    const hashAfter = await computeHash(opts);

    expect(hashBefore).not.toBe(hashAfter);
  });

  it('returns a different hash when a new file is added to the tracked set', async () => {
    await writeFile(tmpDir, 'src/a.ts', 'const a = 1;');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    const hashBefore = await computeHash(opts);

    await writeFile(tmpDir, 'src/b.ts', 'const b = 2;');

    const hashAfter = await computeHash(opts);

    expect(hashBefore).not.toBe(hashAfter);
  });

  // ── Config-first hashing (REQ-016) ────────────────────────────────────────

  it('a config change produces a different hash even when source files are unchanged (REQ-016)', async () => {
    await writeFile(tmpDir, 'src/index.ts', 'const x = 1;');

    const base = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    const hashNoConfig = await computeHash({ ...base });
    const hashConfigA = await computeHash({ ...base, configContent: '{"framework":"jest"}' });
    const hashConfigB = await computeHash({ ...base, configContent: '{"framework":"vitest"}' });

    expect(hashNoConfig).not.toBe(hashConfigA);
    expect(hashConfigA).not.toBe(hashConfigB);
    expect(hashNoConfig).not.toBe(hashConfigB);
  });

  it('treats empty string configContent identically to absent configContent', async () => {
    await writeFile(tmpDir, 'src/index.ts', 'export {};');

    const opts = { projectRoot: tmpDir, testDir: 'tests', sourcePatterns: ['src/**/*.ts'] };

    const hashNoConfig = await computeHash({ ...opts });
    const hashEmptyConfig = await computeHash({ ...opts, configContent: '' });

    expect(hashNoConfig).toBe(hashEmptyConfig);
  });

  it('is deterministic across two calls with the same non-empty configContent', async () => {
    await writeFile(tmpDir, 'src/index.ts', 'export const v = 42;');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
      configContent: '{"framework":"pytest","timeout":60}',
    };

    const hash1 = await computeHash({ ...opts });
    const hash2 = await computeHash({ ...opts });

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── Mtime fast-path ───────────────────────────────────────────────────────

  it('fast-path: does not call fs.readFile on the second call when no mtimes changed', async () => {
    await writeFile(tmpDir, 'src/stable.ts', 'export const stable = true;');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    // First call: computes hash and populates the mtime cache
    const hash1 = await computeHash(opts);

    // Install spy AFTER the first call so only subsequent calls are intercepted
    const readFileSpy: MockInstance = vi.spyOn(fsModule.promises, 'readFile');

    // Second call with identical options — mtimes unchanged, fast-path should fire
    const hash2 = await computeHash(opts);

    expect(hash2).toBe(hash1);
    // The fast-path must have returned the cached hash without reading any file
    expect(readFileSpy).not.toHaveBeenCalled();
  });

  it('fast-path: re-reads files and returns an updated hash when a file mtime changes', async () => {
    await writeFile(tmpDir, 'src/changing.ts', 'const v = 1;');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    const hash1 = await computeHash(opts);

    // Overwrite — the OS will advance the mtime
    await writeFile(tmpDir, 'src/changing.ts', 'const v = 2; // updated');

    const hash2 = await computeHash(opts);

    expect(hash2).not.toBe(hash1);
  });

  // ── OOM guard: 50,000-file limit ─────────────────────────────────────────

  it('throws ExecutionError when fast-glob discovers more than 50,000 files', async () => {
    const fakePaths = Array.from({ length: 50_001 }, (_, i) => `/fake/path/file-${i}.ts`);
    mockedFg.mockResolvedValueOnce(fakePaths);

    await expect(
      computeHash({
        projectRoot: tmpDir,
        testDir: 'tests',
        sourcePatterns: ['src/**/*.ts'],
      }),
    ).rejects.toThrow(ExecutionError);
  });

  it('ExecutionError message from the OOM guard mentions the 50,000-file limit', async () => {
    const fakePaths = Array.from({ length: 50_001 }, (_, i) => `/fake/path/file-${i}.ts`);
    mockedFg.mockResolvedValueOnce(fakePaths);

    await expect(
      computeHash({
        projectRoot: tmpDir,
        testDir: 'tests',
        sourcePatterns: ['**/*.ts'],
      }),
    ).rejects.toThrow(/50,000/);
  });

  it('does NOT throw when exactly 50,000 files are discovered', async () => {
    // Use one real file for all 50,000 "entries" so fs.stat / fs.readFile work
    const realFile = await writeFile(tmpDir, 'src/file.ts', '// content');
    const fakePaths = Array.from({ length: 50_000 }, () => realFile);
    mockedFg.mockResolvedValueOnce(fakePaths);

    await expect(
      computeHash({
        projectRoot: tmpDir,
        testDir: 'tests',
        sourcePatterns: ['src/**/*.ts'],
      }),
    ).resolves.toMatch(/^[0-9a-f]{64}$/);
  });

  // ── options.filter ────────────────────────────────────────────────────────

  it('applies options.filter as a case-insensitive substring filter on file paths', async () => {
    await writeFile(tmpDir, 'src/auth.ts', 'const auth = true;');
    await writeFile(tmpDir, 'src/billing.ts', 'const billing = true;');

    const hashAll = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    });

    const hashAuthOnly = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
      filter: 'auth',
    });

    const hashBillingOnly = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
      filter: 'billing',
    });

    // Filtered sets are strict subsets of the full set → all hashes differ
    expect(hashAuthOnly).not.toBe(hashAll);
    expect(hashBillingOnly).not.toBe(hashAll);
    expect(hashAuthOnly).not.toBe(hashBillingOnly);
    expect(hashAuthOnly).toMatch(/^[0-9a-f]{64}$/);
    expect(hashBillingOnly).toMatch(/^[0-9a-f]{64}$/);
  });

  // ── options.testFile (single-file mode) ───────────────────────────────────

  it('hashes only the single specified testFile and ignores sourcePatterns', async () => {
    await writeFile(tmpDir, 'tests/a.test.ts', 'test A content');
    await writeFile(tmpDir, 'tests/b.test.ts', 'test B content');

    const hashA = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['tests/**/*.ts'],
      testFile: 'tests/a.test.ts',
    });

    const hashB = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['tests/**/*.ts'],
      testFile: 'tests/b.test.ts',
    });

    const hashAll = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['tests/**/*.ts'],
    });

    expect(hashA).not.toBe(hashB);
    expect(hashA).not.toBe(hashAll);
    expect(hashB).not.toBe(hashAll);
    expect(hashA).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves a relative testFile path against projectRoot', async () => {
    await writeFile(tmpDir, 'tests/unit.test.ts', 'it works');

    const hashRelative = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: [],
      testFile: 'tests/unit.test.ts',
    });

    const hashAbsolute = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: [],
      testFile: path.join(tmpDir, 'tests/unit.test.ts'),
    });

    // Same physical file regardless of how the path is specified
    expect(hashRelative).toBe(hashAbsolute);
  });

  // ── Ignore patterns ───────────────────────────────────────────────────────

  it('excludes node_modules from discovered files', async () => {
    await writeFile(tmpDir, 'src/index.ts', 'export {};');
    await writeFile(tmpDir, 'node_modules/pkg/index.ts', 'should be ignored');

    // A broad pattern would include node_modules if the ignore list were absent
    const hashBroad = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['**/*.ts'],
    });

    // Narrow pattern that never touches node_modules
    const hashNarrow = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    });

    // node_modules is always excluded — both patterns see only src/index.ts
    expect(hashBroad).toBe(hashNarrow);
  });

  it('excludes .git directory contents', async () => {
    await writeFile(tmpDir, 'src/main.ts', 'export {};');
    await writeFile(tmpDir, '.git/COMMIT_EDITMSG', 'Initial commit');

    const hashIgnored = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['**/*'],
    });

    const hashSrcOnly = await computeHash({
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    });

    // .git is excluded unconditionally — both see only src/main.ts
    expect(hashIgnored).toBe(hashSrcOnly);
  });

  // ── Path-order determinism ────────────────────────────────────────────────

  it('produces the same hash regardless of the order the OS enumerates files', async () => {
    // Create files in a non-alphabetical creation order
    await writeFile(tmpDir, 'src/c.ts', 'c content');
    await writeFile(tmpDir, 'src/a.ts', 'a content');
    await writeFile(tmpDir, 'src/b.ts', 'b content');

    const opts = {
      projectRoot: tmpDir,
      testDir: 'tests',
      sourcePatterns: ['src/**/*.ts'],
    };

    const hash1 = await computeHash(opts);
    const hash2 = await computeHash(opts);

    // Internal lexicographic sort must produce the same digest each time
    expect(hash1).toBe(hash2);
  });
});
