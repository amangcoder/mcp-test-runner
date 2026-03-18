/**
 * Unit tests for src/parsers/junit-xml.ts — parseJunitXml().
 *
 * Coverage targets:
 *   - Correct NormalizedResult counts from fixture
 *   - AC-012: failureMessage includes BOTH the <failure> message attribute
 *             AND the element text body
 *   - Parameterized test names with brackets are preserved unchanged
 *   - Missing @_time attribute produces duration 0 (not NaN)
 *   - Empty / whitespace-only input throws ParseError
 *   - ParseError has rawOutput field on parse failure
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseJunitXml } from '../../parsers/junit-xml.js';
import { ParseError } from '../../errors.js';

// ─── Load fixture ─────────────────────────────────────────────────────────────

const fixtureXml = readFileSync(
  new URL('../fixtures/sample-junit.xml', import.meta.url),
  'utf-8',
);

// ─── Fixture-based tests ──────────────────────────────────────────────────────

describe('parseJunitXml — fixture parsing', () => {
  it('returns a NormalizedResult with framework set to "pytest"', () => {
    const result = parseJunitXml(fixtureXml);
    expect(result.framework).toBe('pytest');
  });

  it('sets fromCache to false', () => {
    const result = parseJunitXml(fixtureXml);
    expect(result.fromCache).toBe(false);
  });

  it('produces exactly 5 test entries', () => {
    const result = parseJunitXml(fixtureXml);
    expect(result.tests).toHaveLength(5);
  });

  it('summary: total=5, passed=2, failed=2 (failed+errored), skipped=1', () => {
    const result = parseJunitXml(fixtureXml);
    expect(result.summary.total).toBe(5);
    expect(result.summary.passed).toBe(2);
    // parseJunitXml rolls errored into failed count
    expect(result.summary.failed).toBe(2);
    expect(result.summary.skipped).toBe(1);
  });

  it('identifies test_addition as status "passed"', () => {
    const result = parseJunitXml(fixtureXml);
    const entry = result.tests.find((t) => t.name === 'test_addition');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('passed');
  });

  // ── AC-012 ─────────────────────────────────────────────────────────────────

  it('AC-012: failureMessage for the failed testcase contains BOTH the <failure> message attribute AND the element text body', () => {
    const result = parseJunitXml(fixtureXml);
    const entry = result.tests.find((t) => t.name === 'test_subtraction');

    expect(entry).toBeDefined();
    expect(entry!.status).toBe('failed');
    expect(entry!.failureMessage).toBeDefined();

    // The @message attribute must be present in the combined failureMessage
    expect(entry!.failureMessage).toContain('AssertionError: assert 1 == 2');

    // The text body of the <failure> element must ALSO be present
    expect(entry!.failureMessage).toContain('Traceback');
  });

  it('errored testcase is mapped to status "errored"', () => {
    const result = parseJunitXml(fixtureXml);
    const entry = result.tests.find((t) => t.name === 'test_division_by_zero');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('errored');
    expect(entry!.failureMessage).toContain('ZeroDivisionError');
  });

  it('skipped testcase is mapped to status "skipped"', () => {
    const result = parseJunitXml(fixtureXml);
    const entry = result.tests.find((t) => t.name === 'test_multiply');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('skipped');
  });

  it('preserves the parameterized test name including brackets', () => {
    const result = parseJunitXml(fixtureXml);
    const entry = result.tests.find((t) => t.name === 'test_add[1-2-3]');
    expect(entry).toBeDefined();
    expect(entry!.name).toBe('test_add[1-2-3]');
    expect(entry!.status).toBe('passed');
  });
});

// ─── Edge-case tests ──────────────────────────────────────────────────────────

describe('parseJunitXml — edge cases', () => {
  it('missing @_time attribute produces duration 0, not NaN', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<testsuites>
  <testsuite name="suite">
    <testcase classname="Foo" name="test_no_time"/>
  </testsuite>
</testsuites>`;
    const result = parseJunitXml(xml);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].duration).toBe(0);
    expect(Number.isNaN(result.tests[0].duration)).toBe(false);
  });

  it('throws ParseError when input is an empty string', () => {
    expect(() => parseJunitXml('')).toThrow(ParseError);
  });

  it('thrown ParseError for empty input has a rawOutput field (string)', () => {
    let caughtError: unknown;
    try {
      parseJunitXml('');
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(ParseError);
    expect(typeof (caughtError as ParseError).rawOutput).toBe('string');
  });

  it('throws ParseError when input is whitespace only', () => {
    expect(() => parseJunitXml('   \n\t  ')).toThrow(ParseError);
  });

  it('returns an empty tests array for XML with no testcase elements', () => {
    const xml = `<?xml version="1.0"?>
<testsuites>
  <testsuite name="empty"/>
</testsuites>`;
    const result = parseJunitXml(xml);
    expect(result.tests).toHaveLength(0);
    expect(result.summary.total).toBe(0);
  });

  it('handles bare <testsuite> root (no <testsuites> wrapper)', () => {
    const xml = `<?xml version="1.0"?>
<testsuite name="bare">
  <testcase classname="Foo" name="test_one" time="0.001"/>
</testsuite>`;
    const result = parseJunitXml(xml);
    expect(result.tests).toHaveLength(1);
    expect(result.tests[0].name).toBe('test_one');
  });
});
