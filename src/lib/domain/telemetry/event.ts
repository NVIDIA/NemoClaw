// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export type TelemetryOutcome =
  | "completed"
  | "checked"
  | "cancelled"
  | "skipped"
  | "failed"
  | "no_change"
  | "unverified";
export type TelemetryState = "applied" | "pending" | "partial" | "unchanged" | "unavailable";
export type TelemetryScope = "cli" | "sandbox" | "configuration";
export type ValueStatus =
  | "reported"
  | "unapproved"
  | "not_applicable"
  | "not_configured"
  | "unavailable"
  | "not_persisted"
  | "not_observed"
  | "collection_error";
export const TELEMETRY_OPERATIONS = [
  "install",
  "update",
  "upgrade_sandboxes",
  "sandbox_create",
  "sandbox_rebuild",
  "sandbox_destroy",
  "sandbox_recover",
  "inference_set",
  "agent_add",
  "agent_delete",
  "agents_apply",
  "messaging_add",
  "messaging_remove",
  "messaging_pause",
  "messaging_resume",
  "settings_change",
  "policy_change",
] as const;
export type TelemetryOperation = (typeof TELEMETRY_OPERATIONS)[number];

/** The public host config setter currently supports these approved Hermes route keys. */
export function isTelemetryConfigurationKey(key: unknown): boolean {
  return key === "model.default" || key === "model.provider" || key === "model.api_mode";
}

export function readTelemetryTestLabel(env: Readonly<NodeJS.ProcessEnv>): string | null {
  const value = env.NEMOCLAW_TELEMETRY_TEST_LABEL;
  if (value === undefined) return "";
  return value.length <= 96 &&
    /^qa-[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,39}:attempt-[1-9][0-9]{0,2}$/.test(value)
    ? value
    : null;
}

export interface TelemetryTargetReceipt {
  scope: TelemetryScope;
  sandboxName?: string;
  gatewayName?: string;
  outcome: TelemetryOutcome;
  state: TelemetryState;
  verificationStatus?: ValueStatus;
  /** Failed metadata writes stay private and identify only affected observations. */
  metadataErrors?: TelemetryMetadataError[];
}

export type TelemetryModelAssignment = "primary" | "override" | "fallback" | "subagent";

export type TelemetryMetadataError =
  | {
      category: "model_source";
      slot?: { agentId: string; assignment: TelemetryModelAssignment; reference: string };
    }
  | { category: "native_model_source" | "policy_tier" | "configuration_apply_state" };

export interface TelemetryModel {
  assignment: TelemetryModelAssignment;
  modelId: string;
  modelStatus: ValueStatus;
  knownModelKey: string;
  knownModelKeyStatus: ValueStatus;
  modelSource: string;
  modelSourceStatus: ValueStatus;
  providerProfile: string;
  providerStatus: ValueStatus;
  apiFamily: string;
  apiStatus: ValueStatus;
}

export interface TelemetryAgent {
  agentHarnessId: string;
  agentHarnessStatus: ValueStatus;
  managedAgentVersion: string;
  managedAgentVersionStatus: ValueStatus;
  modelsStatus: ValueStatus;
  models: TelemetryModel[];
}

export interface TelemetrySettings {
  computeDriver: string;
  computeDriverStatus: ValueStatus;
  gpuState: string;
  gpuStatus: ValueStatus;
  webSearchEnabled: "true" | "false" | "unknown";
  webSearchStatus: ValueStatus;
  observabilityEnabled: "true" | "false" | "unknown";
  observabilityStatus: ValueStatus;
  imageOwnership: string;
  imageOwnershipStatus: ValueStatus;
  policyTier: string;
  policyTierStatus: ValueStatus;
}

export interface TelemetryConfiguration {
  state: TelemetryState;
  status: ValueStatus;
  agentHarnessId: string;
  agentHarnessStatus: ValueStatus;
  managedAgentVersion: string;
  managedAgentVersionStatus: ValueStatus;
  sandboxOS: string;
  sandboxOSStatus: ValueStatus;
  defaultAgentModel: { agentPosition: number; modelPosition: number; status: ValueStatus };
  currentInferenceRoute: TelemetryModel;
  currentInferenceRouteStatus: ValueStatus;
  settings: TelemetrySettings;
  messaging: { configuredMessagingChannels: string[]; messagingStatus: ValueStatus };
  agentsStatus: ValueStatus;
  agents: TelemetryAgent[];
}

export interface TelemetrySnapshot {
  configurations: TelemetryConfiguration[];
  publishedEnvironmentCount: number;
  configuredRuntimeCount: number;
  configuredAgentCount: number;
  countsStatus: ValueStatus;
  collectionStatus: "complete" | "partial" | "collection_error";
  /** Names remain local and are never included in the wire event. */
  targetPositions: Map<string, number>;
}

export interface TelemetryLocation {
  countryCode: string;
  countryName: string;
  countryStatus: ValueStatus;
  regionName: string;
  regionStatus: ValueStatus;
  cityName: string;
  cityStatus: ValueStatus;
  locationSource: "none" | "approved_network_origin" | "approved_deployment";
  locationPrecision: "none" | "country" | "region" | "city";
  locationStatus: "not_configured" | "unavailable" | "partial" | "reported" | "collection_error";
  locationObservedAt: string;
  locationObservedAtStatus: ValueStatus;
}

export interface TelemetryOperationContext {
  operation: TelemetryOperation;
  startedAt: string;
  completedAt: string;
  outcome: TelemetryOutcome;
  state: TelemetryState;
  scope: TelemetryScope;
  previousVersion?: string;
  targetVersion?: string;
  installedVersion?: string;
  targets: TelemetryTargetReceipt[];
}

export interface OperationEventParameters extends Omit<TelemetrySnapshot, "targetPositions"> {
  nvidiaSource: "nemoclaw";
  testLabel: string;
  operation: TelemetryOperation;
  outcome: TelemetryOutcome;
  configurationScope: "published_configuration";
  operationScope: TelemetryScope;
  state: TelemetryState;
  startedAt: string;
  completedAt: string;
  versions: {
    installed: string;
    installedStatus: ValueStatus;
    previous: string;
    previousStatus: ValueStatus;
    target: string;
    targetStatus: ValueStatus;
  };
  platform: {
    hostOS: string;
    hostOSStatus: ValueStatus;
    hostArch: string;
    hostArchStatus: ValueStatus;
    hostContext: string;
    hostContextStatus: ValueStatus;
  };
  location: TelemetryLocation;
  targetResultsStatus: ValueStatus;
  targetResults: {
    scope: TelemetryScope;
    outcome: TelemetryOutcome;
    state: TelemetryState;
    verificationStatus: ValueStatus;
    configurationPosition: number;
    configurationStatus: ValueStatus;
  }[];
}

export interface TelemetryOperationEvent {
  name: "nemoclaw_operation_finished";
  ts: string;
  parameters: OperationEventParameters;
}
