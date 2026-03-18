/**
 * Unit tests for src/parsers/vitest-json.ts — parseVitestJson().
 *
 * Coverage targets:
 *   - NormalizedResult summary counts and test entries match fixture
 *   - 'pending' status maps to 'skipped' in TestEntry
 *   - Invalid JSON input throws ParseError with a non-empty rawOutput field
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseVitestJson } from '../../parsers/vitest-json.js';
import { ParseError } from '../../errors.js';

// ─── Load fixture ─────────────────────────────────────────────────────────────

const fixtureJson = readFileSync(
  new URL('../fixtures/sample-vitest.json', import.meta.url),
  'utf-8',
);

// Parsed fixture data for expectation comparisons
const fixture = JSON.parse(fixtureJson) as {
  numTotalTests: number;
  numPassedTests: number;
  numFailedTests: number;
  numPendingTests: number;
};

// ─── Fixture-based tests ──────────────────────────────────────────────────────

describe('parseVitestJson — fixture parsing', () => {
  it('returns a NormalizedResult with framework set to "vitest"', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.framework).toBe('vitest');
  });

  it('sets fromCache to false', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.fromCache).toBe(false);
  });

  it('summary.total matches fixture numTotalTests', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.summary.total).toBe(fixture.numTotalTests);
  });

  it('summary.passed matches fixture numPassedTests', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.summary.passed).toBe(fixture.numPassedTests);
  });

  it('summary.failed matches fixture numFailedTests', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.summary.failed).toBe(fixture.numFailedTests);
  });

  it('summary.skipped matches fixture numPendingTests', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.summary.skipped).toBe(fixture.numPendingTests);
  });

  it('produces 3 TestEntry records', () => {
    const result = parseVitestJson(fixtureJson);
    expect(result.tests).toHaveLength(3);
  });

  it('maps all 3 entries correctly: 2 passed, 1 failed', () => {
    const result = parseVitestJson(fixtureJson);
    const passed = result.tests.filter((t) => t.status === 'passed');
    const failed = result.tests.filter((t) => t.status === 'failed');
    expect(passed).toHaveLength(2);
    expect(failed).toHaveLength(1);
  });

  it('failed test entry has a non-empty failureMessage', () => {
    const result = parseVitestJson(fixtureJson);
    const failedEntry = result.tests.find(
      (t) => t.name === 'trims leading and trailing whitespace',
    );
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.status).toBe('failed');
    expect(failedEntry!.failureMessage).toBeDefined();
    expect(failedEntry!.failureMessage!.length).toBeGreaterThan(0);
  });

  it('suite name is derived from ancestorTitles when present', () => {
    const result = parseVitestJson(fixtureJson);
    // All entries in the fixture have ancestorTitles: ["StringUtils"]
    for (const entry of result.tests) {
      expect(entry.suite).toBe('StringUtils');
    }
  });

  it('duration is computed from perfStats.runtime (ms → s conversion)', () => {
    // Fixture has runtime: 25ms for the single test file
    const result = parseVitestJson(fixtureJson);
    expect(result.summary.duration).toBeCloseTo(0.025, 5);
  });
});

// ─── Error handling tests ─────────────────────────────────────────────────────

describe('parseVitestJson — error handling', () => {
  it('throws ParseError when input is not valid JSON', () => {
    expect(() => parseVitestJson('not valid json {')).toThrow(ParseError);
  });

  it('ParseError from invalid JSON has a non-empty rawOutput field', () => {
    const badInput = 'not valid json {{{';
    let caughtError: unknown;
    try {
      parseVitestJson(badInput);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ParseError);
    const parseError = caughtError as ParseError;
    expect(parseError.rawOutput.length).toBeGreaterThan(0);
    expect(badInput.startsWith(parseError.rawOutput)).toBe(true);
  });

  it('throws ParseError when JSON object is missing required fields', () => {
    const missingFields = JSON.stringify({ numTotalTests: 3 });
    expect(() => parseVitestJson(missingFields)).toThrow(ParseError);
  });

  it('thrown ParseError for missing fields has a non-empty rawOutput field', () => {
    const badJson = JSON.stringify({ wrong: 'shape' });
    let caughtError: unknown;
    try {
      parseVitestJson(badJson);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ParseError);
    expect((caughtError as ParseError).rawOutput.length).toBeGreaterThan(0);
  });

  it('throws ParseError when input is an empty string', () => {
    expect(() => parseVitestJson('')).toThrow(ParseError);
  });

  it('accepts the older vitest format using "assertionResults" key', () => {
    // Vitest < 1.x used assertionResults; the parser tries assertionResults first
    const oldFormat = JSON.stringify({
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      numPendingTests: 0,
      testResults: [
        {
          name: '/project/src/foo.test.ts',
          assertionResults: [
            {
              ancestorTitles: ['Suite'],
              title: 'passes',
              status: 'passed',
              duration: 1,
              failureMessages: [],
            },
          ],
          perfStats: { runtime: 5 },
        },
      ],
    });
    const result = parseVitestJson(oldFormat);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].status).toBe('passed');
  });
});
