// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "./rebuild.js";

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

describe("rebuild shields relock guard", () => {
  let rebuildSandbox: RebuildSandbox;
  let spies: MockInstance[];
  let errorSpy: MockInstance;
  let logSpy: MockInstance;
  let relockSpy: MockInstance;
  let sandboxListRecoverySpy: MockInstance;
  let targetGatewayRecoverySpy: MockInstance;
  let acquireOnboardLockSpy: MockInstance;
  let releaseOnboardLockSpy: MockInstance;
  let authoritativePreflightSpy: MockInstance;
  let inferenceRouteReadySpy: MockInstance;
  let imagePreflightSpy: MockInstance;
  const rebuildWindow = { relocked: false, wasLocked: true };

  beforeEach(() => {
    spies = [];
    rebuildWindow.relocked = false;
    delete require.cache[requireDist.resolve(rebuildModulePath)];

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
    const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
    const sandboxList = requireDist("../../openshell-sandbox-list.js");
    const resolve = requireDist("../../adapters/openshell/resolve.js");
    const agentRuntime = requireDist("../../agent/runtime.js");
    const onboardSession = requireDist("../../state/onboard-session.js");
    const registry = requireDist("../../state/registry.js");
    const sandboxState = requireDist("../../state/sandbox.js");
    const sandboxSession = requireDist("../../state/sandbox-session.js");
    const sandboxVersion = requireDist("../../sandbox/version.js");
    const rebuildShields = requireDist("./rebuild-shields.js");
    const onboardMod = requireDist("../../onboard.js");
    const imagePreflight = requireDist("./rebuild-custom-image-preflight.js");
    const inferencePreflight = requireDist("./rebuild-inference-preflight.js");

    relockSpy = vi
      .spyOn(rebuildShields, "relockRebuildShieldsWindow")
      .mockImplementation((...args: unknown[]) => {
        const window = args[1] as typeof rebuildWindow;
        window.relocked = true;
        return true;
      });

    sandboxListRecoverySpy = vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery");
    targetGatewayRecoverySpy = vi
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
        buildCtx: "/tmp/rebuild-shields-preflight",
        stagedDockerfile: "/tmp/rebuild-shields-preflight/Dockerfile",
        buildId: "shields-build",
        dockerGpuPatchNetwork: null,
        cleanupBuildCtx: vi.fn(() => true),
      },
    });

    spies.push(
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null),
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      targetGatewayRecoverySpy,
      acquireOnboardLockSpy,
      releaseOnboardLockSpy,
      authoritativePreflightSpy,
      inferenceRouteReadySpy,
      imagePreflightSpy,
      vi.spyOn(inferencePreflight, "preflightRebuildInferenceRoute").mockReturnValue({ ok: true }),
      sandboxListRecoverySpy.mockResolvedValue({
        result: { status: 0, output: "alpha Ready" },
      }),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null),
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        agent: null,
        nimContainer: null,
        nemoclawVersion: "0.0.72",
        dashboardPort: 18789,
        gatewayName: "nemoclaw-8090",
        gatewayPort: 8090,
      } as never),
      vi.spyOn(registry, "listExtraProviders").mockReturnValue([]),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
        expectedVersion: "0.1.0",
        sandboxVersion: "0.0.1",
      } as never),
      vi.spyOn(rebuildShields, "openRebuildShieldsWindow").mockReturnValue(rebuildWindow),
      relockSpy,
      vi.spyOn(sandboxState, "backupSandboxState").mockImplementation(() => {
        throw new Error("unexpected backup exception");
      }),
    );

    ({ rebuildSandbox } = requireDist(rebuildModulePath));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    errorSpy.mockRestore();
    logSpy.mockRestore();
    delete require.cache[requireDist.resolve(rebuildModulePath)];
  });

  it("relocks shields when an unexpected exception escapes after auto-unlock", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "unexpected backup exception",
    );

    expect(relockSpy).toHaveBeenCalledWith("alpha", rebuildWindow, true, expect.any(String));
    expect(sandboxListRecoverySpy).toHaveBeenCalledWith({ gatewayName: "nemoclaw-8090" });
    expect(targetGatewayRecoverySpy).toHaveBeenCalledOnce();
    expect(targetGatewayRecoverySpy).toHaveBeenCalledWith({ gatewayName: "nemoclaw-8090" });
    expect(authoritativePreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        authoritativeResumeConfig: true,
        controlUiPort: 18789,
        model: "nvidia/nemotron",
        provider: "ollama-local",
        sandboxName: "alpha",
        targetGatewayName: "nemoclaw-8090",
        targetGatewayPort: 8090,
      }),
    );
    expect(imagePreflightSpy).toHaveBeenCalledWith(
      expect.objectContaining({ gatewayPort: 8090, model: "nvidia/nemotron" }),
    );
    expect(inferenceRouteReadySpy).toHaveBeenCalledWith("ollama-local", "nvidia/nemotron");
    expect(acquireOnboardLockSpy).toHaveBeenCalledWith("nemoclaw alpha rebuild");
    expect(releaseOnboardLockSpy).toHaveBeenCalledOnce();
    expect(rebuildWindow.relocked).toBe(true);
  });
});
