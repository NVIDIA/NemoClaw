// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Observe exit of a detached ChildProcess without relying on
 * `process.kill(pid, 0)`.
 *
 * ## Why not just `isPidAlive`?
 *
 * `isPidAlive` (in `onboard.ts`) uses `process.kill(pid, 0)` which returns
 * **true for zombies** (detached children that exited but were not reaped
 * by a `wait()` call). `onboard.ts:startDockerDriverGateway` spawns its
 * gateway binary with `detached: true` + `child.unref()` and never calls
 * `wait()`, so a crashed child lingers as a zombie indefinitely and
 * `isPidAlive` reports it as alive.
 *
 * This module solves that by registering a one-shot `'exit'` listener on
 * the `ChildProcess` object. The event fires reliably for detached
 * children once libuv observes `SIGCHLD`, regardless of whether the
 * parent ever reaps. Poll loops can then consult the returned state
 * alongside `isPidAlive` for defence in depth.
 *
 * This is the caller-side half of the #3111 fix. The other half is the
 * real TCP liveness probe in `./gateway-tcp-readiness`.
 */

import type { ChildProcess } from "node:child_process";

export type ChildExitState = {
  /** True once the 'exit' event has fired for this child. */
  readonly exited: boolean;
  /** Exit code, or null if the child was killed by a signal or is still running. */
  readonly code: number | null;
  /** Terminating signal, or null if the child exited normally or is still running. */
  readonly signal: NodeJS.Signals | null;
  /**
   * Human-readable description of how the child exited, or null if it
   * hasn't exited yet. Suitable for inclusion in user-facing failure
   * messages like:
   *
   *   console.error(`Gateway process ${state.describeExit()} before becoming ready.`);
   *   // → "Gateway process exited with code 127 before becoming ready."
   *   // → "Gateway process killed by signal SIGKILL before becoming ready."
   */
  describeExit(): string | null;
};

/**
 * Attach a one-shot 'exit' listener to `child` and return a read-only
 * view of its exit state. The listener runs even after `child.unref()`,
 * so the caller is free to detach the child from the event loop.
 */
export function trackChildExit(child: ChildProcess): ChildExitState {
  const state = {
    exited: false,
    code: null as number | null,
    signal: null as NodeJS.Signals | null,
  };
  child.once(
    "exit",
    (code: number | null, signal: NodeJS.Signals | null) => {
      state.exited = true;
      state.code = code;
      state.signal = signal;
    },
  );
  return {
    get exited() {
      return state.exited;
    },
    get code() {
      return state.code;
    },
    get signal() {
      return state.signal;
    },
    describeExit(): string | null {
      if (!state.exited) return null;
      if (state.signal !== null) return `killed by signal ${state.signal}`;
      return `exited with code ${state.code ?? "(unknown)"}`;
    },
  };
}
