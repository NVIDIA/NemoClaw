// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildCancelRollbackMessage,
  createSandboxCancelRollback,
  installSandboxCancelRollback,
  makeOnboardCancelExit,
} from "./cancel-rollback";

function createGuard() {
  const log = vi.fn();
  return { guard: createSandboxCancelRollback({ log }), log };
}

describe("createSandboxCancelRollback", () => {
  it("preserves the sandbox and recovery state when armed and cancelled (#9833)", () => {
    const { guard, log } = createGuard();
    guard.arm("new-sb");
    guard.markCancelled();
    guard.runIfArmed();
    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain("preserved incomplete sandbox 'new-sb'");
    expect(guidance).toContain("registry and onboarding recovery state");
    expect(guidance).toContain("Do not destroy this sandbox by mutable sandbox name");
  });

  it("does not report recovery on a non-cancel exit (#9833)", () => {
    const { guard, log } = createGuard();
    guard.arm("new-sb");
    guard.runIfArmed();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not report recovery when cancelled before a sandbox is armed (#9833)", () => {
    const { guard, log } = createGuard();
    guard.markCancelled();
    guard.runIfArmed();
    expect(log).not.toHaveBeenCalled();
  });

  it("does not report recovery after the sandbox is disarmed (#9833)", () => {
    const { guard, log } = createGuard();
    guard.arm("new-sb");
    guard.disarm();
    guard.markCancelled();
    guard.runIfArmed();
    expect(log).not.toHaveBeenCalled();
  });

  it("reports recovery at most once (#9833)", () => {
    const { guard, log } = createGuard();
    guard.arm("new-sb");
    guard.markCancelled();
    guard.runIfArmed();
    guard.runIfArmed();
    guard.runIfArmed();
    expect(log).toHaveBeenCalledTimes(buildCancelRollbackMessage("new-sb").length);
  });

  it("reports whether a sandbox is armed", () => {
    const { guard } = createGuard();
    expect(guard.isArmed()).toBe(false);
    guard.arm("new-sb");
    expect(guard.isArmed()).toBe(true);
    guard.disarm();
    expect(guard.isArmed()).toBe(false);
  });

  it("uses the latest sandbox name after rearming (#9833)", () => {
    const { guard, log } = createGuard();
    guard.arm("first");
    guard.arm("second");
    guard.markCancelled();
    guard.runIfArmed();
    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain("'second'");
    expect(guidance).not.toContain("'first'");
  });
});

describe("installSandboxCancelRollback", () => {
  it("registers preservation-only cancellation recovery (#9833)", () => {
    const log = vi.fn();
    const exitHandlers: Array<() => void> = [];
    const guard = installSandboxCancelRollback({
      log,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    expect(exitHandlers).toHaveLength(1);
    guard.arm("new-sb");
    guard.markCancelled();
    exitHandlers[0]();
    expect(log.mock.calls.flat().join("\n")).toContain("preserved incomplete sandbox 'new-sb'");
  });

  it("does not run recovery for an ordinary process exit (#9833)", () => {
    const log = vi.fn();
    const exitHandlers: Array<() => void> = [];
    const guard = installSandboxCancelRollback({
      log,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    guard.arm("new-sb");
    exitHandlers[0]();
    expect(log).not.toHaveBeenCalled();
  });
});

describe("makeOnboardCancelExit", () => {
  it("cleans up, marks cancellation, then exits nonzero", () => {
    const order: string[] = [];
    const cleanup = vi.fn(() => order.push("cleanup"));
    const guard = { markCancelled: vi.fn(() => order.push("markCancelled")) };
    const exit = vi.fn((_code: number) => order.push("exit"));
    makeOnboardCancelExit(guard, cleanup, exit)();
    expect(order).toEqual(["cleanup", "markCancelled", "exit"]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("buildCancelRollbackMessage", () => {
  it("reports identity-bound preservation without name-only destruction (#9833)", () => {
    const guidance = buildCancelRollbackMessage("sb").join("\n");
    expect(guidance).toContain("preserved incomplete sandbox 'sb'");
    expect(guidance).toContain("identity-bound recovery");
    expect(guidance).toContain("Do not destroy this sandbox by mutable sandbox name");
    expect(guidance).not.toContain("removed incomplete sandbox");
    expect(guidance).not.toContain("openshell sandbox delete");
  });
});
