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
import type { SandboxEntry } from "../state/registry";

const SANDBOX_FINGERPRINT = "a".repeat(64);
type ExternalPendingPolicyVerification = Extract<
  NonNullable<SandboxEntry["pendingPolicyVerification"]>,
  { policyAuthority: "externally-managed" }
>;

function pendingSandboxEntry(
  overrides: Partial<ExternalPendingPolicyVerification> = {},
): SandboxEntry {
  return {
    name: "new-sb",
    gatewayName: "nemoclaw",
    gatewayPort: 8080,
    lifecycleGeneration: "generation-1",
    lifecycleLiveIdentityFingerprint: SANDBOX_FINGERPRINT,
    pendingPolicyVerification: {
      schemaVersion: 1,
      state: "verified-create",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      sandboxName: "new-sb",
      lifecycleGeneration: "generation-1",
      sandboxIdentityFingerprint: SANDBOX_FINGERPRINT,
      route: "none",
      policyHash: "policy-hash",
      policyVersion: 1,
      policyAuthority: "externally-managed",
      observedPolicyAuthority: "externally-managed",
      ...overrides,
    },
  };
}

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
    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("removed incomplete sandbox 'new-sb'"),
    );
  });

  it("preserves recovery state when container deletion is not confirmed", () => {
    const { deps, calls } = createDeps({ deleteSandboxContainer: vi.fn(() => false) });
    const rollback = createSandboxCancelRollback(deps);

    rollback.arm("new-sb");
    rollback.markCancelled();
    rollback.runIfArmed();

    expect(calls.removeFromRegistry).not.toHaveBeenCalled();
    expect(calls.clearSession).not.toHaveBeenCalled();
    expect(calls.log).toHaveBeenCalledWith(
      expect.stringContaining("preserved incomplete sandbox 'new-sb'"),
    );
    expect(calls.log.mock.calls.flat().join("\n")).not.toContain("openshell sandbox delete");
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
      registry: { getSandbox: () => null, removeSandbox },
      clearOnboardSession: () => {},
      registerExitHandler: (h) => exitHandlers.push(h),
    });

    expect(exitHandlers).toHaveLength(1);

    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    expect(runOpenshell).toHaveBeenCalledWith(["sandbox", "delete", "new-sb"], {
      ignoreError: true,
    });
    expect(removeSandbox).toHaveBeenCalledWith("new-sb");
  });

  it("does not fire the rollback on a non-cancel exit", () => {
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const removeSandbox = vi.fn();
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { getSandbox: () => null, removeSandbox },
      clearOnboardSession: () => {},
      registerExitHandler: (h) => exitHandlers.push(h),
    });
    rollback.arm("new-sb"); // armed, but never cancelled
    exitHandlers[0]();

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(removeSandbox).not.toHaveBeenCalled();
  });

  it("deletes a pending create only after its exact identity and checkpoint are re-read", () => {
    const entry = pendingSandboxEntry();
    const getSandbox = vi.fn(() => entry);
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const removeSandbox = vi.fn();
    const clearOnboardSession = vi.fn();
    const inspectIdentity = vi.fn(() => SANDBOX_FINGERPRINT);
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { getSandbox, removeSandbox },
      clearOnboardSession,
      inspectOpenShellSandboxIdentityFingerprint: inspectIdentity,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    expect(getSandbox).toHaveBeenCalledTimes(2);
    expect(inspectIdentity).toHaveBeenCalledWith({
      sandboxName: "new-sb",
      gatewayName: "nemoclaw",
    });
    expect(runOpenshell).toHaveBeenCalledWith(["sandbox", "delete", "-g", "nemoclaw", "new-sb"], {
      ignoreError: true,
    });
    expect(removeSandbox).toHaveBeenCalledWith("new-sb");
    expect(clearOnboardSession).toHaveBeenCalledOnce();
  });

  it("preserves a pending create and its fingerprint when deletion is not confirmed", () => {
    const entry = pendingSandboxEntry();
    const runOpenshell = vi.fn(() => ({ status: 1 }));
    const removeSandbox = vi.fn();
    const clearOnboardSession = vi.fn();
    const log = vi.fn();
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { getSandbox: () => entry, removeSandbox },
      clearOnboardSession,
      inspectOpenShellSandboxIdentityFingerprint: () => SANDBOX_FINGERPRINT,
      log,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    expect(runOpenshell).toHaveBeenCalledWith(["sandbox", "delete", "-g", "nemoclaw", "new-sb"], {
      ignoreError: true,
    });
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(clearOnboardSession).not.toHaveBeenCalled();
    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain(SANDBOX_FINGERPRINT);
    expect(guidance).toContain("identity-bound recovery");
    expect(guidance).not.toContain("openshell sandbox delete");
  });

  it.each([
    ["does not match", () => "b".repeat(64)],
    [
      "cannot be inspected",
      () => {
        throw new Error("identity unavailable");
      },
    ],
  ])("preserves a pending create when its exact identity %s", (_case, inspect) => {
    const entry = pendingSandboxEntry();
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const removeSandbox = vi.fn();
    const clearOnboardSession = vi.fn();
    const log = vi.fn();
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { getSandbox: () => entry, removeSandbox },
      clearOnboardSession,
      inspectOpenShellSandboxIdentityFingerprint: vi.fn(inspect),
      log,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    expect(runOpenshell).not.toHaveBeenCalled();
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(clearOnboardSession).not.toHaveBeenCalled();
    expect(log.mock.calls.flat().join("\n")).toContain("preserved incomplete sandbox 'new-sb'");
  });

  it("preserves a pending create when its durable checkpoint changes during inspection", () => {
    const entry = pendingSandboxEntry();
    const changed = pendingSandboxEntry({ policyVersion: 2 });
    const getSandbox = vi.fn().mockReturnValueOnce(entry).mockReturnValueOnce(changed);
    const runOpenshell = vi.fn(() => ({ status: 0 }));
    const removeSandbox = vi.fn();
    const clearOnboardSession = vi.fn();
    const exitHandlers: Array<() => void> = [];

    const rollback = installSandboxCancelRollback({
      runOpenshell,
      registry: { getSandbox, removeSandbox },
      clearOnboardSession,
      inspectOpenShellSandboxIdentityFingerprint: () => SANDBOX_FINGERPRINT,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    expect(getSandbox).toHaveBeenCalledTimes(2);
    expect(runOpenshell).not.toHaveBeenCalled();
    expect(removeSandbox).not.toHaveBeenCalled();
    expect(clearOnboardSession).not.toHaveBeenCalled();
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

  it("preserves identity-bound recovery guidance when the delete failed", () => {
    const lines = buildCancelRollbackMessage("sb", false, SANDBOX_FINGERPRINT);
    expect(lines.join("\n")).toContain("preserved incomplete sandbox 'sb'");
    expect(lines.join("\n")).toContain(SANDBOX_FINGERPRINT);
    expect(lines.join("\n")).toContain("identity-bound recovery");
    expect(lines.join("\n")).not.toContain("openshell sandbox delete");
  });
});
