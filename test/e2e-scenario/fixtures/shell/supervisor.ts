// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

/**
 * Lifecycle-only supervisor for child processes spawned by the E2E
 * TypeScript layer.
 *
 * Spec ownership: detached process-group cleanup, SIGTERM -> SIGKILL
 * escalation, timeout enforcement, and AbortSignal handling are
 * FIXTURE INFRASTRUCTURE. Every TS spawn site delegates here so the
 * cleanup contract stays in one place. Callers keep their own spawn()
 * call so per-site argv contracts (literal `bash -c` scripts with
 * positional argv, host-CLI argv arrays, trusted-command descriptors)
 * and any CodeQL suppression markers stay attached to the literal
 * spawn line that actually performs the syscall.
 *
 * Contract:
 *   - The caller spawns the child with `detached: true` so the
 *     supervisor can target the whole process group when delivering
 *     signals. Without it, bash ignores SIGTERM until its current
 *     foreground command (e.g. `sleep`) returns, so timeouts never
 *     actually fire.
 *   - The caller hands the resulting `ChildProcess` to
 *     `superviseChild` immediately, before awaiting any other event.
 *   - The caller wires up its own redaction / evidence policy via the
 *     `onStdout` / `onStderr` chunk callbacks. The supervisor never
 *     touches the evidence layer itself.
 */

export interface SuperviseOptions {
  /** Max wall-clock budget for the child, in milliseconds. On expiry
   *  the supervisor sends SIGTERM to the process group, then SIGKILL
   *  after `killGraceMs`. */
  timeoutMs: number;
  /** Grace between SIGTERM and SIGKILL. Defaults to 5 s to match the
   *  PhaseOrchestrator's historic behavior. Lower values (e.g. 1 s)
   *  fit the fixture layer's tighter cleanup window. */
  killGraceMs?: number;
  /** External cancel. When aborted, the supervisor terminates the
   *  child group the same way it does on timeout but reports
   *  `timedOut: false`. */
  signal?: AbortSignal;
  /** UTF-8 stdin payload. Requires the caller to have set
   *  `stdio[0] = "pipe"` so `child.stdin` is a writable stream. */
  stdin?: string;
  /** Per-chunk stdout sink. Receives the UTF-8 decoded chunk. The
   *  supervisor performs no buffering or redaction itself. */
  onStdout?: (chunk: string) => void;
  /** Per-chunk stderr sink. Receives the UTF-8 decoded chunk. */
  onStderr?: (chunk: string) => void;
}

export interface SuperviseResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  /** True when the child was killed by the timeout. AbortSignal-driven
   *  termination keeps this false so callers can distinguish budget
   *  exhaustion from external cancellation. */
  timedOut: boolean;
  /** Set when the spawn itself failed (ENOENT, EPERM, ...). Mutually
   *  exclusive with a non-null `exitCode`. */
  spawnError?: Error;
}

const DEFAULT_KILL_GRACE_MS = 5_000;

export function superviseChild(
  child: ChildProcess,
  opts: SuperviseOptions,
): Promise<SuperviseResult> {
  return new Promise<SuperviseResult>((resolve) => {
    const killGraceMs = opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
    const pgid = child.pid;

    const signalProcessGroup = (signal: NodeJS.Signals): void => {
      if (typeof pgid === "number") {
        try {
          process.kill(-pgid, signal);
          return;
        } catch {
          /* fall back to the leader below */
        }
      }
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    };

    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    const terminate = (): void => {
      signalProcessGroup("SIGTERM");
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => {
        signalProcessGroup("SIGKILL");
      }, killGraceMs);
      killTimer.unref();
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, opts.timeoutMs);

    const onAbort = (): void => {
      // Disarm the wall timer first so a late firing cannot retroactively
      // flag timedOut=true for what is in fact an external cancellation.
      clearTimeout(timeout);
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
      } else {
        opts.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    if (opts.onStdout && child.stdout) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        opts.onStdout?.(chunk);
      });
    }
    if (opts.onStderr && child.stderr) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        opts.onStderr?.(chunk);
      });
    }
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }

    let settled = false;
    const settle = (result: SuperviseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (opts.signal) opts.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };

    child.on("error", (err) => {
      settle({ exitCode: null, signal: null, timedOut, spawnError: err });
    });
    child.on("close", (code, signal) => {
      settle({ exitCode: code, signal, timedOut });
    });
  });
}
