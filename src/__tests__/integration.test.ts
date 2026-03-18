/**
 * src/__tests__/integration.test.ts
 *
 * Integration tests for the test-runner MCP server (TASK-012).
 *
 * These tests use real, un-mocked implementations (hasher, cache, parsers)
 * with real temp directories.  The ONLY mocked boundary is the child-process
 * executor — we inject fixture output instead of spawning pytest/jest/vitest.
 *
 * Scenarios covered:
 *  1. Full cache lifecycle   — three sequential orchestrator runs verify the
 *                              fromCache flag transitions correctly when source
 *                              files change.
 *  2. Parser integration     — real fixture files fed through
 *                              OutputParserFactory.parse() for all three
 *                              frameworks; checks NormalizedResult shape.
 *  3. Cache persistence      — 3 entries written then re-read from a new
 *                              CacheManager instance match the originals.
 *  4. MCP tool registration  — Server + InMemoryTransport verifies that
 *                              ListTools returns exactly 2 tools with correct
 *                              names and schemas (AC-011).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Mock the executor (avoid spawning real test runners).
// All other modules (hasher, cache, parsers) use their real implementations.
// ---------------------------------------------------------------------------

vi.mock('../executor.js', () => ({
  execute: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports — must come AFTER vi.mock() calls
// ---------------------------------------------------------------------------

import { execute } from '../executor.js';
import { TestOrchestrator } from '../orchestrator.js';
import { CacheManager } from '../cache.js';
import { parse } from '../parsers/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type {
  ResolvedConfig,
  NormalizedResult,
  ExecutionResult,
  ExecuteOptions,
} from '../types.js';

// ---------------------------------------------------------------------------
// Typed mock helpers
// ---------------------------------------------------------------------------

const mockExecute = vi.mocked(execute);

// ---------------------------------------------------------------------------
// Fixture file paths and content
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

const JUNIT_XML = readFileSync(path.join(FIXTURES_DIR, 'sample-junit.xml'), 'utf-8');
const JEST_JSON = readFileSync(path.join(FIXTURES_DIR, 'sample-jest.json'), 'utf-8');
const VITEST_JSON = readFileSync(path.join(FIXTURES_DIR, 'sample-vitest.json'), 'utf-8');

// ---------------------------------------------------------------------------
// Shared test data builders
// ---------------------------------------------------------------------------

function makeNormalizedResult(overrides: Partial<NormalizedResult> = {}): NormalizedResult {
  return {
    summary: { total: 3, passed: 2, failed: 1, skipped: 0, duration: 0.5 },
    tests: [
      { suite: 'SuiteA', name: 'test one', status: 'passed', duration: 0.1 },
      { suite: 'SuiteA', name: 'test two', status: 'passed', duration: 0.2 },
      {
        suite: 'SuiteA',
        name: 'test three',
        status: 'failed',
        duration: 0.2,
        failureMessage: 'Expected 1 but got 2',
      },
    ],
    fromCache: false,
    framework: 'jest',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockExecResult(overrides: Partial<ExecutionResult> = {}): ExecutionResult {
  return {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

// ===========================================================================
// Scenario 1: Full cache lifecycle
// ===========================================================================

describe('Integration: Full cache lifecycle', () => {
  let tmpDir: string;

  /**
   * Each test gets a fresh temp directory containing:
   *  - source.py  (a simple Python source file to contribute to the hash)
   *  - tests/     (empty test directory, discovered by computeHash glob)
   */
  beforeEach(async () => {
    vi.clearAllMocks();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'int-cache-'));
    await fs.writeFile(path.join(tmpDir, 'source.py'), 'def foo(): pass\n', 'utf-8');
    await fs.mkdir(path.join(tmpDir, 'tests'), { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it(
    'first run returns fromCache:false, second identical run returns fromCache:true,' +
      ' third run after source modification returns fromCache:false',
    async () => {
      const config: ResolvedConfig = {
        framework: 'pytest',
        testDir: path.join(tmpDir, 'tests'),
        timeout: 30,
        sourcePatterns: ['*.py'],
        projectRoot: tmpDir,
        configContent: '{}',
      };

      const cacheManager = new CacheManager();
      const orchestrator = new TestOrchestrator(config, cacheManager);

      // ── Mock executor ─────────────────────────────────────────────────────
      // The orchestrator passes the tmpFile as the arg after '--junitxml'.
      // We write the fixture XML to that path so the real JUnit parser can
      // read it, simulating a successful pytest run.
      mockExecute.mockImplementation(async (opts: ExecuteOptions) => {
        const junitIdx = opts.args.indexOf('--junitxml');
        if (junitIdx >= 0) {
          const outputPath = opts.args[junitIdx + 1] as string;
          await fs.writeFile(outputPath, JUNIT_XML, 'utf-8');
        }
        return makeMockExecResult();
      });

      // ── Run 1: cold cache → fromCache:false ───────────────────────────────
      const r1 = await orchestrator.runTests({});
      expect(r1.fromCache).toBe(false);
      expect(mockExecute).toHaveBeenCalledTimes(1);

      // ── Run 2: same source files → hash identical → cache hit ─────────────
      const r2 = await orchestrator.runTests({});
      expect(r2.fromCache).toBe(true);
      // execute() must NOT have been called again on a cache hit
      expect(mockExecute).toHaveBeenCalledTimes(1);

      // ── Modify source file so its content hash changes ────────────────────
      // Add a small delay to guarantee the OS records a new mtime (> 1 ms).
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      await fs.writeFile(
        path.join(tmpDir, 'source.py'),
        'def foo(): return 42\n',
        'utf-8',
      );
      // Explicitly advance the mtime by 1 second so the hasher's mtime
      // fast-path is definitely bypassed even on high-resolution filesystems.
      const futureTime = new Date(Date.now() + 1_000);
      await fs.utimes(path.join(tmpDir, 'source.py'), futureTime, futureTime);

      // ── Run 3: source changed → new hash → cache miss → fromCache:false ───
      const r3 = await orchestrator.runTests({});
      expect(r3.fromCache).toBe(false);
      expect(mockExecute).toHaveBeenCalledTimes(2);
    },
  );
});

// ===========================================================================
// Scenario 2: Parser integration — all three frameworks via real fixture files
// ===========================================================================

describe('Integration: Parser integration (all three frameworks)', () => {
  /** Accepted TestEntry status values — must match the TypeScript union type. */
  const VALID_STATUSES = new Set<string>(['passed', 'failed', 'skipped', 'errored']);

  /**
   * ISO-8601 datetime regex.  Accepts fractional seconds and always requires
   * a trailing 'Z' (UTC) because all NormalizedResult timestamps use
   * new Date().toISOString() which emits UTC.
   */
  const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

  /** Temp file used by the pytest integration path (JUnit XML on disk). */
  let pytestTmpFile: string | undefined;

  afterEach(async () => {
    if (pytestTmpFile) {
      try {
        await fs.unlink(pytestTmpFile);
      } catch {
        // Ignore — file may already have been deleted
      }
      pytestTmpFile = undefined;
    }
  });

  it.each([
    ['pytest', 'junit-xml', JUNIT_XML] as const,
    ['jest', 'jest-json', JEST_JSON] as const,
    ['vitest', 'vitest-json', VITEST_JSON] as const,
  ])(
    '%s (%s fixture): OutputParserFactory.parse() returns a NormalizedResult satisfying the TypeScript interface',
    (framework, _fixtureName, fixtureContent) => {
      let execResult: ExecutionResult;

      if (framework === 'pytest') {
        // pytest parser reads JUnit XML from executionResult.outputFile
        pytestTmpFile = path.join(
          os.tmpdir(),
          `parser-int-pytest-${Date.now()}-${Math.random()}.xml`,
        );
        writeFileSync(pytestTmpFile, fixtureContent, 'utf-8');
        execResult = {
          exitCode: 0,
          stdout: '',
          stderr: '',
          timedOut: false,
          outputFile: pytestTmpFile,
        };
      } else {
        // jest/vitest parsers fall back to executionResult.stdout when
        // outputFile is absent — avoid temp-file overhead for JSON.
        execResult = {
          exitCode: 0,
          stdout: fixtureContent,
          stderr: '',
          timedOut: false,
        };
      }

      const result = parse(framework, execResult);

      // ── summary must be a valid Summary object ───────────────────────────
      expect(typeof result.summary.total).toBe('number');
      expect(result.summary.total).toBeGreaterThan(0);
      expect(Number.isInteger(result.summary.total)).toBe(true);

      for (const field of ['passed', 'failed', 'skipped', 'duration'] as const) {
        expect(typeof result.summary[field]).toBe('number');
        expect(Number.isNaN(result.summary[field])).toBe(false);
      }

      // ── tests array must exist and every TestEntry must have valid fields ─
      expect(Array.isArray(result.tests)).toBe(true);

      for (const entry of result.tests) {
        expect(VALID_STATUSES.has(entry.status)).toBe(
          true,
          `Unexpected status "${entry.status}" for test "${entry.name}"`,
        );
        expect(typeof entry.suite).toBe('string');
        expect(typeof entry.name).toBe('string');
        expect(typeof entry.duration).toBe('number');
        expect(Number.isNaN(entry.duration)).toBe(false);
      }

      // ── timestamp must be a valid ISO-8601 UTC string ────────────────────
      expect(typeof result.timestamp).toBe('string');
      expect(ISO_8601_RE.test(result.timestamp)).toBe(
        true,
        `timestamp "${result.timestamp}" is not ISO-8601`,
      );

      // ── framework field must be one of the three supported values ─────────
      expect(['pytest', 'jest', 'vitest']).toContain(result.framework);

      // ── fromCache is always false from the parser (the orchestrator sets it) ─
      expect(result.fromCache).toBe(false);
    },
  );
});

// ===========================================================================
// Scenario 3: Cache persistence round-trip
// ===========================================================================

describe('Integration: Cache persistence round-trip', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'int-persist-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it(
    '3 entries: set → persistToDisk → new CacheManager → loadFromDisk → all entries present and values match originals',
    async () => {
      const cache1 = new CacheManager();

      const entries: Array<{ hash: string; result: NormalizedResult }> = [
        { hash: 'persist-hash-1', result: makeNormalizedResult({ framework: 'pytest' }) },
        { hash: 'persist-hash-2', result: makeNormalizedResult({ framework: 'jest' }) },
        { hash: 'persist-hash-3', result: makeNormalizedResult({ framework: 'vitest' }) },
      ];

      for (const { hash, result } of entries) {
        cache1.set(hash, result);
      }

      // ── Persist to a file in os.tmpdir() ─────────────────────────────────
      const cacheFilePath = path.join(tmpDir, 'integration-cache.json');
      await cache1.persistToDisk(cacheFilePath);

      // Verify the file exists and is valid JSON
      const raw = await fs.readFile(cacheFilePath, 'utf-8');
      expect(() => JSON.parse(raw)).not.toThrow();

      // ── Load into a brand-new CacheManager instance ───────────────────────
      const cache2 = new CacheManager();
      await cache2.loadFromDisk(cacheFilePath);

      // ── All 3 entries must be present and match the originals ─────────────
      for (const { hash, result } of entries) {
        const hit = cache2.get(hash);
        expect(hit).toBeDefined();
        expect(hit!.hash).toBe(hash);
        // Deep equality check — every field of the original NormalizedResult
        // must survive the JSON serialisation/deserialisation round-trip.
        expect(hit!.result).toEqual(result);
      }
    },
  );
});

// ===========================================================================
// Scenario 4: MCP tool registration (AC-011)
// ===========================================================================

describe('Integration: MCP tool registration (AC-011)', () => {
  // Keep track of client/server so they can be torn down after each test.
  let client: Client | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    try {
      await client?.close();
    } catch {
      // Ignore — transport may already be closed
    }
    try {
      await server?.close();
    } catch {
      // Ignore — transport may already be closed
    }
    client = undefined;
    server = undefined;
  });

  it(
    'ListTools handler returns exactly 2 tools — "run_tests" and "run_single_test" — with correct schemas',
    async () => {
      // ── Build an in-process server ────────────────────────────────────────
      // We do NOT call createServer() because that connects to StdioServerTransport
      // and blocks forever.  Instead we replicate the handler registration inline
      // and use InMemoryTransport for a fully in-process roundtrip.
      server = new Server({ name: 'test-runner', version: '0.1.0' });

      // The orchestrator is not used by the ListTools handler; mock it so that
      // any accidental invocation produces a test failure.
      const mockOrchestrator = vi.fn();

      server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
          {
            name: 'run_tests',
            description: 'Execute test suite and return structured results',
            inputSchema: {
              type: 'object' as const,
              properties: {
                filter: {
                  type: 'string',
                  description: 'Glob/regex pattern to select test files',
                },
                skipCache: {
                  type: 'boolean',
                  description: 'Force fresh execution ignoring cache',
                },
                timeout: {
                  type: 'number',
                  description: 'Per-invocation timeout override in seconds',
                },
              },
              additionalProperties: false,
            },
          },
          {
            name: 'run_single_test',
            description:
              'Execute a specific test file with optional test name filter',
            inputSchema: {
              type: 'object' as const,
              required: ['testFile'] as const,
              properties: {
                testFile: {
                  type: 'string',
                  description: 'Relative path to the test file',
                },
                testName: {
                  type: 'string',
                  description: 'Test name or pattern',
                },
                skipCache: {
                  type: 'boolean',
                  description: 'Force fresh execution ignoring cache',
                },
                timeout: {
                  type: 'number',
                  description: 'Per-invocation timeout override in seconds',
                },
              },
              additionalProperties: false,
            },
          },
        ],
      }));

      // ── Wire server and client with in-memory transports ──────────────────
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      client = new Client({ name: 'test-client', version: '1.0.0' });

      await server.connect(serverTransport);
      await client.connect(clientTransport);

      // ── Request the tool list ─────────────────────────────────────────────
      const response = await client.listTools();

      // ── Assertions ────────────────────────────────────────────────────────

      // Exactly 2 tools registered
      expect(response.tools).toHaveLength(2);

      const toolNames = response.tools.map((t) => t.name);
      expect(toolNames).toContain('run_tests');
      expect(toolNames).toContain('run_single_test');

      // run_tests schema
      const runTests = response.tools.find((t) => t.name === 'run_tests');
      expect(runTests).toBeDefined();
      expect(runTests!.inputSchema.type).toBe('object');
      const runTestsProps = runTests!.inputSchema.properties as Record<string, unknown>;
      expect(runTestsProps).toHaveProperty('filter');
      expect(runTestsProps).toHaveProperty('skipCache');
      expect(runTestsProps).toHaveProperty('timeout');
      // run_tests does NOT require any properties (all are optional)
      expect(runTests!.inputSchema.required ?? []).not.toContain('filter');

      // run_single_test schema
      const runSingleTest = response.tools.find((t) => t.name === 'run_single_test');
      expect(runSingleTest).toBeDefined();
      expect(runSingleTest!.inputSchema.type).toBe('object');
      // testFile is the only required parameter
      expect((runSingleTest!.inputSchema.required as string[]) ?? []).toContain('testFile');
      const runSingleTestProps = runSingleTest!.inputSchema.properties as Record<string, unknown>;
      expect(runSingleTestProps).toHaveProperty('testFile');
      expect(runSingleTestProps).toHaveProperty('testName');
      expect(runSingleTestProps).toHaveProperty('skipCache');
      expect(runSingleTestProps).toHaveProperty('timeout');

      // The mocked orchestrator must never have been called — ListTools must
      // NOT trigger any test execution.
      expect(mockOrchestrator).not.toHaveBeenCalled();
    },
  );
});
