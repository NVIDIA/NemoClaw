// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

type RebuildSandbox = typeof import("../../../../dist/lib/actions/sandbox/rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const rebuildModulePath = "../../../../dist/lib/actions/sandbox/rebuild.js";

describe("rebuild shields relock guard", () => {
  let rebuildSandbox: RebuildSandbox;
  let spies: MockInstance[];
  let errorSpy: MockInstance;
  let logSpy: MockInstance;
  let relockSpy: MockInstance;
  const rebuildWindow = { relocked: false, wasLocked: true };

  beforeEach(() => {
    spies = [];
    rebuildWindow.relocked = false;
    delete require.cache[requireDist.resolve(rebuildModulePath)];

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../../../dist/lib/adapters/openshell/gateway-drift.js");
    const gatewayRuntime = requireDist("../../../../dist/lib/gateway-runtime-action.js");
    const sandboxList = requireDist("../../../../dist/lib/openshell-sandbox-list.js");
    const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
    const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");
    const onboardSession = requireDist("../../../../dist/lib/state/onboard-session.js");
    const registry = requireDist("../../../../dist/lib/state/registry.js");
    const sandboxState = requireDist("../../../../dist/lib/state/sandbox.js");
    const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");
    const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");
    const rebuildShields = requireDist("../../../../dist/lib/actions/sandbox/rebuild-shields.js");

    relockSpy = vi
      .spyOn(rebuildShields, "relockRebuildShieldsWindow")
      .mockImplementation((...args: unknown[]) => {
        const window = args[1] as typeof rebuildWindow;
        window.relocked = true;
        return true;
      });

    spies.push(
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcPreflightIssue").mockReturnValue(null),
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      vi.spyOn(gatewayRuntime, "recoverNamedGatewayRuntime").mockResolvedValue({ recovered: false }),
      vi.spyOn(sandboxList, "captureSandboxListWithGatewayRecovery").mockResolvedValue({
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
      } as never),
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

    expect(relockSpy).toHaveBeenCalledWith(
      "alpha",
      rebuildWindow,
      true,
      expect.any(String),
    );
    expect(rebuildWindow.relocked).toBe(true);
  });
});
