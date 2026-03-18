/**
 * Vitest JSON output parser for test-runner MCP server.
 * Converts `vitest --reporter=json` output into a NormalizedResult.
 *
 * Vitest's JSON reporter schema mirrors jest's `--json` schema closely.
 * Key differences:
 *   - The file-path field is `name` instead of `testFilePath`.
 *   - Across vitest versions the inner test-case array has been named both
 *     `assertionResults` (older) and `testResults` (newer).  We try
 *     `assertionResults` first and fall back to `testResults`.
 *
 * Security note: failureMessages are truncated to 10,000 characters to prevent
 * accidental env variable / secret leakage in large failure outputs.
 */

import { basename } from 'node:path';
import { ParseError } from '../errors.js';
import type { NormalizedResult, Summary, TestEntry } from '../types.js';

/** Maximum characters kept from a single test's failure messages (env-leakage mitigation). */
const MAX_FAILURE_MSG_CHARS = 10_000;

// ─── Raw Vitest JSON shape types ──────────────────────────────────────────────

interface RawVitestAssertionResult {
  /** Ancestor describe-block titles, outermost first. */
  ancestorTitles: string[];
  /** The `it`/`test` title. */
  title: string;
  /** Test outcome. */
  status: 'passed' | 'failed' | 'pending' | 'todo';
  /** Duration in milliseconds; may be null for skipped/todo. */
  duration: number | null;
  /** Failure detail strings (stack traces etc.). */
  failureMessages: string[];
}

interface RawVitestFileResult {
  /** Absolute path to the test file (field is `name` in vitest). */
  name: string;
  /**
   * Test cases in this file.
   * Vitest < 1.x used `assertionResults`; vitest ≥ 1.x may use `testResults`.
   * We accept either.
   */
  assertionResults?: RawVitestAssertionResult[];
  testResults?: RawVitestAssertionResult[];
  /** Performance statistics for this file (mirrors jest's perfStats shape). */
  perfStats?: { runtime?: number };
}

interface RawVitestJson {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
  testResults: RawVitestFileResult[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Map a single vitest assertionResult + its file name to a TestEntry.
 */
function mapAssertionResult(
  ar: RawVitestAssertionResult,
  filePath: string,
): TestEntry {
  // suite: ancestor describe blocks joined, or fall back to the bare filename
  const suite =
    ar.ancestorTitles.length > 0
      ? ar.ancestorTitles.join(' > ')
      : basename(filePath);

  // status: vitest's 'pending' and 'todo' both map to 'skipped'
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
 * Build a Summary from the top-level vitest JSON counts and computed duration.
 */
function buildSummary(raw: RawVitestJson, duration: number): Summary {
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
 * Parse the output of `vitest --reporter=json` into a NormalizedResult.
 *
 * @param jsonContent - The raw JSON string written by vitest.
 * @throws ParseError if the input is not valid JSON or is missing required fields.
 */
export function parseVitestJson(jsonContent: string): NormalizedResult {
  // Wrap JSON.parse in try/catch per REQ-013
  let raw: unknown;
  try {
    raw = JSON.parse(jsonContent);
  } catch (err) {
    throw new ParseError(
      `Failed to parse Vitest JSON output: ${err instanceof Error ? err.message : String(err)}`,
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
      'Vitest JSON output is missing required top-level fields (numTotalTests, numPassedTests, numFailedTests, numPendingTests, testResults)',
      jsonContent.slice(0, 500),
    );
  }

  const vitestJson = raw as RawVitestJson;

  // Flatten all test cases across all files into a single TestEntry[]
  const tests: TestEntry[] = [];
  let totalDurationMs = 0;

  for (const fileResult of vitestJson.testResults) {
    // Accumulate per-file runtime for overall duration
    totalDurationMs += fileResult.perfStats?.runtime ?? 0;

    // Try assertionResults first (older vitest), fall back to testResults (newer vitest)
    const assertions = fileResult.assertionResults ?? fileResult.testResults ?? [];

    for (const ar of assertions) {
      tests.push(mapAssertionResult(ar, fileResult.name));
    }
  }

  const duration = totalDurationMs / 1000;
  const summary = buildSummary(vitestJson, duration);

  return {
    summary,
    tests,
    framework: 'vitest',
    fromCache: false,
    timestamp: new Date().toISOString(),
  };
}
