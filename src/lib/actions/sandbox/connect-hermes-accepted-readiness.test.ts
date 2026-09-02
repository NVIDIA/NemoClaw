// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";
import { HermesPortableForwardRecoveryError } from "./probe/hermes-portable-forward-recovery";

const originalStdoutIsTty = process.stdout.isTTY;

function acceptedHermesHarness(provider: string | null, model: string | null) {
  const entry = {
    name: "alpha",
    agent: "hermes",
    provider,
    model,
    policies: [],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
  } as never;
  const harness = createConnectHarness({
    agentName: "hermes",
    sessionAgent: { name: "hermes" },
    registryEntry: entry,
    portableReceiptDisposition: { kind: "hermes", phase: "active" },
    readinessDecision: {
      kind: "accepted",
      category: "accepted",
      agent: { name: "hermes" },
      sb: entry,
    },
  });
  harness.inspectLaunchReadinessSpy.mockResolvedValue({
    kind: "accepted",
    category: "accepted",
    agent: { name: "hermes" },
    sb: harness.registryEntries[0]!,
  } as never);
  return harness;
}

function configureHealthyForward(harness: ReturnType<typeof acceptedHermesHarness>): void {
  const captureResolved = harness.captureResolvedOpenshellSpy.getMockImplementation()!;
  harness.spawnSyncSpy.mockReturnValue({ status: 0, signal: null } as never);
  harness.captureResolvedOpenshellSpy.mockImplementation(((args: unknown, options: unknown) => {
    const argv = Array.isArray(args) ? args.map(String) : [];
    return argv[0] === "forward" && argv[1] === "list"
      ? {
          status: 0,
          output: "SANDBOX BIND PORT PID STATUS\nalpha 127.0.0.1 18789 12345 running",
        }
      : captureResolved(args, options);
  }) as never);
}

function missingHermesHarness(
  disposition: "running-current" | "stopped" = "running-current",
  category = "missing",
) {
  const entry = {
    name: "alpha",
    agent: "hermes",
    provider: "ollama-local",
    model: "qwen3-vl:4b",
    policies: [],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    gatewayPort: 18_789,
    dashboardPort: 18_789,
    lifecycleGeneration: "generation-1",
    hostLocalInferenceReceipt: "exact-receipt\n",
  } as never;
  return createConnectHarness({
    agentName: "hermes",
    sessionAgent: { name: "hermes" },
    registryEntry: entry,
    portableReceiptDisposition: { kind: "hermes", phase: "active" },
    portableRecoveryResult: { kind: "already-running" },
    hermesReadinessRuntimeDisposition: disposition,
    readinessDecision: {
      kind: "fallback",
      category,
      fence: { epochId: "a".repeat(64) },
      gatewayName: "nemoclaw",
      gatewayPort: 18_789,
      fenceFailed: false,
      recoveryBlocked: false,
    },
  });
}

describe("Hermes accepted launch-readiness probe", () => {
  beforeEach(() => {
    vi.stubEnv("NEMOCLAW_TEST_NO_SLEEP", "1");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
    vi.spyOn(process, "exit").mockImplementation(((code?: number | string | null) => {
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

  it("reuses current schema-6 lifecycle, route, and forward health without recovery", async () => {
    const harness = acceptedHermesHarness("ollama-local", "qwen3-vl:4b");
    configureHealthyForward(harness);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.assertHermesPortableOperatingCommandCurrentSpy).toHaveBeenCalledTimes(10);
    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.captureResolvedOpenshellSpy).toHaveBeenCalledOnce();
    expect(harness.captureResolvedOpenshellSpy.mock.calls[0]?.[0]).toEqual([
      "forward",
      "list",
      "--gateway",
      "nemoclaw",
    ]);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /Probe timing: .*lifecycleAction=reused forwardAction=verified result=ready/,
    );
  });

  it("publishes missing readiness for one running exact runtime without recovery", async () => {
    vi.stubEnv("PATH", "/hostile/ambient/bin");
    const harness = missingHermesHarness();

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.inspectHermesPortableOllamaReadinessRuntimeSpy).toHaveBeenCalledOnce();
    expect(harness.inspectHermesPortableOllamaReadinessRuntimeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          HOME: "/home/test",
          XDG_CONFIG_HOME: "/home/test/.config",
          XDG_RUNTIME_DIR: "/run/user/1000",
        },
      }),
    );
    expect(harness.verifyHermesPortableLaunchForwardsSpy).toHaveBeenCalledOnce();
    expect(harness.launchReadinessMutationGateSpy).toHaveBeenCalledOnce();
    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.getSandboxDockerRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.dockerStartSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.publishLaunchReadinessSpy.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ assertPublicationCurrent: expect.any(Function) }),
    );
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /lifecycleAction=reused forwardAction=verified result=ready/,
    );
  });

  it("routes one stopped exact runtime to existing recovery once", async () => {
    const harness = missingHermesHarness("stopped");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.inspectHermesPortableOllamaReadinessRuntimeSpy).toHaveBeenCalledOnce();
    expect(harness.verifyHermesPortableLaunchForwardsSpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
  });

  it("routes an unhealthy exact forward to existing recovery without fast publication", async () => {
    const harness = missingHermesHarness();
    harness.verifyHermesPortableLaunchForwardsSpy.mockReturnValue({ kind: "unhealthy" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
  });

  it("routes typed publication health failure to existing recovery under one mutation gate", async () => {
    const harness = missingHermesHarness();
    harness.publishLaunchReadinessSpy
      .mockResolvedValueOnce({ kind: "validation-failed", category: "health" })
      .mockResolvedValueOnce({ kind: "published" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.launchReadinessMutationGateSpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["identity", { kind: "validation-failed", category: "identity" }],
    ["config", { kind: "validation-failed", category: "config" }],
    ["evidence", { kind: "evidence-failed" }],
  ] as const)("rejects %s publication failure without recovery", async (_label, result) => {
    const harness = missingHermesHarness();
    harness.publishLaunchReadinessSpy.mockResolvedValue(result as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
  });

  it("rejects runtime authority drift before publication or recovery", async () => {
    const harness = missingHermesHarness();
    harness.inspectHermesPortableOllamaReadinessRuntimeSpy.mockImplementation(() => {
      throw new Error("private publication receipt changed");
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["occupied", "forward-occupied"],
    ["unavailable", "forward-state-unavailable"],
    ["authority drift", "authority-drift"],
  ] as const)("rejects %s forward evidence without recovery", async (_label, failure) => {
    const harness = missingHermesHarness();
    harness.verifyHermesPortableLaunchForwardsSpy.mockImplementation(() => {
      throw new HermesPortableForwardRecoveryError(failure);
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it.each([
    ["before forward", 1, 0],
    ["after forward", 2, 0],
    ["before publication", 3, 0],
    ["after publication", 4, 1],
  ] as const)(
    "rejects transaction drift %s without recovery",
    async (_label, failureCall, expectedPublications) => {
      const harness = missingHermesHarness();
      const assertCurrent = vi.fn(() => {
        expect(assertCurrent.mock.calls.length).not.toBe(failureCall);
      });
      harness.inspectHermesPortableOllamaReadinessRuntimeSpy.mockReturnValue({
        kind: "running-current",
        assertCurrent,
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow();

      expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
      expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
      expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledTimes(expectedPublications);
    },
  );

  it("keeps stale readiness on the existing recovery path", async () => {
    const harness = missingHermesHarness("running-current", "expired");

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.inspectHermesPortableOllamaReadinessRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
  });

  it("keeps schema-5 missing readiness on the existing recovery path", async () => {
    const harness = missingHermesHarness();
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy
      .mockReturnValueOnce({ kind: "requalification-required" })
      .mockReturnValueOnce({
        kind: "current",
        commandAuthority: {
          assertCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          assertTransactionCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          receipt: {} as never,
          env: {},
          executablePath: "/usr/bin/openshell",
        },
      });
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({
      kind: "migrated",
      snapshot: {},
      assertCurrent: vi.fn(),
    } as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.inspectHermesPortableOllamaReadinessRuntimeSpy).not.toHaveBeenCalled();
    expect(harness.requalifyPortableAgentAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
  });

  it("keeps accepted compatible-endpoint authority verification-only", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "descriptor/model");
    configureHealthyForward(harness);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.captureResolvedOpenshellSpy).not.toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      expect.any(Object),
    );
    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("requalifies schema-5 authority and then rechecks readiness", async () => {
    const harness = acceptedHermesHarness(null, null);
    configureHealthyForward(harness);
    const assertRequalifiedReceiptCurrent = vi.fn();
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy
      .mockReturnValueOnce({ kind: "requalification-required" })
      .mockReturnValueOnce({
        kind: "current",
        commandAuthority: {
          assertCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          env: {},
          executablePath: "/usr/bin/openshell",
        },
      });
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({
      kind: "migrated",
      snapshot: {},
      assertCurrent: assertRequalifiedReceiptCurrent,
    } as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.requalifyPortableAgentAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy.mock.calls[1]?.[1]).toEqual({
      priorReceiptAuthority: {
        kind: "migrated",
        snapshot: {},
        assertCurrent: assertRequalifiedReceiptCurrent,
      },
    });
    expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.assertHermesPortableOperatingCommandCurrentSpy).toHaveBeenCalledTimes(10);
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.runSandboxExecChildSpy).not.toHaveBeenCalled();
  });

  it("recovers a stopped schema-6 lifecycle before retrying accepted authority", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "model-alpha");
    configureHealthyForward(harness);
    const assertRequalifiedReceiptCurrent = vi.fn();
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy
      .mockImplementationOnce(() => {
        throw new Error("stopped container has no current operating authority");
      })
      .mockReturnValueOnce({
        kind: "current",
        commandAuthority: {
          assertCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          env: {},
          executablePath: "/usr/bin/openshell",
        },
      });
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({
      kind: "already-current",
      snapshot: {},
      assertCurrent: assertRequalifiedReceiptCurrent,
    } as never);
    harness.recoverPortableDemoLifecycleSpy.mockImplementation((...args) => {
      args[4]?.onComplete({
        entryQualificationMs: 101,
        containerStartMs: 102,
        postStartCurrentnessMs: 103,
        execReadyMs: 104,
        execReadyCurrentnessMs: 41,
        execReadyCommandMs: 42,
        execReadySleepMs: 21,
        preHealthCurrentnessMs: 105,
        authenticatedHealthMs: 106,
        authenticatedHealthPodmanMs: 43,
        authenticatedHealthOpenShellMs: 44,
        authenticatedHealthSleepMs: 19,
        startupLaunchMs: 107,
        healthPollCurrentnessMs: 108,
        finalQualificationMs: 109,
        rollbackMs: 0,
        qualificationCount: 2,
        transactionCurrentnessCount: 20,
        containerInspectionCount: 8,
        containerStartCount: 1,
        execReadyAttempts: 1,
        authenticatedHealthCount: 1,
        startupLaunchCount: 0,
        rollbackCount: 0,
        totalMs: 938,
        containerAction: "started",
        result: "recovered",
      });
      return { kind: "recovered" };
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.requalifyPortableAgentAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy.mock.calls[1]?.[1]).toEqual({
      priorReceiptAuthority: {
        kind: "already-current",
        snapshot: {},
        assertCurrent: assertRequalifiedReceiptCurrent,
      },
    });
    expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(/result=ready/);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Hermes Portable lifecycle recovery timing: entryQualification=101ms containerStart=102ms postStartCurrentness=103ms execReady=104ms execReadyCurrentness=41ms execReadyCommand=42ms execReadySleep=21ms preHealthCurrentness=105ms authenticatedHealth=106ms authenticatedHealthPodman=43ms authenticatedHealthOpenShell=44ms authenticatedHealthSleep=19ms startupLaunch=107ms healthPollCurrentness=108ms finalQualification=109ms rollback=0ms qualificationCount=2 transactionCurrentnessCount=20 containerInspectionCount=8 containerStartCount=1 execReadyAttempts=1 authenticatedHealthCount=1 startupLaunchCount=0 rollbackCount=0 total=938ms containerAction=started result=recovered",
    );
  });

  it("reuses one recovered lifecycle when missing readiness routes to stopped inference", async () => {
    const harness = missingHermesHarness("stopped");
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy
      .mockImplementationOnce(() => {
        throw new Error("stopped container has no current operating authority");
      })
      .mockReturnValue({
        kind: "current",
        commandAuthority: {
          assertCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          assertTransactionCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          receipt: {} as never,
          env: {},
          executablePath: "/usr/bin/openshell",
        },
      });
    const assertRequalifiedReceiptCurrent = vi.fn();
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({
      kind: "already-current",
      snapshot: {},
      assertCurrent: assertRequalifiedReceiptCurrent,
    } as never);
    harness.recoverPortableDemoLifecycleSpy.mockReturnValue({ kind: "recovered" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.inspectHermesPortableOllamaReadinessRuntimeSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).toHaveBeenCalledOnce();
    expect(harness.publishLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(assertRequalifiedReceiptCurrent.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(harness.logSpy.mock.calls.flat().join("\n")).toMatch(
      /lifecycleAction=recovered forwardAction=verified result=ready/,
    );
  });

  it("rejects recovered lifecycle drift before stopped inference recovery", async () => {
    const harness = missingHermesHarness("stopped");
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy
      .mockImplementationOnce(() => {
        throw new Error("stopped container has no current operating authority");
      })
      .mockReturnValue({
        kind: "current",
        commandAuthority: {
          assertCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          assertTransactionCurrent: harness.assertHermesPortableOperatingCommandCurrentSpy,
          receipt: {} as never,
          env: {},
          executablePath: "/usr/bin/openshell",
        },
      });
    const assertRequalifiedReceiptCurrent = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementation(() => {
        throw new Error("recovered receipt authority changed");
      });
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({
      kind: "already-current",
      snapshot: {},
      assertCurrent: assertRequalifiedReceiptCurrent,
    } as never);
    harness.recoverPortableDemoLifecycleSpy.mockReturnValue({ kind: "recovered" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.recoverPortableDemoLifecycleSpy).toHaveBeenCalledOnce();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("does not recover when stopped schema-6 requalification fails", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "model-alpha");
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy.mockImplementationOnce(() => {
      throw new Error("operating authority is not ready");
    });
    harness.requalifyPortableAgentAuthoritySpy.mockImplementationOnce(() => {
      throw new Error("receipt, executable, or policy authority changed");
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.requalifyPortableAgentAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.inspectLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("does not recover when stopped schema-6 receipt authority drifts", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "model-alpha");
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy.mockImplementationOnce(() => {
      throw new Error("operating authority is not ready");
    });
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({
      kind: "already-current",
      snapshot: {},
      assertCurrent: () => {
        throw new Error("requalified receipt authority changed");
      },
    } as never);

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.requalifyPortableAgentAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.inspectLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("rejects schema-5 authority that disappears during requalification", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "model-alpha");
    harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy.mockReturnValue({
      kind: "requalification-required",
    });
    harness.requalifyPortableAgentAuthoritySpy.mockReturnValue({ kind: "not-installed" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.requalifyPortableAgentAuthoritySpy).toHaveBeenCalledOnce();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.runSandboxExecChildSpy).not.toHaveBeenCalled();
  });

  it("rejects retained operating-command authority drift before success", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "model-alpha");
    harness.assertHermesPortableOperatingCommandCurrentSpy.mockImplementation(() => {
      throw new Error("operating authority changed");
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.assertHermesPortableOperatingCommandCurrentSpy).toHaveBeenCalledOnce();
    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.runSandboxExecChildSpy).not.toHaveBeenCalled();
  });

  it("rejects a substituted registry row even when readiness accepts that row", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "model-alpha");
    harness.inspectLaunchReadinessSpy.mockImplementationOnce(async () => {
      harness.registryEntries[0]!.model = "model-changed";
      return {
        kind: "accepted",
        category: "accepted",
        agent: { name: "hermes" },
        sb: harness.registryEntries[0]!,
      } as never;
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.assertHermesPortableOperatingCommandCurrentSpy).toHaveBeenCalledTimes(2);
    expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.runSandboxExecChildSpy).not.toHaveBeenCalled();
  });

  it("routes every OpenShell-backed readiness observation through retained authority", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "descriptor/model");
    harness.captureOpenshellSpy.mockImplementation(() => {
      throw new Error("ambient OpenShell must not be used");
    });
    harness.spawnSyncSpy.mockReturnValue({ status: 0, signal: null } as never);
    harness.captureResolvedOpenshellSpy
      .mockReturnValueOnce({ status: 0, output: "" } as never)
      .mockReturnValueOnce({
        status: 0,
        output: "Name: alpha\nId: sandbox-generation-1\nPhase: Ready\n",
      } as never)
      .mockImplementationOnce(((args: unknown) => {
        const argv = Array.isArray(args) ? args.map(String) : [];
        const marker = argv.join(" ").match(/__NEMOCLAW_SANDBOX_EXEC_STARTED___[0-9a-f]{32}/u)?.[0];
        return { status: 0, output: `${marker ?? "missing-marker"}\nRUNNING` };
      }) as never)
      .mockReturnValueOnce({
        status: 0,
        output: "SANDBOX BIND PORT PID STATUS\nalpha 127.0.0.1 18789 12345 running",
      } as never)
      .mockReturnValueOnce({ status: 0, output: "OK 200" } as never)
      .mockReturnValueOnce({
        status: 0,
        output: "SANDBOX BIND PORT PID STATUS\nalpha 127.0.0.1 18789 12345 running",
      } as never);
    harness.inspectLaunchReadinessSpy.mockImplementationOnce(async (_sandboxName, deps) => {
      const authorityCalls = () =>
        harness.assertHermesPortableOperatingCommandCurrentSpy.mock.calls.length;
      const assertBoundObservation = async (observe: () => unknown | Promise<unknown>) => {
        const before = authorityCalls();
        await observe();
        expect(authorityCalls() - before).toBe(2);
      };
      await assertBoundObservation(() => deps.capture?.(["policy", "get", "-g", "nemoclaw"]));
      await assertBoundObservation(() =>
        deps.observeSandbox?.({
          sandboxName: "alpha",
          gatewayName: "nemoclaw",
          gatewayPort: 18789,
        }),
      );
      await assertBoundObservation(() => deps.gatewayHealth?.("alpha", "nemoclaw"));
      await assertBoundObservation(() => deps.forwardsHealthy?.("alpha", "nemoclaw"));
      await assertBoundObservation(() =>
        deps.inferenceProbe?.("alpha", { name: "hermes" } as never, "nemoclaw"),
      );
      return {
        kind: "accepted",
        category: "accepted",
        agent: { name: "hermes" },
        sb: harness.registryEntries[0]!,
      } as never;
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.captureResolvedOpenshellSpy).toHaveBeenCalledTimes(6);
    const exactOptions = {
      env: {
        HOME: "/home/test",
        XDG_CONFIG_HOME: "/home/test/.config",
        XDG_RUNTIME_DIR: "/run/user/1000",
      },
      openshellBinary: "/usr/bin/openshell",
      replaceEnv: true,
    };
    expect(harness.captureResolvedOpenshellSpy.mock.calls[0]?.[1]).toMatchObject(exactOptions);
    expect(harness.captureResolvedOpenshellSpy.mock.calls[1]?.[1]).toMatchObject(exactOptions);
    expect(harness.captureResolvedOpenshellSpy.mock.calls[2]?.[1]).toMatchObject(exactOptions);
    expect(harness.captureResolvedOpenshellSpy.mock.calls[3]?.[1]).toMatchObject(exactOptions);
    expect(harness.captureResolvedOpenshellSpy.mock.calls[4]?.[1]).toMatchObject(exactOptions);
    expect(harness.captureResolvedOpenshellSpy.mock.calls[5]?.[1]).toMatchObject(exactOptions);
  });

  it.each(["executable", "socket"])(
    "rejects a %s authority swap during semantic readiness",
    async (authorityKind) => {
      const harness = acceptedHermesHarness("compatible-endpoint", "descriptor/model");
      harness.assertHermesPortableOperatingCommandCurrentSpy
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockImplementationOnce(() => {
          throw new Error(`${authorityKind} authority changed`);
        });
      harness.inspectLaunchReadinessSpy.mockImplementationOnce(async (_sandboxName, deps) => {
        deps.capture?.(["policy", "get", "-g", "nemoclaw"]);
        return {
          kind: "accepted",
          category: "accepted",
          agent: { name: "hermes" },
          sb: harness.registryEntries[0]!,
        } as never;
      });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.requalifyPortableAgentAuthoritySpy).not.toHaveBeenCalled();
      expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
      expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
      expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    },
  );

  it("rejects active and successor receipt replacement during semantic readiness", async () => {
    const harness = acceptedHermesHarness("compatible-endpoint", "descriptor/model");
    harness.assertHermesPortableOperatingCommandCurrentSpy
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error("active and successor receipt snapshot changed");
      });
    harness.inspectLaunchReadinessSpy.mockImplementationOnce(async (_sandboxName, deps) => {
      deps.capture?.(["policy", "get", "-g", "nemoclaw"]);
      return {
        kind: "accepted",
        category: "accepted",
        agent: { name: "hermes" },
        sb: harness.registryEntries[0]!,
      } as never;
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });

  it("rejects retained command-authority drift after fallback before recovery", async () => {
    const entry = {
      name: "alpha",
      agent: "hermes",
      provider: "ollama-local",
      model: "qwen3-vl:4b",
      policies: [],
      openshellDriver: "docker",
      gatewayName: "nemoclaw",
      lifecycleGeneration: "generation-1",
    } as never;
    const harness = createConnectHarness({
      agentName: "hermes",
      sessionAgent: { name: "hermes" },
      registryEntry: entry,
      portableReceiptDisposition: { kind: "hermes", phase: "active" },
      readinessDecision: {
        kind: "fallback",
        category: "health",
        fence: { epochId: "a".repeat(64) },
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        fenceFailed: false,
        recoveryBlocked: false,
      },
    });
    harness.assertHermesPortableOperatingCommandCurrentSpy
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => {
        throw new Error("retained OpenShell command generation changed");
      });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledOnce();
    expect(harness.assertHermesPortableOperatingCommandCurrentSpy).toHaveBeenCalledTimes(3);
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.captureResolvedOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
  });
});
