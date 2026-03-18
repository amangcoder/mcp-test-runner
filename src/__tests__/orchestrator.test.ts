/**
 * src/__tests__/orchestrator.test.ts
 *
 * Unit tests for TestOrchestrator (TASK-008).
 *
 * All external dependencies (computeHash, execute, parse, CacheManager,
 * fs.unlink) are fully mocked so tests run in-process without spawning
 * child processes or touching the filesystem.
 *
 * Coverage:
 *  - AC-004: Cache hit returns fromCache:true in under 50 ms
 *  - AC-005: Cache miss executes runner, returns fromCache:false
 *  - AC-010: skipCache:true bypasses cache even when a valid entry exists
 *  - CommandInjectionError for filter / testName with shell metacharacters
 *  - PathTraversalError for testFile escaping projectRoot
 *  - REQ-011: exit code 0/1 produces NormalizedResult, does NOT throw
 *  - AC-008: timedOut:true throws TimeoutError
 *  - Framework CLI args (--junitxml / --outputFile)
 *  - Temp file deleted in finally (success and failure paths)
 *  - runSingleTest single-file and test-name filtering args
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — hoisted before any import
// ---------------------------------------------------------------------------

vi.mock('../hasher.js', () => ({
  computeHash: vi.fn(),
}));

vi.mock('../executor.js', () => ({
  execute: vi.fn(),
}));

vi.mock('../parsers/index.js', () => ({
  parse: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  unlink: vi.fn(),
  // Other fs promises used by CacheManager (not needed here)
  writeFile: vi.fn(),
  rename: vi.fn(),
  readFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks are in place)
// ---------------------------------------------------------------------------

import { computeHash } from '../hasher.js';
import { execute } from '../executor.js';
import { parse } from '../parsers/index.js';
import { unlink } from 'node:fs/promises';
import { TestOrchestrator } from '../orchestrator.js';
import { CacheManager } from '../cache.js';
import {
  CommandInjectionError,
  PathTraversalError,
  TimeoutError,
  ExecutionError,
  ParseError,
} from '../errors.js';
import type { ResolvedConfig, NormalizedResult, ExecutionResult } from '../types.js';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockComputeHash = vi.mocked(computeHash);
const mockExecute = vi.mocked(execute);
const mockParse = vi.mocked(parse);
const mockUnlink = vi.mocked(unlink);

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const PROJECT_ROOT = '/project';

function makeConfig(
  overrides: Partial<ResolvedConfig> = {},
): ResolvedConfig {
  return {
    framework: 'pytest',
    testDir: '/project/tests',
    timeout: 300,
    sourcePatterns: ['src/**/*.py'],
    projectRoot: PROJECT_ROOT,
    configContent: '{}',
    ...overrides,
  };
}

function makeNormalizedResult(
  overrides: Partial<NormalizedResult> = {},
): NormalizedResult {
  return {
    summary: { total: 5, passed: 5, failed: 0, skipped: 0, duration: 1.2 },
    tests: [],
    fromCache: false,
    framework: 'pytest',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeExecutionResult(
  overrides: Partial<ExecutionResult> = {},
): ExecutionResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults so tests that don't care about the mechanics still work.
  mockComputeHash.mockResolvedValue('deadbeef1234');
  mockExecute.mockResolvedValue(makeExecutionResult());
  mockParse.mockReturnValue(makeNormalizedResult());
  mockUnlink.mockResolvedValue(undefined);
});

// ===========================================================================
// runTests — cache hit (AC-004)
// ===========================================================================

describe('runTests — cache hit (AC-004)', () => {
  it('returns fromCache:true when a valid cache entry exists', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    const stored = makeNormalizedResult({ fromCache: false });
    cache.set('deadbeef1234', stored);

    const result = await orchestrator.runTests({});

    expect(result.fromCache).toBe(true);
  });

  it('does NOT call execute() on a cache hit', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    cache.set('deadbeef1234', makeNormalizedResult());

    await orchestrator.runTests({});

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('returns the cached summary and tests unchanged', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    const stored = makeNormalizedResult({
      summary: { total: 10, passed: 8, failed: 2, skipped: 0, duration: 3.5 },
    });
    cache.set('deadbeef1234', stored);

    const result = await orchestrator.runTests({});

    expect(result.summary).toEqual(stored.summary);
    expect(result.tests).toEqual(stored.tests);
  });

  it('completes in under 50 ms on a cache hit', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    cache.set('deadbeef1234', makeNormalizedResult());

    const start = Date.now();
    await orchestrator.runTests({});
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(50);
  });
});

// ===========================================================================
// runTests — cache miss (AC-005)
// ===========================================================================

describe('runTests — cache miss (AC-005)', () => {
  it('returns fromCache:false when no cache entry exists', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    const result = await orchestrator.runTests({});

    expect(result.fromCache).toBe(false);
  });

  it('calls execute() on a cache miss', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    await orchestrator.runTests({});

    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('stores the result in the cache after a cache miss', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    const parsed = makeNormalizedResult();
    mockParse.mockReturnValue(parsed);

    await orchestrator.runTests({});

    // Hash is 'deadbeef1234' from the mock
    const cached = cache.get('deadbeef1234');
    expect(cached).toBeDefined();
    expect(cached!.result.summary).toEqual(parsed.summary);
  });

  it('calls parse() with the framework from config', async () => {
    const config = makeConfig({ framework: 'jest' });
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    await orchestrator.runTests({});

    expect(mockParse).toHaveBeenCalledWith('jest', expect.anything());
  });
});

// ===========================================================================
// runTests — skipCache (AC-010)
// ===========================================================================

describe('runTests — skipCache (AC-010)', () => {
  it('executes even when a valid cache entry exists', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    cache.set('deadbeef1234', makeNormalizedResult());

    await orchestrator.runTests({ skipCache: true });

    expect(mockExecute).toHaveBeenCalledOnce();
  });

  it('returns fromCache:false with skipCache:true even on a cache hit', async () => {
    const config = makeConfig();
    const cache = new CacheManager();
    const orchestrator = new TestOrchestrator(config, cache);

    cache.set('deadbeef1234', makeNormalizedResult());

    const result = await orchestrator.runTests({ skipCache: true });

    expect(result.fromCache).toBe(false);
  });
});

// ===========================================================================
// Security — CommandInjectionError
// ===========================================================================

describe('security — CommandInjectionError', () => {
  const METACHARACTERS = [';', '|', '&', '$', '`', '!', '<', '>', '{', '}', '(', ')'];

  it.each(METACHARACTERS)(
    'throws CommandInjectionError for filter containing shell metachar: %s',
    async (char) => {
      const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

      await expect(
        orchestrator.runTests({ filter: `safe${char}value` }),
      ).rejects.toThrow(CommandInjectionError);
    },
  );

  it.each(METACHARACTERS)(
    'throws CommandInjectionError for testName containing shell metachar: %s',
    async (char) => {
      const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

      await expect(
        orchestrator.runSingleTest({
          testFile: 'tests/test_foo.py',
          testName: `safe${char}value`,
        }),
      ).rejects.toThrow(CommandInjectionError);
    },
  );

  it('throws BEFORE calling execute() when filter is malicious', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runTests({ filter: 'test; rm -rf /' }),
    ).rejects.toThrow(CommandInjectionError);

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('does NOT throw for a safe filter string', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runTests({ filter: 'test_my_feature' }),
    ).resolves.toBeDefined();
  });

  it('does NOT throw for a safe filter with slashes and brackets', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runTests({ filter: 'src/tests/[unit]' }),
    ).resolves.toBeDefined();
  });

  it('allows undefined filter without throwing', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(orchestrator.runTests({})).resolves.toBeDefined();
  });
});

// ===========================================================================
// Security — PathTraversalError
// ===========================================================================

describe('security — PathTraversalError', () => {
  it("throws PathTraversalError for testFile='../../etc/passwd'", async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runSingleTest({ testFile: '../../etc/passwd' }),
    ).rejects.toThrow(PathTraversalError);
  });

  it('throws PathTraversalError BEFORE calling execute()', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runSingleTest({ testFile: '../../etc/passwd' }),
    ).rejects.toThrow(PathTraversalError);

    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('throws PathTraversalError for testFile with multiple traversal steps', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runSingleTest({ testFile: '../../../root/.ssh/id_rsa' }),
    ).rejects.toThrow(PathTraversalError);
  });

  it('does NOT throw for a valid test file within the project', async () => {
    // testDir is '/project/tests', testFile resolves inside '/project'
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await expect(
      orchestrator.runSingleTest({ testFile: 'test_unit.py' }),
    ).resolves.toBeDefined();
  });
});

// ===========================================================================
// Exit code handling (REQ-011, AC-002)
// ===========================================================================

describe('exit code handling (REQ-011)', () => {
  it('does NOT throw for exit code 0 — returns NormalizedResult', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ exitCode: 0 }));

    await expect(orchestrator.runTests({})).resolves.toMatchObject({
      fromCache: false,
    });
  });

  it('does NOT throw for exit code 1 — returns NormalizedResult (test failures are structured)', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ exitCode: 1 }));

    await expect(orchestrator.runTests({})).resolves.toMatchObject({
      fromCache: false,
    });
  });

  it('throws ExecutionError for pytest with exit code 2', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ exitCode: 2 }));

    await expect(orchestrator.runTests({})).rejects.toThrow(ExecutionError);
  });

  it('still parses jest output for exit code 2 (jest uses exit code 2+ for config errors but may still emit JSON)', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ exitCode: 2 }));
    // parse succeeds → should NOT throw, should return NormalizedResult
    mockParse.mockReturnValue(makeNormalizedResult({ framework: 'jest' }));

    await expect(orchestrator.runTests({})).resolves.toMatchObject({
      fromCache: false,
    });
  });

  it('throws ExecutionError for jest with exit code 2 when parse ALSO fails', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ exitCode: 2 }));
    mockParse.mockImplementation(() => {
      throw new ParseError('bad json', '{}');
    });

    await expect(orchestrator.runTests({})).rejects.toThrow(ExecutionError);
  });
});

// ===========================================================================
// Timeout (AC-008)
// ===========================================================================

describe('timeout handling (AC-008)', () => {
  it('throws TimeoutError when execResult.timedOut is true', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ timedOut: true, exitCode: 1 }));

    await expect(orchestrator.runTests({})).rejects.toThrow(TimeoutError);
  });

  it('does NOT call parse() when timedOut is true', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ timedOut: true }));

    await expect(orchestrator.runTests({})).rejects.toThrow(TimeoutError);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('rethrows ExecutionError from execute() (ENOENT)', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockRejectedValue(
      new ExecutionError('command not found: pytest'),
    );

    await expect(orchestrator.runTests({})).rejects.toThrow(ExecutionError);
  });
});

// ===========================================================================
// Framework CLI args
// ===========================================================================

describe('framework CLI args — pytest', () => {
  it('uses command=pytest for pytest framework', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.command).toBe('pytest');
  });

  it('includes --junitxml as a discrete arg element (not shell-interpolated)', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--junitxml');
    // --junitxml and the file path must be separate array elements
    const idx = opts.args.indexOf('--junitxml');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(opts.args[idx + 1]).toBeTruthy(); // next element is the tmpFile path
    // They must NOT be combined as a single string
    expect(opts.args[idx]).not.toMatch(/=\//);
  });

  it('includes -v in pytest args', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('-v');
  });

  it('includes -k and the filter as separate args when filter is provided', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({ filter: 'test_login' });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('-k');
    const kIdx = opts.args.indexOf('-k');
    expect(opts.args[kIdx + 1]).toBe('test_login');
  });

  it('does NOT include -k when filter is omitted', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).not.toContain('-k');
  });
});

describe('framework CLI args — jest', () => {
  it('uses command=npx for jest framework', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.command).toBe('npx');
  });

  it('passes jest as the first arg to npx', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args[0]).toBe('jest');
  });

  it('includes --json and --outputFile as discrete args', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--json');
    expect(opts.args).toContain('--outputFile');
    const idx = opts.args.indexOf('--outputFile');
    expect(opts.args[idx + 1]).toBeTruthy(); // next element is the tmpFile path
  });

  it('includes --testPathPattern and filter when filter is provided', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({ filter: 'auth' });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--testPathPattern');
    const idx = opts.args.indexOf('--testPathPattern');
    expect(opts.args[idx + 1]).toBe('auth');
  });
});

describe('framework CLI args — vitest', () => {
  it('uses command=npx for vitest framework', async () => {
    const config = makeConfig({ framework: 'vitest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.command).toBe('npx');
  });

  it('passes vitest run as the first two args to npx', async () => {
    const config = makeConfig({ framework: 'vitest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args[0]).toBe('vitest');
    expect(opts.args[1]).toBe('run');
  });

  it('includes --reporter=json and --outputFile as discrete args', async () => {
    const config = makeConfig({ framework: 'vitest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--reporter=json');
    expect(opts.args).toContain('--outputFile');
  });

  it('includes --grep and filter when filter is provided', async () => {
    const config = makeConfig({ framework: 'vitest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({ filter: 'auth suite' });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--grep');
    const idx = opts.args.indexOf('--grep');
    expect(opts.args[idx + 1]).toBe('auth suite');
  });
});

// ===========================================================================
// Temp file lifecycle
// ===========================================================================

describe('temp file lifecycle', () => {
  it('deletes tmpFile in finally on the happy path', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await orchestrator.runTests({});

    expect(mockUnlink).toHaveBeenCalledOnce();
    // The deleted path should look like a mcp-test- temp file
    const [deletedPath] = mockUnlink.mock.calls[0];
    expect(String(deletedPath)).toMatch(/mcp-test-\d+/);
  });

  it('deletes tmpFile in finally even when execute() throws', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockRejectedValue(new ExecutionError('command not found: pytest'));

    await expect(orchestrator.runTests({})).rejects.toThrow(ExecutionError);
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it('deletes tmpFile in finally even when parse() throws', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockParse.mockImplementation(() => {
      throw new ParseError('bad xml', '<invalid>');
    });

    await expect(orchestrator.runTests({})).rejects.toThrow(ParseError);
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it('deletes tmpFile in finally when timedOut is true', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockExecute.mockResolvedValue(makeExecutionResult({ timedOut: true }));

    await expect(orchestrator.runTests({})).rejects.toThrow(TimeoutError);
    expect(mockUnlink).toHaveBeenCalledOnce();
  });

  it('does not throw if unlink fails (file was never created)', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());
    mockUnlink.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    await expect(orchestrator.runTests({})).resolves.toBeDefined();
  });

  it('passes the same tmpFile path to execute args AND to parse', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [execOpts] = mockExecute.mock.calls[0];
    const [, parsedExecResult] = mockParse.mock.calls[0];

    // The tmpFile in the exec args (after --junitxml) must match the outputFile
    // passed to the parser
    const xmlIdx = execOpts.args.indexOf('--junitxml');
    const tmpFileInArgs = execOpts.args[xmlIdx + 1];
    expect((parsedExecResult as ExecutionResult).outputFile).toBe(tmpFileInArgs);
  });

  it('does NOT pass outputFile to execute() (orchestrator manages cleanup itself)', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await orchestrator.runTests({});

    const [execOpts] = mockExecute.mock.calls[0];
    // outputFile must NOT be in ExecuteOptions so executor doesn't delete it early
    expect(execOpts.outputFile).toBeUndefined();
  });
});

// ===========================================================================
// runSingleTest — args construction
// ===========================================================================

describe('runSingleTest — framework args', () => {
  it('pytest: includes the resolved testFile as a positional arg', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({ testFile: 'test_auth.py' });

    const [opts] = mockExecute.mock.calls[0];
    // Resolved path: path.resolve('/project/tests', 'test_auth.py')
    expect(opts.args.some((a) => a.endsWith('test_auth.py'))).toBe(true);
  });

  it('pytest: includes -k testName when testName is provided', async () => {
    const config = makeConfig({ framework: 'pytest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({
      testFile: 'test_auth.py',
      testName: 'test_login',
    });

    const [opts] = mockExecute.mock.calls[0];
    const kIdx = opts.args.indexOf('-k');
    expect(kIdx).toBeGreaterThanOrEqual(0);
    expect(opts.args[kIdx + 1]).toBe('test_login');
  });

  it('jest: includes --testPathPattern with the resolved testFile', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({ testFile: 'auth.test.ts' });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--testPathPattern');
    const idx = opts.args.indexOf('--testPathPattern');
    expect(opts.args[idx + 1]).toMatch(/auth\.test\.ts/);
  });

  it('jest: includes --testNamePattern when testName is provided', async () => {
    const config = makeConfig({ framework: 'jest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({
      testFile: 'auth.test.ts',
      testName: 'should login',
    });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--testNamePattern');
    const idx = opts.args.indexOf('--testNamePattern');
    expect(opts.args[idx + 1]).toBe('should login');
  });

  it('vitest: includes the resolved testFile as a positional arg', async () => {
    const config = makeConfig({ framework: 'vitest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({ testFile: 'auth.test.ts' });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args.some((a) => a.endsWith('auth.test.ts'))).toBe(true);
  });

  it('vitest: includes --grep testName when testName is provided', async () => {
    const config = makeConfig({ framework: 'vitest' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({
      testFile: 'auth.test.ts',
      testName: 'login flow',
    });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.args).toContain('--grep');
    const idx = opts.args.indexOf('--grep');
    expect(opts.args[idx + 1]).toBe('login flow');
  });
});

// ===========================================================================
// Execute options — cwd and env
// ===========================================================================

describe('execute options', () => {
  it('passes config.projectRoot as cwd', async () => {
    const config = makeConfig({ projectRoot: '/my-project' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.cwd).toBe('/my-project');
  });

  it('passes an empty env object (security: no secret forwarding at orchestrator level)', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.env).toEqual({});
  });

  it('uses config.timeout * 1000 as the effective timeout in ms', async () => {
    const config = makeConfig({ timeout: 60 }); // 60 seconds
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.timeout).toBe(60_000);
  });

  it('uses options.timeout * 1000 over config.timeout when provided', async () => {
    const config = makeConfig({ timeout: 60 });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({ timeout: 120 });

    const [opts] = mockExecute.mock.calls[0];
    expect(opts.timeout).toBe(120_000);
  });
});

// ===========================================================================
// Hash options passed to computeHash
// ===========================================================================

describe('computeHash options', () => {
  it('passes projectRoot, testDir, sourcePatterns, and configContent from config', async () => {
    const config = makeConfig({
      projectRoot: '/proj',
      testDir: '/proj/tests',
      sourcePatterns: ['src/**/*.ts'],
      configContent: '{"framework":"pytest"}',
    });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runTests({});

    expect(mockComputeHash).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: '/proj',
        testDir: '/proj/tests',
        sourcePatterns: ['src/**/*.ts'],
        configContent: '{"framework":"pytest"}',
      }),
    );
  });

  it('passes filter to computeHash for runTests', async () => {
    const orchestrator = new TestOrchestrator(makeConfig(), new CacheManager());

    await orchestrator.runTests({ filter: 'test_auth' });

    expect(mockComputeHash).toHaveBeenCalledWith(
      expect.objectContaining({ filter: 'test_auth' }),
    );
  });

  it('passes resolvedTestFile as testFile to computeHash for runSingleTest', async () => {
    const config = makeConfig({ testDir: '/project/tests' });
    const orchestrator = new TestOrchestrator(config, new CacheManager());

    await orchestrator.runSingleTest({ testFile: 'test_auth.py' });

    expect(mockComputeHash).toHaveBeenCalledWith(
      expect.objectContaining({
        testFile: expect.stringMatching(/test_auth\.py$/),
      }),
    );
  });
});
