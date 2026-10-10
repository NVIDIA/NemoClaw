// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import Ajv from "ajv";
import { assertSafeConfigStructure } from "../../security/config-structure";
import {
  AGENT_HARNESS_IDS,
  COMPUTE_DRIVERS,
  GPU_STATES,
  MANAGED_AGENT_VERSIONS,
  MESSAGING_CHANNELS,
  MODEL_SELECTION_SOURCES,
  POLICY_TIER_CATEGORIES,
  SANDBOX_OPERATING_SYSTEMS,
  TELEMETRY_API_FAMILIES,
  TELEMETRY_MODEL_IDS,
  TELEMETRY_MODEL_KEYS,
  TELEMETRY_PROVIDER_PROFILES,
} from "./dimensions";
import { TELEMETRY_OPERATIONS, type TelemetryOperationEvent } from "./event";

export const TELEMETRY_SCHEMA_VERSION = "3.0";
export const TELEMETRY_CLIENT_ID = "2247027956751513";
export const VALUE_STATUSES = [
  "reported",
  "unapproved",
  "not_applicable",
  "not_configured",
  "unavailable",
  "not_persisted",
  "not_observed",
  "collection_error",
];
export const OUTCOMES = [
  "completed",
  "checked",
  "cancelled",
  "skipped",
  "failed",
  "no_change",
  "unverified",
];
export const STATES = ["applied", "pending", "partial", "unchanged", "unavailable"];
export const SCOPES = ["cli", "sandbox", "configuration"];
export const PUBLIC_VERSION_PATTERN =
  "^(?:unknown|[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?)$";
const string = (values?: readonly string[]) => ({
  type: "string",
  ...(values ? { enum: [...values] } : {}),
});
const object = (properties: Record<string, unknown>) => ({
  type: "object",
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const array = (items: unknown) => ({ type: "array", items });
const status = string(VALUE_STATUSES);
const integer = { type: "integer", minimum: 0 };
const position = { type: "integer", minimum: -1 };
const timestamp = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
};
const version = { type: "string", maxLength: 128, pattern: PUBLIC_VERSION_PATTERN };
const model = object({
  assignment: string(["primary", "override", "fallback", "subagent"]),
  modelId: string(TELEMETRY_MODEL_IDS),
  modelStatus: status,
  knownModelKey: string([...new Set(Object.values(TELEMETRY_MODEL_KEYS)), "other", "unknown"]),
  knownModelKeyStatus: status,
  modelSource: string(MODEL_SELECTION_SOURCES),
  modelSourceStatus: status,
  providerProfile: string(TELEMETRY_PROVIDER_PROFILES),
  providerStatus: status,
  apiFamily: string(TELEMETRY_API_FAMILIES),
  apiStatus: status,
});
const harnessFields = {
  agentHarnessId: string(AGENT_HARNESS_IDS),
  agentHarnessStatus: status,
  managedAgentVersion: string([
    ...new Set(Object.values(MANAGED_AGENT_VERSIONS).flat()),
    "other",
    "unknown",
  ]),
  managedAgentVersionStatus: status,
};
const configuration = object({
  state: string(STATES),
  status,
  ...harnessFields,
  sandboxOS: string(SANDBOX_OPERATING_SYSTEMS),
  sandboxOSStatus: status,
  defaultAgentModel: object({ agentPosition: position, modelPosition: position, status }),
  currentInferenceRoute: model,
  currentInferenceRouteStatus: status,
  settings: object({
    computeDriver: string(COMPUTE_DRIVERS),
    computeDriverStatus: status,
    gpuState: string(GPU_STATES),
    gpuStatus: status,
    webSearchEnabled: string(["true", "false", "unknown"]),
    webSearchStatus: status,
    observabilityEnabled: string(["true", "false", "unknown"]),
    observabilityStatus: status,
    imageOwnership: string(["managed", "custom", "unknown"]),
    imageOwnershipStatus: status,
    policyTier: string([...POLICY_TIER_CATEGORIES, "unknown"]),
    policyTierStatus: status,
  }),
  messaging: object({
    configuredMessagingChannels: array(string(MESSAGING_CHANNELS)),
    messagingStatus: status,
  }),
  agentsStatus: status,
  agents: array(object({ ...harnessFields, modelsStatus: status, models: array(model) })),
});
export const operationParametersSchema = object({
  nvidiaSource: string(["nemoclaw"]),
  testLabel: {
    type: "string",
    maxLength: 96,
    pattern: "^(?:|qa-[a-z0-9][a-z0-9-]{0,31}:[a-z0-9][a-z0-9-]{0,39}:attempt-[1-9][0-9]{0,2})$",
  },
  operation: string(TELEMETRY_OPERATIONS),
  outcome: string(OUTCOMES),
  state: string(STATES),
  configurationScope: string(["published_configuration"]),
  operationScope: string(SCOPES),
  startedAt: timestamp,
  completedAt: timestamp,
  versions: object({
    installed: version,
    installedStatus: status,
    previous: version,
    previousStatus: status,
    target: version,
    targetStatus: status,
  }),
  platform: object({
    hostOS: string(["linux", "macos", "windows", "other", "unknown"]),
    hostOSStatus: status,
    hostArch: string(["x64", "arm64", "ia32", "arm", "other", "unknown"]),
    hostArchStatus: status,
    hostContext: string(["native", "wsl", "unknown"]),
    hostContextStatus: status,
  }),
  location: object({
    countryCode: { type: "string", maxLength: 2, pattern: "^(?:|[A-Z]{2})$" },
    countryName: { type: "string", maxLength: 128 },
    countryStatus: status,
    regionName: { type: "string", maxLength: 128 },
    regionStatus: status,
    cityName: { type: "string", maxLength: 128 },
    cityStatus: status,
    locationSource: string(["none", "approved_network_origin", "approved_deployment"]),
    locationPrecision: string(["none", "country", "region", "city"]),
    locationStatus: string([
      "not_configured",
      "unavailable",
      "partial",
      "reported",
      "collection_error",
    ]),
    locationObservedAt: {
      type: "string",
      pattern: "^(?:|\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z)$",
    },
    locationObservedAtStatus: status,
  }),
  publishedEnvironmentCount: integer,
  configuredRuntimeCount: integer,
  configuredAgentCount: integer,
  countsStatus: status,
  collectionStatus: string(["complete", "partial", "collection_error"]),
  configurations: array(configuration),
  targetResultsStatus: status,
  targetResults: array(
    object({
      scope: string(SCOPES),
      outcome: string(OUTCOMES),
      state: string(STATES),
      verificationStatus: status,
      configurationPosition: position,
      configurationStatus: status,
    }),
  ),
});
const validate = new Ajv({ strict: true }).compile(
  object({
    name: string(["nemoclaw_operation_finished"]),
    ts: timestamp,
    parameters: operationParametersSchema,
  }),
);
export function isOperationEvent(value: unknown): value is TelemetryOperationEvent {
  try {
    assertSafeConfigStructure(value);
  } catch {
    return false;
  }
  if (!validate(value)) return false;
  const event = value as unknown as TelemetryOperationEvent;
  const parameters = event.parameters;
  return (
    Date.parse(parameters.completedAt) >= Date.parse(parameters.startedAt) &&
    parameters.configurations.every(
      (row) =>
        row.defaultAgentModel.status !== "reported" ||
        (row.defaultAgentModel.agentPosition >= 0 &&
          row.defaultAgentModel.modelPosition >= 0 &&
          row.agents[row.defaultAgentModel.agentPosition]?.models[
            row.defaultAgentModel.modelPosition
          ] !== undefined),
    ) &&
    parameters.targetResults.every(
      (target) =>
        target.configurationStatus !== "reported" ||
        (target.configurationPosition >= 0 &&
          parameters.configurations[target.configurationPosition] !== undefined),
    )
  );
}

/** Registration proposal only. Service acceptance and activation require separate approval. */
export function proposedSmsSchema(): Record<string, unknown> {
  return {
    $schema: "http://json-schema.org/draft-07/schema#",
    schemaMeta: {
      schemaVersion: TELEMETRY_SCHEMA_VERSION,
      clientId: TELEMETRY_CLIENT_ID,
      clientName: "NemoClaw",
      definitionVersion: "2.0",
      personalization: "anonymous",
    },
    description:
      "One complete terminal NemoClaw operation record with approved categories and explicit collection status. Production disabled.",
    oneOf: [{ $ref: "#/definitions/events/nemoclaw_operation_finished" }],
    definitions: {
      types: {},
      events: {
        nemoclaw_operation_finished: {
          ...operationParametersSchema,
          description:
            "One complete terminal NemoClaw operation record containing all approved anonymous versions, platform, agent/model/provider associations, settings, messaging, coarse-location status and QA label.",
          eventMeta: {
            service: "telemetry",
            gdpr: {
              category: "functional",
              description:
                "Approved anonymous operation/configuration categories; no entity identifiers, credentials, content, URLs, paths, or IP addresses. Receiver enrichment and applicable consent/privacy requirements require verification.",
            },
          },
        },
      },
    },
  };
}
