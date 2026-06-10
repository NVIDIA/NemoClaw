// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { OpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";

type RebuildSandbox =
  typeof import("../../../../dist/lib/actions/sandbox/rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);

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

describe("rebuild gateway drift preflight", () => {
  let rebuildSandbox: RebuildSandbox;
  let exitSpy: ReturnType<typeof mockExit>;
  let errorSpy: MockInstance;
  let spies: MockInstance[];
  let checkAgentVersionSpy: MockInstance;
  let detectPreflightIssueSpy: MockInstance;
  let captureOpenshellSpy: MockInstance;
  let printIssueSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;

  beforeEach(async () => {
    spies = [];
    exitSpy = mockExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const gatewayDrift = requireDist("../../../../dist/lib/adapters/openshell/gateway-drift.js");
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const gatewayRuntime = requireDist("../../../../dist/lib/gateway-runtime-action.js");
    const registry = requireDist("../../../../dist/lib/state/registry.js");
    const resolve = requireDist("../../../../dist/lib/adapters/openshell/resolve.js");
    const sandboxSession = requireDist("../../../../dist/lib/state/sandbox-session.js");
    const onboardSession = requireDist("../../../../dist/lib/state/onboard-session.js");
    const sandboxVersion = requireDist("../../../../dist/lib/sandbox/version.js");
    const agentRuntime = requireDist("../../../../dist/lib/agent/runtime.js");

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
    recoverNamedGatewayRuntimeSpy = vi
      .spyOn(gatewayRuntime, "recoverNamedGatewayRuntime")
      .mockResolvedValue({ recovered: true });

    spies.push(
      detectPreflightIssueSpy,
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      captureOpenshellSpy,
      recoverNamedGatewayRuntimeSpy,
      printIssueSpy,
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        nimContainer: null,
        agent: null,
      } as never),
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

    ({ rebuildSandbox } = requireDist("../../../../dist/lib/actions/sandbox/rebuild.js"));
  });

  afterEach(() => {
    for (const spy of spies) spy.mockRestore();
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it("fails before version or liveness RPCs when gateway image drift is detected", async () => {
    await expect(rebuildSandbox("alpha", ["--yes"])).rejects.toThrow("process.exit(1)");

    expect(printIssueSpy).toHaveBeenCalledWith(
      driftIssue,
      expect.objectContaining({ command: "nemoclaw alpha rebuild" }),
    );
    expect(checkAgentVersionSpy).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).not.toHaveBeenCalled();
    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
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
    const openshellRuntime = requireDist("../../../../dist/lib/adapters/openshell/runtime.js");
    const destroy = requireDist("../../../../dist/lib/actions/sandbox/destroy.js");
    const onboardMod = requireDist("../../../../dist/lib/onboard.js");
    spies.push(
      vi
        .spyOn(openshellRuntime, "runOpenshell")
        .mockReturnValue({ status: 0, output: "" } as never),
      vi.spyOn(destroy, "removeSandboxRegistryEntry").mockImplementation(() => undefined),
      vi.spyOn(onboardMod, "onboard").mockRejectedValue(new Error("recreate-stub")),
    );

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      /stale-sandbox recovery/,
    );

    expect(recoverNamedGatewayRuntimeSpy).toHaveBeenCalledWith({
      recoverableStates: ["missing_named", "named_unhealthy", "named_unreachable"],
    });
    // The liveness query ran twice (initial failure + post-recovery retry).
    expect(listCalls).toBe(2);
  });

  it("does not recover generic sandbox list failures", async () => {
    detectPreflightIssueSpy.mockReturnValue(null);
    captureOpenshellSpy.mockReturnValue({ status: 1, output: "unknown option: sandbox list" });

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Failed to query running sandboxes from OpenShell.",
    );

    expect(recoverNamedGatewayRuntimeSpy).not.toHaveBeenCalled();
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(1);
  });
});
