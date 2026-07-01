// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  makeActiveTeamsMessagingPlan,
  makePreparedRecoveryManifest,
} from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import { createRebuildFlowHarness, installRebuildFlowTestHooks } from "./rebuild-flow-test-harness";

export function registerRebuildFlowRecoveryTests(): void {
  describe("rebuildSandbox flow: recovery", () => {
    installRebuildFlowTestHooks();

    it("restores a validated prepared manifest without taking a second backup (#6114)", async () => {
      const harness = createRebuildFlowHarness({ sandboxListOutput: "alpha Error" });
      const recoveryManifest = makePreparedRecoveryManifest();

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest,
        }),
      ).resolves.toBeUndefined();

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
        "alpha",
        recoveryManifest.backupPath,
      );
    });

    it("rejects a mismatched prepared manifest before deleting the sandbox (#6114)", async () => {
      const harness = createRebuildFlowHarness({
        recoveryManifestValidation: () => ({
          ok: false,
          reason: "manifest sandbox 'beta' does not match 'alpha'",
        }),
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Invalid recovery manifest");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("revalidates a prepared manifest immediately before deletion (#6114)", async () => {
      let validationCount = 0;
      const harness = createRebuildFlowHarness({
        recoveryManifestValidation: (manifest) => {
          validationCount++;
          return validationCount === 1
            ? { ok: true, manifest }
            : { ok: false, reason: "persisted backup identity changed during validation" };
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Invalid recovery manifest");

      expect(validationCount).toBe(2);
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
    });

    it("rejects registry configuration drift before prepared recovery deletion (#6114)", async () => {
      const harness = createRebuildFlowHarness({
        preDeleteSandboxEntry: {
          name: "alpha",
          provider: "compatible-endpoint",
          model: "new-model",
          policies: ["npm", "github"],
          agent: null,
          agentVersion: "0.1.0",
          nemoclawVersion: "0.0.71",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Recovery registry configuration changed during preflight");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
    });

    it("uses the refreshed registry snapshot for prepared-recovery rollback (#6114)", async () => {
      const harness = createRebuildFlowHarness({
        defaultSandbox: "alpha",
        preDeleteDefaultSandbox: "beta",
        onboard: () => {
          throw new Error("recreate failed");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Recreate failed");

      expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "alpha", agentVersion: "0.1.0" }),
        { reclaimDefault: null },
      );
    });

    it("rejects a latest-backup change before prepared recovery deletion (#6114)", async () => {
      const harness = createRebuildFlowHarness({
        preDeleteLatestManifest: {
          ...makePreparedRecoveryManifest(),
          timestamp: "2026-07-01T07-00-00-000Z",
          backupPath: "/tmp/rebuild-backups/alpha/2026-07-01T07-00-00-000Z",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Recovery backup identity changed during preflight");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.runOpenshellSpy).not.toHaveBeenCalledWith(
        ["sandbox", "delete", "alpha"],
        expect.anything(),
      );
    });

    it("restores the registry entry when prepared-backup recreation fails (#6114)", async () => {
      const harness = createRebuildFlowHarness({
        defaultSandbox: "alpha",
        onboard: () => {
          throw new Error("recreate failed");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Recreate failed");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.restoreSandboxEntrySpy).toHaveBeenCalledWith(
        expect.objectContaining({ name: "alpha", agentVersion: "0.1.0" }),
        { reclaimDefault: "alpha" },
      );
      expect(harness.restoreSandboxStateSpy).not.toHaveBeenCalled();
    });

    it("performs exactly one prepared-recovery rollback when MCP state is present", async () => {
      const mcpEntry = { server: "github", providerName: "nemoclaw-mcp-alpha-github" };
      const harness = createRebuildFlowHarness({
        defaultSandbox: "alpha",
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [mcpEntry],
        },
        onboard: () => {
          throw new Error("recreate failed");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Recreate failed");

      expect(harness.restoreSandboxEntrySpy.mock.calls).toEqual([
        [expect.objectContaining({ name: "alpha" }), { reclaimDefault: "alpha" }],
      ]);
    });

    it("blocks installer recovery when MCP post-restore verification is incomplete", async () => {
      const mcpEntry = { server: "github", providerName: "nemoclaw-mcp-alpha-github" };
      const harness = createRebuildFlowHarness({
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [mcpEntry],
        },
        restoreMcpBridgesAfterRebuild: () => Promise.reject(new Error("MCP restore boom")),
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).rejects.toThrow("Prepared backup recovery");

      expect(harness.errorSpy).toHaveBeenCalledWith(
        expect.stringContaining("MCP bridge restore incomplete: MCP restore boom"),
      );
      expect(harness.relockSpy).toHaveBeenCalled();
    });

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
