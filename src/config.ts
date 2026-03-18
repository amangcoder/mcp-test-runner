/**
 * ConfigLoader module for the test-runner MCP server.
 * Reads and validates .mcp-test-runner.json, applies defaults,
 * and auto-detects the test framework when no config file is present.
 */

import fs from 'fs/promises';
import path from 'path';
import { ConfigError } from './errors.js';
import type { ResolvedConfig } from './types.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const VALID_FRAMEWORKS = ['pytest', 'jest', 'vitest'] as const;
type Framework = (typeof VALID_FRAMEWORKS)[number];

/** Checked in priority order: vitest > jest > pytest */
const VITEST_CONFIG_FILES = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
] as const;

const JEST_CONFIG_FILES = [
  'jest.config.ts',
  'jest.config.js',
  'jest.config.cjs',
  'jest.config.mjs',
] as const;

const PYTEST_CONFIG_FILES = [
  'pytest.ini',
  'pyproject.toml',
  'setup.cfg',
] as const;

// ── detectFramework ───────────────────────────────────────────────────────────

/**
 * Auto-detects the test framework by checking for well-known config files in
 * the given project root. Priority order: vitest > jest > pytest.
 *
 * @throws {ConfigError} When no recognized framework config file is found.
 */
export async function detectFramework(
  projectRoot: string,
): Promise<'pytest' | 'jest' | 'vitest'> {
  // 1. Check vitest config files first (highest priority)
  for (const file of VITEST_CONFIG_FILES) {
    try {
      await fs.access(path.join(projectRoot, file));
      return 'vitest';
    } catch {
      // File not found — continue checking
    }
  }

  // 2. Check jest config files
  for (const file of JEST_CONFIG_FILES) {
    try {
      await fs.access(path.join(projectRoot, file));
      return 'jest';
    } catch {
      // File not found — continue checking
    }
  }

  // 3. Check pytest config files (lowest priority)
  for (const file of PYTEST_CONFIG_FILES) {
    try {
      await fs.access(path.join(projectRoot, file));
      return 'pytest';
    } catch {
      // File not found — continue checking
    }
  }

  throw new ConfigError(
    'Cannot auto-detect test framework — no recognized config file found',
  );
}

// ── getConfigContent ──────────────────────────────────────────────────────────

/**
 * Returns the raw JSON string content of .mcp-test-runner.json, or an empty
 * string if the file does not exist. Used by ContentHasher to include the
 * config in the cache key (REQ-016).
 */
export async function getConfigContent(projectRoot: string): Promise<string> {
  const configPath = path.join(projectRoot, '.mcp-test-runner.json');
  try {
    return await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }
}

// ── loadConfig ────────────────────────────────────────────────────────────────

/**
 * Reads and validates .mcp-test-runner.json from the given project root.
 * When the file is absent (ENOENT), auto-detects the framework. Applies
 * defaults for optional fields before returning a fully resolved config.
 *
 * @throws {ConfigError} For invalid JSON, unrecognized framework, non-positive
 *   timeout, non-string testDir, or when auto-detection fails.
 */
export async function loadConfig(projectRoot: string): Promise<ResolvedConfig> {
  const configPath = path.join(projectRoot, '.mcp-test-runner.json');

  // ── Step 1: Read the config file ─────────────────────────────────────────
  let rawContent: string | undefined;
  try {
    rawContent = await fs.readFile(configPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // File absent → auto-detect framework and apply defaults
      const framework = await detectFramework(projectRoot);
      return buildResolvedConfig({ framework }, projectRoot, undefined);
    }
    // Any other I/O error propagates as-is
    throw err;
  }

  // ── Step 2: Parse JSON ───────────────────────────────────────────────────
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch {
    throw new ConfigError('Invalid JSON in .mcp-test-runner.json');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ConfigError(
      '.mcp-test-runner.json must be a JSON object, not an array or primitive',
    );
  }

  const raw = parsed as Record<string, unknown>;

  // ── Step 3: Validate individual fields ───────────────────────────────────

  // framework — must be one of the three known strings if present
  let framework: Framework;
  if ('framework' in raw) {
    if (!isValidFramework(raw.framework)) {
      throw new ConfigError(
        `Invalid framework "${String(raw.framework)}" in .mcp-test-runner.json: ` +
          'must be one of "pytest", "jest", or "vitest"',
      );
    }
    framework = raw.framework;
  } else {
    // Absent → auto-detect
    framework = await detectFramework(projectRoot);
  }

  // timeout — must be a positive finite number if present
  if ('timeout' in raw) {
    const t = raw.timeout;
    if (typeof t !== 'number' || !Number.isFinite(t) || t <= 0) {
      throw new ConfigError(
        'Invalid timeout in .mcp-test-runner.json: must be a positive number',
      );
    }
  }

  // testDir — must be a string if present
  if ('testDir' in raw) {
    if (typeof raw.testDir !== 'string') {
      throw new ConfigError(
        'Invalid testDir in .mcp-test-runner.json: must be a string',
      );
    }
  }

  // ── Step 4: Build the resolved config with defaults ──────────────────────
  return buildResolvedConfig({ ...raw, framework }, projectRoot, rawContent);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Type-guard for the framework union. */
function isValidFramework(value: unknown): value is Framework {
  return (VALID_FRAMEWORKS as readonly unknown[]).includes(value);
}

interface PartialConfig {
  framework: Framework;
  testCommand?: unknown;
  testDir?: unknown;
  timeout?: unknown;
  sourcePatterns?: unknown;
  [key: string]: unknown;
}

/**
 * Merges validated fields with framework-specific defaults to produce a fully
 * populated ResolvedConfig.
 */
function buildResolvedConfig(
  config: PartialConfig,
  projectRoot: string,
  configContent: string | undefined,
): ResolvedConfig {
  const { framework } = config;

  // testDir default: 'tests' for pytest, '__tests__' for jest/vitest
  const testDir =
    typeof config.testDir === 'string'
      ? config.testDir
      : framework === 'pytest'
        ? 'tests'
        : '__tests__';

  // timeout default: 300 seconds
  const timeout =
    typeof config.timeout === 'number' &&
    Number.isFinite(config.timeout) &&
    config.timeout > 0
      ? config.timeout
      : 300;

  // sourcePatterns default by language
  const sourcePatterns = Array.isArray(config.sourcePatterns)
    ? (config.sourcePatterns as string[])
    : framework === 'pytest'
      ? ['src/**/*.py', 'tests/**/*.py']
      : ['src/**/*.ts', 'src/**/*.js', 'src/**/*.tsx'];

  const resolved: ResolvedConfig = {
    framework,
    testDir,
    timeout,
    sourcePatterns,
    projectRoot,
  };

  // Optional: testCommand passthrough
  if (typeof config.testCommand === 'string') {
    resolved.testCommand = config.testCommand;
  }

  // configContent is set when the file exists (empty string is excluded —
  // absence means no file was present, so no cache-key contribution)
  if (configContent !== undefined) {
    resolved.configContent = configContent;
  }

  return resolved;
}
