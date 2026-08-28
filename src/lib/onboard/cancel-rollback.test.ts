// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  buildCancelRollbackMessage,
  createSandboxCancelRollback,
  installSandboxCancelRollback,
  makeOnboardCancelExit,
} from "./cancel-rollback";

const SANDBOX_FINGERPRINT = "a".repeat(64);

function createHarness() {
  const log = vi.fn();
  return { log, rollback: createSandboxCancelRollback({ log }) };
}

describe("createSandboxCancelRollback", () => {
  it("preserves an armed cancelled sandbox and reports its captured identity (#9833)", () => {
    const { rollback, log } = createHarness();

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    rollback.markCancelled();
    rollback.runIfArmed();

    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain("preserved incomplete sandbox 'new-sb'");
    expect(guidance).toContain(SANDBOX_FINGERPRINT);
    expect(guidance).toContain("OpenShell administrator");
    expect(guidance).toContain("did not run OpenShell's mutable-name deletion command");
    expect(guidance).toContain("Do not delete the sandbox by mutable sandbox name");
    expect(guidance).toContain("Shared inference providers are gateway configuration");
    expect(guidance).toContain("not sandbox cleanup targets");
    expect(guidance).toContain("sandbox-scoped resources whose ownership is confirmed");
    expect(guidance).toContain("no supported operation to clear this recovery record");
    expect(guidance).toContain("credential environment name alone does not prove exposure");
    expect(guidance).toContain("rotate a credential only when identity-bound inspection proves");
    expect(guidance).not.toContain("rotate any credential");
  });

  it.each([
    ["missing", undefined],
    ["invalid", "not-a-fingerprint"],
  ])("preserves registry and session recovery guidance when identity is %s", (_case, identity) => {
    const { rollback, log } = createHarness();

    rollback.arm("new-sb", identity);
    rollback.markCancelled();
    rollback.runIfArmed();

    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain("preserved incomplete sandbox 'new-sb'");
    expect(guidance).toContain("identity fingerprint is unavailable");
    expect(guidance).toContain("preserve the registry and onboarding recovery state");
  });

  it("does not run on a non-cancel exit", () => {
    const { rollback, log } = createHarness();

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    rollback.runIfArmed();

    expect(log).not.toHaveBeenCalled();
  });

  it("does not run when cancelled before any sandbox was armed", () => {
    const { rollback, log } = createHarness();

    rollback.markCancelled();
    rollback.runIfArmed();

    expect(log).not.toHaveBeenCalled();
  });

  it("does not run after disarm", () => {
    const { rollback, log } = createHarness();

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    rollback.disarm();
    rollback.markCancelled();
    rollback.runIfArmed();

    expect(log).not.toHaveBeenCalled();
  });

  it("runs at most once", () => {
    const { rollback, log } = createHarness();

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    rollback.markCancelled();
    rollback.runIfArmed();
    const callCount = log.mock.calls.length;
    rollback.runIfArmed();

    expect(log).toHaveBeenCalledTimes(callCount);
  });

  it("tracks the latest armed sandbox and identity", () => {
    const { rollback, log } = createHarness();

    expect(rollback.isArmed()).toBe(false);
    rollback.arm("first", "b".repeat(64));
    rollback.arm("second", SANDBOX_FINGERPRINT);
    expect(rollback.isArmed()).toBe(true);
    rollback.markCancelled();
    rollback.runIfArmed();

    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain("second");
    expect(guidance).toContain(SANDBOX_FINGERPRINT);
    expect(guidance).not.toContain("b".repeat(64));
    expect(rollback.isArmed()).toBe(false);
  });
});

describe("installSandboxCancelRollback", () => {
  it("registers a non-destructive exit handler that retains external recovery state (#9833)", () => {
    const log = vi.fn();
    const recordRecovery = vi.fn();
    const exitHandlers: Array<() => void> = [];
    const rollback = installSandboxCancelRollback({
      log,
      recordRecovery,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    expect(exitHandlers).toHaveLength(1);
    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    rollback.markCancelled();
    exitHandlers[0]();

    expect(recordRecovery).toHaveBeenCalledWith("new-sb", SANDBOX_FINGERPRINT, undefined);
    expect(log.mock.calls.flat().join("\n")).toContain(SANDBOX_FINGERPRINT);
  });

  it("forwards the full verified tuple from cancellation to durable state (#9833)", () => {
    const recordRecovery = vi.fn();
    const recoveryContext = {
      gatewayName: "nemoclaw-18080",
      gatewayPort: 18080,
      lifecycleGeneration: "00000000-0000-4000-8000-000000000004",
      verifiedEffectivePolicyIdentity: { hash: "sha256:policy-4", activeVersion: 4 },
    } as const;
    const rollback = createSandboxCancelRollback({ log: vi.fn(), recordRecovery });
    const armWithContext = rollback.arm as (
      sandboxName: string,
      sandboxIdentityFingerprint: string,
      context: typeof recoveryContext,
    ) => void;

    armWithContext("new-sb", SANDBOX_FINGERPRINT, recoveryContext);
    rollback.markCancelled();

    expect(recordRecovery).toHaveBeenCalledWith("new-sb", SANDBOX_FINGERPRINT, recoveryContext);
  });

  it("persists recovery before a deferred process exit and records it once (#9833)", () => {
    const log = vi.fn();
    const recordRecovery = vi.fn();
    const exitHandlers: Array<() => void> = [];
    const rollback = installSandboxCancelRollback({
      log,
      recordRecovery,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    const deferredExit = new Error("deferred exit");
    const cancel = makeOnboardCancelExit(rollback, vi.fn(), () => {
      throw deferredExit;
    });

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    expect(() => cancel()).toThrow(deferredExit);
    expect(recordRecovery).toHaveBeenCalledOnce();
    expect(recordRecovery).toHaveBeenCalledWith("new-sb", SANDBOX_FINGERPRINT, undefined);

    exitHandlers[0]();
    expect(recordRecovery).toHaveBeenCalledOnce();
    expect(log.mock.calls.flat().join("\n")).toContain(SANDBOX_FINGERPRINT);
  });

  it("retries recovery from the exit handler after the immediate durable write fails (#9833)", () => {
    const log = vi.fn();
    const recordRecovery = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("recovery write failed");
      })
      .mockImplementationOnce(() => undefined);
    const exitHandlers: Array<() => void> = [];
    const rollback = installSandboxCancelRollback({
      log,
      recordRecovery,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    expect(() => rollback.markCancelled()).not.toThrow();
    expect(recordRecovery).toHaveBeenCalledOnce();

    exitHandlers[0]();
    expect(recordRecovery).toHaveBeenCalledTimes(2);
    expect(recordRecovery).toHaveBeenLastCalledWith("new-sb", SANDBOX_FINGERPRINT, undefined);
    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain(SANDBOX_FINGERPRINT);
    expect(guidance).not.toContain("could not save the onboarding recovery record");
  });

  it("exits and reports identity recovery when both durable writes fail (#9833)", () => {
    const log = vi.fn();
    const recordRecovery = vi.fn(() => {
      throw new Error("recovery write failed");
    });
    const exitHandlers: Array<() => void> = [];
    const rollback = installSandboxCancelRollback({
      log,
      recordRecovery,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });
    const exit = vi.fn();

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    expect(() => makeOnboardCancelExit(rollback, vi.fn(), exit)()).not.toThrow();
    expect(exit).toHaveBeenCalledWith(1);

    expect(() => exitHandlers[0]()).not.toThrow();
    expect(recordRecovery).toHaveBeenCalledTimes(2);
    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain(SANDBOX_FINGERPRINT);
    expect(guidance).toContain("could not save the onboarding recovery record");
  });

  it("retries recovery on a repeated exit callback after two durable writer failures (#9833)", () => {
    const log = vi.fn();
    const recordRecovery = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("immediate recovery write failed");
      })
      .mockImplementationOnce(() => {
        throw new Error("first exit recovery write failed");
      })
      .mockImplementationOnce(() => undefined);
    const exitHandlers: Array<() => void> = [];
    const rollback = installSandboxCancelRollback({
      log,
      recordRecovery,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });

    rollback.arm("new-sb", SANDBOX_FINGERPRINT);
    rollback.markCancelled();
    exitHandlers[0]();
    exitHandlers[0]();

    expect(recordRecovery).toHaveBeenCalledTimes(3);
    expect(recordRecovery).toHaveBeenNthCalledWith(3, "new-sb", SANDBOX_FINGERPRINT, undefined);
    const guidanceCalls = log.mock.calls.filter(([message]) =>
      String(message).includes("preserved incomplete sandbox"),
    );
    expect(guidanceCalls).toHaveLength(1);

    exitHandlers[0]();
    expect(recordRecovery).toHaveBeenCalledTimes(3);
  });

  it("preserves missing-checkpoint recovery state without a mutable-name fallback (#9833)", () => {
    const log = vi.fn();
    const exitHandlers: Array<() => void> = [];
    const rollback = installSandboxCancelRollback({
      log,
      registerExitHandler: (handler) => exitHandlers.push(handler),
    });

    rollback.arm("new-sb");
    rollback.markCancelled();
    exitHandlers[0]();

    const guidance = log.mock.calls.flat().join("\n");
    expect(guidance).toContain("identity fingerprint is unavailable");
    expect(guidance).toContain("OpenShell administrator");
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
  it("preserves identity-bound recovery guidance", () => {
    const message = buildCancelRollbackMessage("sb", SANDBOX_FINGERPRINT).join("\n");

    expect(message).toContain("preserved incomplete sandbox 'sb'");
    expect(message).toContain(SANDBOX_FINGERPRINT);
    expect(message).toContain("identity-bound inspection, recovery, or removal");
    expect(message).not.toContain("openshell sandbox delete");
    expect(message).not.toContain("cannot delete it by immutable identity");
  });
});
