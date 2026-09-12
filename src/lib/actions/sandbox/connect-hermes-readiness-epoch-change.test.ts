// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectHarness } from "../../../../test/support/connect-flow-test-harness";

const originalStdoutIsTty = process.stdout.isTTY;

function changedEpochHermesHarness() {
  const entry = {
    name: "alpha",
    agent: "hermes",
    provider: "compatible-endpoint",
    model: "descriptor/model",
    policies: [],
    openshellDriver: "docker",
    gatewayName: "nemoclaw",
    lifecycleGeneration: "generation-1",
  } as never;
  return createConnectHarness({
    agentName: "hermes",
    sessionAgent: { name: "hermes" },
    registryEntry: entry,
    portableReceiptDisposition: { kind: "hermes", phase: "active" },
  });
}

function fallbackReadiness() {
  return {
    kind: "fallback",
    category: "config",
    fence: { epochId: "a".repeat(64) },
    gatewayName: "nemoclaw",
    gatewayPort: 18789,
    fenceFailed: false,
    recoveryBlocked: false,
  } as const;
}

function acceptedReadiness(harness: ReturnType<typeof changedEpochHermesHarness>) {
  return {
    kind: "accepted",
    category: "accepted",
    agent: { name: "hermes" },
    sb: harness.registryEntries[0]!,
  } as const;
}

function configureHealthyForward(harness: ReturnType<typeof changedEpochHermesHarness>): void {
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

describe("Hermes changed launch-readiness epoch", () => {
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

  it("reinspects a changed epoch only through recaptured receipt command authority", async () => {
    const harness = changedEpochHermesHarness();
    configureHealthyForward(harness);
    harness.captureOpenshellSpy.mockImplementation(() => {
      throw new Error("ambient OpenShell must not be used");
    });
    harness.inspectLaunchReadinessSpy
      .mockResolvedValueOnce(fallbackReadiness() as never)
      .mockImplementationOnce(async (_sandboxName, deps) => {
        deps.capture?.(["policy", "get", "-g", "nemoclaw"]);
        return acceptedReadiness(harness) as never;
      });
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({ kind: "changed" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledTimes(2);
    expect(harness.qualifyHermesPortableAcceptedReadinessAuthoritySpy).toHaveBeenCalledTimes(2);
    expect(harness.captureResolvedOpenshellSpy).toHaveBeenCalledTimes(2);
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
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).toContain(
      "Probe complete: launch readiness is healthy for 'alpha'.",
    );
  });

  it.each(["receipt", "executable", "socket"])(
    "rejects %s authority drift during changed-epoch reinspection",
    async (authorityKind) => {
      const harness = changedEpochHermesHarness();
      harness.inspectLaunchReadinessSpy
        .mockResolvedValueOnce(fallbackReadiness() as never)
        .mockImplementationOnce(async (_sandboxName, deps) => {
          deps.capture?.(["policy", "get", "-g", "nemoclaw"]);
          return acceptedReadiness(harness) as never;
        });
      harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({ kind: "changed" });
      harness.assertHermesPortableOperatingCommandCurrentSpy
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockReturnValueOnce(undefined)
        .mockImplementationOnce(() => {
          throw new Error(`${authorityKind} authority changed`);
        });

      await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
        "process.exit(1)",
      );

      expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledTimes(2);
      expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
      expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
      expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
      expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Probe complete:");
    },
  );

  it("rejects a substituted registry row during changed-epoch reinspection", async () => {
    const harness = changedEpochHermesHarness();
    harness.inspectLaunchReadinessSpy
      .mockResolvedValueOnce(fallbackReadiness() as never)
      .mockImplementationOnce(async () => {
        harness.registryEntries[0]!.provider = "ollama-local";
        harness.registryEntries[0]!.model = "qwen3-vl:4b";
        return acceptedReadiness(harness) as never;
      });
    harness.launchReadinessMutationGateSpy.mockResolvedValueOnce({ kind: "changed" });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.inspectLaunchReadinessSpy).toHaveBeenCalledTimes(2);
    expect(harness.recoverPortableDemoLifecycleSpy).not.toHaveBeenCalled();
    expect(harness.recoverHermesPortableOllamaInferenceSpy).not.toHaveBeenCalled();
    expect(harness.publishLaunchReadinessSpy).not.toHaveBeenCalled();
    expect(harness.logSpy.mock.calls.flat().join("\n")).not.toContain("Probe complete:");
  });
});
