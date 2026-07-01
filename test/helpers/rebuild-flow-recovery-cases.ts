// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { makeActiveTeamsMessagingPlan } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import { createRebuildFlowHarness, installRebuildFlowTestHooks } from "./rebuild-flow-test-harness";

export function registerRebuildFlowRecoveryTests(): void {
  describe("rebuildSandbox flow: recovery", () => {
    installRebuildFlowTestHooks();
    it("prunes the disabled Teams preset from the final registry policies after rebuild", async () => {
      const disabledTeamsPlan = {
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: "openclaw",
        workflow: "rebuild",
        channels: [],
        disabledChannels: ["teams"],
        credentialBindings: [],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      };
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        backupPolicyPresets: ["teams", "npm"],
        buildMessagingRebuildPlan: () => disabledTeamsPlan,
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
      expect(harness.applyPresetSpy).not.toHaveBeenCalledWith("alpha", "teams");
      expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
        agentVersion: "0.2.0",
        policies: ["npm"],
        policyTier: null,
        policyPresetsFinalized: undefined,
      });
    });

    it("aborts before backup/delete when messaging manifest staging fails", async () => {
      const harness = createRebuildFlowHarness({
        buildMessagingRebuildPlan: () => {
          throw new Error("manifest boom");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("manifest boom");

      const errors = harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(errors).toContain("messaging manifest plan could not be staged");
      expect(harness.releaseOnboardLockSpy).toHaveBeenCalledOnce();
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("reattaches exactly the MCP providers detached when sandbox deletion fails", async () => {
      const attached = {
        server: "attached",
        providerName: "nemoclaw-mcp-alpha-attached",
      };
      const alreadyDetached = {
        server: "already-detached",
        providerName: "nemoclaw-mcp-alpha-already-detached",
      };
      const harness = createRebuildFlowHarness({
        mcpPreparation: {
          entries: [attached, alreadyDetached],
          detachedProviderEntries: [attached],
        },
        runOpenshell: (args) =>
          args.join(" ") === "sandbox delete alpha"
            ? { status: 7, output: "delete failed", stderr: "delete failed" }
            : { status: 0, output: "" },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Failed to delete sandbox");

      expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledWith(
        "alpha",
        [attached],
        undefined,
      );
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("does not reclaim the default sandbox when an MCP rebuild recreate fails", async () => {
      const mcpEntry = {
        server: "github",
        providerName: "nemoclaw-mcp-alpha-github",
      };
      const harness = createRebuildFlowHarness({
        defaultSandbox: "alpha",
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
        },
        onboard: () => {
          throw new Error("inner recreate boom");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Recreate failed");

      expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
      expect(harness.restoreSandboxEntrySpy.mock.calls).toEqual([
        [expect.objectContaining({ name: "alpha" })],
      ]);
    });

    it("starts the active Teams host forward after a successful rebuild", async () => {
      const plan = makeActiveTeamsMessagingPlan();
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        buildMessagingRebuildPlan: () => plan,
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.ensureMessagingHostForwardAfterRebuildSpy).toHaveBeenCalledWith("alpha", plan);
      expect(
        harness.ensureMessagingHostForwardAfterRebuildSpy.mock.invocationCallOrder[0],
      ).toBeGreaterThan(harness.onboardSpy.mock.invocationCallOrder[0]);
    });

    it("finishes the rebuild while surfacing incomplete post-restore work", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { policyPresetsFinalized: true, policyTier: "balanced" },
        executeSandboxCommand: () => ({ status: 1, stdout: "", stderr: "hash refresh failed" }),
        repairMutableConfigPerms: () => ({
          applied: false,
          skipReason: "unreadable",
          reason: "cannot stat mutable config",
        }),
        restoreSandboxState: () => ({
          success: false,
          restoredDirs: ["workspace"],
          restoredFiles: [],
          failedDirs: ["config"],
          failedFiles: ["user.md"],
        }),
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("rebuilt but some post-restore steps were incomplete");
      expect(output).toContain("State restore was incomplete");
      expect(output).toContain("Mutable config permissions were not verified");
      expect(output).toContain("Mutable OpenClaw config hash was not refreshed");
      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
      expect(harness.errorSpy).toHaveBeenCalledWith(expect.stringContaining("bad, throw"));
      expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
      expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
        agentVersion: "0.2.0",
        policies: ["npm"],
        policyTier: "balanced",
        policyPresetsFinalized: undefined,
      });
      expect(output).toContain("Policy presets failed to reapply: bad, throw");
    });

    it("reports both MCP and policy recovery when both restores are incomplete", async () => {
      const mcpEntry = {
        server: "github",
        providerName: "nemoclaw-mcp-alpha-github",
      };
      const harness = createRebuildFlowHarness({
        applyPreset: () => false,
        backupPolicyPresets: ["npm"],
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
        },
        restoreMcpBridgesAfterRebuild: () => Promise.reject(new Error("MCP restore boom")),
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      const output = harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n");
      expect(output).toContain("rebuilt but some post-restore steps were incomplete");
      expect(output).toContain("MCP bridge definitions were preserved but not fully refreshed");
      expect(output).toContain("Policy presets failed to reapply: npm");
      expect(output).not.toContain("rebuilt successfully");
      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("MCP bridge restore incomplete: MCP restore boom"),
      );
    });
  });
}
