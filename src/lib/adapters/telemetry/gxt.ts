// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { classifyTelemetryHostOS } from "../../domain/telemetry/dimensions";
import {
  normalizeTelemetryArchitecture,
  parseTelemetryLocation,
  type TelemetryConfiguration,
  type TelemetryLocation,
  UNKNOWN_TELEMETRY_CONFIGURATION,
} from "../../domain/telemetry/dimensions";
import { parseTelemetryEvent, type TelemetryEvent } from "../../domain/telemetry/event";
import { MAX_TELEMETRY_BATCH_EVENTS } from "../../domain/telemetry/observations";

export const NEMOCLAW_TELEMETRY_CLIENT_ID = "2247027956751513" as const;
export const NEMOCLAW_TELEMETRY_SCHEMA_VERSION = "2.2" as const;
export const GXT_EVENT_PROTOCOL_VERSION = "1.6" as const;
export const NEMOCLAW_TELEMETRY_SYSTEM_VERSION = "nemoclaw-telemetry/2.0" as const;

const PUBLIC_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const HOST_OPERATING_SYSTEMS = ["linux", "macos", "windows", "other", "unknown"] as const;
const HOST_CONTEXTS = ["native", "wsl", "unknown"] as const;

export interface GxtEnvelopeContext {
  clientVersion: string;
  cpuArchitecture: string;
  hostOS: ReturnType<typeof classifyTelemetryHostOS>;
  hostContext: (typeof HOST_CONTEXTS)[number];
  location: Readonly<TelemetryLocation>;
  sentAt: Date;
}

export interface TelemetryEventParameters
  extends
    Omit<TelemetryConfiguration, "webSearchEnabled" | "observabilityEnabled" | "policyTier">,
    Omit<
      TelemetryLocation,
      "countryCode" | "countryName" | "regionName" | "cityName" | "locationObservedAt"
    > {
  webSearchEnabled: "true" | "false" | "unknown";
  observabilityEnabled: "true" | "false" | "unknown";
  policyTier: NonNullable<TelemetryConfiguration["policyTier"]> | "unknown";
  countryCode: string;
  countryName: string;
  regionName: string;
  cityName: string;
  locationObservedAt: string;
  nvidiaSource: "nemoclaw";
  testLabel: string;
  operation: TelemetryEvent["operation"];
  configurationScope:
    | "operation"
    | "primary_configuration"
    | "published_configuration"
    | "aggregate";
  hostOS: ReturnType<typeof classifyTelemetryHostOS>;
  hostContext: (typeof HOST_CONTEXTS)[number];
  hostArch: string;
  count?: number;
  agent_runtime?: string;
  managed_agent_version?: string;
  model_source?: string;
  known_model_key?: string;
  provider_profile?: string;
  api_family?: string;
  messaging_channel?: string;
  scope?: "host" | "sandbox";
  signal?: string;
  value?: string;
}

export interface InstallCompletedTelemetryPayload {
  browserType: "undefined";
  clientId: typeof NEMOCLAW_TELEMETRY_CLIENT_ID;
  clientType: "Native";
  clientVariant: "Release";
  clientVer: string;
  cpuArchitecture: string;
  deviceGdprBehOptIn: "None";
  deviceGdprFuncOptIn: "None";
  deviceGdprTechOptIn: "None";
  deviceId: "undefined";
  deviceMake: "undefined";
  deviceModel: "undefined";
  deviceOS: "undefined";
  deviceOSVersion: "undefined";
  deviceType: "undefined";
  eventProtocol: typeof GXT_EVENT_PROTOCOL_VERSION;
  eventSchemaVer: typeof NEMOCLAW_TELEMETRY_SCHEMA_VERSION;
  eventSysVer: typeof NEMOCLAW_TELEMETRY_SYSTEM_VERSION;
  externalUserId: "undefined";
  gdprBehOptIn: "None";
  gdprFuncOptIn: "None";
  gdprTechOptIn: "None";
  idpId: "undefined";
  integrationId: "undefined";
  productName: "undefined";
  productVersion: "undefined";
  sentTs: string;
  sessionId: "undefined";
  userId: "undefined";
  events: readonly [
    {
      name: TelemetryEvent["event"];
      parameters: TelemetryEventParameters;
      ts: string;
    },
  ];
}

function wireTelemetryFlag(value: boolean | "unknown"): "true" | "false" | "unknown" {
  if (value === "unknown") return value;
  return value ? "true" : "false";
}

export function buildInstallCompletedTelemetryPayload(
  value: unknown,
  context: Readonly<GxtEnvelopeContext>,
): InstallCompletedTelemetryPayload | null {
  const event = parseTelemetryEvent(value);
  if (!event) return null;
  const {
    clientVersion,
    cpuArchitecture,
    hostOS,
    hostContext,
    location: locationValue,
    sentAt,
  } = context;
  const location = parseTelemetryLocation(locationValue);
  if (
    !location ||
    typeof clientVersion !== "string" ||
    clientVersion.length > 128 ||
    !PUBLIC_VERSION_PATTERN.test(clientVersion) ||
    !HOST_OPERATING_SYSTEMS.some((allowed) => allowed === hostOS) ||
    !HOST_CONTEXTS.some((allowed) => allowed === hostContext) ||
    (hostContext === "wsl" && hostOS !== "linux")
  ) {
    return null;
  }

  let timestamp: string;
  try {
    timestamp = Date.prototype.toISOString.call(sentAt);
  } catch {
    return null;
  }

  const architecture = normalizeTelemetryArchitecture(cpuArchitecture);
  const configuration =
    event.event === "nemoclaw_configuration_completed"
      ? event.configuration
      : UNKNOWN_TELEMETRY_CONFIGURATION;
  let configurationScope: TelemetryEventParameters["configurationScope"] = "aggregate";
  if (event.event === "nemoclaw_configuration_completed") {
    configurationScope = event.scope ?? "primary_configuration";
  } else if (event.event === "nemoclaw_install_completed") {
    configurationScope = "operation";
  }

  const measurement: Partial<TelemetryEventParameters> = {};
  switch (event.event) {
    case "nemoclaw_sandbox_count_observed":
      measurement.count = event.count;
      break;
    case "nemoclaw_agent_runtime_observed":
      measurement.count = event.count;
      measurement.agent_runtime = event.agent_runtime;
      break;
    case "nemoclaw_managed_agent_version_observed":
      measurement.count = event.count;
      measurement.agent_runtime = event.agent_runtime;
      measurement.managed_agent_version = event.managed_agent_version;
      break;
    case "nemoclaw_model_observed":
      measurement.count = event.count;
      measurement.model_source = event.model_source;
      measurement.known_model_key = event.known_model_key;
      measurement.modelId = event.modelId;
      if (event.modelId === "unknown") measurement.modelStatus = "not_observed";
      else if (event.modelId === "other") measurement.modelStatus = "unapproved";
      else measurement.modelStatus = "reported";
      measurement.provider_profile = event.provider_profile;
      measurement.providerProfile = event.provider_profile;
      measurement.api_family = event.api_family;
      measurement.apiFamily = event.api_family;
      break;
    case "nemoclaw_messaging_observed":
      measurement.count = event.count;
      measurement.messaging_channel = event.messaging_channel;
      break;
    case "nemoclaw_configuration_observed":
      measurement.scope = event.scope;
      measurement.signal = event.signal;
      measurement.value = event.value;
      measurement.count = event.scope === "sandbox" ? event.count : 1;
      break;
    case "nemoclaw_install_completed":
    case "nemoclaw_configuration_completed":
      break;
  }

  return {
    browserType: "undefined",
    clientId: NEMOCLAW_TELEMETRY_CLIENT_ID,
    clientType: "Native",
    clientVariant: "Release",
    clientVer: clientVersion,
    cpuArchitecture: architecture.cpuArchitecture,
    deviceGdprBehOptIn: "None",
    deviceGdprFuncOptIn: "None",
    deviceGdprTechOptIn: "None",
    deviceId: "undefined",
    deviceMake: "undefined",
    deviceModel: "undefined",
    deviceOS: "undefined",
    deviceOSVersion: "undefined",
    deviceType: "undefined",
    eventProtocol: GXT_EVENT_PROTOCOL_VERSION,
    eventSchemaVer: NEMOCLAW_TELEMETRY_SCHEMA_VERSION,
    eventSysVer: NEMOCLAW_TELEMETRY_SYSTEM_VERSION,
    externalUserId: "undefined",
    gdprBehOptIn: "None",
    gdprFuncOptIn: "None",
    gdprTechOptIn: "None",
    idpId: "undefined",
    integrationId: "undefined",
    productName: "undefined",
    productVersion: "undefined",
    sentTs: timestamp,
    sessionId: "undefined",
    userId: "undefined",
    events: [
      {
        name: event.event,
        parameters: {
          nvidiaSource: "nemoclaw",
          testLabel: event.testLabel ?? "",
          operation: event.operation,
          configurationScope,
          hostOS,
          hostContext,
          hostArch: architecture.hostArch,
          agentHarnessId: configuration.agentHarnessId,
          agentHarnessStatus: configuration.agentHarnessStatus,
          modelId: configuration.modelId,
          modelStatus: configuration.modelStatus,
          providerProfile: configuration.providerProfile,
          apiFamily: configuration.apiFamily,
          sandboxOS: configuration.sandboxOS,
          sandboxOSStatus: configuration.sandboxOSStatus,
          computeDriver: configuration.computeDriver,
          gpuState: configuration.gpuState,
          webSearchEnabled: wireTelemetryFlag(configuration.webSearchEnabled),
          observabilityEnabled: wireTelemetryFlag(configuration.observabilityEnabled),
          imageOwnership: configuration.imageOwnership,
          policyTier: configuration.policyTier ?? "unknown",
          policyTierStatus: configuration.policyTierStatus,
          configuredMessagingChannels: configuration.configuredMessagingChannels,
          messagingStatus: configuration.messagingStatus,
          countryCode: location.countryCode ?? "",
          countryName: location.countryName ?? "",
          regionName: location.regionName ?? "",
          cityName: location.cityName ?? "",
          locationSource: location.locationSource,
          locationStatus: location.locationStatus,
          locationPrecision: location.locationPrecision,
          locationObservedAt: location.locationObservedAt ?? "",
          ...measurement,
        },
        ts: timestamp,
      },
    ],
  };
}

export interface TelemetryBatchPayload extends Omit<InstallCompletedTelemetryPayload, "events"> {
  events: readonly InstallCompletedTelemetryPayload["events"][number][];
}

/** A completed command sends one bounded envelope, never one request per observation. */
export function buildTelemetryBatchPayload(
  value: unknown,
  context: Readonly<GxtEnvelopeContext>,
): TelemetryBatchPayload | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_TELEMETRY_BATCH_EVENTS)
    return null;
  const events: TelemetryEvent[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const event = parseTelemetryEvent(value[index]);
    if (
      !event ||
      (events.length > 0 && event.testLabel !== events[0]?.testLabel) ||
      (events.length > 0 && event.operation !== events[0]?.operation)
    )
      return null;
    if (event.event === "nemoclaw_install_completed" && value.length !== 1) return null;
    events.push(event);
  }
  const snapshot = events.find((event) => event.event === "nemoclaw_sandbox_count_observed");
  if (snapshot) {
    if (
      events.length >= MAX_TELEMETRY_BATCH_EVENTS ||
      events.some(
        (event) => event.event === "nemoclaw_configuration_observed" && event.scope === "host",
      )
    )
      return null;
    let hostPlatform: Exclude<GxtEnvelopeContext["hostOS"], "windows"> | "wsl";
    if (context.hostContext === "wsl") hostPlatform = "wsl";
    else if (context.hostOS === "windows") hostPlatform = "other";
    else hostPlatform = context.hostOS;
    events.push({
      event: "nemoclaw_configuration_observed",
      operation: snapshot.operation,
      scope: "host",
      signal: "host_platform",
      value: hostPlatform,
      ...(snapshot.testLabel === undefined ? {} : { testLabel: snapshot.testLabel }),
    });
  }
  let envelope: InstallCompletedTelemetryPayload | null = null;
  const records: InstallCompletedTelemetryPayload["events"][number][] = [];
  for (const event of events) {
    const payload = buildInstallCompletedTelemetryPayload(event, context);
    if (!payload) return null;
    envelope ??= payload;
    records.push(payload.events[0]);
  }
  return envelope ? { ...envelope, events: Object.freeze(records) } : null;
}
