/**
 * JUnit XML parser for test-runner MCP server.
 * Converts pytest's JUnit XML output into a NormalizedResult.
 *
 * Security note: XMLParser is NEVER configured with processEntities:true
 * to prevent XXE (XML External Entity) injection attacks.
 */

import { XMLParser } from 'fast-xml-parser';
import { ParseError } from '../errors.js';
import type { NormalizedResult, Summary, TestEntry } from '../types.js';

/** Maximum allowed XML input size: 50 MB */
const MAX_XML_BYTES = 52_428_800;

/**
 * Safe XMLParser config.
 *
 * IMPORTANT: processEntities is intentionally absent (defaults to false in
 * fast-xml-parser ≥4.x) to prevent XXE injection.
 *
 * The isArray callback is critical: without it a single <testcase> becomes
 * an object instead of an array, breaking all downstream logic.
 */
const XML_PARSER_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseAttributeValue: true,
  isArray: (name: string) =>
    ['testsuite', 'testcase', 'failure', 'error', 'skipped'].includes(name),
} as const;

// ─── Internal shape types ────────────────────────────────────────────────────

interface RawFailure {
  '@_message'?: string;
  '#text'?: string;
}

interface RawError {
  '@_message'?: string;
  '#text'?: string;
}

interface RawSkipped {
  '@_message'?: string;
}

interface RawTestcase {
  '@_name'?: string;
  '@_classname'?: string;
  '@_time'?: string | number;
  failure?: RawFailure[];
  error?: RawError[];
  skipped?: RawSkipped[];
}

interface RawTestsuite {
  '@_name'?: string;
  testcase?: RawTestcase[];
}

interface RawRoot {
  testsuites?: {
    testsuite?: RawTestsuite[];
  };
  testsuite?: RawTestsuite[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Derive status and failureMessage for a single testcase element.
 */
function deriveStatus(tc: RawTestcase): Pick<TestEntry, 'status' | 'failureMessage'> {
  if (tc.failure && tc.failure.length > 0) {
    const f = tc.failure[0];
    const attr = f['@_message'] ?? '';
    const text = f['#text'] ? '\n' + f['#text'] : '';
    const failureMessage = (attr + text).trim();
    return { status: 'failed', failureMessage: failureMessage || undefined };
  }

  if (tc.error && tc.error.length > 0) {
    const e = tc.error[0];
    const attr = e['@_message'] ?? '';
    const text = e['#text'] ? '\n' + e['#text'] : '';
    const failureMessage = (attr + text).trim();
    return { status: 'errored', failureMessage: failureMessage || undefined };
  }

  if (tc.skipped && tc.skipped.length > 0) {
    return { status: 'skipped' };
  }

  return { status: 'passed' };
}

/**
 * Convert a raw testcase element + its parent suite name into a TestEntry.
 */
function mapTestcase(tc: RawTestcase, parentSuiteName: string | undefined): TestEntry {
  const suite = (tc['@_classname'] as string | undefined) ?? parentSuiteName ?? 'unknown';
  const name = (tc['@_name'] as string | undefined) ?? 'unknown';

  const rawTime = tc['@_time'];
  const parsed = parseFloat(String(rawTime ?? '0'));
  const duration = isNaN(parsed) ? 0 : parsed;

  const { status, failureMessage } = deriveStatus(tc);

  const entry: TestEntry = { suite, name, status, duration };
  if (failureMessage !== undefined) {
    entry.failureMessage = failureMessage;
  }
  return entry;
}

/**
 * Flatten a list of raw testsuite elements into TestEntry[].
 */
function flattenSuites(suites: RawTestsuite[]): TestEntry[] {
  const entries: TestEntry[] = [];
  for (const suite of suites) {
    const suiteName = suite['@_name'];
    for (const tc of suite.testcase ?? []) {
      entries.push(mapTestcase(tc, suiteName));
    }
  }
  return entries;
}

/**
 * Compute Summary from a list of TestEntry records.
 */
function computeSummary(tests: TestEntry[]): Summary {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  let errored = 0;
  let duration = 0;

  for (const t of tests) {
    duration += t.duration;
    switch (t.status) {
      case 'passed':
        passed++;
        break;
      case 'failed':
        failed++;
        break;
      case 'skipped':
        skipped++;
        break;
      case 'errored':
        errored++;
        break;
    }
  }

  return {
    total: tests.length,
    passed,
    // failed includes errored in the summary count (both are "not passing")
    failed: failed + errored,
    skipped,
    duration,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Parse a JUnit XML string (as produced by pytest --junit-xml=...) into a
 * NormalizedResult.
 *
 * Guards (throw ParseError):
 *  - empty / whitespace-only input
 *  - input larger than 50 MB
 *  - malformed / un-parseable XML
 *
 * Security: XMLParser is NEVER configured with processEntities:true.
 */
export function parseJunitXml(xmlContent: string): NormalizedResult {
  // Guard: empty input
  if (!xmlContent || xmlContent.trim().length === 0) {
    throw new ParseError('Empty XML output', '');
  }

  // Guard: size limit
  if (xmlContent.length > MAX_XML_BYTES) {
    throw new ParseError('XML output exceeds 50MB limit', xmlContent.slice(0, 500));
  }

  // Parse XML — wrap in try/catch per REQ-013
  let raw: RawRoot;
  try {
    const parser = new XMLParser(XML_PARSER_OPTIONS);
    raw = parser.parse(xmlContent) as RawRoot;
  } catch (err) {
    throw new ParseError(
      `Failed to parse JUnit XML: ${err instanceof Error ? err.message : String(err)}`,
      xmlContent.slice(0, 500),
    );
  }

  // Collect suites — handle both <testsuites> and bare <testsuite> roots
  let suites: RawTestsuite[] = [];

  if (raw.testsuites?.testsuite) {
    // Root element is <testsuites> containing one or more <testsuite> children
    suites = raw.testsuites.testsuite;
  } else if (raw.testsuite) {
    // Root element is a bare <testsuite>
    suites = raw.testsuite;
  }

  const tests = flattenSuites(suites);
  const summary = computeSummary(tests);

  return {
    summary,
    tests,
    framework: 'pytest',
    fromCache: false,
    timestamp: new Date().toISOString(),
  };
}
