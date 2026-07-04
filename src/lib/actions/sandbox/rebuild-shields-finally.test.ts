// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "./rebuild.js";

describe("rebuild shields relock guard", () => {
  let rebuildSandbox: RebuildSandbox;
  let spies: MockInstance[];
  let errorSpy: MockInstance;
  let logSpy: MockInstance;
  let relockSpy: MockInstance;
  let sandboxListRecoverySpy: MockInstance;
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
    const onboardMod = requireDist("../../onboard.js");
    const onboardSession = requireDist("../../state/onboard-session.js");
    const registry = requireDist("../../state/registry.js");
    const sandboxState = requireDist("../../state/sandbox.js");
    const sandboxSession = requireDist("../../state/sandbox-session.js");
    const sandboxVersion = requireDist("../../sandbox/version.js");
    const rebuildShields = requireDist("./rebuild-shields.js");
    const rebuildImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
    const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
    const nim = requireDist("../../inference/nim.js");

    relockSpy = vi
      .spyOn(rebuildShields, "relockRebuildShieldsWindow")
      .mockImplementation((...args: unknown[]) => {
        const window = args[1] as typeof rebuildWindow;
        window.relocked = true;
        return true;
      });

    sandboxListRecoverySpy = vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery");

    spies.push(
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null),
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({
        recovered: true,
        before: { state: "connected_other" },
        after: { state: "healthy_named" },
      }),
      sandboxListRecoverySpy.mockResolvedValue({
        result: { status: 0, output: "alpha Ready" },
      }),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null),
      vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true }),
      vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined),
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        agent: null,
        nimContainer: null,
        nemoclawVersion: "0.1.0",
        gatewayName: "nemoclaw-8090",
        gatewayPort: 8090,
        dashboardPort: 18789,
      } as never),
      vi.spyOn(registry, "updateSandbox").mockReturnValue(true),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(sandboxVersion, "checkAgentVersion").mockReturnValue({
        expectedVersion: "0.1.0",
        sandboxVersion: "0.0.1",
      } as never),
      vi.spyOn(nim, "detectGpu").mockReturnValue(null),
      vi.spyOn(onboardMod, "preflightAuthoritativeRebuildTarget").mockResolvedValue(undefined),
      vi.spyOn(rebuildImagePreflight, "preflightRebuildImage").mockResolvedValue({
        ok: true,
        imageTag: null,
      }),
      vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true),
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
    expect(rebuildWindow.relocked).toBe(true);
  }, 15_000);
});
