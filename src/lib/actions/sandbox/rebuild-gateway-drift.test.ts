// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { OpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);

// Warm the large CommonJS source graph outside the per-test hook timeout.
requireDist("./rebuild.js");
delete require.cache[requireDist.resolve("./rebuild.js")];

const driftIssue: OpenShellStateRpcIssue = {
  kind: "image_drift",
  drift: {
    containerName: "openshell-cluster-nemoclaw",
    currentImage: "ghcr.io/nvidia/openshell/cluster:0.0.36",
    currentVersion: "0.0.36",
    expectedVersion: "0.0.37",
  },
};

function mockExit() {
  return vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
    throw new Error(`process.exit(${code ?? 0})`);
  }) as never);
}

function healthyGatewayRecovery(gatewayName: string) {
  const state = {
    state: "healthy_named" as const,
    status: `Gateway: ${gatewayName}\nStatus: Connected`,
    gatewayInfo: `Gateway: ${gatewayName}`,
    activeGateway: gatewayName,
  };
  return { recovered: true, before: state, after: state, attempted: false };
}

const sandboxGpuConfig = {
  mode: "0" as const,
  hostGpuDetected: false,
  hostGpuPlatform: null,
  sandboxGpuEnabled: false,
  sandboxGpuDevice: null,
  errors: [],
};
const runtimePreflightResult = {
  gpu: null,
  host: { dockerReachable: true, runtime: "docker", notes: [] },
  sandboxGpuConfig,
};

describe("rebuild gateway drift preflight", () => {
  let rebuildSandbox: RebuildSandbox;
  let exitSpy: ReturnType<typeof mockExit>;
  let errorSpy: MockInstance;
  let spies: MockInstance[];
  let checkAgentVersionSpy: MockInstance;
  let detectPreflightIssueSpy: MockInstance;
  let captureOpenshellSpy: MockInstance;
  let runOpenshellSpy: MockInstance;
  let printIssueSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;
  let acquireOnboardLockSpy: MockInstance;
  let releaseOnboardLockSpy: MockInstance;
  let authoritativePreflightSpy: MockInstance;
  let inferenceRouteReadySpy: MockInstance;
  let imagePreflightSpy: MockInstance;

  beforeEach(async () => {
    spies = [];
    exitSpy = mockExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const registry = requireDist("../../state/registry.js");
    const resolve = requireDist("../../adapters/openshell/resolve.js");
    const sandboxSession = requireDist("../../state/sandbox-session.js");
    const onboardSession = requireDist("../../state/onboard-session.js");
    const sandboxVersion = requireDist("../../sandbox/version.js");
    const agentRuntime = requireDist("../../agent/runtime.js");
    const onboardMod = requireDist("../../onboard.js");
    const imagePreflight = requireDist("./rebuild-custom-image-preflight.js");

    printIssueSpy = vi
      .spyOn(gatewayDrift, "printOpenShellStateRpcIssue")
      .mockImplementation(() => undefined);
    detectPreflightIssueSpy = vi
      .spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue")
      .mockReturnValue(driftIssue);
    checkAgentVersionSpy = vi
      .spyOn(sandboxVersion, "checkAgentVersion")
      .mockReturnValue({ expectedVersion: "0.1.0", sandboxVersion: "0.0.1" } as never);
    captureOpenshellSpy = vi
      .spyOn(openshellRuntime, "captureOpenshell")
      .mockReturnValue({ status: 0, output: "alpha Ready" });
    runOpenshellSpy = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0, output: "" } as never);
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockImplementation((...args: unknown[]) => {
        const options = args[0] as { gatewayName?: string } | undefined;
        return Promise.resolve(healthyGatewayRecovery(options?.gatewayName ?? "nemoclaw"));
      });
    acquireOnboardLockSpy = vi
      .spyOn(onboardSession, "acquireOnboardLock")
      .mockReturnValue({ acquired: true, lockFile: "/tmp/onboard.lock", stale: false });
    releaseOnboardLockSpy = vi
      .spyOn(onboardSession, "releaseOnboardLock")
      .mockImplementation(() => undefined);
    authoritativePreflightSpy = vi
      .spyOn(onboardMod, "preflightAuthoritativeRebuildTarget")
      .mockResolvedValue(runtimePreflightResult);
    inferenceRouteReadySpy = vi.spyOn(onboardMod, "isInferenceRouteReady").mockReturnValue(true);
    imagePreflightSpy = vi.spyOn(imagePreflight, "preflightRebuildImage").mockResolvedValue({
      ok: true,
      preparedBuildContext: {
        buildCtx: "/tmp/rebuild-drift-preflight",
        stagedDockerfile: "/tmp/rebuild-drift-preflight/Dockerfile",
        buildId: "drift-build",
        dockerGpuPatchNetwork: null,
        cleanupBuildCtx: vi.fn(() => true),
      },
    });

    spies.push(
      detectPreflightIssueSpy,
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      captureOpenshellSpy,
      runOpenshellSpy,
      recoverNamedGatewayRuntimeSpy,
      acquireOnboardLockSpy,
      releaseOnboardLockSpy,
      authoritativePreflightSpy,
      inferenceRouteReadySpy,
      imagePreflightSpy,
      printIssueSpy,
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        nimContainer: null,
        agent: null,
        nemoclawVersion: "0.0.72",
        dashboardPort: 18789,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      } as never),
      vi.spyOn(registry, "listExtraProviders").mockReturnValue([]),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      checkAgentVersionSpy,
    );

    ({ rebuildSandbox } = requireDist("./rebuild.js"));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails after target recovery but before replacement or liveness preflights on gateway drift", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"])).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      driftIssue,
      expect.objectContaining({ command: "nemoclaw alpha rebuild" }),
    );
    expect(checkAgentVersionSpy).toHaveBeenCalledOnce();
    expect(acquireOnboardLockSpy).toHaveBeenCalledWith("nemoclaw alpha rebuild");
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(authoritativePreflightSpy).not.toHaveBeenCalled();
    expect(imagePreflightSpy).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });

  it("recovers the named gateway and retries the liveness query before entering stale recovery", async () => {
    detectPreflightIssueSpy.mockReturnValue(null);
    // First `sandbox list` fails (gateway down) and triggers recovery; the retry
    // shows only 'beta', so 'alpha' is absent. Before treating that as stale,
    // rebuild reconciles against the NAMED gateway, which reports a healthy
    // nemoclaw (status Connected + gateway info), confirming the sandbox is
    // genuinely gone (#4497).
    let listCalls = 0;
    captureOpenshellSpy.mockImplementation((args: string[]) => {
      if (args[0] === "sandbox" && args[1] === "list") {
        listCalls += 1;
        return listCalls === 1
          ? { status: 1, output: "client error (Connect): Connection refused" }
          : { status: 0, output: "beta Ready" };
      }
      if (args[0] === "status") {
        return {
          status: 0,
          output: "Server Status\n\n  Gateway: nemoclaw\n  Status: Connected\n",
        };
      }
      if (args[0] === "gateway" && args[1] === "info") {
        return { status: 0, output: "Gateway Info\n\nGateway: nemoclaw\n" };
      }
      if (args[0] === "sandbox" && args[1] === "get") {
        return { status: 1, output: "Error:   × Not Found: sandbox not found" };
      }
      return { status: 0, output: "" };
    });

    // The reconcile confirms the stale state, so rather than dead-ending at
    // "Cannot back up state", rebuild skips backup and recreates from the
    // preserved registry metadata. Stub the destructive steps + recreate handoff
    // so the path stays hermetic, and assert the recreate failure surfaces the
    // stale-recovery message instead of "not running".
    const destroy = requireDist("./destroy.js");
    const onboardMod = requireDist("../../onboard.js");
    spies.push(
      vi.spyOn(destroy, "removeSandboxRegistryEntry").mockImplementation(() => undefined),
      vi.spyOn(onboardMod, "onboard").mockRejectedValue(new Error("recreate-stub")),
    );

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      /stale-sandbox recovery/,
    );

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(authoritativePreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        authoritativeResumeConfig: true,
        controlUiPort: 18789,
        model: "nvidia/nemotron",
        provider: "ollama-local",
        sandboxName: "alpha",
        targetGatewayName: "nemoclaw",
        targetGatewayPort: 8080,
      }),
    );
    expect(imagePreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayPort: 8080,
        model: "nvidia/nemotron",
        provider: "ollama-local",
      }),
    );
    expect(inferenceRouteReadySpy).toHaveBeenCalledWith("ollama-local", "nvidia/nemotron");
    expect(releaseOnboardLockSpy).toHaveBeenCalledOnce();
    // One early inference-route eligibility read plus the failed liveness read
    // and its post-recovery retry.
    expect(listCalls).toBe(3);
  });

  it("recovers the persisted non-default gateway when the sandbox is bound to nemoclaw-<port>", async () => {
    detectPreflightIssueSpy.mockReturnValue(null);
    // Reseed the sandbox lookup to expose a non-default gateway binding
    // (gatewayPort=12345 → gateway name `nemoclaw-12345`). The stale-recovery
    // path must address that gateway, not the default `nemoclaw`, otherwise a
    // sandbox onboarded against `NEMOCLAW_GATEWAY_PORT=12345` would try to
    // recover the wrong (and possibly nonexistent) default gateway.
    for (const spy of spies) spy.mockRestore();
    spies.length = 0;
    const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const registry = requireDist("../../state/registry.js");
    const resolve = requireDist("../../adapters/openshell/resolve.js");
    const sandboxSession = requireDist("../../state/sandbox-session.js");
    const onboardSession = requireDist("../../state/onboard-session.js");
    const sandboxVersion = requireDist("../../sandbox/version.js");
    const agentRuntime = requireDist("../../agent/runtime.js");
    const onboardMod = requireDist("../../onboard.js");
    const imagePreflight = requireDist("./rebuild-custom-image-preflight.js");

    let listCalls = 0;
    detectPreflightIssueSpy = vi
      .spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue")
      .mockReturnValue(null);
    captureOpenshellSpy = vi.spyOn(openshellRuntime, "captureOpenshell").mockImplementation(((
      args: string[],
    ) => {
      if (args[0] === "sandbox" && args[1] === "list") {
        listCalls += 1;
        return listCalls === 1
          ? { status: 1, output: "client error (Connect): Connection refused" }
          : { status: 0, output: "beta Ready" };
      }
      if (args[0] === "status") {
        return {
          status: 0,
          output: "Server Status\n\n  Gateway: nemoclaw-12345\n  Status: Connected\n",
        };
      }
      if (args[0] === "gateway" && args[1] === "info") {
        return { status: 0, output: "Gateway Info\n\nGateway: nemoclaw-12345\n" };
      }
      if (args[0] === "sandbox" && args[1] === "get") {
        return { status: 1, output: "Error:   × Not Found: sandbox not found" };
      }
      return { status: 0, output: "" };
    }) as never);
    runOpenshellSpy = vi
      .spyOn(openshellRuntime, "runOpenshell")
      .mockReturnValue({ status: 0, output: "" } as never);
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockImplementation((...args: unknown[]) => {
        const options = args[0] as { gatewayName?: string } | undefined;
        return Promise.resolve(healthyGatewayRecovery(options?.gatewayName ?? "nemoclaw"));
      });
    acquireOnboardLockSpy = vi
      .spyOn(onboardSession, "acquireOnboardLock")
      .mockReturnValue({ acquired: true, lockFile: "/tmp/onboard.lock", stale: false });
    releaseOnboardLockSpy = vi
      .spyOn(onboardSession, "releaseOnboardLock")
      .mockImplementation(() => undefined);
    authoritativePreflightSpy = vi
      .spyOn(onboardMod, "preflightAuthoritativeRebuildTarget")
      .mockResolvedValue(runtimePreflightResult);
    inferenceRouteReadySpy = vi.spyOn(onboardMod, "isInferenceRouteReady").mockReturnValue(true);
    imagePreflightSpy = vi.spyOn(imagePreflight, "preflightRebuildImage").mockResolvedValue({
      ok: true,
      preparedBuildContext: {
        buildCtx: "/tmp/rebuild-drift-preflight",
        stagedDockerfile: "/tmp/rebuild-drift-preflight/Dockerfile",
        buildId: "drift-build",
        dockerGpuPatchNetwork: null,
        cleanupBuildCtx: vi.fn(() => true),
      },
    });
    checkAgentVersionSpy = vi
      .spyOn(sandboxVersion, "checkAgentVersion")
      .mockReturnValue({ expectedVersion: "0.1.0", sandboxVersion: "0.0.1" } as never);
    printIssueSpy = vi
      .spyOn(gatewayDrift, "printOpenShellStateRpcIssue")
      .mockImplementation(() => undefined);

    const destroy = requireDist("./destroy.js");
    spies.push(
      detectPreflightIssueSpy,
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      captureOpenshellSpy,
      runOpenshellSpy,
      recoverNamedGatewayRuntimeSpy,
      acquireOnboardLockSpy,
      releaseOnboardLockSpy,
      authoritativePreflightSpy,
      inferenceRouteReadySpy,
      imagePreflightSpy,
      printIssueSpy,
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        nimContainer: null,
        agent: null,
        nemoclawVersion: "0.0.72",
        dashboardPort: 18789,
        gatewayName: "nemoclaw-12345",
        gatewayPort: 12345,
      } as never),
      vi.spyOn(registry, "listExtraProviders").mockReturnValue([]),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      checkAgentVersionSpy,
      vi.spyOn(destroy, "removeSandboxRegistryEntry").mockImplementation(() => undefined),
      vi.spyOn(onboardMod, "onboard").mockRejectedValue(new Error("recreate-stub")),
    );

    ({ rebuildSandbox } = requireDist("./rebuild.js"));

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      /stale-sandbox recovery/,
    );

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw-12345",
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(authoritativePreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        targetGatewayName: "nemoclaw-12345",
        targetGatewayPort: 12345,
      }),
    );
    expect(imagePreflightSpy).toHaveBeenCalledWith(expect.objectContaining({ gatewayPort: 12345 }));
    expect(releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(listCalls).toBe(3);
  });

  it("does not recover generic sandbox list failures", async () => {
    detectPreflightIssueSpy.mockReturnValue(null);
    captureOpenshellSpy.mockReturnValue({ status: 1, output: "unknown option: sandbox list" });

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Failed to query running sandboxes from OpenShell.",
    );

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledTimes(1);
    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      gatewayName: "nemoclaw",
      recoverableStates: [
        "missing_named",
        "named_unhealthy",
        "named_unreachable",
        "connected_other",
      ],
    });
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(2);
    expect(releaseOnboardLockSpy).toHaveBeenCalledOnce();
  });
});
