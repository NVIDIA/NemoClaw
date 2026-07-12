// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  configureDcodeSession,
  makeDcodeSandboxEntry,
} from "../../../../test/helpers/rebuild-dcode-flow-support";
import {
  createRebuildFlowHarness,
  makePreparedRecoveryManifest,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";

describe("rebuildSandbox DCode flow: recovery", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it("recreates non-Ready DCode from a validated backup without requiring a live route (#6195)", async () => {
    const recoveryManifest = {
      ...makePreparedRecoveryManifest(),
      agentType: "langchain-deepagents-code",
      agentVersion: "0.1.12",
      dir: "/sandbox/.deepagents",
    };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: makeDcodeSandboxEntry(),
      sandboxListOutput: "alpha Error",
      preDeleteLatestManifest: recoveryManifest,
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], {
        throwOnError: true,
        recoveryManifest,
      }),
    ).resolves.toBeUndefined();

    expect(harness.preflightDcodeRouteSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).toHaveBeenCalledOnce();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.runOpenshellSpy).toHaveBeenCalledWith(
      ["sandbox", "delete", "alpha"],
      expect.objectContaining({ ignoreError: true }),
    );
    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.restoreSandboxStateSpy).toHaveBeenCalledWith(
      "alpha",
      recoveryManifest.backupPath,
      { targetAgentType: "langchain-deepagents-code" },
    );
  });
  it("replays captured custom policies during stale DCode recovery without a backup (#6195)", async () => {
    const customPolicy = {
      name: "custom-egress",
      content: "network_policies:\n  custom-egress: {}\n",
      sourcePath: "/tmp/custom-egress.yaml",
    };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        customPolicies: [customPolicy],
        policyPresetsFinalized: true,
      },
      sandboxListOutput: "",
      reconciledSandboxGatewayState: { state: "missing", output: "" },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.applyPresetSpy).not.toHaveBeenCalled();
    expect(harness.applyPresetContentSpy).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ policies: [], policyPresetsFinalized: true }),
    );
  });

  it("removes transient observability egress after rebuilding a restricted DCode sandbox", async () => {
    let policyTierSeenDuringOnboard: string | undefined;
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      applyPreset: () => true,
      backupPolicyPresets: ["npm", "observability-otlp-local"],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets: ["observability-otlp-local"],
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        observabilityEnabled: true,
        policies: ["npm", "observability-otlp-local"],
        policyPresetsFinalized: true,
        policyTier: " Restricted ",
      },
      onboard: () => {
        policyTierSeenDuringOnboard = process.env.NEMOCLAW_POLICY_TIER;
      },
    });
    configureDcodeSession(harness);
    harness.session.observabilityEnabled = true;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(policyTierSeenDuringOnboard).toBe("restricted");
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({ observabilityRequestedExplicitly: false }),
    );
    expect(harness.session.observabilityRequestedExplicitly).toBe(false);
    expect(harness.applyPresetSpy).not.toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith("alpha", {
      agentVersion: "0.2.0",
      policies: ["npm"],
      policyTier: "restricted",
      policyPresetsFinalized: true,
    });
  });

  it("restores the required observability preset on a balanced DCode rebuild", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      applyPreset: () => true,
      backupPolicyPresets: ["npm"],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets: [],
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        observabilityEnabled: true,
        policies: ["npm"],
        policyPresetsFinalized: true,
        policyTier: "balanced",
      },
    });
    configureDcodeSession(harness);
    harness.session.observabilityEnabled = true;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.applyPresetSpy).toHaveBeenCalledWith("alpha", "observability-otlp-local");
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        policies: ["npm", "observability-otlp-local"],
        policyTier: "balanced",
        policyPresetsFinalized: true,
      }),
    );
  });

  it.each([
    {
      label: "enables",
      flag: "--observability",
      before: false,
      expected: true,
      expectedObservabilityApplyCalls: [["alpha", "observability-otlp-local"]] as const,
      backupPresets: [] as string[],
      gatewayPresets: [] as string[],
    },
    {
      label: "disables",
      flag: "--no-observability",
      before: true,
      expected: false,
      expectedObservabilityApplyCalls: [] as const,
      backupPresets: ["observability-otlp-local"],
      gatewayPresets: ["observability-otlp-local"],
    },
  ])("$label observability transactionally while preserving managed MCP state", async ({
    flag,
    before,
    expected,
    expectedObservabilityApplyCalls,
    backupPresets,
    gatewayPresets,
  }) => {
    const mcpEntry = { server: "search", providerName: "mcp-search" };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      applyPreset: () => true,
      backupPolicyPresets: backupPresets,
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets,
      mcpPreparation: {
        entries: [mcpEntry],
        detachedProviderEntries: [mcpEntry],
        scrubbedAdapterEntries: [],
      },
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        observabilityEnabled: before,
        policies: backupPresets,
        policyPresetsFinalized: true,
        policyTier: "balanced",
        mcp: {
          bridges: { search: mcpEntry },
          managedServerNames: ["search"],
        },
      },
    });
    configureDcodeSession(harness);
    harness.session.observabilityEnabled = before;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", flag], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        observabilityEnabled: expected,
        observabilityRequestedExplicitly: true,
      }),
    );
    expect(harness.session.observabilityEnabled).toBe(expected);
    expect(harness.session.observabilityRequestedExplicitly).toBe(true);
    const observabilityApplyCalls = harness.applyPresetSpy.mock.calls.filter(
      ([sandboxName, presetName]) =>
        sandboxName === "alpha" && presetName === "observability-otlp-local",
    );
    expect(observabilityApplyCalls).toEqual(expectedObservabilityApplyCalls);
    expect(harness.restoreMcpBridgesAfterRebuildSpy).toHaveBeenCalledWith("alpha", [mcpEntry]);
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        policies: expected ? ["observability-otlp-local"] : [],
        policyTier: "balanced",
        policyPresetsFinalized: true,
      }),
    );
  });

  it("preserves a fresh agent-required preset introduced by inner onboard", async () => {
    const freshRequiredPreset = "future-dcode-required";
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      applyPreset: () => true,
      backupPolicyPresets: ["npm"],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets: [freshRequiredPreset],
      onboard: (session) => {
        session.policyPresets = ["npm", freshRequiredPreset];
      },
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        policies: ["npm"],
        policyPresetsFinalized: true,
        policyTier: "balanced",
      },
    });
    configureDcodeSession(harness);

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        policies: ["npm", freshRequiredPreset],
        policyPresetsFinalized: true,
      }),
    );
  });

  it("never removes or persists DCode base-policy keys detected as broad presets", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      backupPolicyPresets: [],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets: ["github", "pypi"],
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        observabilityEnabled: false,
        policies: [],
        policyPresetsFinalized: true,
        policyTier: "balanced",
      },
    });
    configureDcodeSession(harness);
    harness.session.observabilityEnabled = false;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.removePresetSpy).not.toHaveBeenCalled();
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ policies: [], policyPresetsFinalized: true }),
    );
  });

  it("does not narrow a differently named custom policy owning observability egress", async () => {
    const customPolicy = {
      name: "corp-otel",
      content:
        "network_policies:\n  observability-otlp-local:\n    endpoints:\n      - host: collector.corp.example\n",
      sourcePath: "/tmp/corp-otel.yaml",
    };
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      backupPolicyPresets: [],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets: ["observability-otlp-local"],
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        customPolicies: [customPolicy],
        observabilityEnabled: false,
        policies: [],
        policyPresetsFinalized: true,
        policyTier: "balanced",
      },
    });
    configureDcodeSession(harness);
    harness.session.observabilityEnabled = false;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).resolves.toBeUndefined();

    expect(harness.applyPresetContentSpy).toHaveBeenCalledWith(
      "alpha",
      customPolicy.name,
      customPolicy.content,
      { custom: { sourcePath: customPolicy.sourcePath } },
    );
    expect(harness.removePresetSpy).not.toHaveBeenCalled();
    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ policies: [], policyPresetsFinalized: true }),
    );
  });

  it("fails after recording recovery state when restricted egress removal cannot be verified", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "langchain-deepagents-code",
      applyPreset: () => true,
      backupPolicyPresets: ["npm", "observability-otlp-local"],
      dcodeRouteResults: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }],
      gatewayPresets: ["observability-otlp-local"],
      verificationUnavailableAfterPresetRemoval: true,
      sandboxEntry: {
        ...makeDcodeSandboxEntry(),
        observabilityEnabled: true,
        policies: ["npm", "observability-otlp-local"],
        policyPresetsFinalized: true,
        policyTier: "restricted",
      },
    });
    configureDcodeSession(harness);
    harness.session.observabilityEnabled = true;

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Rebuild completed with unverified live policy reconciliation for 'alpha'.");

    expect(harness.registryUpdateSpy).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        policies: ["npm", "observability-otlp-local"],
        policyTier: "restricted",
        policyPresetsFinalized: undefined,
      }),
    );
    expect(harness.relockSpy).toHaveBeenCalled();
  });

  it("rejects an observability override for a non-DCode sandbox before mutation", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "openclaw",
      sandboxEntry: {
        name: "alpha",
        agent: "openclaw",
        nemoclawVersion: "0.1.0",
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes", "--observability"], { throwOnError: true }),
    ).rejects.toThrow("Unsupported rebuild observability override");

    expect(harness.openShieldsSpy).not.toHaveBeenCalled();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });
});
