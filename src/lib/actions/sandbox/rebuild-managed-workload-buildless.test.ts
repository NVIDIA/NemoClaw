// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { managedStartupE2eProfile } from "../../../../scripts/checks/generate-managed-startup-profile-fixture.mts";
import {
  createRebuildFlowHarness,
  resetRebuildFlowTestEnvironment,
  restoreRebuildFlowTestEnvironment,
} from "../../../../test/helpers/rebuild-flow-harness";
import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_PLATFORMS,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  type ManagedImageContractV1,
  type ShippedManagedImageAgent,
} from "../../onboard/managed-image/contract";
import { encodeManagedStartupProfile } from "../../onboard/managed-startup/profile";
import {
  resolveManagedRebuildOpenClawReasoning,
  resolveManagedRebuildOpenClawReasoningEffort,
} from "./agents/managed-workload-rebuild-profile";

const OLD_RELEASE = "v0.0.97";
const NEW_RELEASE = "v0.0.98";
const MANAGED_IMAGE_PLATFORM = MANAGED_IMAGE_PLATFORMS[0];

function managedContract(
  agent: ShippedManagedImageAgent,
  generation: "old" | "new",
): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest: `sha256:${string}` = `sha256:${(generation === "old" ? "a" : "b").repeat(64)}`;
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: MANAGED_IMAGE_PLATFORM,
    image,
    digest,
    reference: `${image}@${digest}` as ManagedImageContractV1["reference"],
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: (generation === "old" ? "1" : "2").repeat(40),
      release: generation === "old" ? OLD_RELEASE : NEW_RELEASE,
      cohort: generation === "old" ? "ghrun-100-1" : "ghrun-200-2",
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function managedSandboxEntry(agent: ShippedManagedImageAgent): Record<string, unknown> {
  const old = managedContract(agent, "old");
  const baseProfile = managedStartupE2eProfile(agent);
  const profile =
    baseProfile.agent === "openclaw"
      ? {
          ...baseProfile,
          inference: {
            ...baseProfile.inference,
            upstreamProvider: "compatible-endpoint",
          },
          tuning: {
            ...baseProfile.tuning,
            reasoning: true,
          },
        }
      : baseProfile;
  const encodedProfile = encodeManagedStartupProfile(profile);
  return {
    agent: agent === "openclaw" ? null : agent,
    provider: "ollama-local",
    model: "nvidia/nemotron",
    fromDockerfile: null,
    imageTag: old.reference,
    dashboardPort: agent === "langchain-deepagents-code" ? 0 : 18_789,
    gatewayName: "nemoclaw",
    gatewayPort: 8_080,
    toolDisclosure: "progressive",
    dcodeAutoApprovalMode: "disabled",
    observabilityEnabled: false,
    workload: {
      schemaVersion: 1,
      kind: "managed-image",
      reference: old.reference,
      release: old.source.release,
      sourceRevision: old.source.revision,
      sourceCohort: old.source.cohort,
      capabilityContractVersion: old.capabilityContractVersion,
      startupProfileContractVersion: old.startupProfileContractVersion,
      encodedProfile,
      startupProfileSha256: createHash("sha256").update(encodedProfile, "utf8").digest("hex"),
      credentialProxyReplayRequired: false,
      shared: true,
    },
  };
}

function replacement(agent: ShippedManagedImageAgent): Record<string, unknown> {
  const contract = managedContract(agent, "new");
  return {
    source: {
      kind: "managed-image",
      reference: contract.reference,
      contract,
    },
    release: NEW_RELEASE,
    fallbackDiagnostic: null,
  };
}

describe("managed workload rebuild buildless boundary", () => {
  beforeEach(resetRebuildFlowTestEnvironment);
  afterEach(restoreRebuildFlowTestEnvironment);

  it.each([
    "openclaw",
    "hermes",
    "langchain-deepagents-code",
  ] as const)("upgrades %s through one staged catalog/profile handoff without any build path", async (agent) => {
    const oldEntry = managedSandboxEntry(agent);
    const replacementWorkload = replacement(agent);
    const harness = createRebuildFlowHarness({
      agentName: agent,
      sandboxEntry: oldEntry,
      managedWorkloadReplacement: replacementWorkload,
      ...(agent === "openclaw" ? { managedContextWindow: 65_536 } : {}),
    });
    harness.ensureAgentBaseImageSpy.mockImplementation(() => {
      throw new Error("managed rebuild touched agent base-image preparation");
    });
    harness.preflightRebuildImageSpy.mockImplementation(() => {
      throw new Error("managed rebuild touched generic image preflight");
    });
    harness.prepareManagedDcodeRebuildImageSpy.mockImplementation(() => {
      throw new Error("managed rebuild touched DCode image preparation");
    });
    harness.dockerBuildSpy.mockImplementation(() => {
      throw new Error("managed rebuild touched docker build");
    });

    await expect(
      harness.rebuildSandbox(
        "alpha",
        [
          "--yes",
          "--tool-disclosure",
          "direct",
          ...(agent === "langchain-deepagents-code"
            ? ["--dcode-auto-approval", "thread-opt-in", "--observability"]
            : []),
        ],
        { throwOnError: true },
      ),
    ).resolves.toBeUndefined();

    expect(harness.prepareManagedWorkloadSourceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: agent,
        policy: "require-managed",
      }),
    );
    expect(harness.prepareManagedRebuildProfileHandoffSpy).toHaveBeenCalledOnce();
    expect(harness.ensureAgentBaseImageSpy).not.toHaveBeenCalled();
    expect(harness.preflightRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.prepareManagedDcodeRebuildImageSpy).not.toHaveBeenCalled();
    expect(harness.dockerBuildSpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: agent === "openclaw" ? null : agent,
        fromDockerfile: null,
        toolDisclosure: "direct",
        managedWorkloadRebuild: expect.objectContaining({
          previousReceipt: expect.objectContaining({
            reference: oldEntry.imageTag,
          }),
          replacement: expect.objectContaining({
            source: expect.objectContaining({
              reference: (replacementWorkload.source as Record<string, unknown>).reference,
            }),
          }),
          replacementProfile: expect.objectContaining({
            encodedProfile: expect.any(String),
            profile: expect.objectContaining({
              agent,
              inference: expect.objectContaining({
                model: "nvidia/nemotron",
              }),
              tools: expect.objectContaining({ disclosure: "direct" }),
              ...(agent === "openclaw"
                ? {
                    tuning: expect.objectContaining({
                      contextWindow: 65_536,
                      reasoning: false,
                    }),
                  }
                : {}),
            }),
          }),
        }),
        ...(agent === "langchain-deepagents-code"
          ? {
              dcodeAutoApprovalMode: "thread-opt-in",
              observabilityEnabled: true,
            }
          : {}),
      }),
    );

    const profileOrder = harness.prepareManagedRebuildProfileHandoffSpy.mock.invocationCallOrder[0];
    const registryOrder = harness.registryUpdateSpy.mock.invocationCallOrder[0];
    const shieldsOrder = harness.openShieldsSpy.mock.invocationCallOrder[0];
    const backupOrder = harness.backupSandboxStateSpy.mock.invocationCallOrder[0];
    const onboardOrder = harness.onboardSpy.mock.invocationCallOrder[0];
    expect(profileOrder).toBeLessThan(registryOrder);
    expect(registryOrder).toBeLessThan(shieldsOrder);
    expect(shieldsOrder).toBeLessThan(backupOrder);
    expect(backupOrder).toBeLessThan(onboardOrder);
  }, 20_000);

  it.each([
    ["compatible-endpoint", "false", false],
    ["compatible-endpoint", "true", true],
    ["nvidia-prod", "true", false],
  ] as const)("derives current OpenClaw reasoning for %s/%s instead of retaining receipt state", (provider, compatibleReasoning, expected) => {
    expect(resolveManagedRebuildOpenClawReasoning(provider, compatibleReasoning)).toBe(expected);
  });

  it.each([
    ["compatible-endpoint", "openai-completions", "high", "high"],
    ["compatible-endpoint", "openai-completions", null, "default"],
    ["compatible-endpoint", "openai-responses", "high", "default"],
    ["nvidia-prod", "openai-completions", "high", "default"],
  ] as const)("derives current OpenClaw reasoning effort for %s/%s/%s", (provider, inferenceApi, compatibleReasoningEffort, expected) => {
    expect(
      resolveManagedRebuildOpenClawReasoningEffort(
        provider,
        inferenceApi,
        compatibleReasoningEffort,
      ),
    ).toBe(expected);
  });

  it("fails profile rendering before registry update, shields, backup, or deletion", async () => {
    const harness = createRebuildFlowHarness({
      agentName: "openclaw",
      sandboxEntry: managedSandboxEntry("openclaw"),
      managedWorkloadReplacement: replacement("openclaw"),
      prepareManagedRebuildProfileHandoff: () => {
        throw new Error("poisoned fresh profile");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("poisoned fresh profile");

    expect(harness.prepareManagedRebuildProfileHandoffSpy).toHaveBeenCalledOnce();
    expect(harness.registryUpdateSpy).not.toHaveBeenCalled();
    expect(harness.openShieldsSpy).not.toHaveBeenCalled();
    expect(harness.backupSandboxStateSpy).not.toHaveBeenCalled();
    expect(harness.removeSandboxRegistryEntrySpy).not.toHaveBeenCalled();
    expect(harness.onboardSpy).not.toHaveBeenCalled();
  });

  it("restores the old immutable receipt when recreation fails after delete", async () => {
    const oldEntry = managedSandboxEntry("hermes");
    const harness = createRebuildFlowHarness({
      agentName: "hermes",
      sandboxEntry: oldEntry,
      managedWorkloadReplacement: replacement("hermes"),
      onboard: () => {
        throw new Error("replacement launch failed");
      },
    });

    await expect(
      harness.rebuildSandbox("alpha", ["--yes"], { throwOnError: true }),
    ).rejects.toThrow("Recreate failed");

    expect(harness.onboardSpy).toHaveBeenCalledOnce();
    expect(harness.restoreRegistryEntryIfMissingSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({
          imageTag: oldEntry.imageTag,
          workload: oldEntry.workload,
        }),
      }),
    );
    expect(
      (
        harness.restoreRegistryEntryIfMissingSpy.mock.calls[0]?.[0] as {
          entry: { imageTag: string };
        }
      ).entry.imageTag,
    ).not.toBe((replacement("hermes").source as Record<string, unknown>).reference);
  });
});
