// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import { entry } from "../../../../test/helpers/native-launch-readiness.ts";
import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";
import { LaunchReadinessFenceError } from "../../state/launch-readiness-lease";
import type { SandboxEntry } from "../../state/registry";
import {
  inspectLaunchReadiness,
  type LaunchReadinessDeps,
  publicationFromDecision,
  withLaunchReadinessMutationGate,
} from "./launch-readiness";

// The reported #10638 failure needs two facts kept apart: the persistent
// receipt store is unsafe, but the runtime authority epoch was still durably
// rotated. Only a caller that does not require published evidence may continue
// past a receipt-store-only verdict. These cases own that contract at both the
// mutation gate and the connect caller.

const SANDBOX = "alpha";
const GATEWAY_NAME = "nemoclaw";
const GATEWAY_PORT = 8080;
const EPOCH = "a".repeat(64);

describe("launch readiness mutation gate unsafe verdict scope", () => {
  function gateDeps(sandbox: SandboxEntry): LaunchReadinessDeps {
    return {
      getSandbox: () => sandbox,
      withSandboxLock: async <T>(_name: string, operation: () => Promise<T> | T) => operation(),
      withGatewayLock: async <T>(_name: string, operation: () => Promise<T> | T) => operation(),
    };
  }

  function publication() {
    return {
      sandboxName: SANDBOX,
      gatewayName: GATEWAY_NAME,
      gatewayPort: GATEWAY_PORT,
      epochId: EPOCH,
    };
  }

  it("enters the mutation window for a receipt-store-only verdict when the caller tolerates it (#10638)", async () => {
    const currentDeps = gateDeps(entry());
    const evidence = {
      resource: "persistent receipt directory" as const,
      path: "/home/test/.nemoclaw/launch-readiness",
      expectedUid: 1000,
      observedUid: 1000,
      expectedMode: "0700" as const,
      observedMode: "0750",
      operation: "inspect" as const,
      errorCode: null,
      repair: "manual" as const,
    };
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "receipt-store" as const,
      evidence,
    }));
    currentDeps.tolerateReceiptStoreUnsafe = true;
    const mutation = vi.fn(() => "complete");

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({
      kind: "entered",
      value: "complete",
      toleratedReceiptStoreUnsafe: { evidence },
    });
    expect(mutation).toHaveBeenCalledOnce();
  });

  it("never tolerates a runtime-authority verdict even when publication is optional (#10638)", async () => {
    const currentDeps = gateDeps(entry());
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "runtime-authority" as const,
    }));
    currentDeps.tolerateReceiptStoreUnsafe = true;
    const mutation = vi.fn();

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({ kind: "unsafe", scope: "runtime-authority" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("keeps refusing a receipt-store verdict for callers that require publication (#10638)", async () => {
    const currentDeps = gateDeps(entry());
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "receipt-store" as const,
    }));
    const mutation = vi.fn();

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({ kind: "unsafe", scope: "receipt-store" });
    expect(mutation).not.toHaveBeenCalled();
  });

  it("tolerates a receipt-store verdict that carries no bounded evidence (#10638)", async () => {
    // The store can classify an unsafe receipt without a diagnostic snapshot.
    // The caller still runs the complete preflight; it just has no path to show.
    const currentDeps = gateDeps(entry());
    currentDeps.checkMutationAuthority = vi.fn(() => ({
      kind: "unsafe" as const,
      scope: "receipt-store" as const,
    }));
    currentDeps.tolerateReceiptStoreUnsafe = true;
    const mutation = vi.fn(() => "complete");

    await expect(
      withLaunchReadinessMutationGate(publication(), mutation, currentDeps),
    ).resolves.toEqual({
      kind: "entered",
      value: "complete",
      // The marker is present even without a bounded snapshot, so the caller
      // still reports that evidence could not be republished.
      toleratedReceiptStoreUnsafe: {},
    });
    expect(mutation).toHaveBeenCalledOnce();
  });
});

describe("launch readiness rotated-epoch handoff", () => {
  // A fence that rotated the runtime authority and then failed to store its
  // receipt must still pin that epoch. Otherwise the optional-publication gate
  // receives null and accepts a producer that lost authority to a later one.
  it("carries the rotated epoch from the fence through to the mutation gate (#10638)", async () => {
    const rotatedEpochId = "b".repeat(64);
    const laterEpochId = "c".repeat(64);
    const deps: LaunchReadinessDeps = {
      getSandbox: () => entry(),
      withSandboxLock: async <T>(_name: string, operation: () => Promise<T> | T) => operation(),
      withGatewayLock: async <T>(_name: string, operation: () => Promise<T> | T) => operation(),
      readLease: () => ({ kind: "missing" }),
      fenceLease: () => {
        throw new LaunchReadinessFenceError(false, true, false, rotatedEpochId);
      },
      checkMutationAuthority: () => "changed",
    };

    const decision = await inspectLaunchReadiness(SANDBOX, deps);
    expect(decision).toMatchObject({
      kind: "fallback",
      fence: null,
      fenceFailed: true,
      recoveryBlocked: false,
      rotatedEpochId,
    });
    expect(publicationFromDecision(SANDBOX, decision)).toMatchObject({
      epochId: rotatedEpochId,
    });

    // Another producer rotated the authority before this one reached the gate.
    const checkMutationAuthority = vi.fn(() => "changed" as const);
    const mutation = vi.fn();
    await expect(
      withLaunchReadinessMutationGate(
        {
          sandboxName: SANDBOX,
          gatewayName: GATEWAY_NAME,
          gatewayPort: GATEWAY_PORT,
          epochId: laterEpochId,
        },
        mutation,
        { ...deps, checkMutationAuthority, tolerateReceiptStoreUnsafe: true },
      ),
    ).resolves.toEqual({ kind: "changed" });
    expect(mutation).not.toHaveBeenCalled();
  });
});

describe("connectSandbox launch-readiness unsafe verdict scope", () => {
  let exitSpy: MockInstance;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, "isTTY", {
      configurable: true,
      value: originalStdoutIsTty,
    });
  });

  it("probe-only reports bounded unsafe authority evidence before mutation (#10638)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({
      kind: "unsafe",
      scope: "runtime-authority",
      evidence: {
        resource: "persistent receipt",
        path: "/home/test/.nemoclaw/launch-readiness/receipt.json",
        expectedUid: 1000,
        observedUid: 1000,
        expectedMode: "0600",
        observedMode: "0640",
        operation: "inspect",
        errorCode: null,
        repair: "chmod",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    const errors = harness.errorSpy.mock.calls.flat().join("\n");
    expect(errors).toContain("current launch-readiness epoch could not be safely revalidated");
    expect(errors).toContain("expected mode 0600, observed mode 0640");
    expect(errors).toContain("chmod 0600 --");
  });

  it("probe-only still refuses a runtime-authority unsafe verdict when publication is optional (#10638)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({
      kind: "unsafe",
      scope: "runtime-authority",
    });

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).rejects.toThrow("process.exit(1)");

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "current launch-readiness epoch could not be safely revalidated",
    );
  });

  it("probe-only completes recovery when only the receipt store is unsafe and publication is optional (#10638)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: false,
      },
      readinessPublicationResult: {
        kind: "evidence-failed",
        diagnostic: { stage: "publication-store", reason: "receipt-unsafe" },
      },
    });
    harness.launchReadinessMutationGateSpy.mockImplementationOnce((async (...args: unknown[]) => {
      const operation = args[1] as () => unknown;
      // Pin the caller-to-gate option transfer: dropping or reversing
      // `!requireLaunchReadinessPublication` would leave the gate strict and
      // this run would stop before recovery.
      expect(args[2]).toMatchObject({ tolerateReceiptStoreUnsafe: true });
      return {
        kind: "entered",
        value: await operation(),
        toleratedReceiptStoreUnsafe: {
          evidence: {
            resource: "persistent receipt directory",
            path: "/home/test/.nemoclaw/launch-readiness",
            expectedUid: 1000,
            observedUid: 1000,
            expectedMode: "0700",
            observedMode: "0750",
            operation: "inspect",
            errorCode: null,
            repair: "manual",
          },
        },
      };
    }) as never);

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).resolves.toBeUndefined();

    expect(harness.checkAndRecoverSpy).toHaveBeenCalledOnce();
    expect(exitSpy).not.toHaveBeenCalled();
    const logs = harness.logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("launch-readiness evidence cannot be republished");
    expect(logs).toContain("expected mode 0700, observed mode 0750");
    expect(harness.errorSpy.mock.calls.flat().join("\n")).not.toContain("Probe failed");
  });

  it("still reports an evidence-free tolerated verdict instead of finishing silently (#10638)", async () => {
    const harness = createConnectHarness({
      readinessDecision: {
        kind: "fallback",
        category: "unsafe",
        fence: null,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: true,
        recoveryBlocked: false,
      },
      readinessPublicationResult: { kind: "evidence-failed" },
    });
    harness.launchReadinessMutationGateSpy.mockImplementationOnce((async (...args: unknown[]) => {
      const operation = args[1] as () => unknown;
      return {
        kind: "entered",
        value: await operation(),
        // The store classified the receipt as unsafe without a bounded snapshot.
        toleratedReceiptStoreUnsafe: {},
      };
    }) as never);

    await expect(
      harness.connectSandbox("alpha", {
        probeOnly: true,
        requireLaunchReadinessPublication: false,
      }),
    ).resolves.toBeUndefined();

    expect(exitSpy).not.toHaveBeenCalled();
    const logs = harness.logSpy.mock.calls.flat().join("\n");
    expect(logs).toContain("launch-readiness evidence cannot be republished");
    expect(logs).toContain("Repair the current user's secure OS runtime authority");
  });

  it("probe-only still exits when required publication hits an unsafe receipt store (#10638)", async () => {
    const harness = createConnectHarness();
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({
      kind: "unsafe",
      scope: "receipt-store",
      evidence: {
        resource: "persistent receipt directory",
        path: "/home/test/.nemoclaw/launch-readiness",
        expectedUid: 1000,
        observedUid: 1000,
        expectedMode: "0700",
        observedMode: "0750",
        operation: "inspect",
        errorCode: null,
        repair: "manual",
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "current launch-readiness epoch could not be safely revalidated",
    );
  });
});
