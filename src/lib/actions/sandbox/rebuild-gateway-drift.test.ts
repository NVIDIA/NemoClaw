// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";

import type { OpenShellStateRpcIssue } from "../../adapters/openshell/gateway-drift";

type RebuildSandbox = typeof import("./rebuild")["rebuildSandbox"];

const requireDist = createRequire(import.meta.url);
const gatewayDrift = requireDist("../../adapters/openshell/gateway-drift.js");
const openshellRuntime = requireDist("../../adapters/openshell/runtime.js");
const gatewayRuntime = requireDist("../../gateway-runtime-action.js");
const registry = requireDist("../../state/registry.js");
const resolve = requireDist("../../adapters/openshell/resolve.js");
const sandboxSession = requireDist("../../state/sandbox-session.js");
const onboardSession = requireDist("../../state/onboard-session.js");
const sandboxVersion = requireDist("../../sandbox/version.js");
const agentRuntime = requireDist("../../agent/runtime.js");
const rebuildUsageNotice = requireDist("./rebuild-usage-notice.js");
const rebuildImagePreflight = requireDist("./rebuild-custom-image-preflight.js");
const { rebuildSandbox } = requireDist("./rebuild.js") as {
  rebuildSandbox: RebuildSandbox;
};

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
  let exitSpy: ReturnType<typeof mockExit>;
  let errorSpy: MockInstance;
  let spies: MockInstance[];
  let checkAgentVersionSpy: MockInstance;
  let detectPreflightIssueSpy: MockInstance;
  let captureOpenshellSpy: MockInstance;
  let runOpenshellSpy: MockInstance;
  let printIssueSpy: MockInstance;
  let recoverNamedGatewayRuntimeSpy: MockInstance;

  beforeEach(async () => {
    spies = [];
    exitSpy = mockExit();
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

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
      .mockResolvedValue({
        recovered: true,
        before: { state: "healthy_named" },
        after: { state: "healthy_named" },
      });

    spies.push(
      detectPreflightIssueSpy,
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      captureOpenshellSpy,
      runOpenshellSpy,
      recoverNamedGatewayRuntimeSpy,
      printIssueSpy,
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        nimContainer: null,
        agent: null,
        nemoclawVersion: "0.1.0",
        dashboardPort: 18789,
        gatewayName: "nemoclaw",
        gatewayPort: 8080,
      } as never),
      vi.spyOn(registry, "updateSandbox").mockReturnValue(true),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null),
      vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true }),
      vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi
        .spyOn(requireDist("../../onboard.js"), "preflightAuthoritativeRebuildTarget")
        .mockResolvedValue(undefined),
      vi
        .spyOn(rebuildImagePreflight, "preflightRebuildImage")
        .mockResolvedValue({ ok: true, imageTag: null }),
      vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true),
      checkAgentVersionSpy,
    );
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

  it.each([
    {
      recordedGateway: "nemoclaw",
      recordedPort: 8080,
      activeGateway: "other-gw",
    },
    {
      recordedGateway: "nemoclaw-9000",
      recordedPort: 9000,
      activeGateway: "nemoclaw",
    },
  ])("refuses stale recovery when '$activeGateway' is active instead of recorded gateway '$recordedGateway' (#4497)", async ({
    recordedGateway,
    recordedPort,
    activeGateway,
  }) => {
    detectPreflightIssueSpy.mockReturnValue(null);
    vi.mocked(registry.getSandbox).mockReturnValue({
      name: "alpha",
      provider: "ollama-local",
      model: "nvidia/nemotron",
      policies: [],
      nimContainer: null,
      agent: null,
      nemoclawVersion: "0.1.0",
      dashboardPort: 18789,
      gatewayName: recordedGateway,
      gatewayPort: recordedPort,
    } as never);
    const openshellResults: Record<string, { status: number; output: string }> = {
      "sandbox list": { status: 0, output: "" },
      "sandbox get": {
        status: 1,
        output: "Error:   × Not Found: sandbox not found",
      },
    };
    captureOpenshellSpy.mockImplementation(
      (args: string[]) => openshellResults[args.slice(0, 2).join(" ")] ?? { status: 0, output: "" },
    );
    const getNamedGatewayLifecycleStateSpy = vi
      .spyOn(gatewayRuntime, "getNamedGatewayLifecycleState")
      .mockReturnValue({
        state: "connected_other",
        activeGateway,
        status: `Gateway: ${activeGateway}\nStatus: Connected`,
      } as never);
    const backupSandboxStateSpy = vi
      .spyOn(requireDist("../../state/sandbox.js"), "backupSandboxState")
      .mockImplementation(() => {
        throw new Error("unexpected backup");
      });
    const removeSandboxRegistryEntrySpy = vi
      .spyOn(requireDist("./destroy.js"), "removeSandboxRegistryEntryWithReceipt")
      .mockImplementation(() => {
        throw new Error("unexpected registry removal");
      });
    const onboardSpy = vi
      .spyOn(requireDist("../../onboard.js"), "onboard")
      .mockImplementation(async () => {
        throw new Error("unexpected onboard");
      });
    spies.push(
      getNamedGatewayLifecycleStateSpy,
      backupSandboxStateSpy,
      removeSandboxRegistryEntrySpy,
      onboardSpy,
    );

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Could not confirm live state",
    );

    const output = errorSpy.mock.calls.flat().join("\n");
    expect(output).toContain("NOT been removed");
    expect(output).toContain(`openshell gateway select ${recordedGateway}`);
    expect(getNamedGatewayLifecycleStateSpy).toHaveBeenCalledWith(recordedGateway);
    expect(runOpenshellSpy).toHaveBeenCalledWith(
      ["gateway", "select", recordedGateway],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(runOpenshellSpy).not.toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.anything(),
    );
    expect(removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(onboardSpy).not.toHaveBeenCalled();
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
      vi.spyOn(destroy, "removeSandboxRegistryEntryWithReceipt").mockReturnValue(null),
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
    // The liveness query ran twice (initial failure + post-recovery retry).
    expect(listCalls).toBe(2);
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
      .mockResolvedValue({
        recovered: true,
        before: { state: "healthy_named" },
        after: { state: "healthy_named" },
      });
    checkAgentVersionSpy = vi
      .spyOn(sandboxVersion, "checkAgentVersion")
      .mockReturnValue({ expectedVersion: "0.1.0", sandboxVersion: "0.0.1" } as never);
    printIssueSpy = vi
      .spyOn(gatewayDrift, "printOpenShellStateRpcIssue")
      .mockImplementation(() => undefined);

    const destroy = requireDist("./destroy.js");
    const onboardMod = requireDist("../../onboard.js");
    spies.push(
      detectPreflightIssueSpy,
      vi.spyOn(gatewayDrift, "detectOpenShellStateRpcResultIssue").mockReturnValue(null),
      captureOpenshellSpy,
      runOpenshellSpy,
      recoverNamedGatewayRuntimeSpy,
      printIssueSpy,
      vi.spyOn(registry, "getSandbox").mockReturnValue({
        name: "alpha",
        provider: "ollama-local",
        model: "nvidia/nemotron",
        policies: [],
        nimContainer: null,
        agent: null,
        gatewayName: "nemoclaw-12345",
        gatewayPort: 12345,
        nemoclawVersion: "0.1.0",
        dashboardPort: 18789,
      } as never),
      vi.spyOn(registry, "updateSandbox").mockReturnValue(true),
      vi.spyOn(resolve, "resolveOpenshell").mockReturnValue(null),
      vi.spyOn(sandboxSession, "getActiveSandboxSessions").mockReturnValue({
        detected: false,
        sessions: [],
      }),
      vi.spyOn(onboardSession, "loadSession").mockReturnValue(null),
      vi.spyOn(onboardSession, "acquireOnboardLock").mockReturnValue({ acquired: true }),
      vi.spyOn(onboardSession, "releaseOnboardLock").mockImplementation(() => undefined),
      vi.spyOn(agentRuntime, "getSessionAgent").mockReturnValue(null),
      vi.spyOn(agentRuntime, "getAgentDisplayName").mockReturnValue("OpenClaw"),
      vi.spyOn(onboardMod, "preflightAuthoritativeRebuildTarget").mockResolvedValue(undefined),
      vi
        .spyOn(rebuildImagePreflight, "preflightRebuildImage")
        .mockResolvedValue({ ok: true, imageTag: null }),
      vi.spyOn(rebuildUsageNotice, "ensureRebuildUsageNoticeAccepted").mockResolvedValue(true),
      checkAgentVersionSpy,
      vi.spyOn(destroy, "removeSandboxRegistryEntryWithReceipt").mockReturnValue(null),
      vi.spyOn(onboardMod, "onboard").mockRejectedValue(new Error("recreate-stub")),
    );
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
    expect(listCalls).toBe(2);
  });

  it("does not retry gateway recovery for generic sandbox list failures", async () => {
    detectPreflightIssueSpy.mockReturnValue(null);
    captureOpenshellSpy.mockReturnValue({ status: 1, output: "unknown option: sandbox list" });

    await expect(rebuildSandbox("alpha", ["--yes"], { throwOnError: true })).rejects.toThrow(
      "Failed to query running sandboxes from OpenShell.",
    );

    const listRecoveryCalls = recoverNamedGatewayRuntimeSpy.mock.calls.filter(
      ([options]) => options.recoverableStates !== undefined,
    );
    expect(listRecoveryCalls).toEqual([
      [
        {
          gatewayName: "nemoclaw",
          recoverableStates: [
            "missing_named",
            "named_unhealthy",
            "named_unreachable",
            "connected_other",
          ],
        },
      ],
    ]);
    expect(captureOpenshellSpy).toHaveBeenCalledTimes(1);
  });
});
