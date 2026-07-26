// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { makePreparedRecoveryManifest } from "../../src/lib/actions/sandbox/rebuild-flow-test-fixtures";
import { expectNoSandboxDelete } from "./rebuild-delete-assertions";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  originalSandboxName,
  snapshotEnv,
} from "./rebuild-flow-test-harness";

export function registerRebuildFlowLifecycleTests(): void {
  describe("rebuildSandbox flow: lifecycle", () => {
    installRebuildFlowTestHooks();

    it("rejects a multi-agent sandbox before backup, onboard, or deletion", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { agents: [{ name: "openclaw" }, { name: "hermes" }] },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Multi-agent sandbox rebuild is not yet supported");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
      expectNoSandboxDelete(harness.runOpenshellSpy);
    });

    it("backs up once, recreates, restores, reapplies policy, and relocks on a successful OpenClaw rebuild", async ({
      onTestFinished,
    }) => {
      const restoreEnv = snapshotEnv(["NEMOCLAW_RECREATE_WITHOUT_BACKUP"]);
      onTestFinished(restoreEnv);
      process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP = "0";
      let innerBackupMarker: string | undefined;
      const mcpEntry = {
        server: "github",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "nemoclaw-mcp-alpha-github",
        policyName: "mcp-bridge-github",
        adapter: "mcporter",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:00:00.000Z",
      };
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: { policyPresetsFinalized: true, policyTier: "balanced" },
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
        },
        onboard: () => {
          innerBackupMarker = process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP;
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
      expect(harness.backupSandboxStateSpy).toHaveBeenCalledWith("alpha");
      expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith("alpha");
      expect(harness.prepareMcpBridgesForRebuildSpy.mock.invocationCallOrder[0]).toBeLessThan(
        harness.warnUnpreservedUserManagedFilesSpy.mock.invocationCallOrder[0],
      );
      expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
        ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
        expect.objectContaining({ ignoreError: true }),
      );
      expect(harness.onboardSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          resume: true,
          nonInteractive: true,
          recreateSandbox: true,
          authoritativeResumeConfig: true,
          autoYes: true,
        }),
      );
      expect(innerBackupMarker).toBe("1");
      expect(process.env.NEMOCLAW_RECREATE_WITHOUT_BACKUP).toBe("0");
      expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({
          provider: "ollama-local",
          model: "nvidia/nemotron",
          webSearchEnabled: false,
          fromDockerfile: null,
          hermesAuthMethod: null,
        }),
      );
      const deleteCall = harness.runOpenshellSpy.mock.calls.findIndex(
        (call) =>
          Array.isArray(call[0]) && call[0].join(" ") === "sandbox delete -g nemoclaw alpha",
      );
      expect(harness.registryUpdateSpy.mock.invocationCallOrder[0]).toBeLessThan(
        harness.runOpenshellSpy.mock.invocationCallOrder[deleteCall],
      );
      expect(harness.session.policyPresets).toEqual(["npm", "bad", "throw"]);
      expect(harness.session.steps.gateway.status).toBe("complete");
      expect(harness.session.steps.preflight.status).toBe("complete");
      expect(harness.session.steps.sandbox.status).toBe("pending");
      expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
        "alpha",
        "/tmp/nemoclaw-rebuild-backup",
        { targetAgentType: "openclaw" },
      );
      expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
      expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "Preserving MCP-bearing registry entry across sandbox recreation",
      );
      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
      expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
      expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
        agentVersion: "0.2.0",
        policies: ["npm", "bad", "throw"],
        policyTier: "balanced",
        policyPresetsFinalized: true,
      });
      expect(harness.executeSandboxCommandSpy).toHaveBeenCalledWith(
        "alpha",
        "openclaw doctor --fix",
      );
      expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
      expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe(originalSandboxName);
      expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "rebuilt successfully",
      );
    });

    it("keeps baseline exclusions durable through successful replacement onboarding (#7194)", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          baselineExclusions: [
            {
              version: 1,
              agent: "openclaw",
              key: "openclaw_docs",
              digest: "baseline-digest",
              acknowledgedAt: "2026-07-19T00:00:00.000Z",
              appliedAgentVersion: "2026.6.10",
            },
          ],
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith("alpha");
      expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).toHaveBeenCalledOnce();
      expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "Preserving baseline-exclusion registry entry across sandbox recreation",
      );
      expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
      expect(harness.restoreSandboxEntryIfMissingSpy).not.toHaveBeenCalled();
    });

    it("rejects a schema-invalid recorded-agent baseline before registry or live sandbox mutation (#7194)", async () => {
      const harness = createRebuildFlowHarness({
        agentPolicyAdditionsContent: `
version: 1
network_policies:
  unsafe_entry:
    name: unsafe_entry
    endpoints:
      - host: api.example.test
        port: 443
        access: full
`,
        preflightWithProductionBaselineResolver: true,
        sandboxEntry: {
          agent: "hermes",
          baselineExclusions: [
            {
              version: 1,
              agent: "hermes",
              key: "nous_research",
              digest: "baseline-digest",
              acknowledgedAt: "2026-07-19T00:00:00.000Z",
            },
          ],
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
      ).rejects.toThrow("Replacement onboarding preflight failed");

      expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
        "does not satisfy the shipped sandbox policy schema",
      );
      expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.prepareMcpBridgesForRebuildSpy).not.toHaveBeenCalled();
      expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(
        harness.runOpenshellSpy.mock.calls.some(
          ([args]) => Array.isArray(args) && args.join(" ") === "sandbox delete alpha",
        ),
      ).toBe(false);
    });

    it("keeps baseline-exclusion retry metadata when inner replacement creation fails (#7194)", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          baselineExclusions: [
            {
              version: 1,
              agent: "openclaw",
              key: "openclaw_docs",
              digest: "baseline-digest",
              acknowledgedAt: "2026-07-19T00:00:00.000Z",
              appliedAgentVersion: "2026.6.10",
            },
          ],
        },
        onboard: () => {
          throw new Error("injected replacement create failure");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
      ).rejects.toThrow("Recreate failed");

      expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
      expect(harness.restoreSandboxEntrySpy).not.toHaveBeenCalled();
      expect(harness.restoreSandboxEntryIfMissingSpy).not.toHaveBeenCalled();
      expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
        "Preserving baseline-exclusion registry entry across sandbox recreation",
      );
    });

    it("waits for post-delete sandbox absence before inner onboarding (#7194)", async () => {
      const events: string[] = [];
      let sandboxGetAttempts = 0;
      const probeSequence = [
        {
          event: "stale-live",
          result: { status: 0, output: "Sandbox: alpha\nPhase: Ready" },
        },
        {
          event: "absent",
          result: { status: 1, output: "", stderr: "Error: sandbox alpha not found" },
        },
      ];
      const harness = createRebuildFlowHarness({
        captureOpenshell: () => {
          const probe = probeSequence[Math.min(sandboxGetAttempts, probeSequence.length - 1)];
          sandboxGetAttempts += 1;
          events.push(probe.event);
          return probe.result;
        },
        onboard: () => {
          events.push("onboard");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(events).toEqual(["stale-live", "absent", "onboard"]);
      expect(
        harness.captureOpenshellSpy.mock.calls.filter(
          ([args]) => Array.isArray(args) && args.join(" ") === "sandbox get -g nemoclaw alpha",
        ),
      ).toHaveLength(2);
    });

    it("accepts the agent version cached by the confirmation probe before lock acquisition", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { agentVersion: null },
        entryUpdatesAfterVersionCheck: { agentVersion: "0.2.0" },
        versionCheck: {
          sandboxVersion: "0.2.0",
          expectedVersion: "0.2.0",
          isStale: false,
          verificationFailed: false,
          detectionMethod: "ssh-exec",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], {
          throwOnError: true,
          recoveryManifest: makePreparedRecoveryManifest(),
        }),
      ).resolves.toBeUndefined();

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).toHaveBeenCalledOnce();
    });

    it("rejects an agent version cache value that differs from the probe result", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { agentVersion: null },
        entryUpdatesAfterVersionCheck: { agentVersion: "unexpected-version" },
        versionCheck: {
          sandboxVersion: "0.2.0",
          expectedVersion: "0.2.0",
          isStale: false,
          verificationFailed: false,
          detectionMethod: "ssh-exec",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Sandbox configuration changed before rebuild lock acquisition");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("rejects real registry drift alongside the confirmation probe cache write", async () => {
      const harness = createRebuildFlowHarness({
        sandboxEntry: { agentVersion: null },
        entryUpdatesAfterVersionCheck: {
          agentVersion: "0.2.0",
          model: "changed-during-confirmation",
        },
        versionCheck: {
          sandboxVersion: "0.2.0",
          expectedVersion: "0.2.0",
          isStale: false,
          verificationFailed: false,
          detectionMethod: "ssh-exec",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Sandbox configuration changed before rebuild lock acquisition");

      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("changes tool disclosure through the MCP-preserving rebuild transaction", async () => {
      const mcpEntry = {
        server: "github",
        providerName: "nemoclaw-mcp-alpha-github",
      };
      const harness = createRebuildFlowHarness({
        sandboxEntry: {
          toolDisclosure: "progressive",
          mcp: { bridges: { github: mcpEntry } },
        },
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
          scrubbedAdapterEntries: [mcpEntry],
        },
      });

      await expect(
        harness.rebuildSandbox(
          "alpha",
          { yes: true, toolDisclosure: "direct" },
          { throwOnError: true },
        ),
      ).resolves.toBeUndefined();

      expect(harness.onboardSpy).toHaveBeenCalledWith(
        expect.objectContaining({ toolDisclosure: "direct" }),
      );
      expect(harness.session.toolDisclosure).toBe("direct");
      expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
      for (const [, update] of harness.registryUpdateSpy.mock.calls) {
        expect(update).not.toHaveProperty("toolDisclosure");
      }
    });

    it("relocks as absent when registry cleanup throws after confirmed delete", async () => {
      const harness = createRebuildFlowHarness({
        removeSandboxRegistryEntryWithReceipt: () => {
          throw new Error("registry cleanup after delete failed");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("registry cleanup after delete failed");

      expect(harness.onboardSpy).not.toHaveBeenCalled();
      expect(harness.relockSpy).toHaveBeenLastCalledWith(
        "alpha",
        expect.any(Object),
        false,
        "nemoclaw",
      );
    });

    it("relocks as present when shields postwork throws after successful onboard", async () => {
      const harness = createRebuildFlowHarness({
        staleRecovery: true,
        clearShieldsState: () => {
          throw new Error("post-onboard shields cleanup failed");
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("post-onboard shields cleanup failed");

      expect(harness.onboardSpy).toHaveBeenCalledOnce();
      expect(harness.relockSpy).toHaveBeenLastCalledWith(
        "alpha",
        expect.any(Object),
        true,
        "nemoclaw",
      );
    });

    it("uses the no-exec MCP preparation path when recovering an absent sandbox", async () => {
      const overrideEnvVar = "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF";
      const restoreEnv = snapshotEnv([overrideEnvVar]);
      const disposeImageRef = vi.fn(() => true);
      process.env[overrideEnvVar] = "nemoclaw-hermes-sandbox-base-local:image-caller";
      const mcpEntry = {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      };
      try {
        const harness = createRebuildFlowHarness({
          staleRecovery: true,
          sandboxEntry: { mcp: { bridges: { github: mcpEntry } } },
          baseImagePreflight: {
            ok: true,
            imageRef: "nemoclaw-hermes-sandbox-base-local:image-preflighted",
            overrideEnvVar,
            disposeImageRef,
          },
          mcpPreparation: {
            entries: [mcpEntry],
            detachedProviderEntries: [],
            scrubbedAdapterEntries: [],
          },
          onboard: () => {
            expect(process.env[overrideEnvVar]).toBe(
              "nemoclaw-hermes-sandbox-base-local:image-preflighted",
            );
          },
        });

        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).resolves.toBeUndefined();

        expect(process.env[overrideEnvVar]).toBe("nemoclaw-hermes-sandbox-base-local:image-caller");
        expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
        expect(harness.prepareMcpBridgesForAbsentSandboxRebuildSpy).toHaveBeenCalledWith("alpha");
        expect(harness.prepareMcpBridgesForRebuildSpy).not.toHaveBeenCalled();
        expect(harness.warnUnpreservedUserManagedFilesSpy).not.toHaveBeenCalled();
        expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).not.toHaveBeenCalled();
        expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
        expect(disposeImageRef).toHaveBeenCalledOnce();
      } finally {
        restoreEnv();
      }
    });

    it("disposes the base-image handoff when live-state preflight fails (#7144)", async () => {
      const disposeImageRef = vi.fn(() => true);
      const harness = createRebuildFlowHarness({
        sandboxListOutput: "",
        reconciledSandboxGatewayState: { state: "unknown", output: "indeterminate" },
        baseImagePreflight: {
          ok: true,
          imageRef: `nemoclaw-hermes-sandbox-base-local:rebuild-123-${"a".repeat(16)}-image-${"b".repeat(64)}`,
          overrideEnvVar: "NEMOCLAW_HERMES_SANDBOX_BASE_IMAGE_REF",
          disposeImageRef,
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).rejects.toThrow("Could not confirm live state");

      expect(disposeImageRef).toHaveBeenCalledOnce();
      expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
      expect(harness.onboardSpy).not.toHaveBeenCalled();
    });

    it("pins compatible-endpoint reasoning for an MCP-bearing rebuild", async () => {
      const restoreEnv = snapshotEnv(["COMPATIBLE_API_KEY", "NEMOCLAW_REASONING"]);
      process.env.COMPATIBLE_API_KEY = "compat-key";
      process.env.NEMOCLAW_REASONING = "false";
      const mcpEntry = {
        server: "github",
        agent: "openclaw",
        adapter: "mcporter",
        url: "https://mcp.example.test/mcp",
        env: ["GITHUB_TOKEN"],
        providerName: "alpha-mcp-github",
        policyName: "mcp-bridge-github",
        addedAt: "2026-06-01T00:00:00.000Z",
      };
      let reasoningSeenInsideOnboard: string | undefined;
      try {
        const harness = createRebuildFlowHarness({
          applyPreset: () => true,
          sandboxEntry: {
            provider: "compatible-endpoint",
            model: "reasoning-model",
            endpointUrl: "https://compatible.example.test/v1",
            compatibleEndpointReasoning: "true",
            mcp: { bridges: { github: mcpEntry } },
          },
          sessionSandboxName: "other",
          mcpPreparation: {
            entries: [mcpEntry],
            detachedProviderEntries: [mcpEntry],
          },
          onboard: (session) => {
            reasoningSeenInsideOnboard = process.env.NEMOCLAW_REASONING;
            expect(session.compatibleEndpointReasoning).toBe("true");
          },
        });
        harness.session.compatibleEndpointReasoning = "false";

        await expect(
          harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
        ).resolves.toBeUndefined();

        expect(reasoningSeenInsideOnboard).toBeUndefined();
        expect(harness.session.compatibleEndpointReasoning).toBe("true");
        expect(process.env.NEMOCLAW_REASONING).toBe("false");
        expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
      } finally {
        restoreEnv();
      }
    });

    it("restores enabled messaging presets while pruning disabled ones from final policies", async () => {
      const disabledSlackPlan = {
        schemaVersion: 1,
        sandboxName: "alpha",
        agent: "openclaw",
        workflow: "rebuild",
        channels: [
          { channelId: "telegram", disabled: false },
          { channelId: "discord", disabled: false },
          { channelId: "whatsapp", disabled: false },
          { channelId: "wechat", disabled: false },
          { channelId: "slack", disabled: true },
        ],
        disabledChannels: ["slack"],
        credentialBindings: [],
        networkPolicy: { presets: [], entries: [] },
        agentRender: [],
        buildSteps: [],
        stateUpdates: [],
        healthChecks: [],
      };
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        backupPolicyPresets: ["slack", "npm", "pypi", "telegram"],
        buildMessagingRebuildPlan: () => disabledSlackPlan,
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.applyPresetSpy.mock.calls.map((call) => call[1])).toEqual([
        "npm",
        "pypi",
        "telegram",
        "discord",
        "whatsapp",
        "wechat",
      ]);
      expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
        agentVersion: "0.2.0",
        policies: ["npm", "pypi", "telegram", "discord", "whatsapp", "wechat"],
        policyTier: null,
        policyPresetsFinalized: undefined,
      });
    });

    it("preserves a finalized empty policy selection and its tier", async () => {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        backupPolicyPresets: [],
        sandboxEntry: {
          policies: [],
          policyPresetsFinalized: true,
          policyTier: "restricted",
        },
      });

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(harness.session.policyPresets).toEqual([]);
      expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
        agentVersion: "0.2.0",
        policies: [],
        policyTier: "restricted",
        policyPresetsFinalized: true,
      });
    });
  });
}
