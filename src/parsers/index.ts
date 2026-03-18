/**
 * OutputParserFactory — routes test execution results to the correct parser.
 *
 * Supported frameworks:
 *   - 'pytest'  → JUnit XML (via parseJunitXml)
 *   - 'jest'    → Jest JSON (via parseJestJson)
 *   - 'vitest'  → Vitest JSON (via parseVitestJson)
 *
 * For jest and vitest, structured output is read from executionResult.outputFile
 * when that field is set (the executor wrote JSON to a temp file), otherwise
 * we fall back to executionResult.stdout.
 */

import { readFileSync } from 'node:fs';
import { ParseError } from '../errors.js';
import type { ExecutionResult, NormalizedResult } from '../types.js';
import { parseJunitXml } from './junit-xml.js';
import { parseJestJson } from './jest-json.js';
import { parseVitestJson } from './vitest-json.js';

/**
 * Route a raw ExecutionResult to the correct structured-output parser and
 * return a NormalizedResult.
 *
 * @param framework  - The test framework that produced the output.
 * @param executionResult - The raw result from the child process.
 * @throws ParseError if the framework is unrecognized, if outputFile is absent
 *         or unreadable (for pytest), or if the structured output is malformed.
 */
export function parse(
  framework: 'pytest' | 'jest' | 'vitest',
  executionResult: ExecutionResult,
): NormalizedResult {
  switch (framework) {
    case 'pytest': {
      if (!executionResult.outputFile) {
        throw new ParseError(
          'pytest parser requires an outputFile path but none was provided',
          '',
        );
      }

      let xmlContent: string;
      try {
        xmlContent = readFileSync(executionResult.outputFile, 'utf-8');
      } catch (err) {
        throw new ParseError(
          `Failed to read JUnit XML output file "${executionResult.outputFile}": ${
            err instanceof Error ? err.message : String(err)
          }`,
          '',
        );
      }

      return parseJunitXml(xmlContent);
    }

    case 'jest': {
      // Prefer the output file (structured JSON temp file) over stdout
      let jsonContent: string;
      if (executionResult.outputFile) {
        try {
          jsonContent = readFileSync(executionResult.outputFile, 'utf-8');
        } catch (err) {
          throw new ParseError(
            `Failed to read Jest JSON output file "${executionResult.outputFile}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            '',
          );
        }
      } else {
        jsonContent = executionResult.stdout;
      }

      return parseJestJson(jsonContent);
    }

    case 'vitest': {
      // Prefer the output file (structured JSON temp file) over stdout
      let jsonContent: string;
      if (executionResult.outputFile) {
        try {
          jsonContent = readFileSync(executionResult.outputFile, 'utf-8');
        } catch (err) {
          throw new ParseError(
            `Failed to read Vitest JSON output file "${executionResult.outputFile}": ${
              err instanceof Error ? err.message : String(err)
            }`,
            '',
          );
        }
      } else {
        jsonContent = executionResult.stdout;
      }

      return parseVitestJson(jsonContent);
    }

    default: {
      // TypeScript exhaustiveness guard — `framework` is typed as a union but
      // this branch handles unexpected runtime values.
      const _exhaustive: never = framework;
      throw new ParseError(
        `Unrecognized test framework: "${String(_exhaustive)}"`,
        '',
      );
    }
  }
}
