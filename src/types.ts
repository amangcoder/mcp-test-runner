/**
 * Shared TypeScript interfaces for the test-runner MCP server.
 * All downstream modules import from this file.
 */

/**
 * Summary statistics for a test run.
 */
export interface Summary {
  /** Total number of tests discovered */
  total: number;
  /** Number of tests that passed */
  passed: number;
  /** Number of tests that failed */
  failed: number;
  /** Number of tests that were skipped or pending */
  skipped: number;
  /** Total duration of the test run in seconds */
  duration: number;
}

/**
 * A single test case result.
 */
export interface TestEntry {
  /** The test suite or class name (e.g. classname for pytest, describe block for jest/vitest) */
  suite: string;
  /** The individual test case name */
  name: string;
  /** The outcome of the test */
  status: 'passed' | 'failed' | 'skipped' | 'errored';
  /** Duration of this individual test in seconds */
  duration: number;
  /** Failure or error message if status is 'failed' or 'errored' */
  failureMessage?: string;
}

/**
 * The normalized test result returned to the MCP client.
 * Common shape regardless of which test framework was used.
 */
export interface NormalizedResult {
  /** Aggregate statistics */
  summary: Summary;
  /** Individual test entries */
  tests: TestEntry[];
  /** Whether this result was served from the content-hash cache */
  fromCache: boolean;
  /** The test framework that produced this result (pytest, jest, or vitest) */
  framework: string;
  /** ISO-8601 timestamp of when the result was produced or cached */
  timestamp: string;
}

/**
 * The resolved configuration after reading .mcp-test-runner.json and applying defaults.
 */
export interface ResolvedConfig {
  /** The test framework to use */
  framework: 'pytest' | 'jest' | 'vitest';
  /** Optional custom test command override (takes precedence over framework defaults) */
  testCommand?: string;
  /** Root directory for test files (default: 'tests' for pytest, '__tests__' for jest/vitest) */
  testDir: string;
  /** Maximum time in seconds to allow for a test run (default: 300) */
  timeout: number;
  /** Glob patterns for source files to include in the content hash */
  sourcePatterns: string[];
  /** Raw content of .mcp-test-runner.json used for cache-key computation */
  configContent?: string;
  /** The absolute path to the project root */
  projectRoot: string;
}

/**
 * Options for spawning a test runner child process.
 */
export interface ExecuteOptions {
  /** The command to execute (e.g. 'pytest', 'npx') */
  command: string;
  /** Arguments to pass to the command as a discrete array (never shell-interpolated) */
  args: string[];
  /** Working directory for the child process */
  cwd: string;
  /** Maximum time in milliseconds to wait before killing the process */
  timeout: number;
  /** Environment variables to pass to the child process */
  env: NodeJS.ProcessEnv;
  /** Optional path to a temp file where the test runner writes structured output */
  outputFile?: string;
}

/**
 * The raw result returned by spawning a test runner child process.
 */
export interface ExecutionResult {
  /** Exit code from the child process (0 = success, 1 = test failures, >1 = infrastructure error) */
  exitCode: number;
  /** Captured stdout from the child process */
  stdout: string;
  /** Captured stderr from the child process */
  stderr: string;
  /** Path to a temp file containing structured output (JUnit XML or JSON) if applicable */
  outputFile?: string;
  /** Whether the process was killed due to exceeding the timeout */
  timedOut: boolean;
}

/**
 * Options for computing a content hash over the project's source and test files.
 */
export interface HashOptions {
  /** Absolute path to the project root directory */
  projectRoot: string;
  /** Directory containing test files (relative or absolute) */
  testDir: string;
  /** Glob patterns for source files to include in the hash */
  sourcePatterns: string[];
  /** Optional filter pattern to narrow the scope (e.g. a test name or file glob) */
  filter?: string;
  /** Optional specific test file path to hash (for run_single_test) */
  testFile?: string;
  /** Raw content of .mcp-test-runner.json to include in the hash (per REQ-016) */
  configContent?: string;
}

/**
 * A single entry in the LRU cache.
 */
export interface CachedResult {
  /** The normalized test result that was cached */
  result: NormalizedResult;
  /** ISO-8601 timestamp of when this entry was stored */
  timestamp: string;
  /** The content hash that this entry was keyed by */
  hash: string;
}
