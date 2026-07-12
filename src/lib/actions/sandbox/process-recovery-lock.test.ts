// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, describe, expect, it, vi } from "vitest";

const requireSource = createRequire(import.meta.url);
const PROCESS_RECOVERY_MODULE = "./process-recovery.js";
const TIMER_BOUND_LOCK_MODULE = "../../shields/timer-bound-lock.js";
const AGENT_RUNTIME_MODULE = "../../agent/runtime.js";

describe("gateway process recovery timer ownership", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete require.cache[requireSource.resolve(PROCESS_RECOVERY_MODULE)];
  });

  it("rechecks the timer generation after waiting and carries the current token", () => {
    delete require.cache[requireSource.resolve(PROCESS_RECOVERY_MODULE)];
    const timerBound = requireSource(
      TIMER_BOUND_LOCK_MODULE,
    ) as typeof import("../../shields/timer-bound-lock");
    const actualWithTimerBoundLock = timerBound.withTimerBoundShieldsMutationLock;
    const oldToken = "1".repeat(32);
    const currentToken = "2".repeat(32);
    const tokens = [oldToken, currentToken, currentToken, currentToken];
    const owners: unknown[] = [];

    vi.spyOn(timerBound, "withTimerBoundShieldsMutationLock").mockImplementation(
      (sandboxName, command, callback) =>
        actualWithTimerBoundLock(sandboxName, command, callback, {
          readToken: () => tokens.shift(),
          withLock: (_name, _command, fn, options) => {
            owners.push(options);
            return fn();
          },
          withLockAsync: vi.fn(),
        }),
    );
    const agentRuntime = requireSource(
      AGENT_RUNTIME_MODULE,
    ) as typeof import("../../agent/runtime");
    vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue({
      runtime: { kind: "terminal" },
    } as never);

    const recovery = requireSource(PROCESS_RECOVERY_MODULE) as typeof import("./process-recovery");
    expect(recovery.checkAndRecoverSandboxProcesses("terminal-box", { quiet: true })).toEqual({
      checked: true,
      wasRunning: null,
      recovered: false,
      forwardRecovered: false,
      runtime: "terminal",
    });
    expect(owners).toEqual([{ takeoverToken: oldToken }, { takeoverToken: currentToken }]);
  });
});
