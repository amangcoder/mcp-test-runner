/**
 * src/__tests__/executor.test.ts
 *
 * Unit tests for the secure child-process executor (TASK-005).
 *
 * Coverage:
 *  - Command allowlist enforcement (CommandInjectionError)
 *  - shell:false guarantee on every spawn call
 *  - Environment variable filtering (no secret leakage)
 *  - Process group kill on timeout (SIGTERM → SIGKILL, timedOut:true)
 *  - Exit code 1 returns ExecutionResult, not a thrown error (REQ-011)
 *  - ENOENT → ExecutionError with "command not found" message (AC-007)
 *  - Temp file read + delete in finally block
 *  - stdout/stderr buffer overflow guard (> 100 MB)
 */

import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — vi.mock() is hoisted above imports automatically
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
  unlink: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (resolved after mocks are in place)
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import {
  execute,
  COMMAND_ALLOWLIST,
  buildFilteredEnv,
} from '../executor.js';
import { CommandInjectionError, ExecutionError } from '../errors.js';
import type { ExecuteOptions } from '../types.js';

// ---------------------------------------------------------------------------
// Typed mock accessors
// ---------------------------------------------------------------------------

// vi.mocked() unwraps to the underlying MockInstance type
const mockSpawn = vi.mocked(spawn);
// For overloaded functions, cast through unknown to get a flexible mock type
const mockReadFile = readFile as unknown as { mockResolvedValue: (v: unknown) => void; mockRejectedValue: (e: unknown) => void };
const mockUnlink = unlink as unknown as { mockResolvedValue: (v: unknown) => void; mockRejectedValue: (e: unknown) => void };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal EventEmitter-based mock of the ChildProcess returned by spawn(). */
class MockChildProcess extends EventEmitter {
  pid: number | undefined = 12345;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
}

/** Default ExecuteOptions factory to reduce repetition in tests. */
function makeOptions(overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
  return {
    command: 'pytest',
    args: [],
    cwd: '/tmp',
    timeout: 30_000,
    env: {},
    ...overrides,
  };
}

/** Simulates the process emitting 'close' with the given exit code. */
function emitClose(child: MockChildProcess, code: number | null): void {
  child.emit('close', code, null);
}

// ---------------------------------------------------------------------------
// Global setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Provide safe default mock implementations so tests that don't care about
  // fs operations don't need to set them up manually.
  mockReadFile.mockResolvedValue(Buffer.from(''));
  mockUnlink.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ===========================================================================
// COMMAND ALLOWLIST
// ===========================================================================

describe('command allowlist', () => {
  it('allows all commands in the allowlist', async () => {
    for (const cmd of COMMAND_ALLOWLIST) {
      const child = new MockChildProcess();
      mockSpawn.mockReturnValueOnce(child as unknown as ReturnType<typeof spawn>);

      const promise = execute(makeOptions({ command: cmd }));
      emitClose(child, 0);
      await expect(promise).resolves.toMatchObject({ exitCode: 0 });
    }
  });

  it.each(['rm', 'curl', 'wget', 'bash', 'sh', '/bin/sh', 'cat', 'python2'])(
    'throws CommandInjectionError for disallowed command: %s',
    async (cmd) => {
      await expect(execute(makeOptions({ command: cmd }))).rejects.toThrow(
        CommandInjectionError,
      );
    },
  );

  it('throws CommandInjectionError BEFORE calling spawn', async () => {
    await expect(execute(makeOptions({ command: 'rm' }))).rejects.toThrow(
      CommandInjectionError,
    );
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('includes the disallowed command name in the error message', async () => {
    await expect(execute(makeOptions({ command: 'curl' }))).rejects.toThrow(
      /curl/,
    );
  });

  it('includes the list of permitted commands in the error message', async () => {
    await expect(execute(makeOptions({ command: 'curl' }))).rejects.toThrow(
      /pytest/,
    );
  });
});

// ===========================================================================
// SHELL:FALSE GUARANTEE
// ===========================================================================

describe('shell:false guarantee', () => {
  it('always spawns with shell:false', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    emitClose(child, 0);
    await promise;

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [, , opts] = mockSpawn.mock.calls[0];
    expect((opts as Record<string, unknown>)['shell']).toBe(false);
  });

  it('spawns with detached:true so the process group can be killed', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    emitClose(child, 0);
    await promise;

    const [, , opts] = mockSpawn.mock.calls[0];
    expect((opts as Record<string, unknown>)['detached']).toBe(true);
  });

  it('passes args as a discrete array, not shell-interpolated into the command', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const args = ['-v', '--tb=short', 'tests/'];
    const promise = execute(makeOptions({ args }));
    emitClose(child, 0);
    await promise;

    const [spawnCmd, spawnArgs] = mockSpawn.mock.calls[0];
    expect(spawnCmd).toBe('pytest');
    expect(spawnArgs).toEqual(args);
  });

  it('passes the correct cwd to spawn', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ cwd: '/project' }));
    emitClose(child, 0);
    await promise;

    const [, , opts] = mockSpawn.mock.calls[0];
    expect((opts as Record<string, unknown>)['cwd']).toBe('/project');
  });
});

// ===========================================================================
// ENVIRONMENT FILTERING
// ===========================================================================

describe('env filtering', () => {
  it('does not forward arbitrary secrets from process.env to the child', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const saved = process.env['AWS_SECRET_ACCESS_KEY'];
    process.env['AWS_SECRET_ACCESS_KEY'] = 'super-secret-key';

    try {
      const promise = execute(makeOptions({ env: {} }));
      emitClose(child, 0);
      await promise;

      const [, , opts] = mockSpawn.mock.calls[0];
      const spawnEnv = (opts as Record<string, unknown>)['env'] as NodeJS.ProcessEnv;
      expect(spawnEnv['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env['AWS_SECRET_ACCESS_KEY'];
      } else {
        process.env['AWS_SECRET_ACCESS_KEY'] = saved;
      }
    }
  });

  it('does not forward DATABASE_PASSWORD from process.env', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const saved = process.env['DATABASE_PASSWORD'];
    process.env['DATABASE_PASSWORD'] = 'hunter2';

    try {
      const promise = execute(makeOptions({ env: {} }));
      emitClose(child, 0);
      await promise;

      const [, , opts] = mockSpawn.mock.calls[0];
      const spawnEnv = (opts as Record<string, unknown>)['env'] as NodeJS.ProcessEnv;
      expect(spawnEnv['DATABASE_PASSWORD']).toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env['DATABASE_PASSWORD'];
      } else {
        process.env['DATABASE_PASSWORD'] = saved;
      }
    }
  });

  it('forwards PATH from process.env (allowlisted key)', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const savedPath = process.env['PATH'];
    process.env['PATH'] = '/usr/bin:/bin';

    try {
      const promise = execute(makeOptions({ env: {} }));
      emitClose(child, 0);
      await promise;

      const [, , opts] = mockSpawn.mock.calls[0];
      const spawnEnv = (opts as Record<string, unknown>)['env'] as NodeJS.ProcessEnv;
      expect(spawnEnv['PATH']).toBe('/usr/bin:/bin');
    } finally {
      if (savedPath !== undefined) process.env['PATH'] = savedPath;
    }
  });

  it('merges caller-supplied env additions into the filtered env', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(
      makeOptions({ env: { PYTEST_ADDOPTS: '--verbose' } }),
    );
    emitClose(child, 0);
    await promise;

    const [, , opts] = mockSpawn.mock.calls[0];
    const spawnEnv = (opts as Record<string, unknown>)['env'] as NodeJS.ProcessEnv;
    expect(spawnEnv['PYTEST_ADDOPTS']).toBe('--verbose');
  });

  it('caller-supplied env overrides allowlisted keys from process.env', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ env: { PATH: '/custom/path' } }));
    emitClose(child, 0);
    await promise;

    const [, , opts] = mockSpawn.mock.calls[0];
    const spawnEnv = (opts as Record<string, unknown>)['env'] as NodeJS.ProcessEnv;
    expect(spawnEnv['PATH']).toBe('/custom/path');
  });
});

// ===========================================================================
// buildFilteredEnv (unit-tested in isolation)
// ===========================================================================

describe('buildFilteredEnv', () => {
  it('excludes keys not in the safe list', () => {
    const saved = process.env['MY_SECRET'];
    process.env['MY_SECRET'] = 'do-not-forward';

    try {
      const result = buildFilteredEnv({});
      expect(result['MY_SECRET']).toBeUndefined();
    } finally {
      if (saved === undefined) {
        delete process.env['MY_SECRET'];
      } else {
        process.env['MY_SECRET'] = saved;
      }
    }
  });

  it('includes PATH when it is set in process.env', () => {
    const saved = process.env['PATH'];
    process.env['PATH'] = '/safe/bin';

    try {
      const result = buildFilteredEnv({});
      expect(result['PATH']).toBe('/safe/bin');
    } finally {
      if (saved !== undefined) process.env['PATH'] = saved;
    }
  });

  it('caller extraEnv wins over safe process.env keys', () => {
    const saved = process.env['PATH'];
    process.env['PATH'] = '/original/path';

    try {
      const result = buildFilteredEnv({ PATH: '/overridden' });
      expect(result['PATH']).toBe('/overridden');
    } finally {
      if (saved !== undefined) process.env['PATH'] = saved;
    }
  });

  it('includes arbitrary keys from extraEnv that are not in the safe list', () => {
    const result = buildFilteredEnv({ CUSTOM_KEY: 'custom_value' });
    expect(result['CUSTOM_KEY']).toBe('custom_value');
  });
});

// ===========================================================================
// EXIT CODE HANDLING (REQ-011)
// ===========================================================================

describe('exit code handling (REQ-011)', () => {
  it('resolves with exitCode:0 for a successful process', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    emitClose(child, 0);
    const result = await promise;

    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it('resolves (does NOT throw) when the process exits with code 1 (test failures)', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    emitClose(child, 1);
    // Must resolve, never reject, for exit code 1
    const result = await promise;

    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
  });

  it('uses exitCode:1 when the process was killed by a signal (code is null)', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    child.emit('close', null, 'SIGTERM');
    const result = await promise;

    expect(result.exitCode).toBe(1);
  });

  it('captures stdout in the result', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    child.stdout.emit('data', Buffer.from('test output line\n'));
    emitClose(child, 0);
    const result = await promise;

    expect(result.stdout).toBe('test output line\n');
  });

  it('captures stderr in the result', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    child.stderr.emit('data', Buffer.from('warning: something\n'));
    emitClose(child, 0);
    const result = await promise;

    expect(result.stderr).toBe('warning: something\n');
  });

  it('accumulates multiple data chunks into the stdout buffer', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions());
    child.stdout.emit('data', Buffer.from('chunk1'));
    child.stdout.emit('data', Buffer.from(' chunk2'));
    emitClose(child, 0);
    const result = await promise;

    expect(result.stdout).toBe('chunk1 chunk2');
  });
});

// ===========================================================================
// ENOENT — command not found (AC-007)
// ===========================================================================

describe('ENOENT handling (AC-007)', () => {
  function makeEnoent(command: string): Error {
    return Object.assign(new Error(`spawn ${command} ENOENT`), {
      code: 'ENOENT',
    });
  }

  it('throws ExecutionError when the command binary is not found', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ command: 'pytest' }));
    child.emit('error', makeEnoent('pytest'));

    await expect(promise).rejects.toThrow(ExecutionError);
  });

  it('includes "command not found" in the error message', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ command: 'pytest' }));
    child.emit('error', makeEnoent('pytest'));

    await expect(promise).rejects.toThrow(/command not found/);
  });

  it('includes the command name in the error message', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ command: 'pytest' }));
    child.emit('error', makeEnoent('pytest'));

    await expect(promise).rejects.toThrow(/pytest/);
  });

  it('throws ExecutionError for non-ENOENT spawn errors', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ command: 'pytest' }));
    const permError = Object.assign(new Error('spawn EACCES'), {
      code: 'EACCES',
    });
    child.emit('error', permError);

    await expect(promise).rejects.toThrow(ExecutionError);
  });
});

// ===========================================================================
// TIMEOUT — process group kill (AC-008)
// ===========================================================================

describe('timeout / process group kill (AC-008)', () => {
  it('sets timedOut:true when the timeout fires before the process exits', async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_001); // fire the kill timer
    emitClose(child, null);
    const result = await promise;

    expect(result.timedOut).toBe(true);
  });

  it('does NOT set timedOut:true for normal (pre-timeout) exits', async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ timeout: 30_000 }));
    emitClose(child, 0); // exits before the timeout
    const result = await promise;

    expect(result.timedOut).toBe(false);
  });

  it('calls process.kill with a NEGATIVE PID (process group) on timeout', async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    child.pid = 9999;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 1_000 }));
    await vi.advanceTimersByTimeAsync(1_001);
    emitClose(child, null);
    await promise;

    // Negative PID targets the entire process group
    expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('sends SIGKILL after the 5-second grace period following SIGTERM', async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    child.pid = 9999;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 1_000 }));

    // Advance to fire the main kill timer (SIGTERM)
    await vi.advanceTimersByTimeAsync(1_001);
    // Advance past the 5-second SIGKILL grace period
    await vi.advanceTimersByTimeAsync(5_001);

    emitClose(child, null);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(-9999, 'SIGKILL');

    killSpy.mockRestore();
  });

  it('cancels the kill timer so process.kill is NOT called after a normal exit', async () => {
    vi.useFakeTimers();

    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 30_000 }));
    emitClose(child, 0); // exits before timeout
    await promise;

    // Advance well past what would have been the timeout — kill must not fire
    await vi.advanceTimersByTimeAsync(35_000);
    expect(killSpy).not.toHaveBeenCalled();

    killSpy.mockRestore();
  });
});

// ===========================================================================
// STDOUT / STDERR BUFFER OVERFLOW GUARD (> 100 MB)
// ===========================================================================

describe('buffer overflow guard (100 MB)', () => {
  it('kills the process group when stdout exceeds 100 MB', async () => {
    const child = new MockChildProcess();
    child.pid = 7777;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 30_000 }));

    // 101 MB chunk exceeds the 100 MB guard
    child.stdout.emit('data', Buffer.alloc(101 * 1024 * 1024));
    emitClose(child, null);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(-7777, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('kills the process group when stderr exceeds 100 MB', async () => {
    const child = new MockChildProcess();
    child.pid = 7778;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 30_000 }));

    child.stderr.emit('data', Buffer.alloc(101 * 1024 * 1024));
    emitClose(child, null);
    await promise;

    expect(killSpy).toHaveBeenCalledWith(-7778, 'SIGTERM');

    killSpy.mockRestore();
  });

  it('replaces stderr with a descriptive overflow message', async () => {
    const child = new MockChildProcess();
    child.pid = 7779;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 30_000 }));

    child.stdout.emit('data', Buffer.alloc(101 * 1024 * 1024));
    emitClose(child, null);
    const result = await promise;

    expect(result.stderr).toBe(
      'Process killed: stdout/stderr exceeded the 100 MB buffer limit.',
    );
  });

  it('does not append further chunks after overflow is detected', async () => {
    const child = new MockChildProcess();
    child.pid = 7780;
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    vi.spyOn(process, 'kill').mockImplementation(() => true);

    const promise = execute(makeOptions({ timeout: 30_000 }));

    // First chunk: trigger overflow
    child.stdout.emit('data', Buffer.alloc(101 * 1024 * 1024));
    // Second chunk: should be discarded
    child.stdout.emit('data', Buffer.from('should be discarded'));

    emitClose(child, null);
    const result = await promise;

    // stdout should be empty (overflow was triggered on the first chunk before
    // any data was appended to the string buffer)
    expect(result.stdout).toBe('');
  });
});

// ===========================================================================
// TEMP FILE SUPPORT (outputFile)
// ===========================================================================

describe('outputFile handling', () => {
  it('includes the outputFile path in the result when the file exists', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockReadFile.mockResolvedValue(Buffer.from('<junit xml />'));

    const promise = execute(makeOptions({ outputFile: '/tmp/out.xml' }));
    emitClose(child, 0);
    const result = await promise;

    expect(result.outputFile).toBe('/tmp/out.xml');
  });

  it('sets outputFile to undefined when the file does not exist', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockReadFile.mockRejectedValue(
      Object.assign(new Error('no such file'), { code: 'ENOENT' }),
    );

    const promise = execute(makeOptions({ outputFile: '/tmp/missing.xml' }));
    emitClose(child, 0);
    const result = await promise;

    expect(result.outputFile).toBeUndefined();
  });

  it('deletes the outputFile in a finally block on the happy path', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockReadFile.mockResolvedValue(Buffer.from('<xml/>'));
    mockUnlink.mockResolvedValue(undefined);

    const promise = execute(makeOptions({ outputFile: '/tmp/out.xml' }));
    emitClose(child, 0);
    await promise;

    expect(vi.mocked(unlink)).toHaveBeenCalledWith('/tmp/out.xml');
  });

  it('deletes the outputFile in a finally block even when readFile throws', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockReadFile.mockRejectedValue(new Error('read error'));
    mockUnlink.mockResolvedValue(undefined);

    const promise = execute(makeOptions({ outputFile: '/tmp/out.xml' }));
    emitClose(child, 0);
    await promise;

    expect(vi.mocked(unlink)).toHaveBeenCalledWith('/tmp/out.xml');
  });

  it('deletes the outputFile when the process exits with a non-zero code', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockReadFile.mockResolvedValue(Buffer.from(''));
    mockUnlink.mockResolvedValue(undefined);

    const promise = execute(makeOptions({ outputFile: '/tmp/out.xml' }));
    emitClose(child, 1);
    await promise;

    expect(vi.mocked(unlink)).toHaveBeenCalledWith('/tmp/out.xml');
  });

  it('does not call readFile or unlink when outputFile is not provided', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);

    const promise = execute(makeOptions({ outputFile: undefined }));
    emitClose(child, 0);
    await promise;

    expect(vi.mocked(readFile)).not.toHaveBeenCalled();
    expect(vi.mocked(unlink)).not.toHaveBeenCalled();
  });

  it('resolves successfully even if unlink fails (file already gone)', async () => {
    const child = new MockChildProcess();
    mockSpawn.mockReturnValue(child as unknown as ReturnType<typeof spawn>);
    mockReadFile.mockResolvedValue(Buffer.from(''));
    mockUnlink.mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );

    const promise = execute(makeOptions({ outputFile: '/tmp/out.xml' }));
    emitClose(child, 0);

    // Must resolve even if cleanup fails
    await expect(promise).resolves.toBeDefined();
  });
});

// ===========================================================================
// COMMAND_ALLOWLIST contents
// ===========================================================================

describe('COMMAND_ALLOWLIST set', () => {
  it('contains all required test-runner executables', () => {
    const required = [
      'pytest', 'python', 'python3',
      'jest', 'vitest',
      'npx', 'yarn', 'pnpm', 'node',
      'poetry', 'uv',
    ];
    for (const cmd of required) {
      expect(COMMAND_ALLOWLIST.has(cmd), `Expected '${cmd}' in allowlist`).toBe(true);
    }
  });

  it('does not contain shell utilities or dangerous commands', () => {
    const dangerous = ['rm', 'bash', 'sh', 'curl', 'wget', 'pip', 'python2'];
    for (const cmd of dangerous) {
      expect(COMMAND_ALLOWLIST.has(cmd), `Expected '${cmd}' NOT in allowlist`).toBe(false);
    }
  });
});
