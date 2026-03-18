/**
 * Unit tests for src/config.ts — ConfigLoader module.
 *
 * Uses vitest's vi.mock to stub fs/promises so no real filesystem access occurs.
 * Each describe block focuses on one exported function.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock fs/promises before importing the module under test ──────────────────
vi.mock('fs/promises', () => ({
  default: {
    readFile: vi.fn(),
    access: vi.fn(),
  },
}));

import fs from 'fs/promises';
import { loadConfig, detectFramework, getConfigContent } from '../config.js';
import { ConfigError } from '../errors.js';

// Typed stubs
const mockReadFile = vi.mocked(fs.readFile);
const mockAccess = vi.mocked(fs.access);

const PROJECT_ROOT = '/fake/project';

// Helper: make fs.access succeed for a given filename only
function accessSucceedsFor(successFile: string) {
  mockAccess.mockImplementation(async (p) => {
    if (String(p).endsWith(successFile)) return;
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  });
}

// Helper: make all fs.access calls fail
function accessAlwaysFails() {
  mockAccess.mockImplementation(async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    throw err;
  });
}

// ── detectFramework ───────────────────────────────────────────────────────────

describe('detectFramework', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns "vitest" when vitest.config.ts is present', async () => {
    accessSucceedsFor('vitest.config.ts');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('vitest');
  });

  it('returns "vitest" when vitest.config.js is present (no .ts)', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('vitest.config.js')) return;
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('vitest');
  });

  it('returns "vitest" when vitest.config.mjs is present', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('vitest.config.mjs')) return;
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('vitest');
  });

  it('returns "jest" when only jest.config.js is present', async () => {
    mockAccess.mockImplementation(async (p) => {
      if (String(p).endsWith('jest.config.js')) return;
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('jest');
  });

  it('returns "jest" when only jest.config.ts is present', async () => {
    accessSucceedsFor('jest.config.ts');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('jest');
  });

  it('returns "jest" when only jest.config.cjs is present', async () => {
    accessSucceedsFor('jest.config.cjs');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('jest');
  });

  it('returns "jest" when only jest.config.mjs is present', async () => {
    accessSucceedsFor('jest.config.mjs');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('jest');
  });

  it('returns "pytest" when only pytest.ini is present', async () => {
    accessSucceedsFor('pytest.ini');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('pytest');
  });

  it('returns "pytest" when only pyproject.toml is present', async () => {
    accessSucceedsFor('pyproject.toml');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('pytest');
  });

  it('returns "pytest" when only setup.cfg is present', async () => {
    accessSucceedsFor('setup.cfg');
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('pytest');
  });

  it('prefers "vitest" over "jest" when both config files exist', async () => {
    // Both vitest.config.ts AND jest.config.js exist — vitest wins
    mockAccess.mockImplementation(async (p) => {
      const name = String(p);
      if (name.endsWith('vitest.config.ts') || name.endsWith('jest.config.js'))
        return;
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('vitest');
  });

  it('prefers "jest" over "pytest" when both config files exist', async () => {
    mockAccess.mockImplementation(async (p) => {
      const name = String(p);
      if (name.endsWith('jest.config.js') || name.endsWith('pytest.ini'))
        return;
      const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      throw err;
    });
    await expect(detectFramework(PROJECT_ROOT)).resolves.toBe('jest');
  });

  it('throws ConfigError when no framework indicator files exist', async () => {
    accessAlwaysFails();
    await expect(detectFramework(PROJECT_ROOT)).rejects.toThrow(ConfigError);
    await expect(detectFramework(PROJECT_ROOT)).rejects.toThrow(
      'Cannot auto-detect test framework',
    );
  });
});

// ── getConfigContent ──────────────────────────────────────────────────────────

describe('getConfigContent', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the raw JSON string when .mcp-test-runner.json exists', async () => {
    const json = '{"framework":"jest"}';
    mockReadFile.mockResolvedValue(json as unknown as Buffer);
    await expect(getConfigContent(PROJECT_ROOT)).resolves.toBe(json);
  });

  it('returns empty string when .mcp-test-runner.json does not exist', async () => {
    const err = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(err);
    await expect(getConfigContent(PROJECT_ROOT)).resolves.toBe('');
  });

  it('propagates non-ENOENT errors (e.g. EACCES)', async () => {
    const err = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    mockReadFile.mockRejectedValue(err);
    await expect(getConfigContent(PROJECT_ROOT)).rejects.toThrow(
      'Permission denied',
    );
  });
});

// ── loadConfig ────────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ── Happy paths ────────────────────────────────────────────────────────────

  it('returns defaults when config file has only framework field (pytest)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"pytest"}' as unknown as Buffer,
    );
    const result = await loadConfig(PROJECT_ROOT);

    expect(result.framework).toBe('pytest');
    expect(result.testDir).toBe('tests');
    expect(result.timeout).toBe(300);
    expect(result.sourcePatterns).toEqual([
      'src/**/*.py',
      'tests/**/*.py',
    ]);
    expect(result.projectRoot).toBe(PROJECT_ROOT);
    expect(result.configContent).toBe('{"framework":"pytest"}');
  });

  it('returns defaults when config file has only framework field (jest)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"jest"}' as unknown as Buffer,
    );
    const result = await loadConfig(PROJECT_ROOT);

    expect(result.framework).toBe('jest');
    expect(result.testDir).toBe('__tests__');
    expect(result.timeout).toBe(300);
    expect(result.sourcePatterns).toEqual([
      'src/**/*.ts',
      'src/**/*.js',
      'src/**/*.tsx',
    ]);
  });

  it('returns defaults when config file has only framework field (vitest)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"vitest"}' as unknown as Buffer,
    );
    const result = await loadConfig(PROJECT_ROOT);

    expect(result.framework).toBe('vitest');
    expect(result.testDir).toBe('__tests__');
    expect(result.sourcePatterns).toEqual([
      'src/**/*.ts',
      'src/**/*.js',
      'src/**/*.tsx',
    ]);
  });

  it('honours explicit testDir, timeout, and sourcePatterns from the config', async () => {
    const config = JSON.stringify({
      framework: 'pytest',
      testDir: 'my_tests',
      timeout: 120,
      sourcePatterns: ['app/**/*.py'],
    });
    mockReadFile.mockResolvedValue(config as unknown as Buffer);
    const result = await loadConfig(PROJECT_ROOT);

    expect(result.testDir).toBe('my_tests');
    expect(result.timeout).toBe(120);
    expect(result.sourcePatterns).toEqual(['app/**/*.py']);
  });

  it('includes testCommand when provided', async () => {
    const config = JSON.stringify({
      framework: 'jest',
      testCommand: 'yarn jest',
    });
    mockReadFile.mockResolvedValue(config as unknown as Buffer);
    const result = await loadConfig(PROJECT_ROOT);
    expect(result.testCommand).toBe('yarn jest');
  });

  it('auto-detects framework when .mcp-test-runner.json is absent (ENOENT)', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);

    // Make detectFramework succeed for vitest.config.ts
    accessSucceedsFor('vitest.config.ts');

    const result = await loadConfig(PROJECT_ROOT);
    expect(result.framework).toBe('vitest');
    // No configContent when file is absent
    expect(result.configContent).toBeUndefined();
  });

  it('auto-detects framework when framework field is absent from config', async () => {
    mockReadFile.mockResolvedValue('{}' as unknown as Buffer);
    accessSucceedsFor('jest.config.js');
    const result = await loadConfig(PROJECT_ROOT);
    expect(result.framework).toBe('jest');
  });

  it('sets configContent on the result when file exists', async () => {
    const raw = '{"framework":"vitest","timeout":60}';
    mockReadFile.mockResolvedValue(raw as unknown as Buffer);
    const result = await loadConfig(PROJECT_ROOT);
    expect(result.configContent).toBe(raw);
  });

  it('does NOT set configContent when file is absent', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);
    accessSucceedsFor('pytest.ini');
    const result = await loadConfig(PROJECT_ROOT);
    expect(result.configContent).toBeUndefined();
  });

  // ── Validation errors ──────────────────────────────────────────────────────

  it('throws ConfigError for invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not-json{{{' as unknown as Buffer);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(
      'Invalid JSON in .mcp-test-runner.json',
    );
  });

  it('throws ConfigError when root is a JSON array instead of object', async () => {
    mockReadFile.mockResolvedValue('[1,2,3]' as unknown as Buffer);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError when root is a JSON string instead of object', async () => {
    mockReadFile.mockResolvedValue('"hello"' as unknown as Buffer);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for unrecognized framework string', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"mocha"}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow('Invalid framework');
  });

  it('throws ConfigError for framework: null', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":null}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for framework: 42 (number)', async () => {
    mockReadFile.mockResolvedValue('{"framework":42}' as unknown as Buffer);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for non-positive timeout (zero)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"jest","timeout":0}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow('timeout');
  });

  it('throws ConfigError for non-positive timeout (negative)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"jest","timeout":-1}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for non-finite timeout (Infinity)', async () => {
    // JSON.parse("Infinity") → error, so use a number that JSON can represent but is not finite-safe
    // We can test NaN by injecting via a cast, but JSON can't encode NaN/Infinity.
    // Instead test with a string timeout value.
    mockReadFile.mockResolvedValue(
      '{"framework":"pytest","timeout":"fast"}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('throws ConfigError for non-string testDir (number)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"jest","testDir":123}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow('testDir');
  });

  it('throws ConfigError for non-string testDir (boolean)', async () => {
    mockReadFile.mockResolvedValue(
      '{"framework":"vitest","testDir":true}' as unknown as Buffer,
    );
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
  });

  it('propagates non-ENOENT file read errors', async () => {
    const ioErr = Object.assign(new Error('disk error'), { code: 'EIO' });
    mockReadFile.mockRejectedValue(ioErr);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow('disk error');
    // Must NOT be wrapped in ConfigError
    await expect(loadConfig(PROJECT_ROOT)).rejects.not.toThrow(ConfigError);
  });

  it('propagates ConfigError from detectFramework when no config file and no framework indicators', async () => {
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    mockReadFile.mockRejectedValue(enoent);
    accessAlwaysFails();
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(ConfigError);
    await expect(loadConfig(PROJECT_ROOT)).rejects.toThrow(
      'Cannot auto-detect test framework',
    );
  });
});
