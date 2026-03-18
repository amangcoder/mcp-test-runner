/**
 * Named error classes for the test-runner MCP server.
 * Each class has a `name` property matching its class name for reliable
 * error type discrimination across module boundaries (where instanceof
 * checks may fail with bundled or transpiled code).
 */

/**
 * Base error class for all test-runner errors.
 * All domain-specific errors extend this class.
 */
export class TestRunnerError extends Error {
  // Explicitly set name so it appears correctly in stack traces and error messages,
  // even across module boundaries where instanceof may fail.
  name = 'TestRunnerError';

  constructor(message: string) {
    super(message);
    // Restore the prototype chain — required when extending built-in Error in TypeScript.
    // Without this, instanceof checks fail in transpiled CommonJS output.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when .mcp-test-runner.json is missing required fields,
 * contains an unrecognized framework string, or cannot be parsed as JSON.
 * Also thrown when the test framework cannot be auto-detected.
 */
export class ConfigError extends TestRunnerError {
  name = 'ConfigError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the test runner child process fails to start
 * (e.g. command not found, ENOENT) or encounters an unexpected
 * infrastructure error (exit code > 1 that cannot be parsed).
 *
 * Note: exit code 1 from test failures is NOT an ExecutionError —
 * those are returned as NormalizedResult (REQ-011).
 */
export class ExecutionError extends TestRunnerError {
  name = 'ExecutionError';
  /** Exit code from the child process, if available */
  readonly exitCode?: number;
  /** Captured stderr from the child process, if available */
  readonly stderr?: string;

  constructor(message: string, exitCode?: number, stderr?: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

/**
 * Thrown when the structured output from the test runner (JUnit XML or JSON)
 * cannot be parsed. The `rawOutput` field contains the first 500 characters
 * of the unparseable content to aid debugging (per REQ-013).
 */
export class ParseError extends TestRunnerError {
  name = 'ParseError';
  /**
   * The first 500 characters of the content that could not be parsed.
   * Truncated to prevent excessive error message size (per REQ-013).
   */
  readonly rawOutput: string;

  constructor(message: string, rawOutput: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
    // Enforce the 500-character limit per REQ-013
    this.rawOutput = rawOutput.slice(0, 500);
  }
}

/**
 * Thrown when the test runner child process exceeds the configured timeout
 * and is killed by the executor.
 */
export class TimeoutError extends TestRunnerError {
  name = 'TimeoutError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a file path parameter resolves to a location outside the
 * project root, indicating a potential directory traversal attack.
 * For example, testFile='../../etc/passwd' would trigger this.
 */
export class PathTraversalError extends TestRunnerError {
  name = 'PathTraversalError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a parameter (filter, testName, or command) contains shell
 * metacharacters or is not in the command allowlist, indicating a potential
 * command injection attack.
 */
export class CommandInjectionError extends TestRunnerError {
  name = 'CommandInjectionError';

  constructor(message: string) {
    super(message);
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
