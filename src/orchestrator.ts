/**
 * src/orchestrator.ts
 *
 * Central integration layer for the test-runner MCP server.
 *
 * Wires together: ContentHasher → CacheManager → TestExecutor → OutputParserFactory
 * and enforces security validations before any compute or execution.
 *
 * Security model:
 *  1. Input allowlist — filter and testName are validated against a strict
 *     character allowlist to prevent command injection.
 *  2. Path traversal guard — testFile is resolved relative to testDir and
 *     verified to remain within projectRoot.
 *  3. All execution is delegated to executor.ts which enforces shell:false
 *     and a command allowlist at the process spawn level.
 */

import os from 'node:os';
import path from 'node:path';
import { unlink } from 'node:fs/promises';

import { computeHash } from './hasher.js';
import { execute } from './executor.js';
import { parse } from './parsers/index.js';
import {
  CommandInjectionError,
  PathTraversalError,
  TimeoutError,
  ExecutionError,
} from './errors.js';
import type { ResolvedConfig, NormalizedResult, ExecutionResult } from './types.js';
import { CacheManager } from './cache.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Allowlist regex for user-supplied filter and testName parameters.
 *
 * Permits alphanumerics, common path/glob characters, and test-framework
 * filtering syntax. Shell metacharacters (;|&$`!<>{}()) are NOT in this set
 * and will cause validateInput() to throw CommandInjectionError.
 */
const INPUT_ALLOWLIST_RE = /^[a-zA-Z0-9_.*/\-\[\]:@#\s]+$/;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Coordinates the full test execution pipeline:
 *   1. Security validation of user inputs
 *   2. Content hash computation for cache keying
 *   3. Cache lookup (unless skipCache is set)
 *   4. Test runner execution (cache miss or skipCache)
 *   5. Error triage (timeout, infrastructure errors vs. test failures)
 *   6. Output parsing (JUnit XML or JSON)
 *   7. Cache storage of the new result
 *   8. Return of NormalizedResult
 */
export class TestOrchestrator {
  private readonly config: ResolvedConfig;
  private readonly cacheManager: CacheManager;

  constructor(config: ResolvedConfig, cacheManager: CacheManager) {
    this.config = config;
    this.cacheManager = cacheManager;
  }

  // ─── Public methods ────────────────────────────────────────────────────────

  /**
   * Run all tests (or a filtered subset) in the configured test directory.
   *
   * @param options.filter    - Optional test filter (pattern/name passed to the
   *                            framework CLI). Must match INPUT_ALLOWLIST_RE.
   * @param options.skipCache - When true, bypass the cache and always execute.
   * @param options.timeout   - Override timeout in seconds (default: config.timeout).
   *
   * @returns NormalizedResult with fromCache:true on a cache hit or
   *          fromCache:false after a fresh test execution.
   *
   * @throws {CommandInjectionError} if filter contains shell metacharacters.
   * @throws {TimeoutError}          if the test runner exceeds the timeout.
   * @throws {ExecutionError}        if the test runner binary is not found (ENOENT)
   *                                 or exits with an unrecoverable error code.
   * @throws {ParseError}            if the structured output cannot be parsed.
   */
  async runTests(options: {
    filter?: string;
    skipCache?: boolean;
    timeout?: number;
  }): Promise<NormalizedResult> {
    const { filter, skipCache = false } = options;

    // ── Security: validate filter ─────────────────────────────────────────
    if (filter !== undefined && filter.length > 0) {
      this.validateInput(filter, 'filter');
    }

    const effectiveTimeoutMs = (options.timeout ?? this.config.timeout) * 1000;

    // ── Step 1: Compute content hash ──────────────────────────────────────
    const hash = await computeHash({
      projectRoot: this.config.projectRoot,
      testDir: this.config.testDir,
      sourcePatterns: this.config.sourcePatterns,
      filter,
      configContent: this.config.configContent,
    });

    // ── Step 2: Cache lookup ──────────────────────────────────────────────
    if (!skipCache) {
      const cached = this.cacheManager.get(hash);
      if (cached !== undefined) {
        return { ...cached.result, fromCache: true };
      }
    }

    // ── Steps 3–10: Execute, parse, cache, return ─────────────────────────
    const tmpFile = buildTmpFilePath();
    try {
      const { command, args } = this.buildRunTestsArgs(filter, tmpFile);

      const execResult = await execute({
        command,
        args,
        cwd: this.config.projectRoot,
        timeout: effectiveTimeoutMs,
        env: {},
        // Do NOT pass outputFile here — we manage tmpFile cleanup ourselves
        // in the finally block below. The executor would delete it prematurely
        // before the parser has a chance to read it.
      });

      const result = this.triageAndParse(execResult, tmpFile, effectiveTimeoutMs);
      result.fromCache = false;
      this.cacheManager.set(hash, result);
      return result;
    } finally {
      await deleteTmpFile(tmpFile);
    }
  }

  /**
   * Run a single test file, optionally filtered to a specific test name.
   *
   * @param options.testFile  - Required relative path to the test file.
   *                            Resolved against testDir; must stay within projectRoot.
   * @param options.testName  - Optional test name filter. Must match INPUT_ALLOWLIST_RE.
   * @param options.skipCache - When true, bypass the cache and always execute.
   * @param options.timeout   - Override timeout in seconds (default: config.timeout).
   *
   * @throws {CommandInjectionError} if testName contains shell metacharacters.
   * @throws {PathTraversalError}    if testFile resolves outside projectRoot.
   * @throws {TimeoutError}          if the test runner exceeds the timeout.
   * @throws {ExecutionError}        if the test runner binary is not found (ENOENT)
   *                                 or exits with an unrecoverable error code.
   * @throws {ParseError}            if the structured output cannot be parsed.
   */
  async runSingleTest(options: {
    testFile: string;
    testName?: string;
    skipCache?: boolean;
    timeout?: number;
  }): Promise<NormalizedResult> {
    const { testFile, testName, skipCache = false } = options;

    // ── Security: validate testName ───────────────────────────────────────
    if (testName !== undefined && testName.length > 0) {
      this.validateInput(testName, 'testName');
    }

    // ── Security: validate testFile path traversal ────────────────────────
    const resolvedTestFile = this.validateTestFilePath(testFile);

    const effectiveTimeoutMs = (options.timeout ?? this.config.timeout) * 1000;

    // ── Compute content hash (single-file scope) ──────────────────────────
    const hash = await computeHash({
      projectRoot: this.config.projectRoot,
      testDir: this.config.testDir,
      sourcePatterns: this.config.sourcePatterns,
      testFile: resolvedTestFile,
      configContent: this.config.configContent,
    });

    // ── Cache lookup ──────────────────────────────────────────────────────
    if (!skipCache) {
      const cached = this.cacheManager.get(hash);
      if (cached !== undefined) {
        return { ...cached.result, fromCache: true };
      }
    }

    // ── Execute, parse, cache, return ─────────────────────────────────────
    const tmpFile = buildTmpFilePath();
    try {
      const { command, args } = this.buildRunSingleTestArgs(
        resolvedTestFile,
        testName,
        tmpFile,
      );

      const execResult = await execute({
        command,
        args,
        cwd: this.config.projectRoot,
        timeout: effectiveTimeoutMs,
        env: {},
      });

      const result = this.triageAndParse(execResult, tmpFile, effectiveTimeoutMs);
      result.fromCache = false;
      this.cacheManager.set(hash, result);
      return result;
    } finally {
      await deleteTmpFile(tmpFile);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /**
   * Validates a user-supplied string against the input allowlist.
   *
   * @throws {CommandInjectionError} if the value contains characters outside
   *         the allowlist (i.e. shell metacharacters or other unsafe input).
   */
  private validateInput(value: string, paramName: string): void {
    if (!INPUT_ALLOWLIST_RE.test(value)) {
      throw new CommandInjectionError(
        `Parameter '${paramName}' contains disallowed characters. ` +
          `Only alphanumerics and safe punctuation (${INPUT_ALLOWLIST_RE.source}) are permitted. ` +
          `Shell metacharacters (; | & $ \` ! < > { } ( )) are not allowed.`,
      );
    }
  }

  /**
   * Resolves testFile relative to config.testDir and verifies it remains
   * within config.projectRoot.
   *
   * @returns The resolved absolute path.
   * @throws {PathTraversalError} if the resolved path is outside projectRoot.
   */
  private validateTestFilePath(testFile: string): string {
    const { projectRoot, testDir } = this.config;
    const resolvedPath = path.resolve(testDir, testFile);
    if (!resolvedPath.startsWith(projectRoot)) {
      throw new PathTraversalError(
        `testFile '${testFile}' resolves to '${resolvedPath}', ` +
          `which is outside the project root '${projectRoot}'.`,
      );
    }
    return resolvedPath;
  }

  /**
   * Error triage and output parsing shared by runTests and runSingleTest.
   *
   * Triage rules:
   *  - timedOut:true  → throw TimeoutError (always, before checking exit code)
   *  - ENOENT errors  → already thrown by execute() as ExecutionError (propagate up)
   *  - exitCode 0 | 1 → attempt parse (test failures are structured results, REQ-011)
   *  - exitCode >1, pytest → throw ExecutionError (always an infrastructure error)
   *  - exitCode >1, jest/vitest → attempt parse; throw ExecutionError if parse fails
   */
  private triageAndParse(
    execResult: ExecutionResult,
    tmpFile: string,
    effectiveTimeoutMs: number,
  ): NormalizedResult {
    // Timeout check — must come before exit code checks
    if (execResult.timedOut) {
      throw new TimeoutError(
        `Test run timed out after ${effectiveTimeoutMs}ms. ` +
          `Increase the timeout or narrow the test scope.`,
      );
    }

    const { framework } = this.config;

    // Pytest: any exit code > 1 is an infrastructure error, never parseable.
    if (execResult.exitCode > 1 && framework === 'pytest') {
      throw new ExecutionError(
        `pytest exited with code ${execResult.exitCode}. ` +
          `This indicates an infrastructure error (not test failures).`,
        execResult.exitCode,
        execResult.stderr,
      );
    }

    // Attach the tmpFile so the parser can read structured output from disk.
    // The file is still present here because we did NOT pass outputFile to
    // execute() — cleanup is deferred to the finally block in the calling method.
    const execResultWithFile: ExecutionResult = { ...execResult, outputFile: tmpFile };

    // For jest/vitest with exitCode > 1: attempt parse first, throw only if it fails.
    // For all other cases (exitCode 0, 1): parse unconditionally.
    try {
      return parse(framework, execResultWithFile);
    } catch (parseErr) {
      if (execResult.exitCode > 1) {
        // Parse failed after a high exit code — treat as infrastructure error.
        throw new ExecutionError(
          `${framework} exited with code ${execResult.exitCode} and output could not be parsed. ` +
            `This likely indicates an infrastructure error rather than test failures.`,
          execResult.exitCode,
          execResult.stderr,
        );
      }
      // exitCode 0 or 1 with an unparseable output → re-throw as ParseError
      // (the parse module already wraps these correctly).
      throw parseErr;
    }
  }

  /**
   * Build framework-specific CLI args for running the full test suite.
   *
   * Each element of the returned args array is a discrete argument —
   * no shell interpolation is performed (shell:false is enforced by executor).
   */
  private buildRunTestsArgs(
    filter: string | undefined,
    tmpFile: string,
  ): { command: string; args: string[] } {
    const { framework } = this.config;

    switch (framework) {
      case 'pytest':
        return {
          command: 'pytest',
          args: [
            '--junitxml', tmpFile,
            '-v',
            ...(filter ? ['-k', filter] : []),
          ],
        };

      case 'jest':
        return {
          command: 'npx',
          args: [
            'jest',
            '--json',
            '--outputFile', tmpFile,
            ...(filter ? ['--testPathPattern', filter] : []),
          ],
        };

      case 'vitest':
        return {
          command: 'npx',
          args: [
            'vitest',
            'run',
            '--reporter=json',
            '--outputFile', tmpFile,
            ...(filter ? ['--grep', filter] : []),
          ],
        };

      default: {
        // TypeScript exhaustiveness guard.
        const _exhaustive: never = framework;
        throw new Error(`Unrecognized framework: "${String(_exhaustive)}"`);
      }
    }
  }

  /**
   * Build framework-specific CLI args for running a single test file.
   *
   * Adds single-file targeting and optional test-name filtering on top of
   * the base args produced for a full run.
   */
  private buildRunSingleTestArgs(
    resolvedTestFile: string,
    testName: string | undefined,
    tmpFile: string,
  ): { command: string; args: string[] } {
    const { framework } = this.config;

    switch (framework) {
      case 'pytest':
        return {
          command: 'pytest',
          args: [
            '--junitxml', tmpFile,
            '-v',
            resolvedTestFile,
            ...(testName ? ['-k', testName] : []),
          ],
        };

      case 'jest':
        return {
          command: 'npx',
          args: [
            'jest',
            '--json',
            '--outputFile', tmpFile,
            '--testPathPattern', resolvedTestFile,
            ...(testName ? ['--testNamePattern', testName] : []),
          ],
        };

      case 'vitest':
        return {
          command: 'npx',
          args: [
            'vitest',
            'run',
            '--reporter=json',
            '--outputFile', tmpFile,
            resolvedTestFile,
            ...(testName ? ['--grep', testName] : []),
          ],
        };

      default: {
        const _exhaustive: never = framework;
        throw new Error(`Unrecognized framework: "${String(_exhaustive)}"`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Module-level helpers (not exported — internal implementation detail)
// ---------------------------------------------------------------------------

/**
 * Generate a unique temp file path for test runner structured output.
 * Uses both Date.now() and Math.random() to minimise the chance of
 * collisions in concurrent call scenarios (e.g. parallel MCP requests).
 */
function buildTmpFilePath(): string {
  return path.join(os.tmpdir(), `mcp-test-${Date.now()}-${Math.random()}`);
}

/**
 * Attempt to delete a temp file, suppressing any error.
 * Called unconditionally from finally blocks — the file may not exist
 * if the test runner was killed before it could write output.
 */
async function deleteTmpFile(filePath: string): Promise<void> {
  try {
    await unlink(filePath);
  } catch {
    // File was never created or already removed — not an error.
  }
}
