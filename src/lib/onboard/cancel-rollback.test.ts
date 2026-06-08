// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildCancelRollbackMessage,
  createSandboxCancelRollback,
  installSandboxCancelRollback,
  makeOnboardCancelExit,
  type SandboxCancelRollbackDeps,
} from "./cancel-rollback";

function createDeps(overrides: Partial<SandboxCancelRollbackDeps> = {}) {
  const calls = {
    deleteContainer: vi.fn((_name: string) => true),
    removeFromRegistry: vi.fn(),
    clearSession: vi.fn(),
    log: vi.fn(),
  };
  const deps: SandboxCancelRollbackDeps = {
    deleteSandboxContainer: calls.deleteContainer,
    removeSandboxFromRegistry: calls.removeFromRegistry,
    clearOnboardSession: calls.clearSession,
    log: calls.log,
    ...overrides,
  };
  return { calls, deps };
}

describe("createSandboxCancelRollback", () => {
  it("rolls back (delete + unregister) when armed and cancelled", () => {
    const { deps, calls } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("new-sb");
    rollback.markCancelled();
    rollback.runIfArmed();

    expect(calls.deleteContainer).toHaveBeenCalledWith("new-sb");
    expect(calls.removeFromRegistry).toHaveBeenCalledWith("new-sb");
    // also discards the aborted session so `nemoclaw list` recovery can't resurrect it
    expect(calls.clearSession).toHaveBeenCalledOnce();
    // delete is attempted before the registry entry is removed
    expect(calls.deleteContainer.mock.invocationCallOrder[0]).toBeLessThan(
      calls.removeFromRegistry.mock.invocationCallOrder[0],
    );
    expect(calls.log).toHaveBeenCalledWith(expect.stringContaining("removed incomplete sandbox 'new-sb'"));
  });

  it("still unregisters and prints manual cleanup when container delete fails", () => {
    const { deps, calls } = createDeps({ deleteSandboxContainer: vi.fn(() => false) });
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("new-sb");
    rollback.markCancelled();
    rollback.runIfArmed();

    expect(calls.removeFromRegistry).toHaveBeenCalledWith("new-sb");
    expect(calls.log).toHaveBeenCalledWith(expect.stringContaining("unregistered incomplete sandbox 'new-sb'"));
    expect(calls.log).toHaveBeenCalledWith(expect.stringContaining('openshell sandbox delete "new-sb"'));
  });

  it("does NOT roll back on a non-cancel exit (armed but not cancelled)", () => {
    const { deps, calls } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("new-sb");
    // no markCancelled() — this is an ordinary failure-path process.exit
    rollback.runIfArmed();

    expect(calls.deleteContainer).not.toHaveBeenCalled();
    expect(calls.removeFromRegistry).not.toHaveBeenCalled();
    expect(calls.clearSession).not.toHaveBeenCalled();
    expect(calls.log).not.toHaveBeenCalled();
  });

  it("does NOT roll back when cancelled before any sandbox was armed", () => {
    const { deps, calls } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    rollback.markCancelled();
    rollback.runIfArmed();

    expect(calls.deleteContainer).not.toHaveBeenCalled();
    expect(calls.removeFromRegistry).not.toHaveBeenCalled();
  });

  it("does NOT roll back after disarm (policies confirmed), even if later cancelled", () => {
    const { deps, calls } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("new-sb");
    rollback.disarm();
    rollback.markCancelled();
    rollback.runIfArmed();

    expect(calls.deleteContainer).not.toHaveBeenCalled();
    expect(calls.removeFromRegistry).not.toHaveBeenCalled();
  });

  it("is idempotent — runs the rollback at most once", () => {
    const { deps, calls } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("new-sb");
    rollback.markCancelled();
    rollback.runIfArmed();
    rollback.runIfArmed();
    rollback.runIfArmed();

    expect(calls.deleteContainer).toHaveBeenCalledTimes(1);
    expect(calls.removeFromRegistry).toHaveBeenCalledTimes(1);
  });

  it("reports armed state via isArmed()", () => {
    const { deps } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    expect(rollback.isArmed()).toBe(false);
    rollback.arm("new-sb");
    expect(rollback.isArmed()).toBe(true);
    rollback.disarm();
    expect(rollback.isArmed()).toBe(false);
  });

  it("re-arming after a previous sandbox tracks the latest name", () => {
    const { deps, calls } = createDeps();
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("first");
    rollback.arm("second");
    rollback.markCancelled();
    rollback.runIfArmed();

    expect(calls.deleteContainer).toHaveBeenCalledWith("second");
    expect(calls.deleteContainer).not.toHaveBeenCalledWith("first");
  });
});

describe("installSandboxCancelRollback", () => {
  it("wires delete to openshell and unregister to the registry, and registers an exit hook", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const removeSandbox = vi.fn();
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { removeSandbox },
      clearOnboardSession: () => {},
      registerExitHandler: (h) => exitHandlers.push(h),
    });

    expect(exitHandlers).toHaveLength(1);

    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    expect(runOpenshell).toHaveBeenCalledWith(["sandbox", "delete", "new-sb"], { ignoreError: true });
    expect(removeSandbox).toHaveBeenCalledWith("new-sb");
  });

  it("does not fire the rollback on a non-cancel exit", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const removeSandbox = vi.fn();
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { removeSandbox },
      clearOnboardSession: () => {},
      registerExitHandler: (h) => exitHandlers.push(h),
    });
    rollback.arm("new-sb"); // armed, but never cancelled
    exitHandlers[0]();

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(removeSandbox).not.toHaveBeenCalled();
  });
});

describe("makeOnboardCancelExit", () => {
  it("cleans up, marks cancelled, then exits non-zero", () => {
    const order: string[] = [];
    const cleanup = vi.fn(() => order.push("cleanup"));
    const rollback = { markCancelled: vi.fn(() => order.push("markCancelled")) };
    const exit = vi.fn((_code: number) => {
      order.push("exit");
    });

    makeOnboardCancelExit(rollback, cleanup, exit)();

    expect(order).toEqual(["cleanup", "markCancelled", "exit"]);
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe("buildCancelRollbackMessage", () => {
  it("reports a clean removal when the delete succeeded", () => {
    const lines = buildCancelRollbackMessage("sb", true);
    expect(lines.join("\n")).toContain("removed incomplete sandbox 'sb'");
    expect(lines.join("\n")).not.toContain("openshell sandbox delete");
  });

  it("falls back to manual cleanup guidance when the delete failed", () => {
    const lines = buildCancelRollbackMessage("sb", false);
    expect(lines.join("\n")).toContain("unregistered incomplete sandbox 'sb'");
    expect(lines.join("\n")).toContain('openshell sandbox delete "sb"');
  });
});
