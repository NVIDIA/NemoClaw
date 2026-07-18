// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("Hermes rebuild post-restore verification", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("fails instead of reporting readiness when restored state leaves the gateway down (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: false,
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
    ).rejects.toThrow("Hermes post-restore verification failed");

    const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(output).toContain("rebuilt but some post-restore steps were incomplete");
    expect(output).toContain("Hermes gateway health was not verified after state restore");
    expect(output).not.toContain("MCP bridge definitions were preserved but not fully refreshed");
    expect(output).not.toContain("rebuilt successfully");
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
  });

  it("accepts restored MCP configuration only after final gateway recovery (#7084)", async () => {
    const mcpEntry = {
      server: "blender",
      providerName: "nemoclaw-mcp-alpha-blender",
    };
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: false,
        recovered: true,
        forwardRecovered: true,
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

    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    expect(harness.restoreMcpBridgesAfterRebuildSpy.mock.invocationCallOrder[0]).toBeLessThan(
      harness.checkAndRecoverSandboxProcessesSpy.mock.invocationCallOrder[0],
    );
    expect(harness.logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Hermes gateway recovered after state restore"),
    );
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

  it("fails when the final gateway check refuses MCP reconciliation (#7084)", async () => {
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
        mcpReconciliationRefused: true,
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
    ).rejects.toThrow("Hermes post-restore verification failed");

    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it.each([
    "forwardRecoveryFailed",
    "secretBoundaryRefused",
  ] as const)("fails when the final gateway check reports %s (#7084)", async (failureFlag) => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: true,
        wasRunning: true,
        recovered: false,
        forwardRecovered: false,
        [failureFlag]: true,
      }),
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
  });

  it("fails when the final gateway health probe is unavailable (#7084)", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      checkAndRecoverSandboxProcesses: () => ({
        checked: false,
        wasRunning: null,
        recovered: false,
        forwardRecovered: false,
      }),
      sandboxEntry: { agent: "hermes" },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Hermes post-restore verification failed");

    expect(harness.logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining("rebuilt successfully"),
    );
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
