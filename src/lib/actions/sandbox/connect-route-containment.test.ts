// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import {
  connectModulePath,
  createConnectHarness,
  requireDist,
} from "../../../../test/support/connect-flow-test-harness";
import type { SandboxEntry } from "../../state/registry";
import {
  repairSandboxInferenceRouteWithDeps,
  type SandboxInferenceRouteRepairDeps,
} from "./connect";

describe("connect route containment", () => {
  let exitSpy: MockInstance;
  const originalStdoutIsTty = process.stdout.isTTY;

  beforeEach(() => {
    process.env.NEMOCLAW_TEST_NO_SLEEP = "1";
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
    delete process.env.NEMOCLAW_TEST_NO_SLEEP;
    delete require.cache[requireDist.resolve(connectModulePath)];
  });

  it("stops before the initial endpoint probe or repair mutation when routes conflict (#6315)", () => {
    const conflict = new Error("shared gateway route conflict");
    const assertRouteCompatible = vi.fn(() => {
      throw conflict;
    });
    const probe = vi.fn(() => ({ healthy: false, broken: true, detail: "BROKEN 503" }));
    const applyVmDnsMonkeypatch = vi.fn(() => ({ ok: false }));
    const reapplyVmInferenceRoute = vi.fn(() => null);
    const repairLegacyDnsProxy = vi.fn(() => ({ exitCode: 0 }));
    const deps: SandboxInferenceRouteRepairDeps = {
      probe,
      shouldApplyVmDnsMonkeypatch: vi.fn(() => false),
      applyVmDnsMonkeypatch,
      reapplyVmInferenceRoute,
      repairLegacyDnsProxy,
      assertRouteCompatible,
    };
    const sandbox: SandboxEntry = {
      name: "demo",
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "nvidia-prod",
      openshellDriver: "vm",
      gpuEnabled: false,
      policies: [],
    };

    expect(() => repairSandboxInferenceRouteWithDeps("vm-box", sandbox, {}, deps)).toThrow(
      conflict,
    );

    expect(assertRouteCompatible).toHaveBeenCalledWith("vm-box", sandbox);
    expect(probe).not.toHaveBeenCalled();
    expect(applyVmDnsMonkeypatch).not.toHaveBeenCalled();
    expect(reapplyVmInferenceRoute).not.toHaveBeenCalled();
    expect(repairLegacyDnsProxy).not.toHaveBeenCalled();
  });

  it("exits before connect-time route writes when another sandbox conflicts (#6315)", async () => {
    const alpha = {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "anthropic-prod",
      model: "claude-sonnet-4-20250514",
    } as const;
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      registryEntry: alpha,
      registryEntries: [
        alpha,
        {
          name: "stopped-peer",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      ],
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("stopped-peer");
    expect(errorOutput).toContain("NEMOCLAW_GATEWAY_PORT");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rechecks peers after waiting for the shared gateway route lock", async () => {
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let reportLockEntered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      reportLockEntered = resolve;
    });
    const alpha = {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "nvidia-prod",
      model: "nvidia/model-a",
    } as const;
    const harness = createConnectHarness({
      registryEntry: alpha,
      registryEntries: [alpha, { ...alpha, name: "peer" }],
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        reportLockEntered();
        await released;
        return await operation();
      },
    });

    const connect = harness.connectSandbox("alpha", { probeOnly: true });
    await lockEntered;
    const peer = harness.registryEntries.find((candidate) => candidate.name === "peer");
    expect(peer).toBeDefined();
    Object.assign(peer!, { provider: "anthropic-prod", model: "claude-new" });
    releaseLock();

    await expect(connect).rejects.toThrow("process.exit(1)");
    expect(harness.withGatewayRouteMutationLockSpy).toHaveBeenCalledWith(
      "nemoclaw",
      expect.any(Function),
    );
    expect(harness.captureOpenshellSpy).toHaveBeenCalledOnce();
    expect(harness.captureOpenshellSpy).toHaveBeenCalledWith(
      ["inference", "get", "-g", "nemoclaw"],
      { ignoreError: true, timeout: 15_000 },
    );
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("aborts before route reads or repairs when the target changes gateways while waiting", async () => {
    let releaseLock!: () => void;
    const released = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    let reportLockEntered!: () => void;
    const lockEntered = new Promise<void>((resolve) => {
      reportLockEntered = resolve;
    });
    const alpha = {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "nvidia-prod",
      model: "nvidia/model-a",
    } as const;
    const harness = createConnectHarness({
      registryEntry: alpha,
      registryEntries: [alpha],
      withGatewayRouteMutationLock: async (_gatewayName, operation) => {
        reportLockEntered();
        await released;
        return await operation();
      },
    });

    const connect = harness.connectSandbox("alpha", { probeOnly: true });
    await lockEntered;
    Object.assign(harness.registryEntries[0], {
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
    });
    releaseLock();

    await expect(connect).rejects.toThrow("process.exit(1)");
    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("changed OpenShell gateways while waiting"),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits before managed route reads or repairs when an endpoint override is ambient", async () => {
    vi.stubEnv("OPENSHELL_GATEWAY_ENDPOINT", "https://other.example.test");
    const harness = createConnectHarness({
      registryEntry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    expect(harness.preflightVllmSpy).not.toHaveBeenCalled();
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSpy).not.toHaveBeenCalled();
    expect(harness.ensureOllamaAuthProxySpy).not.toHaveBeenCalled();
    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      expect.any(Array),
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain("Unset OPENSHELL_GATEWAY_ENDPOINT");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("rejects a pending onboarding reservation before liveness or route work", async () => {
    const harness = createConnectHarness({
      registryEntry: {
        name: "alpha",
        pendingRouteReservation: true,
        gatewayName: "nemoclaw",
        provider: "nvidia-prod",
        model: "nvidia/model-a",
      },
    });

    await expect(harness.connectSandbox("alpha")).rejects.toThrow("process.exit(1)");

    const output = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(output).toContain("still being created by onboarding");
    expect(harness.ensureLiveSandboxSpy).not.toHaveBeenCalled();
    expect(harness.captureOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
  });

  it("exits before repairing a lone incomplete legacy custom route (#6315)", async () => {
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      registryEntry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
        provider: "compatible-endpoint",
        model: "custom/model",
        endpointUrl: null,
        preferredInferenceApi: null,
      },
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(harness.applyVmDnsMonkeypatchSpy).not.toHaveBeenCalled();
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
    expect(harness.spawnSyncSpy).not.toHaveBeenCalledWith(
      "openshell",
      ["sandbox", "connect", "alpha"],
      expect.any(Object),
    );
    const errorOutput = harness.errorSpy.mock.calls.map((call) => String(call[0] ?? "")).join("\n");
    expect(errorOutput).toContain(
      "requested custom route lacks durable endpoint or API-family metadata",
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("exits before an endpoint probe when an aligned route conflicts with a stopped sandbox (#6315)", async () => {
    const alpha = {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw",
      gatewayPort: 8080,
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
    } as const;
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      registryEntry: alpha,
      registryEntries: [
        alpha,
        {
          name: "stopped-peer",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          provider: "anthropic-prod",
          model: "claude-sonnet-4-20250514",
        },
      ],
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).rejects.toThrow(
      "process.exit(1)",
    );

    const routeProbeCalls = harness.captureOpenshellSpy.mock.calls.filter((call) =>
      JSON.stringify(call[0]).includes("inference.local/v1/models"),
    );
    expect(routeProbeCalls).toHaveLength(0);
    expect(harness.runOpenshellSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("scopes every inference read and repair write to the target non-default gateway", async () => {
    const alpha = {
      name: "alpha",
      agent: "openclaw",
      gatewayName: "nemoclaw-9090",
      gatewayPort: 9090,
      openshellDriver: "docker",
      provider: "anthropic-prod",
      model: "claude-sonnet-4-20250514",
    } as const;
    const harness = createConnectHarness({
      inferenceGetOutput:
        "Gateway inference:\n  Provider: nvidia-prod\n  Model: nvidia/nemotron-3-super-120b-a12b\n",
      inferenceProbeResponses: ["BROKEN 503", "BROKEN 503", "OK 200"],
      registryEntry: alpha,
      registryEntries: [
        alpha,
        {
          name: "default-gateway-peer",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          gatewayPort: 8080,
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
        },
      ],
    });

    await expect(harness.connectSandbox("alpha", { probeOnly: true })).resolves.toBeUndefined();

    const inferenceReads = harness.captureOpenshellSpy.mock.calls
      .map((call) => call[0])
      .filter((args) => Array.isArray(args) && args[0] === "inference" && args[1] === "get");
    expect(inferenceReads).toEqual([["inference", "get", "-g", "nemoclaw-9090"]]);

    const inferenceWrites = harness.runOpenshellSpy.mock.calls
      .map((call) => call[0])
      .filter((args) => Array.isArray(args) && args[0] === "inference" && args[1] === "set");
    expect(inferenceWrites).toHaveLength(3);
    for (const args of inferenceWrites) {
      expect(args).toEqual([
        "inference",
        "set",
        "-g",
        "nemoclaw-9090",
        "--provider",
        "anthropic-prod",
        "--model",
        "claude-sonnet-4-20250514",
        "--no-verify",
      ]);
    }
    expect([...inferenceReads, ...inferenceWrites]).not.toContainEqual(
      expect.arrayContaining(["-g", "nemoclaw"]),
    );
    expect(harness.runSetupDnsProxySpy).not.toHaveBeenCalled();
  });
});
