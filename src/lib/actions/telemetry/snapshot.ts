// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { createSupervisedSandboxCommandReader } from "./native-reader";
import type { OpenShellInferenceRouteResult } from "../../adapters/openshell/inference-route";
import {
  approvedCategory,
  classifyTelemetryAgent,
  classifyTelemetrySandboxOS,
  COMPUTE_DRIVERS,
  dataRecord,
  MANAGED_AGENT_VERSIONS,
  MESSAGING_CHANNELS,
  parseRuntimeRoster,
  projectRuntimeAgents,
  projectCurrentInferenceRoute,
  unknownModel,
} from "../../domain/telemetry/dimensions";
import type {
  TelemetryAgent,
  TelemetryConfiguration,
  TelemetryMetadataError,
  TelemetrySettings,
  TelemetrySnapshot,
  TelemetryTargetReceipt,
  ValueStatus,
} from "../../domain/telemetry/event";
import { resolveRegisteredAgentDefinition } from "../../agent/runtime";
import { readAppliedPolicySelection } from "../../domain/telemetry/provenance";
import { DCODE_OBSERVABILITY_FEATURE } from "../../onboard/observability-policy-presets";
import { readManagedWorkloadAuthority } from "../../onboard/workload/authority";
import { resolveSandboxGatewayName } from "../../onboard/gateway-binding/identity";
import { resolveAgentConfig } from "../../sandbox/agent-config";
import { parseConfig } from "../../sandbox/config-format";
import { assertSafeConfigStructure } from "../../security/config-structure";
import {
  listGatewayStateRoots,
  readGatewayRegistryFile,
  resolveHome,
  DEFAULT_GATEWAY_PORT,
} from "../../state/gateway-registry";
import { getMessagingPlanFromEntry } from "../../state/registry-messaging";
import { normalizePendingSandboxCreateIdentity } from "../../state/registry/pending-create-identity";
import { isPublishedSandboxRegistration } from "../../state/registry/route-reservation";
import type { SandboxEntry } from "../../state/registry/types";
import { cloneSandboxWorkloadReceipt } from "../../state/registry/workload";
import { getMcpProviderInspectionRuntimeSelection } from "../sandbox/mcp-bridge-provider-inspection";

const MAX_CONCURRENT_RUNTIME_OBSERVATIONS = 4;

function booleanSetting(value: unknown): {
  value: "true" | "false" | "unknown";
  status: ValueStatus;
} {
  return typeof value === "boolean"
    ? { value: value ? "true" : "false", status: "reported" }
    : { value: "unknown", status: value === undefined ? "not_persisted" : "collection_error" };
}

function projectConfiguration(
  entry: SandboxEntry,
  metadataErrors: readonly TelemetryMetadataError[],
): TelemetryConfiguration {
  const harness = classifyTelemetryAgent(entry.agent);
  let sandboxOS = "unknown";
  let sandboxOSStatus: ValueStatus = "not_persisted";
  let imageOwnership = "unknown";
  let imageOwnershipStatus: ValueStatus = "not_persisted";
  let managedAgentVersion = "unknown";
  let managedAgentVersionStatus: ValueStatus = "not_persisted";
  try {
    const workload = cloneSandboxWorkloadReceipt(entry.workload);
    if (entry.workload !== undefined && !workload) throw new Error("Invalid workload receipt");
    if (workload?.kind === "managed-image") {
      const authority = readManagedWorkloadAuthority(entry);
      if (!authority || authority.agent !== entry.agent)
        throw new Error("Invalid managed workload authority");
      sandboxOS = "linux";
      sandboxOSStatus = "reported";
      imageOwnership = "managed";
      imageOwnershipStatus = "reported";
      const version = approvedCategory(
        entry.agentVersion,
        MANAGED_AGENT_VERSIONS[harness.agentHarnessId] ?? [],
      );
      managedAgentVersion = version.value;
      managedAgentVersionStatus = version.status;
    } else if (workload?.kind === "external-image") {
      if (entry.imageTag !== workload.reference || entry.fromDockerfile != null)
        throw new Error("Conflicting external workload receipt");
      // An external receipt establishes ownership, not a qualified sandbox OS.
      imageOwnership = "custom";
      imageOwnershipStatus = "reported";
      managedAgentVersionStatus = "not_applicable";
    } else if (
      workload?.kind === "legacy-dockerfile" ||
      (entry.workload === undefined &&
        typeof entry.fromDockerfile === "string" &&
        readManagedWorkloadAuthority(entry) === null)
    ) {
      if (
        workload?.kind === "legacy-dockerfile" &&
        entry.imageTag != null &&
        workload.reference !== entry.imageTag
      )
        throw new Error("Conflicting custom workload receipt");
      imageOwnership = "custom";
      imageOwnershipStatus = "reported";
      managedAgentVersionStatus = "not_applicable";
    } else if (workload?.kind === "native-artifact") {
      // This currently inactive receipt is launch intent, not applied runtime evidence.
      sandboxOSStatus = "not_observed";
      imageOwnershipStatus = "not_observed";
      managedAgentVersionStatus = "not_observed";
    }
  } catch {
    sandboxOSStatus = imageOwnershipStatus = managedAgentVersionStatus = "collection_error";
  }
  const driver = approvedCategory(entry.openshellDriver, COMPUTE_DRIVERS);
  const webSearch = booleanSetting(entry.webSearchEnabled);
  const observability = booleanSetting(entry.observabilityEnabled);
  if (
    harness.agentHarnessStatus === "reported" &&
    !DCODE_OBSERVABILITY_FEATURE.supportsAgent(entry.agent)
  ) {
    observability.status =
      entry.observabilityEnabled === true ? "collection_error" : "not_applicable";
  }
  let gpuState = "unknown";
  let gpuStatus: ValueStatus = "not_persisted";
  if (entry.sandboxGpuEnabled === false) {
    gpuState = "not_configured";
    gpuStatus = "reported";
  } else if (entry.sandboxGpuEnabled === true) {
    const proof = dataRecord(entry.sandboxGpuProof);
    gpuState =
      proof?.status === "verified" && proof.cudaVerified === true
        ? "verified"
        : proof?.status === "failed" && proof.cudaVerified === false
          ? "failed"
          : "configured_unverified";
    gpuStatus =
      entry.sandboxGpuProof !== undefined &&
      (!proof ||
        !["verified", "unverified", "failed"].includes(proof.status as string) ||
        typeof proof.cudaVerified !== "boolean" ||
        (proof.status === "verified" && proof.cudaVerified !== true) ||
        (proof.status === "failed" && proof.cudaVerified !== false))
        ? "collection_error"
        : "reported";
  } else if (entry.sandboxGpuEnabled !== undefined) gpuStatus = "collection_error";
  const policy = readAppliedPolicySelection(entry.appliedPolicySelection);
  const policyWriteFailed = metadataErrors.some((error) => error.category === "policy_tier");
  const settings: TelemetrySettings = {
    computeDriver: driver.value,
    computeDriverStatus: driver.status,
    gpuState,
    gpuStatus,
    webSearchEnabled: webSearch.value,
    webSearchStatus: webSearch.status,
    observabilityEnabled: observability.value,
    observabilityStatus: observability.status,
    imageOwnership,
    imageOwnershipStatus,
    policyTier: policyWriteFailed ? "unknown" : (policy?.tier ?? "unknown"),
    policyTierStatus: policyWriteFailed
      ? "collection_error"
      : policy
        ? "reported"
        : entry.appliedPolicySelection === undefined
          ? "not_persisted"
          : "collection_error",
  };
  let configuredMessagingChannels: string[] = [];
  let messagingStatus: ValueStatus =
    entry.agent === "langchain-deepagents-code" ? "not_applicable" : "not_persisted";
  if (entry.messaging !== undefined) {
    const plan = getMessagingPlanFromEntry(entry);
    if (
      plan &&
      plan.sandboxName === entry.name &&
      plan.agent === entry.agent &&
      (entry.agent === "openclaw" || entry.agent === "hermes")
    ) {
      configuredMessagingChannels = plan.channels
        .filter((channel) => channel.configured === true)
        .map((channel) =>
          MESSAGING_CHANNELS.some((id) => id === channel.channelId) ? channel.channelId : "other",
        );
      messagingStatus = "reported";
    } else messagingStatus = "collection_error";
  }
  const pendingFlags = [entry.openClawConfigSyncPending, entry.configurationApplyPending];
  let invalidPending = pendingFlags.some((value) => value !== undefined && value !== true);
  let pendingCreate = false;
  try {
    pendingCreate =
      normalizePendingSandboxCreateIdentity(entry.pendingCreateIdentity) !== undefined;
  } catch {
    invalidPending = true;
  }
  const pending = pendingCreate || pendingFlags.includes(true);
  const applyStateFailed = metadataErrors.some(
    (error) => error.category === "configuration_apply_state",
  );
  return {
    state: invalidPending || applyStateFailed ? "unavailable" : pending ? "pending" : "applied",
    status: invalidPending || applyStateFailed ? "collection_error" : "reported",
    ...harness,
    managedAgentVersion,
    managedAgentVersionStatus,
    sandboxOS,
    sandboxOSStatus,
    settings,
    messaging: { configuredMessagingChannels, messagingStatus },
    agentsStatus: "collection_error",
    agents: [],
    defaultAgentModel: { agentPosition: -1, modelPosition: -1, status: "collection_error" },
    currentInferenceRoute: unknownModel("primary"),
    currentInferenceRouteStatus: "collection_error",
  };
}

async function collectRuntime(
  entry: SandboxEntry,
  row: TelemetryConfiguration,
  options: {
    signal: AbortSignal;
    deadlineAt: number;
    metadataErrors: readonly TelemetryMetadataError[];
    routes: Map<string, Promise<OpenShellInferenceRouteResult>>;
  },
  reader: ReturnType<typeof createSupervisedSandboxCommandReader>,
): Promise<void> {
  if (entry.workload?.kind === "native-artifact") {
    row.state = "unavailable";
    row.status = row.agentsStatus = row.defaultAgentModel.status = "not_observed";
    row.currentInferenceRoute = unknownModel("primary", "not_observed");
    row.currentInferenceRouteStatus = "not_observed";
    return;
  }
  let osObservation: Promise<void> | undefined;
  let routeObservation: Promise<void> | undefined;
  try {
    const runtimeSelection = getMcpProviderInspectionRuntimeSelection(entry);
    const gatewayName = resolveSandboxGatewayName(entry);
    const routeKey = JSON.stringify([gatewayName, runtimeSelection]);
    let route = options.routes.get(routeKey);
    if (!route) {
      const remaining = options.deadlineAt - Date.now();
      if (options.signal.aborted || remaining <= 0)
        throw new Error("Telemetry observation deadline reached");
      route = reader.observeInferenceRoute(
        { target: { kind: "named", gatewayName }, timeoutMs: remaining },
        runtimeSelection,
      );
      options.routes.set(routeKey, route);
    }
    routeObservation = route
      .then((observation) => {
        Object.assign(
          row,
          projectCurrentInferenceRoute(observation, {
            ...entry,
            metadataErrors: options.metadataErrors,
          }),
        );
      })
      .catch(() => {});
    const read = async (command: readonly string[]) => {
      const remaining = options.deadlineAt - Date.now();
      if (options.signal.aborted || remaining <= 0)
        throw new Error("Telemetry observation deadline reached");
      return reader.read(
        {
          sandboxName: entry.name,
          target: { kind: "named", gatewayName },
          command,
          timeoutMilliseconds: remaining,
          timeoutKillSignal: "SIGKILL",
          outputLimitBytes: 16 * 1024 * 1024,
        },
        runtimeSelection,
      );
    };
    if (row.sandboxOSStatus !== "reported") {
      osObservation = read(["uname", "-s"])
        .then((raw) => {
          const observation = classifyTelemetrySandboxOS(raw);
          row.sandboxOS = observation.value;
          row.sandboxOSStatus = observation.status;
        })
        .catch(() => {
          row.sandboxOSStatus = "collection_error";
        });
    }
    if (row.agentHarnessId === "other" || row.agentHarnessId === "unknown") {
      row.agentsStatus = row.defaultAgentModel.status = row.agentHarnessStatus;
      return;
    }
    const config = resolveAgentConfig(entry.name, {
      getSandbox: () => ({ agent: entry.agent ?? undefined }),
      loadAgent: (agentName) => {
        const agent = resolveRegisteredAgentDefinition({ agent: agentName });
        if (!agent) throw new Error("Invalid registered agent definition");
        return agent;
      },
    });
    const [raw, roster] = await Promise.allSettled([
      read(["cat", config.configPath]).then((text) => parseConfig(text, config.format)),
      row.agentHarnessId === "openclaw"
        ? read(["openclaw", "agents", "list", "--json"]).then(parseRuntimeRoster)
        : undefined,
    ]);
    const runtime: Omit<TelemetryAgent, "models" | "modelsStatus"> = {
      agentHarnessId: row.agentHarnessId,
      agentHarnessStatus: row.agentHarnessStatus,
      managedAgentVersion: row.managedAgentVersion,
      managedAgentVersionStatus: row.managedAgentVersionStatus,
    };
    Object.assign(
      row,
      projectRuntimeAgents(
        runtime,
        raw.status === "fulfilled" ? raw.value : null,
        roster.status === "fulfilled" ? roster.value : undefined,
        { ...entry, metadataErrors: options.metadataErrors },
      ),
    );
    if (raw.status === "rejected" || roster.status === "rejected") row.status = "collection_error";
  } catch {
    row.agentsStatus = row.defaultAgentModel.status = "collection_error";
    row.status = "collection_error";
    if (row.sandboxOSStatus !== "reported" && !osObservation)
      row.sandboxOSStatus = "collection_error";
  } finally {
    await Promise.all([osObservation, routeObservation]);
  }
}

function markRuntimeNotObserved(row: TelemetryConfiguration): void {
  row.state = "unavailable";
  row.status = row.agentsStatus = row.defaultAgentModel.status = "not_observed";
  if (row.sandboxOSStatus !== "reported") row.sandboxOSStatus = "not_observed";
  row.currentInferenceRoute = unknownModel("primary", "not_observed");
  row.currentInferenceRouteStatus = "not_observed";
}

function metadataErrorsAt(
  position: number,
  positions: ReadonlyMap<string, number>,
  targets: readonly TelemetryTargetReceipt[],
): TelemetryMetadataError[] {
  return targets.flatMap((target) => {
    if (!target.sandboxName || !target.gatewayName) return [];
    const key = JSON.stringify([target.gatewayName, target.sandboxName]);
    return positions.get(key) === position ? (target.metadataErrors ?? []) : [];
  });
}

/** Read one complete host snapshot. Private names are retained only for target joins. */
export async function collectOperationSnapshot(options: {
  signal: AbortSignal;
  deadlineAt: number;
  targets?: readonly TelemetryTargetReceipt[];
}): Promise<TelemetrySnapshot> {
  const snapshot: TelemetrySnapshot = {
    configurations: [],
    publishedEnvironmentCount: 0,
    configuredRuntimeCount: 0,
    configuredAgentCount: 0,
    countsStatus: "reported",
    collectionStatus: "complete",
    targetPositions: new Map(),
  };
  const entries: SandboxEntry[] = [];
  let inventoryError = false;
  try {
    const home = resolveHome();
    for (const state of listGatewayStateRoots(home)) {
      try {
        if (options.signal.aborted || Date.now() >= options.deadlineAt)
          throw new Error("Telemetry observation deadline reached");
        const registry = readGatewayRegistryFile(home, path.join(state.root, "sandboxes.json"));
        if (!registry) continue;
        assertSafeConfigStructure(registry);
        for (const candidate of Object.values(registry.sandboxes)) {
          const entry = {
            ...candidate,
            ...(state.gatewayPort !== DEFAULT_GATEWAY_PORT &&
            candidate.gatewayPort == null &&
            candidate.gatewayName == null
              ? { gatewayPort: state.gatewayPort }
              : {}),
          } as unknown as SandboxEntry;
          if (
            entry.pendingRouteReservation !== undefined &&
            entry.pendingRouteReservation !== true
          ) {
            inventoryError = true;
            continue;
          }
          if (!isPublishedSandboxRegistration(entry)) continue;
          // Registry null/absence is the canonical default OpenClaw harness.
          entries.push({ ...entry, agent: entry.agent ?? "openclaw" });
        }
      } catch {
        inventoryError = true;
      }
    }
  } catch {
    inventoryError = true;
  }
  const qualified = new Map<string, number[]>();
  entries.forEach((entry, index) => {
    try {
      const key = JSON.stringify([resolveSandboxGatewayName(entry), entry.name]);
      qualified.set(key, [...(qualified.get(key) ?? []), index]);
    } catch {
      inventoryError = true;
    }
  });
  for (const [key, positions] of qualified) {
    if (positions.length === 1) snapshot.targetPositions.set(key, positions[0]);
    else inventoryError = true;
  }
  const metadataErrors = entries.map((_, index) =>
    metadataErrorsAt(index, snapshot.targetPositions, options.targets ?? []),
  );
  snapshot.configurations = entries.map((entry, index) =>
    projectConfiguration(entry, metadataErrors[index]),
  );
  const reader = createSupervisedSandboxCommandReader(options.signal, true);
  const routes = new Map<string, Promise<OpenShellInferenceRouteResult>>();
  let nextIndex = 0;
  let observationIncomplete = false;
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(MAX_CONCURRENT_RUNTIME_OBSERVATIONS, entries.length) },
        async () => {
          while (nextIndex < entries.length) {
            const index = nextIndex++;
            if (options.signal.aborted || Date.now() >= options.deadlineAt) {
              markRuntimeNotObserved(snapshot.configurations[index]);
              observationIncomplete = true;
              continue;
            }
            await collectRuntime(
              entries[index],
              snapshot.configurations[index],
              { ...options, metadataErrors: metadataErrors[index], routes },
              reader,
            );
          }
        },
      ),
    );
  } finally {
    reader.dispose();
  }
  snapshot.publishedEnvironmentCount = entries.length;
  snapshot.configuredRuntimeCount = snapshot.configurations.filter(
    (row) => row.agentHarnessId !== "unknown",
  ).length;
  snapshot.configuredAgentCount = snapshot.configurations.reduce(
    (count, row) => count + row.agents.length,
    0,
  );
  const collectionError =
    inventoryError ||
    observationIncomplete ||
    snapshot.configurations.some((row) => JSON.stringify(row).includes('"collection_error"'));
  if (collectionError) {
    snapshot.collectionStatus = snapshot.configurations.length > 0 ? "partial" : "collection_error";
  }
  if (
    inventoryError ||
    snapshot.configurations.some(
      (row) =>
        row.agentHarnessStatus === "collection_error" || row.agentsStatus === "collection_error",
    )
  )
    snapshot.countsStatus = "collection_error";
  else if (snapshot.configurations.some((row) => row.agentHarnessId === "unknown"))
    snapshot.countsStatus = "not_persisted";
  else {
    const unknownRoster = snapshot.configurations.find((row) => row.agentsStatus !== "reported");
    if (unknownRoster) snapshot.countsStatus = unknownRoster.agentsStatus;
  }
  return snapshot;
}
