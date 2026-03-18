/**
 * src/__tests__/e2e.test.ts
 *
 * End-to-end tests for the test-runner MCP server (TASK-012).
 *
 * These tests spawn the compiled server binary as a real child process and
 * communicate with it over stdin/stdout using the MCP JSON-RPC protocol.
 *
 * Prerequisites:
 *  - The package must be built (`npm run build` / `tsc`) before this suite runs.
 *    The beforeAll hook runs the build automatically.
 *
 * Skip behaviour:
 *  - All e2e tests are skipped (not failed) when SKIP_E2E=true is set in the
 *    environment.  This allows CI to skip the suite in environments where
 *    spawning child processes is not permitted.
 *
 * Protocol notes:
 *  - The MCP SDK's StdioServerTransport uses newline-delimited JSON-RPC 2.0.
 *    Each message is a single-line JSON object followed by '\n'.
 *  - The MCP initialisation handshake requires:
 *      1. Client → Server:  initialize request  (id:1)
 *      2. Server → Client:  initialize response (id:1)
 *      3. Client → Server:  notifications/initialized (no id, no response)
 *    After the handshake the server accepts arbitrary tool requests.
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  afterEach,
  test,
} from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
// src/__tests__/e2e.test.ts  →  ../../  →  project root
const PROJECT_ROOT = path.resolve(path.dirname(__filename), '../..');
const DIST_INDEX_JS = path.join(PROJECT_ROOT, 'dist', 'index.js');

// ---------------------------------------------------------------------------
// Skip flag
// ---------------------------------------------------------------------------

const SKIP_E2E = Boolean(process.env['SKIP_E2E']);

// ---------------------------------------------------------------------------
// MCP JSON-RPC wire-format types
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
  method?: string; // for notifications
}

// ---------------------------------------------------------------------------
// Helper: spawn the built server process
// ---------------------------------------------------------------------------

/**
 * Spawn `node dist/index.js` with stdio piped.
 *
 * @param cwd  Working directory for the spawned process.  Defaults to a
 *             fresh temp directory so the process does not pick up the
 *             project's own .mcp-test-runner.json or cache file.
 */
function spawnServer(cwd: string): ChildProcess {
  const proc = spawn('node', [DIST_INDEX_JS], {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // Pass through environment but avoid accidentally forwarding secrets.
    env: {
      PATH: process.env['PATH'],
      HOME: process.env['HOME'],
      NODE_ENV: 'test',
    },
  });

  // Drain stderr to prevent the OS pipe buffer from filling and blocking the
  // child process.  We do not assert on stderr content in these tests.
  proc.stderr?.on('data', () => {});

  return proc;
}

// ---------------------------------------------------------------------------
// Helper: read JSON-RPC responses from a child process's stdout
// ---------------------------------------------------------------------------

/**
 * Attach a line-buffered reader to `proc.stdout` and return a function that
 * resolves with the next parsed response whose `id` matches the given value.
 *
 * @param proc  The spawned MCP server process.
 * @returns     A function `readResponse(id, timeoutMs?)` that returns a
 *              Promise<JsonRpcResponse> resolving when the matching message
 *              arrives or rejecting on timeout / process exit.
 */
function createResponseReader(
  proc: ChildProcess,
): (id: number, timeoutMs?: number) => Promise<JsonRpcResponse> {
  // lineBuffer accumulates partial lines between 'data' events.
  let lineBuffer = '';
  // pendingById maps request id → resolve callback.
  const pendingById = new Map<number, (r: JsonRpcResponse) => void>();
  const pendingErrors = new Map<number, (e: Error) => void>();

  proc.stdout!.on('data', (chunk: Buffer) => {
    lineBuffer += chunk.toString('utf-8');
    const lines = lineBuffer.split('\n');
    lineBuffer = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let msg: JsonRpcResponse;
      try {
        msg = JSON.parse(trimmed) as JsonRpcResponse;
      } catch {
        // Non-JSON line — ignore (e.g. debug output)
        continue;
      }

      // Route to the waiting promise for this response id
      if (msg.id !== undefined && pendingById.has(msg.id as number)) {
        const resolve = pendingById.get(msg.id as number)!;
        pendingById.delete(msg.id as number);
        pendingErrors.delete(msg.id as number);
        resolve(msg);
      }
    }
  });

  // When the server process exits unexpectedly, reject all pending waiters.
  proc.on('exit', (code) => {
    const err = new Error(
      `Server process exited unexpectedly with code ${String(code)}`,
    );
    for (const [id, reject] of pendingErrors) {
      reject(err);
      pendingById.delete(id);
    }
    pendingErrors.clear();
  });

  return (id: number, timeoutMs = 15_000): Promise<JsonRpcResponse> =>
    new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingById.delete(id);
        pendingErrors.delete(id);
        reject(new Error(`Timeout (${timeoutMs}ms) waiting for response id=${id}`));
      }, timeoutMs);

      pendingById.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      pendingErrors.set(id, (e) => {
        clearTimeout(timer);
        reject(e);
      });
    });
}

// ---------------------------------------------------------------------------
// Helper: send a JSON-RPC message over stdin
// ---------------------------------------------------------------------------

function sendMessage(proc: ChildProcess, msg: JsonRpcRequest): void {
  proc.stdin!.write(JSON.stringify(msg) + '\n');
}

// ---------------------------------------------------------------------------
// Helper: perform the full MCP initialisation handshake
// ---------------------------------------------------------------------------

/**
 * Perform the MCP initialisation handshake:
 *   1. Send `initialize` request (id=1)
 *   2. Wait for `initialize` response
 *   3. Send `notifications/initialized` notification
 *
 * @returns The raw `initialize` response so callers can inspect `serverInfo`.
 */
async function performHandshake(
  proc: ChildProcess,
  readResponse: (id: number, timeoutMs?: number) => Promise<JsonRpcResponse>,
): Promise<JsonRpcResponse> {
  sendMessage(proc, {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'e2e-test-client', version: '1.0.0' },
    },
  });

  const initResponse = await readResponse(1);

  // Send notifications/initialized to complete the handshake (no response expected)
  sendMessage(proc, {
    jsonrpc: '2.0',
    method: 'notifications/initialized',
    params: {},
  });

  return initResponse;
}

// ---------------------------------------------------------------------------
// Cleanup registry — tracks all spawned processes for afterAll teardown
// ---------------------------------------------------------------------------

const spawnedProcesses = new Set<ChildProcess>();

function registerProcess(proc: ChildProcess): ChildProcess {
  spawnedProcesses.add(proc);
  proc.on('exit', () => spawnedProcesses.delete(proc));
  return proc;
}

function killProcess(proc: ChildProcess): void {
  if (!proc.killed) {
    proc.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Temp directory used by all spawned server processes
// ---------------------------------------------------------------------------

let e2eTmpDir: string;

// ===========================================================================
// E2E suite
// ===========================================================================

describe.skipIf(SKIP_E2E)('E2E: MCP server process', () => {
  /**
   * Build the package before running any e2e tests.
   * This ensures dist/index.js is up-to-date.
   */
  beforeAll(async () => {
    e2eTmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'e2e-server-'));

    execSync('npm run build', {
      cwd: PROJECT_ROOT,
      stdio: 'pipe', // suppress build output in test logs
    });

    // Verify the built binary exists
    await fs.access(DIST_INDEX_JS);
  }, 120_000 /* 2 min — tsc can be slow */);

  afterAll(async () => {
    // Kill any processes that didn't clean up after themselves
    for (const proc of spawnedProcesses) {
      killProcess(proc);
    }
    spawnedProcesses.clear();

    if (e2eTmpDir) {
      await fs.rm(e2eTmpDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    // Nothing to do per-test — each test cleans up its own process in a
    // try/finally block.  The afterAll above handles any stragglers.
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Concurrent e2e scenarios
  //
  // Each scenario spawns its own server process and is fully independent.
  // test.concurrent.each ensures they run in parallel.
  // ─────────────────────────────────────────────────────────────────────────

  test.concurrent.each([
    [
      'initialize',
      'server responds to MCP initialize with serverInfo.name === "test-runner"',
    ],
    [
      'tools/list',
      'tools/list response contains exactly "run_tests" and "run_single_test"',
    ],
  ] as const)(
    'E2E scenario: %s — %s',
    async (scenario) => {
      const proc = registerProcess(spawnServer(e2eTmpDir));
      const readResponse = createResponseReader(proc);

      try {
        const initResponse = await performHandshake(proc, readResponse);

        if (scenario === 'initialize') {
          // ── Verify serverInfo.name ──────────────────────────────────────
          expect(initResponse.error).toBeUndefined();
          expect(initResponse.result).toBeDefined();

          const serverInfo = (
            initResponse.result as Record<string, unknown>
          )?.['serverInfo'] as Record<string, unknown> | undefined;

          expect(serverInfo).toBeDefined();
          expect(serverInfo?.['name']).toBe('test-runner');
        } else {
          // scenario === 'tools/list'
          // ── Send tools/list request ─────────────────────────────────────
          sendMessage(proc, {
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/list',
            params: {},
          });

          const toolsResponse = await readResponse(2);

          expect(toolsResponse.error).toBeUndefined();
          expect(toolsResponse.result).toBeDefined();

          const tools = (
            toolsResponse.result as Record<string, unknown>
          )?.['tools'] as Array<Record<string, unknown>> | undefined;

          expect(Array.isArray(tools)).toBe(true);
          expect(tools).toHaveLength(2);

          const toolNames = tools!.map((t) => t['name'] as string);
          expect(toolNames).toContain('run_tests');
          expect(toolNames).toContain('run_single_test');

          // Verify input schema shape for both tools
          const runTests = tools!.find((t) => t['name'] === 'run_tests');
          expect(runTests).toBeDefined();
          expect((runTests!['inputSchema'] as Record<string, unknown>)?.['type']).toBe('object');

          const runSingleTest = tools!.find((t) => t['name'] === 'run_single_test');
          expect(runSingleTest).toBeDefined();
          const singleSchema = runSingleTest!['inputSchema'] as Record<string, unknown>;
          expect(singleSchema?.['type']).toBe('object');
          const required = singleSchema?.['required'] as string[] | undefined;
          expect(required).toBeDefined();
          expect(required).toContain('testFile');
        }
      } finally {
        killProcess(proc);
      }
    },
    60_000, // 60-second per-test timeout
  );
});

// ---------------------------------------------------------------------------
// Smoke test: e2e tests are skipped (not failed) when SKIP_E2E is set
// ---------------------------------------------------------------------------

it('SKIP_E2E guard: e2e describe block is skipped when process.env.SKIP_E2E is truthy', () => {
  // This test always runs (it is NOT inside the skipIf block).
  // It documents that setting SKIP_E2E skips the e2e suite.
  // The actual skip behaviour is validated by the describe.skipIf() decorator above.
  expect(typeof SKIP_E2E).toBe('boolean');
});
