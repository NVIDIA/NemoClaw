// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { parseTelemetryConfiguration } from "../../domain/telemetry/dimensions";
import {
  parseModelSelectionProvenance,
  type AppliedPolicySelection,
} from "../../domain/telemetry/provenance";
import {
  buildConfigurationCompletedEvent,
  parseTelemetryEvent,
  type TelemetryEvent,
} from "../../domain/telemetry/event";
import {
  AGENT_RUNTIMES,
  approvedManagedVersion,
  knownTelemetryModelKey,
  MAX_TELEMETRY_BATCH_EVENTS,
  SANDBOX_SIGNALS,
  sandboxSignalValue,
  type AgentRuntime,
  type ModelObservedEvent,
  type ObservationOperation,
  type SandboxSignal,
} from "../../domain/telemetry/observations";
import { readManagedWorkloadAuthority } from "../../onboard/workload/authority";
import { isPublishedSandboxRegistration } from "../../state/registry/route-reservation";
import type { SandboxEntry } from "../../state/registry/types";
import { projectCommittedTelemetryConfiguration } from "./configuration";

export { MAX_TELEMETRY_BATCH_EVENTS } from "../../domain/telemetry/observations";

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every((descriptor) =>
    Object.hasOwn(descriptor, "value"),
  );
}

function managedVersion(entry: SandboxEntry, runtime: AgentRuntime): string | null {
  if (runtime === "other") return null;
  try {
    const authority = readManagedWorkloadAuthority(entry);
    if (!authority || authority.agent !== runtime) return null;
    return approvedManagedVersion(runtime, entry.agentVersion);
  } catch {
    return null;
  }
}

/** Project a stable durable snapshot, without reading startup profiles as current agent assignments. */
export function projectPublishedTelemetrySnapshot(
  operation: ObservationOperation,
  value: unknown,
  finalizedTarget?: {
    name: string;
    agent: string | null | undefined;
    appliedPolicySelection?: AppliedPolicySelection | null;
  },
): readonly TelemetryEvent[] | null {
  try {
    if (!plainRecord(value) || !plainRecord(value.sandboxes)) return null;
    const events: TelemetryEvent[] = [];
    const runtimeCounts = new Map<AgentRuntime, number>();
    const versionCounts = new Map<
      string,
      { runtime: Exclude<AgentRuntime, "other">; version: string; count: number }
    >();
    const signalCounts = new Map<SandboxSignal, Map<string, number>>();
    const modelCounts = new Map<string, ModelObservedEvent>();
    const messagingCounts = new Map<string, number>();
    let publishedCount = 0;
    for (const [name, candidate] of Object.entries(value.sandboxes)) {
      if (!plainRecord(candidate) || candidate.name !== name || !name.trim()) return null;
      if (
        candidate.pendingRouteReservation !== undefined &&
        candidate.pendingRouteReservation !== true
      )
        return null;
      const entry = candidate as unknown as SandboxEntry;
      if (!isPublishedSandboxRegistration(entry)) continue;
      // These rows are not complete even when an interrupted path omitted its reservation flag.
      if (entry.pendingCreateIdentity !== undefined || entry.openClawConfigSyncPending === true)
        return null;
      const finalizedAgent = finalizedTarget?.name === name ? finalizedTarget.agent : undefined;
      const currentPolicySelection =
        finalizedTarget?.name === name ? finalizedTarget.appliedPolicySelection : undefined;
      const configuration = parseTelemetryConfiguration(
        projectCommittedTelemetryConfiguration(name, entry, finalizedAgent, currentPolicySelection),
      );
      if (!configuration) return null;
      publishedCount += 1;
      events.push(
        buildConfigurationCompletedEvent(operation, configuration, "published_configuration"),
      );
      const runtime =
        AGENT_RUNTIMES.find((item) => item === configuration.agentHarnessId) ?? "other";
      const hasRecordedAgent = configuration.agentHarnessStatus !== "not_observed";
      if (hasRecordedAgent) runtimeCounts.set(runtime, (runtimeCounts.get(runtime) ?? 0) + 1);
      const version = managedVersion(entry, runtime);
      if (hasRecordedAgent && version !== null && runtime !== "other") {
        const key = `${runtime}:${version}`;
        const prior = versionCounts.get(key);
        versionCounts.set(key, { runtime, version, count: (prior?.count ?? 0) + 1 });
      }
      // A legacy row proves only its recorded primary assignment. Never expand
      // this into routes or agents declared in an old startup profile.
      const hasRoute =
        typeof entry.provider === "string" &&
        entry.provider.trim() !== "" &&
        typeof entry.model === "string" &&
        entry.model.trim() !== "";
      if (hasRoute && configuration.agentHarnessId !== "unknown") {
        const provenance = parseModelSelectionProvenance(entry.modelSelectionProvenance);
        const model: ModelObservedEvent = {
          event: "nemoclaw_model_observed",
          operation,
          model_source: provenance?.modelSource ?? "unknown",
          known_model_key: knownTelemetryModelKey(configuration.modelId),
          modelId: configuration.modelId,
          provider_profile: configuration.providerProfile,
          api_family:
            provenance?.apiFamily === configuration.apiFamily ? provenance.apiFamily : "unknown",
          count: 1,
        };
        const key = JSON.stringify([
          model.model_source,
          model.known_model_key,
          model.modelId,
          model.provider_profile,
          model.api_family,
        ]);
        const prior = modelCounts.get(key);
        modelCounts.set(key, { ...model, count: (prior?.count ?? 0) + 1 });
      }
      if (configuration.messagingStatus === "reported") {
        for (const channel of configuration.configuredMessagingChannels)
          messagingCounts.set(channel, (messagingCounts.get(channel) ?? 0) + 1);
      }
      for (const signal of Object.keys(SANDBOX_SIGNALS) as SandboxSignal[]) {
        const counts = signalCounts.get(signal) ?? new Map<string, number>();
        const signalValue = sandboxSignalValue(configuration, signal);
        counts.set(signalValue, (counts.get(signalValue) ?? 0) + 1);
        signalCounts.set(signal, counts);
      }
      if (events.length > MAX_TELEMETRY_BATCH_EVENTS) return null;
    }
    events.unshift({ event: "nemoclaw_sandbox_count_observed", operation, count: publishedCount });
    for (const runtime of AGENT_RUNTIMES) {
      const count = runtimeCounts.get(runtime);
      if (count)
        events.push({
          event: "nemoclaw_agent_runtime_observed",
          operation,
          agent_runtime: runtime,
          count,
        });
    }
    for (const { runtime, version, count } of versionCounts.values()) {
      events.push({
        event: "nemoclaw_managed_agent_version_observed",
        operation,
        agent_runtime: runtime,
        managed_agent_version: version,
        count,
      });
    }
    events.push(...modelCounts.values());
    for (const [channel, count] of messagingCounts) {
      const event = parseTelemetryEvent({
        event: "nemoclaw_messaging_observed",
        operation,
        messaging_channel: channel,
        count,
      });
      if (!event) return null;
      events.push(event);
    }
    for (const [signal, counts] of signalCounts) {
      for (const [signalValue, count] of counts)
        events.push({
          event: "nemoclaw_configuration_observed",
          operation,
          scope: "sandbox",
          signal,
          value: signalValue,
          count,
        });
    }
    if (events.length > MAX_TELEMETRY_BATCH_EVENTS) return null;
    const parsed = events.map(parseTelemetryEvent);
    if (parsed.some((event) => event === null)) return null;
    return Object.freeze(parsed as TelemetryEvent[]);
  } catch {
    return null;
  }
}
