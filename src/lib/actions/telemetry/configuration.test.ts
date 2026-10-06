// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { imageRef, managedWorkload } from "../../domain/config/export-source-test-fixture";
import { parseTelemetryConfiguration } from "../../domain/telemetry/dimensions";
import type { SandboxMessagingPlan } from "../../messaging/manifest";
import { nativeArtifactWorkloadReceiptFixture } from "../../onboard/workload/native-artifact-test-fixture";
import type { LegacyDockerfilePlatformProof, SandboxEntry } from "../../state/registry/types";
import { projectCommittedTelemetryConfiguration } from "./configuration";

function entry(overrides: Partial<SandboxEntry> = {}): SandboxEntry {
  return {
    name: "target-not-default",
    agent: "openclaw",
    model: "Qwen/Qwen3.6-27B-FP8",
    provider: "nvidia-prod",
    preferredInferenceApi: "openai-completions",
    openshellDriver: "docker",
    sandboxGpuEnabled: false,
    webSearchEnabled: true,
    observabilityEnabled: false,
    imageTag: imageRef,
    workload: managedWorkload(),
    ...overrides,
  };
}

function appliedCustomImageEntry(proof: unknown = undefined): SandboxEntry {
  return entry({
    agent: "hermes",
    imageTag: "private-custom-image",
    fromDockerfile: "/private/Dockerfile",
    lifecycleLiveIdentityFingerprint: "a".repeat(64),
    workload: {
      schemaVersion: 1,
      kind: "legacy-dockerfile",
      reference: "private-custom-image",
      ...(proof === undefined ? {} : { platformProof: proof as LegacyDockerfilePlatformProof }),
      shared: false,
    },
  });
}

function appliedPlatformProof(): LegacyDockerfilePlatformProof {
  return {
    schemaVersion: 1,
    source: "applied-image-inspect",
    sandboxName: "target-not-default",
    sandboxIdentityFingerprint: "a".repeat(64),
    reference: "private-custom-image",
    runtimeImageContentId: `sha256:${"b".repeat(64)}`,
    platform: "linux/arm64",
  };
}

function messagingPlan(
  channels: readonly { channelId: string; configured: boolean; disabled?: boolean }[] = [],
): SandboxMessagingPlan {
  return {
    schemaVersion: 1,
    sandboxName: "target-not-default",
    agent: "openclaw",
    workflow: "onboard",
    channels: channels.map(({ channelId, configured, disabled = false }) => ({
      channelId,
      displayName: channelId,
      authMode: "none",
      active: false,
      selected: false,
      configured,
      disabled,
      inputs: [],
      hooks: [],
    })),
    disabledChannels: channels
      .filter((channel) => channel.disabled)
      .map((channel) => channel.channelId),
    credentialBindings: [],
    networkPolicy: { presets: [], entries: [] },
    agentRender: [],
    buildSteps: [],
    stateUpdates: [],
    healthChecks: [],
  };
}

function privateConfigurationEntry(): SandboxEntry {
  return entry({
    endpointUrl: "https://private.example.invalid/tenant",
    credentialEnv: "SECRET_PRIVATE_KEY",
    gatewayName: "private-gateway",
    sandboxGpuProof: {
      status: "failed",
      cudaVerified: false,
      detail: "private diagnostic",
      label: "private proof",
      at: "private timestamp",
    },
    messaging: {
      schemaVersion: 1,
      plan: messagingPlan([{ channelId: "telegram", configured: true }]),
    },
  });
}

describe("committed configuration telemetry projection", () => {
  it("projects the complete allowlisted configuration without private values (#10448)", () => {
    const privateRow = privateConfigurationEntry();
    const projected = projectCommittedTelemetryConfiguration(privateRow.name, privateRow);
    expect(projected).toEqual({
      agentHarnessId: "openclaw",
      agentHarnessStatus: "reported",
      modelId: "Qwen/Qwen3.6-27B-FP8",
      modelStatus: "reported",
      providerProfile: "nvidia",
      apiFamily: "openai-completions",
      sandboxOS: "linux",
      sandboxOSStatus: "reported",
      imageOwnership: "managed",
      computeDriver: "docker",
      gpuState: "not_configured",
      webSearchEnabled: true,
      observabilityEnabled: false,
      policyTier: null,
      policyTierStatus: "not_persisted",
      configuredMessagingChannels: ["telegram"],
      messagingStatus: "reported",
    });
    expect(parseTelemetryConfiguration(projected)).toEqual(projected);
  });

  it.each(["target-not-default", "private", "SECRET_PRIVATE_KEY", imageRef])(
    "does not retain the private value %s (#10448)",
    (excluded) => {
      const row = privateConfigurationEntry();
      expect(JSON.stringify(projectCommittedTelemetryConfiguration(row.name, row))).not.toContain(
        excluded,
      );
    },
  );

  it.each([
    null,
    entry({ name: "another-target" }),
    entry({ pendingRouteReservation: true }),
    entry({ pendingCreateIdentity: {} as SandboxEntry["pendingCreateIdentity"] }),
    entry({ openClawConfigSyncPending: true }),
  ])("rejects unavailable, mismatched, or incomplete targets (#10448)", (row) => {
    expect(projectCommittedTelemetryConfiguration("target-not-default", row)).toBeNull();
  });

  it("uses an explicit completed context for a legacy omitted agent, never a default (#10448)", () => {
    const row = entry({ agent: null, workload: undefined, imageTag: undefined });
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      agentHarnessId: "unknown",
      agentHarnessStatus: "not_observed",
    });
    expect(projectCommittedTelemetryConfiguration(row.name, row, "openclaw")).toMatchObject({
      agentHarnessId: "openclaw",
      agentHarnessStatus: "reported",
    });
    expect(
      projectCommittedTelemetryConfiguration(row.name, entry({ agent: "hermes" }), "openclaw"),
    ).toBeNull();
  });

  it("buckets unapproved private agent and model values without retaining them (#10448)", () => {
    const row = entry({
      agent: "private-agent",
      model: "internal/private-model",
      provider: "secret-profile",
    });
    const projected = projectCommittedTelemetryConfiguration(row.name, row);
    expect(projected).toMatchObject({
      agentHarnessId: "other",
      agentHarnessStatus: "unapproved",
      modelId: "other",
      modelStatus: "unapproved",
      providerProfile: "custom",
      sandboxOS: "unknown",
    });
    expect(JSON.stringify(projected)).not.toContain("private");
    expect(JSON.stringify(projected)).not.toContain("secret-profile");
  });

  it("preserves missing settings as unknown rather than defaulting them (#10448)", () => {
    const projected = projectCommittedTelemetryConfiguration("target-not-default", {
      name: "target-not-default",
    });
    expect(projected).toMatchObject({
      agentHarnessId: "unknown",
      modelId: "unknown",
      providerProfile: "unknown",
      apiFamily: "unknown",
      sandboxOS: "unknown",
      sandboxOSStatus: "not_observed",
      computeDriver: "unknown",
      gpuState: "unknown",
      webSearchEnabled: "unknown",
      observabilityEnabled: "unknown",
      imageOwnership: "unknown",
      configuredMessagingChannels: [],
      messagingStatus: "not_observed",
    });
    expect(parseTelemetryConfiguration(projected)).toEqual(projected);
  });

  it.each([
    [false, "verified", true, "not_configured"],
    [true, "verified", true, "verified"],
    [true, "failed", false, "failed"],
    [true, "verified", false, "configured_unverified"],
    [true, "failed", true, "configured_unverified"],
    [true, "unverified", false, "configured_unverified"],
    [undefined, "verified", true, "unknown"],
  ] as const)(
    "reports GPU state only from consistent sandbox evidence (#10448)",
    (enabled, status, cudaVerified, expected) => {
      const row = entry({
        sandboxGpuEnabled: enabled,
        sandboxGpuProof: { status, cudaVerified, at: "not-collected" },
      });
      expect(projectCommittedTelemetryConfiguration(row.name, row)?.gpuState).toBe(expected);
    },
  );

  it.each([
    ["missing receipt", entry({ workload: undefined })],
    ["mismatched image", entry({ imageTag: "private-custom-image" })],
    ["missing platform", entry({ workload: { ...managedWorkload(), platform: undefined } })],
    ["conflicting Dockerfile", entry({ fromDockerfile: "/private/Dockerfile" })],
  ] as const)(
    "does not substitute host OS for %s workload evidence (#10448)",
    (_description, row) => {
      expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
        sandboxOS: "unknown",
        sandboxOSStatus: "not_observed",
        imageOwnership: "unknown",
      });
    },
  );

  it("reports a qualified external Linux platform without calling its image managed (#10448)", () => {
    const reference = `registry.example.invalid/private-image@sha256:${"e".repeat(64)}`;
    const row = entry({
      imageTag: reference,
      workload: {
        schemaVersion: 1,
        kind: "external-image",
        reference,
        platform: "linux/arm64",
        runtimeImageContentId: `sha256:${"f".repeat(64)}`,
        shared: true,
      },
    });
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      sandboxOS: "linux",
      sandboxOSStatus: "reported",
      imageOwnership: "unknown",
    });
  });

  it("does not mistake inactive Windows launch intent for a completed native runtime (#10448)", () => {
    const row = entry({
      imageTag: undefined,
      workload: nativeArtifactWorkloadReceiptFixture(managedWorkload().encodedProfile),
    });
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      sandboxOS: "unknown",
      sandboxOSStatus: "not_observed",
      imageOwnership: "unknown",
    });
    expect(
      projectCommittedTelemetryConfiguration(row.name, { ...row, imageTag: "conflicting-image" })
        ?.sandboxOS,
    ).toBe("unknown");
  });

  it.each([
    ["array", Object.assign([], { status: "verified", cudaVerified: true })],
    ["string", "verified"],
    ["nonboolean CUDA result", { status: "verified", cudaVerified: "true" }],
  ] as const)("rejects a %s GPU proof shape (#10448)", (_description, proof) => {
    const row = entry({
      sandboxGpuEnabled: true,
      sandboxGpuProof: proof as unknown as SandboxEntry["sandboxGpuProof"],
    });
    expect(projectCommittedTelemetryConfiguration(row.name, row)?.gpuState).toBe(
      "configured_unverified",
    );
  });

  it("reports legacy custom ownership without guessing a platform (#10448)", () => {
    const row = entry({
      imageTag: "private-custom-image",
      fromDockerfile: "/private/Dockerfile",
      workload: {
        schemaVersion: 1,
        kind: "legacy-dockerfile",
        reference: "private-custom-image",
        shared: false,
      },
    });
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      sandboxOS: "unknown",
      sandboxOSStatus: "not_observed",
      imageOwnership: "custom",
    });
  });

  it("reports a custom platform only for its committed target and applied image (#10435)", () => {
    const row = appliedCustomImageEntry(appliedPlatformProof());
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      sandboxOS: "linux",
      sandboxOSStatus: "reported",
      imageOwnership: "custom",
    });
  });

  it.each([
    ["missing proof", undefined],
    ["authored Linux claim", { platform: "linux/arm64" }],
    ["Dockerfile-derived source", { ...appliedPlatformProof(), source: "dockerfile" }],
    ["wrong image reference", { ...appliedPlatformProof(), reference: "different-image" }],
    [
      "mutable image identity",
      { ...appliedPlatformProof(), runtimeImageContentId: "private:latest" },
    ],
    ["Windows platform", { ...appliedPlatformProof(), platform: "windows/amd64" }],
    ["extra forged status", { ...appliedPlatformProof(), status: "verified" }],
    ["array proof", Object.assign([], appliedPlatformProof())],
    ["inherited proof", Object.create(appliedPlatformProof())],
    [
      "invalid sandbox fingerprint",
      { ...appliedPlatformProof(), sandboxIdentityFingerprint: "unproved" },
    ],
  ])("does not report a sandbox OS from %s (#10435)", (_case, proof) => {
    const row = appliedCustomImageEntry(proof);
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      sandboxOS: "unknown",
      sandboxOSStatus: "not_observed",
    });
  });

  it.each([
    ["different target", { ...appliedPlatformProof(), sandboxName: "another-target" }],
    ["stale lifecycle", { ...appliedPlatformProof(), sandboxIdentityFingerprint: "c".repeat(64) }],
  ])("keeps custom ownership without using %s platform proof (#10435)", (_case, proof) => {
    const row = appliedCustomImageEntry(proof);
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      sandboxOS: "unknown",
      sandboxOSStatus: "not_observed",
      imageOwnership: "custom",
    });
  });

  it.each([
    { imageTag: "different-image" },
    { imageTag: undefined },
    { lifecycleLiveIdentityFingerprint: undefined },
    { openshellDriver: "mxc" },
    { openshellDriver: undefined },
  ])(
    "does not report a custom platform when durable bindings are missing or changed (#10435)",
    (overrides) => {
      const row = { ...appliedCustomImageEntry(appliedPlatformProof()), ...overrides };
      expect(projectCommittedTelemetryConfiguration(row.name, row)?.sandboxOS).toBe("unknown");
    },
  );

  it.each([
    { pendingRouteReservation: true as const },
    { pendingCreateIdentity: {} as SandboxEntry["pendingCreateIdentity"] },
    { openClawConfigSyncPending: true as const },
  ])("does not publish platform proof for an incomplete target (#10435)", (overrides) => {
    const row = { ...appliedCustomImageEntry(appliedPlatformProof()), ...overrides };
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toBeNull();
  });

  it("counts configured channels even when disabled and ignores nonconfigured channels (#10448)", () => {
    const row = entry({
      messaging: {
        schemaVersion: 1,
        plan: messagingPlan([
          { channelId: "telegram", configured: true, disabled: true },
          { channelId: "slack", configured: false },
          { channelId: "private-channel-one", configured: true },
          { channelId: "private-channel-two", configured: true },
        ]),
      },
    });
    const projected = projectCommittedTelemetryConfiguration(row.name, row);
    expect(projected).toMatchObject({
      configuredMessagingChannels: ["telegram", "other"],
      messagingStatus: "reported",
    });
    expect(JSON.stringify(projected)).not.toContain("private-channel");
  });

  it.each(["sandbox", "agent", "unsupported-agent", "malformed"])(
    "rejects invalid messaging authority (%s) (#10448)",
    (kind) => {
      const plan = {
        ...messagingPlan(),
        ...(kind === "sandbox" ? { sandboxName: "another-target" } : {}),
        ...(kind === "agent" ? { agent: "hermes" as const } : {}),
      };
      const row = entry({
        ...(kind === "unsupported-agent" ? { agent: "langchain-deepagents-code" } : {}),
        messaging: {
          schemaVersion: 1,
          plan: kind === "malformed" ? ({} as SandboxMessagingPlan) : plan,
        },
      });
      expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
        configuredMessagingChannels: [],
        messagingStatus: "invalid",
      });
    },
  );

  it("distinguishes a valid empty messaging plan from an absent plan (#10448)", () => {
    const row = entry({ messaging: { schemaVersion: 1, plan: messagingPlan() } });
    expect(projectCommittedTelemetryConfiguration(row.name, row)).toMatchObject({
      configuredMessagingChannels: [],
      messagingStatus: "reported",
    });
  });
});
