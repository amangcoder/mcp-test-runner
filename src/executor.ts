/**
 * src/executor.ts
 *
 * Secure child-process executor for test runner commands.
 *
 * SECURITY CRITICAL — this module is the primary attack surface.
 *
 * Security properties enforced:
 *  1. shell:false at all times — no shell interpolation of arguments
 *  2. Command allowlist — only known-safe executables may be spawned
 *  3. Environment filtering — only safe env vars are forwarded to child
 *  4. Process group kill — SIGTERM → SIGKILL on timeout (detached:true)
 *  5. Buffer guard — stdout/stderr capped at 100 MB to prevent DoS
 */

import { spawn } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import type { ExecuteOptions, ExecutionResult } from './types.js';
import { CommandInjectionError, ExecutionError } from './errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Complete list of permitted test-runner commands.
 * Any command not in this set throws CommandInjectionError before spawn.
 */
export const COMMAND_ALLOWLIST: ReadonlySet<string> = new Set([
  'pytest',
  'python',
  'python3',
  'jest',
  'vitest',
  'npx',
  'yarn',
  'pnpm',
  'node',
  'poetry',
  'uv',
]);

/**
 * Environment variable keys that are safe to forward to child processes.
 * Explicit allowlist prevents secret/credential leakage from process.env.
 */
const SAFE_ENV_KEYS: ReadonlyArray<string> = [
  'PATH',
  'HOME',
  'USER',
  'USERNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'NODE_PATH',
  'PYTHONPATH',
  'VIRTUAL_ENV',
  'CONDA_DEFAULT_ENV',
  'CI',
  'NODE_ENV',
  'TERM',
  'TMPDIR',
  'npm_config_prefix',
];

/** Maximum stdout+stderr size before killing the process (100 MB). */
const MAX_BUFFER_BYTES = 100 * 1024 * 1024;

/** Grace period between SIGTERM and SIGKILL on timeout or buffer overflow. */
const KILL_GRACE_MS = 5_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a child-process environment by:
 *  1. Picking only SAFE_ENV_KEYS from the host process.env
 *  2. Merging with caller-supplied env overrides (caller values win on conflicts)
 *
 * Never passes the full process.env to avoid leaking secrets/credentials.
 */
export function buildFilteredEnv(extraEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const filtered: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      filtered[key] = value;
    }
  }
  // Caller-supplied env is merged last — it can override safe keys or add extras.
  return { ...filtered, ...extraEnv };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes a test runner command as a child process with strict security controls.
 *
 * Resolves with an ExecutionResult for all process exits, including exit code 1
 * (test failures). Only throws for infrastructure failures (command not found, etc.).
 *
 * @param options - Execution parameters
 * @returns Resolved ExecutionResult when the process exits (even on test failures)
 *
 * @throws {CommandInjectionError} if options.command is not in COMMAND_ALLOWLIST
 * @throws {ExecutionError} if the command binary cannot be found (ENOENT)
 * @throws {ExecutionError} for unexpected spawn-level failures
 */
export async function execute(options: ExecuteOptions): Promise<ExecutionResult> {
  const { command, args, cwd, timeout, env, outputFile } = options;

  // ── Security check 1: command allowlist ────────────────────────────────
  if (!COMMAND_ALLOWLIST.has(command)) {
    throw new CommandInjectionError(
      `Command '${command}' is not in the allowlist. ` +
        `Permitted commands: ${[...COMMAND_ALLOWLIST].join(', ')}.`,
    );
  }

  // ── Security check 2: env filtering ────────────────────────────────────
  const filteredEnv = buildFilteredEnv(env);

  return new Promise<ExecutionResult>((resolve, reject) => {
    // ── Spawn: shell:false enforced, detached:true for process-group kill ──
    const child = spawn(command, args, {
      shell: false,
      detached: true,
      cwd,
      env: filteredEnv,
    });

    // Accumulators
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let bufferOverflowed = false;

    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let sigkillTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Send a signal to the entire process group by negating the PID.
     * Requires the child to have been spawned with detached:true.
     */
    function signalGroup(signal: NodeJS.Signals): void {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // ESRCH — process (group) already exited; ignore.
        }
      }
    }

    /**
     * Initiate a graceful kill: SIGTERM now, SIGKILL after KILL_GRACE_MS.
     * Used both for timeout kills and for buffer-overflow kills.
     */
    function initiateKill(): void {
      signalGroup('SIGTERM');
      sigkillTimer = setTimeout(() => {
        signalGroup('SIGKILL');
      }, KILL_GRACE_MS);
    }

    // ── Error handler: ENOENT and other spawn failures ──────────────────
    child.on('error', (err: Error) => {
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);
      // Cast to ErrnoException to access the .code property set by Node.js
      // when the underlying OS call fails (e.g. ENOENT, EACCES).
      const errno = err as NodeJS.ErrnoException;
      if (errno.code === 'ENOENT') {
        reject(
          new ExecutionError(
            `command not found: ${command}. Ensure it is installed and available in PATH.`,
          ),
        );
      } else {
        reject(
          new ExecutionError(`Failed to spawn '${command}': ${err.message}`),
        );
      }
    });

    // ── Stdout: accumulate, enforce 100 MB hard limit ───────────────────
    child.stdout?.on('data', (chunk: Buffer) => {
      if (bufferOverflowed) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_BUFFER_BYTES) {
        bufferOverflowed = true;
        clearTimeout(killTimer);
        initiateKill();
        return;
      }
      stdoutBuffer += chunk.toString('utf8');
    });

    // ── Stderr: accumulate, enforce 100 MB hard limit ───────────────────
    child.stderr?.on('data', (chunk: Buffer) => {
      if (bufferOverflowed) return;
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_BUFFER_BYTES) {
        bufferOverflowed = true;
        clearTimeout(killTimer);
        initiateKill();
        return;
      }
      stderrBuffer += chunk.toString('utf8');
    });

    // ── Timeout: SIGTERM → SIGKILL after grace period ───────────────────
    killTimer = setTimeout(() => {
      timedOut = true;
      initiateKill();
    }, timeout);

    // ── Process exit ────────────────────────────────────────────────────
    child.on('close', (code: number | null) => {
      clearTimeout(killTimer);
      clearTimeout(sigkillTimer);

      // A null exit code means the process was killed by a signal.
      const exitCode = code ?? 1;

      const stderrFinal = bufferOverflowed
        ? 'Process killed: stdout/stderr exceeded the 100 MB buffer limit.'
        : stderrBuffer;

      /**
       * Read the optional output file (for JUnit XML / JSON reporter output),
       * then unconditionally delete it in a finally block to prevent temp
       * file accumulation regardless of success, failure, or timeout.
       */
      const finalize = async (): Promise<ExecutionResult> => {
        let outputFileResolved: string | undefined;
        try {
          if (outputFile !== undefined) {
            try {
              // Attempt to read the file to confirm it exists.
              // The path is included in the result so downstream parsers can
              // consume it (e.g. via the same outputFile path before deletion).
              await readFile(outputFile);
              outputFileResolved = outputFile;
            } catch {
              // File was not created (process was killed before writing, etc.)
              outputFileResolved = undefined;
            }
          }

          return {
            exitCode,
            stdout: stdoutBuffer,
            stderr: stderrFinal,
            outputFile: outputFileResolved,
            timedOut,
          };
        } finally {
          // Always remove the temp file — even on the error path.
          if (outputFile !== undefined) {
            try {
              await unlink(outputFile);
            } catch {
              // File may have never been created or was already removed; ignore.
            }
          }
        }
      };

      finalize().then(resolve).catch(reject);
    });
  });
}
