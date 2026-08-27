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
    expect(guidance).toContain("confirm that the exact sandbox is absent");
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

    expect(recordRecovery).toHaveBeenCalledWith("new-sb", SANDBOX_FINGERPRINT);
    expect(log.mock.calls.flat().join("\n")).toContain(SANDBOX_FINGERPRINT);
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
    expect(recordRecovery).toHaveBeenCalledWith("new-sb", SANDBOX_FINGERPRINT);

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
    expect(recordRecovery).toHaveBeenLastCalledWith("new-sb", SANDBOX_FINGERPRINT);
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
  it("preserves identity-bound recovery guidance", () => {
    const message = buildCancelRollbackMessage("sb", SANDBOX_FINGERPRINT).join("\n");

    expect(message).toContain("preserved incomplete sandbox 'sb'");
    expect(message).toContain(SANDBOX_FINGERPRINT);
    expect(message).toContain("identity-bound inspection, recovery, or removal");
    expect(message).not.toContain("openshell sandbox delete");
    expect(message).not.toContain("cannot delete it by immutable identity");
  });
});
