/**
 * Jest JSON output parser for test-runner MCP server.
 * Converts `jest --json` output into a NormalizedResult.
 *
 * Security note: failureMessages are truncated to 10,000 characters to prevent
 * accidental env variable / secret leakage in large failure outputs.
 */

import { basename } from 'node:path';
import { ParseError } from '../errors.js';
import type { NormalizedResult, Summary, TestEntry } from '../types.js';

/** Maximum characters kept from a single test's failure messages (env-leakage mitigation). */
const MAX_FAILURE_MSG_CHARS = 10_000;

// ─── Raw Jest JSON shape types ────────────────────────────────────────────────

interface RawAssertionResult {
  /** Ancestor describe-block titles, outermost first. */
  ancestorTitles: string[];
  /** The `it`/`test` title. */
  title: string;
  /** Test outcome from jest. */
  status: 'passed' | 'failed' | 'pending' | 'todo';
  /** Duration in milliseconds; may be null for pending/todo. */
  duration: number | null;
  /** Failure detail strings (stack traces etc.). */
  failureMessages: string[];
}

interface RawPerfStats {
  /** Total time in milliseconds that this file's tests took. */
  runtime?: number;
}

interface RawTestFileResult {
  /** Absolute path to the test file. */
  testFilePath: string;
  /** Individual assertion results for this file. */
  assertionResults: RawAssertionResult[];
  /** Performance statistics for this file. */
  perfStats?: RawPerfStats;
}

interface RawJestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: RawTestFileResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map a single jest assertionResult + its file path to a TestEntry.
 */
function mapAssertionResult(
  ar: RawAssertionResult,
  testFilePath: string,
): TestEntry {
  // suite: ancestor describe blocks joined, or fall back to the bare filename
  const suite =
    ar.ancestorTitles.length > 0
      ? ar.ancestorTitles.join(' > ')
      : basename(testFilePath);

  // status: jest's 'pending' and 'todo' both map to 'skipped'
  let status: TestEntry['status'];
  switch (ar.status) {
    case 'passed':
      status = 'passed';
      break;
    case 'failed':
      status = 'failed';
      break;
    case 'pending':
    case 'todo':
      status = 'skipped';
      break;
    default: {
      // Runtime guard for unexpected values — treat as skipped
      status = 'skipped';
    }
  }

  // duration: convert ms → s, treat null as 0
  const duration = (ar.duration ?? 0) / 1000;

  // failureMessage: join all messages, truncate for safety
  const rawMsg = ar.failureMessages.join('\n');
  const failureMessage = rawMsg.length > 0 ? rawMsg.slice(0, MAX_FAILURE_MSG_CHARS) : undefined;

  const entry: TestEntry = { suite, name: ar.title, status, duration };
  if (failureMessage !== undefined) {
    entry.failureMessage = failureMessage;
  }
  return entry;
}

/**
 * Build a Summary from the top-level jest JSON counts and computed duration.
 * We use the authoritative counters from jest rather than recomputing from
 * individual entries so that any jest-internal bookkeeping (retried tests,
 * todo counts, etc.) is faithfully reflected.
 */
function buildSummary(raw: RawJestJson, duration: number): Summary {
  return {
    total: raw.numTotalTests,
    passed: raw.numPassedTests,
    failed: raw.numFailedTests,
    skipped: raw.numPendingTests,
    duration,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse the output of `jest --json` into a NormalizedResult.
 *
 * @param jsonContent - The raw JSON string written by jest.
 * @throws ParseError if the input is not valid JSON or is missing required fields.
 */
export function parseJestJson(jsonContent: string): NormalizedResult {
  // Wrap JSON.parse in try/catch per REQ-013
  let raw: unknown;
  try {
    raw = JSON.parse(jsonContent);
  } catch (err) {
    throw new ParseError(
      `Failed to parse Jest JSON output: ${err instanceof Error ? err.message : String(err)}`,
      jsonContent.slice(0, 500),
    );
  }

  // Validate root fields are present
  if (
    raw === null ||
    typeof raw !== 'object' ||
    !('numTotalTests' in raw) ||
    !('numPassedTests' in raw) ||
    !('numFailedTests' in raw) ||
    !('numPendingTests' in raw) ||
    !('testResults' in raw) ||
    !Array.isArray((raw as Record<string, unknown>).testResults)
  ) {
    throw new ParseError(
      'Jest JSON output is missing required top-level fields (numTotalTests, numPassedTests, numFailedTests, numPendingTests, testResults)',
      jsonContent.slice(0, 500),
    );
  }

  const jestJson = raw as RawJestJson;

  // Flatten all assertionResults across all test files into a single TestEntry[]
  const tests: TestEntry[] = [];
  let totalDurationMs = 0;

  for (const fileResult of jestJson.testResults) {
    // Accumulate per-file runtime for overall duration
    totalDurationMs += fileResult.perfStats?.runtime ?? 0;

    for (const ar of fileResult.assertionResults ?? []) {
      tests.push(mapAssertionResult(ar, fileResult.testFilePath));
    }
  }

  const duration = totalDurationMs / 1000;
  const summary = buildSummary(jestJson, duration);

  return {
    summary,
    tests,
    framework: 'jest',
    fromCache: false,
    timestamp: new Date().toISOString(),
  };
}
