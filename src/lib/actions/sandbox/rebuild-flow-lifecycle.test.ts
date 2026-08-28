// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { expectNoSandboxDelete } from "../../../../test/helpers/rebuild-delete-assertions";
import * as policies from "../../policy";
import { digestBaselineEntry, getBaselineEntry } from "../../policy/baseline-exclusion";
import {
  createRebuildFlowHarness,
  installRebuildFlowTestHooks,
  originalSandboxName,
  portableAgentLifecycle,
  snapshotEnv,
} from "../../../../test/helpers/rebuild-flow-generic-harness";
import { makePreparedRecoveryManifest } from "./rebuild-flow-test-fixtures";

const OPENCLAW_BASELINE = policies.resolveAgentBaselinePolicy("openclaw")!;
const OPENCLAW_DOCS_DIGEST = digestBaselineEntry(
  getBaselineEntry(OPENCLAW_BASELINE.content, "openclaw_docs")!,
);

describe("rebuildSandbox flow: lifecycle", () => {
  installRebuildFlowTestHooks();

  it("rejects schema-5 before rebuild effects and rechecks under the lifecycle lock (#9203)", async () => {
    const guard = vi
      .spyOn(portableAgentLifecycle, "assertHermesPortableCommandUnavailable")
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("schema-5 appeared");
      });
    const harness = createRebuildFlowHarness();

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("schema-5 appeared");

    expect(guard).toHaveBeenNthCalledWith(1, "alpha", "sandbox:rebuild");
    expect(guard).toHaveBeenNthCalledWith(2, "alpha", "sandbox:rebuild");
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

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

  it("stops before rebuild effects when external policy requirements are missing (#9833)", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: { policyAuthority: "externally-managed" },
      policyAuthorityInspection: {
        authority: "externally-managed",
        effectivePolicy: { network_policies: {} },
        policyIdentity: { hash: "external-policy", activeVersion: 1 },
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Policy authority preflight failed");

    expect(harness.ensureTargetGatewaySpy).not.toHaveBeenCalled();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("rebuilds a live Shields-up external-policy sandbox without policy mutation (#9833)", async () => {
    const harness = createRebuildFlowHarness({
      applyPreset: () => {
        throw new Error("external rebuild attempted policy replay");
      },
      backupPolicyPresets: [],
      sandboxEntry: {
        policies: [],
        policyAuthority: "externally-managed",
      },
      policyAuthorityInspection: {
        authority: "externally-managed",
        effectivePolicy: YAML.parse(OPENCLAW_BASELINE.content) as Record<string, unknown>,
        policyIdentity: { hash: "external-policy", activeVersion: 1 },
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.openRebuildShieldsWindowSpy).toHaveBeenCalledWith(
      "alpha",
      "nemoclaw",
      "externally-managed",
    );
    expect(harness.relockSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        sourceDeleted: true,
      }),
      true,
      "nemoclaw",
    );
    expect(harness.applyPresetSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "-g", "nemoclaw", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
  });

  it("stops before replacement restore when authority flips after recreate (#9833)", async () => {
    let authorityFlipped = false;
    const managedInspection = {
      authority: "owner-unknown" as const,
      effectivePolicy: {},
      policyIdentity: { hash: "policy-alpha", activeVersion: 7 },
    };
    const harness = createRebuildFlowHarness({
      onboard: () => {
        authorityFlipped = true;
      },
    });
    const inspectChangedAuthority = () =>
      authorityFlipped
        ? {
            authority: "externally-managed" as const,
            effectivePolicy: {},
            policyIdentity: { hash: "external-policy", activeVersion: 2 },
          }
        : managedInspection;
    harness.inspectSandboxPolicyAuthoritySpy.mockImplementation(inspectChangedAuthority);
    harness.inspectGlobalPolicyAuthoritySpy.mockImplementation(() =>
      authorityFlipped
        ? { state: "active", inspection: inspectChangedAuthority() }
        : { state: "absent" },
    );

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("policy authority changed");

    expect(harness.restoreSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.applyPresetSpy).not.toHaveBeenCalled();
    expect(harness.executeSandboxCommandSpy).not.toHaveBeenCalled();
    expect(harness.restoreMcpBridgesAfterRebuildSpy).not.toHaveBeenCalled();
    expect(harness.registryUpdateSpy).not.toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ agentVersion: "0.2.0" }),
    );
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
      backupPolicyPresets: ["npm", "bad", "throw", "mcp-bridge-github"],
      sandboxEntry: {
        mcp: { bridges: { github: mcpEntry } },
        policies: ["npm", "mcp-bridge-github"],
        policyPresetsFinalized: true,
        policyTier: "balanced",
      },
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
    expect(harness.backupSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ captureStateFile: expect.any(Function) }),
    );
    expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith(
      "alpha",
      expect.any(Function),
    );
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
        rebuildPolicyPresets: ["npm", "bad", "throw"],
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
      (call) => Array.isArray(call[0]) && call[0].join(" ") === "sandbox delete -g nemoclaw alpha",
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
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith(
      "alpha",
      [mcpEntry],
      expect.any(Function),
    );
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Preserving journaled source registry entry across sandbox recreation",
    );
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "npm");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "bad");
    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "throw");
    expect(harness.applyPresetSpy).not.toHaveBeenCalledWith("alpha", "mcp-bridge-github");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm", "bad", "throw"],
      policyTier: "balanced",
      policyPresetsFinalized: true,
    });
    expect(harness.executeSandboxExecCommandSpy).toHaveBeenCalledWith(
      "alpha",
      "openclaw doctor --fix",
      300_000,
      { allowLocalDockerFallback: false },
    );
    expect(harness.relockSpy).toHaveBeenCalledWith("alpha", expect.any(Object), true, "nemoclaw");
    expect(process.env.NEMOCLAW_SANDBOX_NAME).toBe(originalSandboxName);
    expect(harness.logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "rebuilt successfully",
    );
  });

  it("keeps the original sandbox when the shared route drifts at the delete edge (#7798)", async () => {
    const harness = createRebuildFlowHarness({
      revalidateRebuildRouteBeforeDelete: () => ({
        ok: false,
        message: "Shared inference route changed before sandbox deletion.",
      }),
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Shared inference route changed before sandbox deletion.");

    expect(harness.backupSandboxStateSpy).toHaveBeenCalledOnce();
    expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledOnce();
    expect(harness.reattachMcpProvidersAfterRebuildAbortSpy).toHaveBeenCalledOnce();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("keeps baseline exclusions durable through successful replacement onboarding (#7194)", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        baselineExclusions: [
          {
            version: 1,
            agent: "openclaw",
            key: "openclaw_docs",
            digest: OPENCLAW_DOCS_DIGEST,
            acknowledgedAt: "2026-07-19T00:00:00.000Z",
            appliedAgentVersion: "2026.6.10",
          },
        ],
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.prepareMcpBridgesForRebuildSpy).toHaveBeenCalledWith(
      "alpha",
      expect.any(Function),
    );
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.errorSpy.mock.calls.map((call) => String(call[0])).join("\n")).toContain(
      "Preserving journaled source registry entry across sandbox recreation",
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
    ).rejects.toThrow("Policy authority preflight failed");

    expect(harness.errorSpy.mock.calls.flat().join("\n")).toContain(
      "invalid versioned baseline exclusion",
    );
    expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.prepareMcpBridgesForRebuildSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
    expectNoSandboxDelete(harness.runOpenshellSpy);
  });

  it("keeps baseline-exclusion retry metadata when inner replacement creation fails (#7194)", async () => {
    const harness = createRebuildFlowHarness({
      sandboxEntry: {
        baselineExclusions: [
          {
            version: 1,
            agent: "openclaw",
            key: "openclaw_docs",
            digest: OPENCLAW_DOCS_DIGEST,
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
      "Preserving journaled source registry entry across sandbox recreation",
    );
  });

  it("waits for post-delete sandbox absence before inner onboarding (#7194)", async () => {
    const events: string[] = [];
    let sourceDeleted = false;
    let replacementCreated = false;
    const harness = createRebuildFlowHarness({
      captureOpenshell: () => {
        const sandboxIsLive = !sourceDeleted || replacementCreated;
        events.push(
          sandboxIsLive
            ? replacementCreated
              ? "replacement-live"
              : "source-live"
            : "source-missing",
        );
        return sandboxIsLive
          ? {
              status: 0,
              output: "Sandbox: alpha\nId: sbx-0d6f4c2a91\nPhase: Ready",
              stdout: "Sandbox: alpha\nId: sbx-0d6f4c2a91\nPhase: Ready",
              stderr: "",
            }
          : {
              status: 1,
              output: "",
              stdout: "",
              stderr: "Error: sandbox alpha not found",
            };
      },
      runOpenshell: (argv) => {
        const deletesSource = argv.join(" ") === "sandbox delete -g nemoclaw alpha";
        sourceDeleted ||= deletesSource;
        return deletesSource ? { status: 0, output: "" } : undefined;
      },
      onboard: () => {
        events.push("onboard");
        replacementCreated = true;
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--verbose"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    const stateTransitions = events.filter(
      (event, index) => index === 0 || event !== events[index - 1],
    );
    expect(stateTransitions).toEqual(["source-live", "source-missing", "onboard"]);
    expect(events.indexOf("source-missing")).toBeLessThan(events.indexOf("onboard"));
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
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith(
      "alpha",
      [mcpEntry],
      expect.any(Function),
    );
    harness.registryUpdateSpy.mock.calls.forEach(([, update]) => {
      expect(update).not.toHaveProperty("toolDisclosure");
    });
  });

  it("relocks as absent and keeps the journaled row when replacement creation fails (#7734)", async () => {
    const harness = createRebuildFlowHarness({
      onboard: () => {
        throw new Error("recreate failed");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.removeSandboxRegistryEntryWithReceiptSpy).not.toHaveBeenCalled();
    expect(harness.relockSpy).toHaveBeenLastCalledWith(
      "alpha",
      expect.any(Object),
      false,
      "nemoclaw",
    );
  });

  it("relocks the recreated sandbox when recovery artifact cleanup fails (#9833)", async () => {
    const recoveryArtifactPath = "/tmp/shields-external-policy-alpha.yaml";
    const harness = createRebuildFlowHarness({
      staleRecovery: true,
      sandboxEntry: { policyAuthority: "nemoclaw-managed" },
      clearShieldsState: () => {
        throw new Error(
          `Could not remove external Shields policy recovery artifact '${recoveryArtifactPath}': permission denied`,
        );
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow(
      `Could not remove external Shields policy recovery artifact '${recoveryArtifactPath}': permission denied`,
    );

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
        sandboxEntry: {
          mcp: { bridges: { github: mcpEntry } },
          policyAuthority: "nemoclaw-managed",
        },
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
      expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith(
        "alpha",
        [mcpEntry],
        expect.any(Function),
      );
      expect(disposeImageRef).toHaveBeenCalledOnce();
    } finally {
      restoreEnv();
    }
  });

  it("disposes the base-image handoff when live-state preflight fails (#7144)", async () => {
    const disposeImageRef = vi.fn(() => true);
    const harness = createRebuildFlowHarness({
      sandboxInventory: { sandboxes: [] },
      reconciledSandboxGatewayState: { state: "unknown", output: "indeterminate" },
      sandboxEntry: { policyAuthority: "nemoclaw-managed" },
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
    const restoreEnv = snapshotEnv([
      "COMPATIBLE_API_KEY",
      "NEMOCLAW_REASONING",
      "NEMOCLAW_REASONING_EFFORT",
    ]);
    process.env.COMPATIBLE_API_KEY = "compat-key";
    process.env.NEMOCLAW_REASONING = "false";
    process.env.NEMOCLAW_REASONING_EFFORT = "low";
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
    let effortSeenInsideOnboard: string | undefined;
    try {
      const harness = createRebuildFlowHarness({
        applyPreset: () => true,
        sandboxEntry: {
          provider: "compatible-endpoint",
          model: "reasoning-model",
          endpointUrl: "https://compatible.example.test/v1",
          compatibleEndpointReasoning: "true",
          compatibleEndpointReasoningEffort: "high",
          mcp: { bridges: { github: mcpEntry } },
        },
        sessionSandboxName: "other",
        mcpPreparation: {
          entries: [mcpEntry],
          detachedProviderEntries: [mcpEntry],
        },
        onboard: (session) => {
          // The recreate reapplies the recorded configuration, never the
          // ambient one an unrelated onboard left behind (#5735, #7940).
          reasoningSeenInsideOnboard = process.env.NEMOCLAW_REASONING;
          effortSeenInsideOnboard = process.env.NEMOCLAW_REASONING_EFFORT;
          expect(session.compatibleEndpointReasoning).toBe("true");
          expect(session.compatibleEndpointReasoningEffort).toBe("high");
        },
      });
      harness.session.compatibleEndpointReasoning = "false";

      await expect(
        harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
      ).resolves.toBeUndefined();

      expect(reasoningSeenInsideOnboard).toBe("true");
      expect(effortSeenInsideOnboard).toBe("high");
      expect(harness.session.compatibleEndpointReasoning).toBe("true");
      expect(harness.session.compatibleEndpointReasoningEffort).toBe("high");
      expect(process.env.NEMOCLAW_REASONING).toBe("false");
      expect(process.env.NEMOCLAW_REASONING_EFFORT).toBe("low");
      expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith(
        "alpha",
        [mcpEntry],
        expect.any(Function),
      );
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
