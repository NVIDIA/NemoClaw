// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChildProcess } from "node:child_process";

export type ChildProcessOwnerOptions = {
  forceTimeoutMs?: number;
  gracefulTimeoutMs?: number;
};

export type ChildProcessOwner = {
  child: ChildProcess;
  closed: Promise<void>;
  terminate: () => Promise<void>;
};

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function childStdioClosed(child: ChildProcess): boolean {
  return child.stdio.every((stream) => stream === null || stream === undefined || stream.destroyed);
}

function waitFor(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(completed);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    timer.unref();
    void promise.then(() => finish(true));
  });
}

export function ownChildProcess(
  child: ChildProcess,
  options: ChildProcessOwnerOptions = {},
): ChildProcessOwner {
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 1_000;
  const forceTimeoutMs = options.forceTimeoutMs ?? 1_000;
  let closed = childHasExited(child) && childStdioClosed(child);
  const closedPromise = closed
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        child.once("close", () => {
          closed = true;
          resolve();
        });
      });

  return {
    child,
    closed: closedPromise,
    terminate: async () => {
      if (closed) return;
      if (!childHasExited(child)) child.kill("SIGTERM");
      if (await waitFor(closedPromise, gracefulTimeoutMs)) return;
      if (!childHasExited(child)) child.kill("SIGKILL");
      if (!(await waitFor(closedPromise, forceTimeoutMs))) {
        throw new Error(`Child process ${child.pid ?? "<unknown>"} did not close after SIGKILL`);
      }
    },
  };
}
