// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  classifyTelemetryAgent,
  classifyTelemetryApi,
  classifyTelemetryModel,
  classifyTelemetryProvider,
  MESSAGING_CHANNELS,
  type TelemetryConfiguration,
} from "../../domain/telemetry/dimensions";
import { BUILT_IN_CHANNEL_MANIFESTS } from "../../messaging/channels/built-ins";
import { isMessagingSupportedAgent } from "../../messaging/utils";
import {
  isManagedImageReference,
  readManagedWorkloadAuthority,
} from "../../onboard/workload/authority";
import { getMessagingPlanFromEntry } from "../../state/registry-messaging";
import {
  parseAppliedPolicySelection,
  type AppliedPolicySelection,
} from "../../domain/telemetry/provenance";
import type { SandboxEntry } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";

function explicitBoolean(value: unknown): boolean | "unknown" {
  return typeof value === "boolean" ? value : "unknown";
}

function computeDriver(value: unknown): TelemetryConfiguration["computeDriver"] {
  if (value === "docker" || value === "podman" || value === "kubernetes") return value;
  return typeof value === "string" && value.trim() !== "" ? "other" : "unknown";
}

function gpuState(entry: SandboxEntry): TelemetryConfiguration["gpuState"] {
  if (entry.sandboxGpuEnabled === false) return "not_configured";
  if (entry.sandboxGpuEnabled !== true) return "unknown";
  const proof = entry.sandboxGpuProof;
  if (
    typeof proof !== "object" ||
    proof === null ||
    Array.isArray(proof) ||
    (Object.getPrototypeOf(proof) !== Object.prototype && Object.getPrototypeOf(proof) !== null)
  ) {
    return "configured_unverified";
  }
  if (proof?.status === "verified" && proof.cudaVerified === true) return "verified";
  if (proof?.status === "failed" && proof.cudaVerified === false) return "failed";
  return "configured_unverified";
}

type WorkloadProjection = Pick<
  TelemetryConfiguration,
  "sandboxOS" | "sandboxOSStatus" | "imageOwnership"
>;

function projectWorkload(entry: SandboxEntry, agent: string | null): WorkloadProjection {
  const unknown: WorkloadProjection = {
    sandboxOS: "unknown",
    sandboxOSStatus: "not_observed",
    imageOwnership: "unknown",
  };
  try {
    const receipt = cloneSandboxWorkloadReceipt(entry.workload);
    if (receipt?.kind === "managed-image") {
      // A completed context can prove an older row's omitted OpenClaw agent;
      // it cannot change an explicit recorded agent or an image reference.
      const authority = readManagedWorkloadAuthority({
        agent,
        fromDockerfile: entry.fromDockerfile,
        imageTag: entry.imageTag,
        workload: entry.workload,
      });
      if (!authority) return unknown;
      return { sandboxOS: "linux", sandboxOSStatus: "reported", imageOwnership: "managed" };
    }
    if (receipt?.kind === "external-image") {
      if (entry.imageTag !== receipt.reference || entry.fromDockerfile != null) return unknown;
      return { sandboxOS: "linux", sandboxOSStatus: "reported", imageOwnership: "unknown" };
    }
    if (receipt?.kind === "native-artifact") {
      // This inactive receipt is launch intent, not proof of a completed
      // native runtime. Wait for qualified applied-state authority.
      return unknown;
    }
    if (receipt?.kind === "legacy-dockerfile") {
      if (entry.imageTag != null && receipt.reference !== entry.imageTag) return unknown;
      if (
        entry.openshellDriver === "docker" &&
        receipt.platformProof?.sandboxName === entry.name &&
        receipt.platformProof.sandboxIdentityFingerprint ===
          entry.lifecycleLiveIdentityFingerprint &&
        receipt.reference === entry.imageTag
      ) {
        return { sandboxOS: "linux", sandboxOSStatus: "reported", imageOwnership: "custom" };
      }
      return { ...unknown, imageOwnership: "custom" };
    }
    // Legacy custom builds do not record a platform. A path proves ownership,
    // not the operating system, and a conflicting receipt is not legacy evidence.
    if (
      entry.workload === undefined &&
      typeof entry.fromDockerfile === "string" &&
      entry.fromDockerfile.trim() !== "" &&
      !isManagedImageReference(entry.imageTag)
    ) {
      return { ...unknown, imageOwnership: "custom" };
    }
    return unknown;
  } catch {
    return unknown;
  }
}

type MessagingProjection = Pick<
  TelemetryConfiguration,
  "configuredMessagingChannels" | "messagingStatus"
>;

function projectMessaging(entry: SandboxEntry, agent: string | null): MessagingProjection {
  if (entry.messaging === undefined) {
    return { configuredMessagingChannels: [], messagingStatus: "not_observed" };
  }
  const invalid: MessagingProjection = {
    configuredMessagingChannels: [],
    messagingStatus: "invalid",
  };
  if (
    entry.messaging?.schemaVersion !== 1 ||
    !isMessagingSupportedAgent({ name: agent ?? undefined }, BUILT_IN_CHANNEL_MANIFESTS)
  ) {
    return invalid;
  }
  const plan = getMessagingPlanFromEntry(entry, {
    sandboxName: entry.name,
    agent,
    // Persisted legacy plans may be normalized, but ambient credentials must
    // never decide which channels this configuration record reports.
    environment: {},
  });
  if (!plan) return invalid;
  const channels = new Set<TelemetryConfiguration["configuredMessagingChannels"][number]>();
  for (const channel of plan.channels) {
    if (channel.configured !== true) continue;
    const approved = MESSAGING_CHANNELS.find((id) => id !== "other" && id === channel.channelId);
    const manifest = BUILT_IN_CHANNEL_MANIFESTS.find((item) => item.id === channel.channelId);
    const supported = manifest?.supportedAgents.some((id) => id === agent) === true;
    channels.add(approved && supported ? approved : "other");
  }
  return { configuredMessagingChannels: [...channels], messagingStatus: "reported" };
}

/** Project only one committed target, never an inventory or a default sandbox. */
export function projectCommittedTelemetryConfiguration(
  sandboxName: string,
  entry: SandboxEntry | null,
  finalizedAgent?: string | null,
  confirmedPolicySelection?: AppliedPolicySelection | null,
): TelemetryConfiguration | null {
  if (
    !entry ||
    entry.name !== sandboxName ||
    entry.pendingRouteReservation === true ||
    entry.pendingCreateIdentity !== undefined ||
    entry.openClawConfigSyncPending === true
  ) {
    return null;
  }
  if (entry.agent != null && finalizedAgent != null && entry.agent !== finalizedAgent) return null;
  const agent = entry.agent ?? finalizedAgent ?? null;
  const recordedPolicy = parseAppliedPolicySelection(entry.appliedPolicySelection);
  const confirmedPolicy = parseAppliedPolicySelection(confirmedPolicySelection);
  // Report the selected tier confirmed during this completed operation and
  // committed with final registration, not the current live policy. An older
  // receipt alone cannot establish this operation's applied selection.
  const policy =
    recordedPolicy && confirmedPolicy && recordedPolicy.tier === confirmedPolicy.tier
      ? recordedPolicy
      : null;
  return {
    ...classifyTelemetryAgent(agent),
    ...classifyTelemetryModel(entry.model),
    providerProfile: classifyTelemetryProvider(entry.provider),
    apiFamily: classifyTelemetryApi(entry.preferredInferenceApi),
    ...projectWorkload(entry, agent),
    computeDriver: computeDriver(entry.openshellDriver),
    gpuState: gpuState(entry),
    webSearchEnabled: explicitBoolean(entry.webSearchEnabled),
    observabilityEnabled: explicitBoolean(entry.observabilityEnabled),
    policyTier: policy?.tier ?? null,
    policyTierStatus: policy
      ? "reported"
      : entry.appliedPolicySelection === undefined
        ? "not_persisted"
        : recordedPolicy
          ? "not_observed"
          : "invalid",
    ...projectMessaging(entry, agent),
  };
}
