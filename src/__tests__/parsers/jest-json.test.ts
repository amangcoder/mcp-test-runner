/**
 * Unit tests for src/parsers/jest-json.ts — parseJestJson().
 *
 * Coverage targets:
 *   - NormalizedResult summary counts match fixture's numTotal/Passed/FailedTests
 *   - 'pending' status in fixture maps to 'skipped' in TestEntry
 *   - Invalid JSON input throws ParseError with a non-empty rawOutput field
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseJestJson } from '../../parsers/jest-json.js';
import { ParseError } from '../../errors.js';

// ─── Load fixture ─────────────────────────────────────────────────────────────

const fixtureJson = readFileSync(
  new URL('../fixtures/sample-jest.json', import.meta.url),
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

describe('parseJestJson — fixture parsing', () => {
  it('returns a NormalizedResult with framework set to "jest"', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.framework).toBe('jest');
  });

  it('sets fromCache to false', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.fromCache).toBe(false);
  });

  it('summary.total matches fixture numTotalTests', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.summary.total).toBe(fixture.numTotalTests);
  });

  it('summary.passed matches fixture numPassedTests', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.summary.passed).toBe(fixture.numPassedTests);
  });

  it('summary.failed matches fixture numFailedTests', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.summary.failed).toBe(fixture.numFailedTests);
  });

  it('summary.skipped matches fixture numPendingTests', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.summary.skipped).toBe(fixture.numPendingTests);
  });

  it('produces 3 TestEntry records (one per assertion)', () => {
    const result = parseJestJson(fixtureJson);
    expect(result.tests).toHaveLength(3);
  });

  it('"pending" status in fixture maps to "skipped" in TestEntry', () => {
    const result = parseJestJson(fixtureJson);
    const pendingEntry = result.tests.find(
      (t) => t.name === 'multiplies numbers (pending)',
    );
    expect(pendingEntry).toBeDefined();
    expect(pendingEntry!.status).toBe('skipped');
  });

  it('failed test entry has a non-empty failureMessage', () => {
    const result = parseJestJson(fixtureJson);
    const failedEntry = result.tests.find(
      (t) => t.name === 'subtracts numbers correctly',
    );
    expect(failedEntry).toBeDefined();
    expect(failedEntry!.status).toBe('failed');
    expect(failedEntry!.failureMessage).toBeDefined();
    expect(failedEntry!.failureMessage!.length).toBeGreaterThan(0);
  });

  it('passed test entry has no failureMessage', () => {
    const result = parseJestJson(fixtureJson);
    const passedEntry = result.tests.find(
      (t) => t.name === 'adds two numbers correctly',
    );
    expect(passedEntry).toBeDefined();
    expect(passedEntry!.status).toBe('passed');
    expect(passedEntry!.failureMessage).toBeUndefined();
  });

  it('duration is computed from perfStats.runtime (ms → s conversion)', () => {
    // Fixture has runtime: 50ms for the single test file.
    const result = parseJestJson(fixtureJson);
    expect(result.summary.duration).toBeCloseTo(0.05, 5);
  });
});

// ─── Error handling tests ─────────────────────────────────────────────────────

describe('parseJestJson — error handling', () => {
  it('throws ParseError when input is not valid JSON', () => {
    expect(() => parseJestJson('not valid json {')).toThrow(ParseError);
  });

  it('ParseError from invalid JSON has a non-empty rawOutput field', () => {
    const badInput = 'not valid json {{{';
    let caughtError: unknown;
    try {
      parseJestJson(badInput);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ParseError);
    const parseError = caughtError as ParseError;
    expect(parseError.rawOutput.length).toBeGreaterThan(0);
    // rawOutput should be a prefix of the bad input
    expect(badInput.startsWith(parseError.rawOutput)).toBe(true);
  });

  it('throws ParseError when JSON object is missing required fields', () => {
    const missingFields = JSON.stringify({ numTotalTests: 3 });
    expect(() => parseJestJson(missingFields)).toThrow(ParseError);
  });

  it('thrown ParseError for missing fields has a non-empty rawOutput field', () => {
    const badJson = JSON.stringify({ wrong: 'shape' });
    let caughtError: unknown;
    try {
      parseJestJson(badJson);
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ParseError);
    expect((caughtError as ParseError).rawOutput.length).toBeGreaterThan(0);
  });

  it('throws ParseError when input is an empty string', () => {
    expect(() => parseJestJson('')).toThrow(ParseError);
  });
});
