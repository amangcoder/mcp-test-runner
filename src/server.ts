import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { createRequire } from 'node:module';

import { CacheManager } from './cache.js';
import { loadConfig } from './config.js';
import { ExecutionError, TestRunnerError } from './errors.js';
import { TestOrchestrator } from './orchestrator.js';

// ---------------------------------------------------------------------------
// Package version — loaded at runtime via createRequire to avoid TypeScript
// rootDir complaints about importing a JSON file from outside src/.
// ---------------------------------------------------------------------------
const _require = createRequire(import.meta.url);
const { version } = _require('../package.json') as { version: string };

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

/**
 * Build a human-readable error message from a TestRunnerError subclass.
 *
 * For ExecutionError instances the exit code and the first 500 characters of
 * stderr are appended (REQ-012, AC-007, AC-008).
 */
function buildErrorMsg(err: TestRunnerError): string {
  const lines: string[] = [`${err.name}: ${err.message}`];

  if (err instanceof ExecutionError) {
    if (err.exitCode !== undefined) {
      lines.push(`Exit code: ${err.exitCode}`);
    }
    if (err.stderr) {
      lines.push(`Stderr: ${err.stderr.slice(0, 500)}`);
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

/**
 * Create and connect the MCP test-runner server.
 *
 * The function registers two tools — `run_tests` and `run_single_test` — and
 * then connects to the stdio transport.  It resolves only after the transport
 * closes (i.e. the MCP client disconnects).
 *
 * @param cacheManager - Shared CacheManager instance (populated from disk by
 *   the caller before this function is invoked).
 */
export async function createServer(cacheManager: CacheManager): Promise<void> {
  const server = new Server({ name: 'test-runner', version });

  // ── tools/list ─────────────────────────────────────────────────────────────

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
          required: ['testFile'],
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

  // ── tools/call ─────────────────────────────────────────────────────────────

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Treat absent arguments as an empty object so downstream code can use
    // optional chaining / undefined checks uniformly.
    const params = (args ?? {}) as Record<string, unknown>;

    try {
      const config = await loadConfig(process.cwd());
      const orchestrator = new TestOrchestrator(config, cacheManager);

      if (name === 'run_tests') {
        const result = await orchestrator.runTests({
          filter:
            typeof params['filter'] === 'string'
              ? params['filter']
              : undefined,
          skipCache:
            typeof params['skipCache'] === 'boolean'
              ? params['skipCache']
              : undefined,
          timeout:
            typeof params['timeout'] === 'number'
              ? params['timeout']
              : undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      if (name === 'run_single_test') {
        // Validate the required `testFile` parameter explicitly so that a
        // missing value produces a structured isError response rather than an
        // uncaught exception (AC-004).
        if (typeof params['testFile'] !== 'string' || params['testFile'] === '') {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: 'Missing required parameter: testFile',
              },
            ],
          };
        }

        const result = await orchestrator.runSingleTest({
          testFile: params['testFile'],
          testName:
            typeof params['testName'] === 'string'
              ? params['testName']
              : undefined,
          skipCache:
            typeof params['skipCache'] === 'boolean'
              ? params['skipCache']
              : undefined,
          timeout:
            typeof params['timeout'] === 'number'
              ? params['timeout']
              : undefined,
        });

        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
        };
      }

      // Unknown tool name
      return {
        isError: true,
        content: [
          {
            type: 'text' as const,
            text: `Unknown tool: ${String(name)}`,
          },
        ],
      };
    } catch (err) {
      // Domain errors → structured isError response (REQ-012, AC-007, AC-008)
      if (err instanceof TestRunnerError) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: buildErrorMsg(err) }],
        };
      }
      // Unexpected errors (programming bugs, I/O failures outside our domain)
      // are re-thrown so the SDK can handle them as protocol-level errors.
      throw err;
    }
  });

  // ── Connect transport ───────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
