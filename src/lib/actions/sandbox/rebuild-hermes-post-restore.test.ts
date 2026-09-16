// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import {
  restartHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestore,
  verifyHermesGatewayAfterStateRestoreForCronGate,
} from "./rebuild-hermes-post-restore";

const RESTART_SUCCEEDED = {
  ok: true,
  restarted: true,
  healthPassed: true,
  forwardRecovered: false,
} as const;

const RESTART_REFUSED = {
  ok: false,
  failureLayer: "native agent command",
  detail: "native Hermes restart failed",
} as const;

describe("binding the Hermes gateway to restored state", () => {
  it("keeps native restart and health operations pinned to the selected OpenShell runtime", async () => {
    const runtimeSelection = {
      gatewayName: "nemoclaw-19080",
      workspace: "default",
      localTlsDir: "/authority/tls",
    };
    const restartSandboxGateway = vi.fn(async () => RESTART_SUCCEEDED);
    const checkAndRecoverSandboxProcesses = vi.fn(async () => ({
      checked: true,
      wasRunning: true,
      recovered: false,
    }));

    const restartState = await restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway,
      runtimeSelection,
    });
    expect(restartState).toBe("restarted");
    expect(restartSandboxGateway).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
      runtimeSelection,
    });

    expect(
      await verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses,
        runtimeSelection,
      }),
    ).toBe("healthy");
    expect(checkAndRecoverSandboxProcesses).toHaveBeenCalledExactlyOnceWith("alpha", {
      quiet: true,
      runtimeSelection,
    });
  });

  it("preserves a config-integrity refusal before gateway replacement (#8671)", async () => {
    const restartState = await restartHermesGatewayAfterStateRestore("alpha", "hermes", {
      restartSandboxGateway: async () => RESTART_REFUSED,
    });

    expect(restartState).toBe("restart-failed");
    expect(
      await verifyHermesGatewayAfterStateRestore("alpha", "hermes", restartState, {
        checkAndRecoverSandboxProcesses: async () => ({
          checked: true,
          wasRunning: true,
          recovered: false,
        }),
      }),
    ).toBe("unverified");
  });
  it("verifies the final cron-bound gateway without restarting after MCP restoration (#8472)", async () => {
    const original = { pid: 41, start_time: 902, drain_token: "restore-token" };
    const replacement = {
      pid: 77,
      start_time: 903,
      drain_token: "restore-token",
    };
    const restartSandboxGateway = vi.fn(async () => RESTART_SUCCEEDED);
    const observeHermesCronReplacement = vi.fn(() => replacement);

    expect(
      await verifyHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        "restarted",
        original,
        {
          restartSandboxGateway,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses: async () => ({
            checked: true,
            wasRunning: true,
            recovered: false,
          }),
        },
      ),
    ).toEqual({ state: "healthy", replacementIdentity: replacement });
    expect(restartSandboxGateway).not.toHaveBeenCalled();
    expect(observeHermesCronReplacement).toHaveBeenCalledTimes(2);
  });

  it("rejects unstable final cron identity without restarting after MCP restoration (#8472)", async () => {
    const restartSandboxGateway = vi.fn(async () => RESTART_SUCCEEDED);
    const observeHermesCronReplacement = vi
      .fn()
      .mockReturnValueOnce({
        pid: 77,
        start_time: 903,
        drain_token: "restore-token",
      })
      .mockReturnValueOnce({
        pid: 88,
        start_time: 904,
        drain_token: "restore-token",
      });

    expect(
      await verifyHermesGatewayAfterStateRestoreForCronGate(
        "alpha",
        "hermes",
        "restarted",
        { pid: 41, start_time: 902, drain_token: "restore-token" },
        {
          restartSandboxGateway,
          observeHermesCronReplacement,
          checkAndRecoverSandboxProcesses: async () => ({
            checked: true,
            wasRunning: true,
            recovered: false,
          }),
        },
      ),
    ).toEqual({ state: "unverified" });
    expect(restartSandboxGateway).not.toHaveBeenCalled();
  });
});

describe("Hermes rebuild post-restore verification", () => {
  installRebuildFlowTestHooks({ acceptThirdPartySoftware: true });

  it("restores MCP without taking native Hermes lifecycle ownership", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
      }),
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry], {
      gatewayName: "nemoclaw",
      workspace: "default",
    });
    expect(harness.restartSandboxGatewaySpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
  });

  it("returns a failed rebuild when managed Hermes MCP restoration is incomplete (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [mcpEntry],
      },
      sandboxEntry: { agent: "hermes" },
    });
    harness.restoreMcpBridgesAfterRebuildSpy.mockRejectedValueOnce(new Error("reload failed"));

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
  });

  it("fails before recovery when recreated Hermes identity is missing (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sessionAgentName: null,
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "Recreated sandbox agent identity did not match the authoritative rebuild target",
    );

    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it("leaves ordinary Hermes lifecycle ownership with the managed image", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.restartSandboxGatewaySpy).not.toHaveBeenCalled();
    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringMatching(/Hermes gateway (?:restarted|recovered) after state restore/),
    );
  });

  it("fails before recovery when recreated Hermes identity mismatches (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sessionAgentName: "langchain-deepagents-code",
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      "Recreated sandbox agent identity did not match the authoritative rebuild target",
    );

    expect(harness.checkAndRecoverSandboxProcessesSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });
});
