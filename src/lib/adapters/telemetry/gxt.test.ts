// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  EMPTY_TELEMETRY_LOCATION,
  type TelemetryConfiguration,
  type TelemetryLocation,
  UNKNOWN_TELEMETRY_CONFIGURATION,
} from "../../domain/telemetry/dimensions";
import { buildInstallCompletedEvent, type TelemetryEvent } from "../../domain/telemetry/event";
import { MAX_TELEMETRY_BATCH_EVENTS, SANDBOX_SIGNALS } from "../../domain/telemetry/observations";
import {
  buildInstallCompletedTelemetryPayload,
  buildTelemetryBatchPayload,
  GXT_EVENT_PROTOCOL_VERSION,
  NEMOCLAW_TELEMETRY_CLIENT_ID,
  NEMOCLAW_TELEMETRY_SCHEMA_VERSION,
  NEMOCLAW_TELEMETRY_SYSTEM_VERSION,
  type GxtEnvelopeContext,
} from "./gxt";
import {
  acceptsFamilyParameters,
  acceptsSmsRegistrationParameters,
  acceptsTelemetryParameters,
  hasCompatibleTelemetryMetadata,
} from "./gxt.test-support";

const sentAt = new Date("2026-09-30T12:34:56.789Z");
const publicModelCodes = { qwen: "qwen3_6_27b_fp8" };
const context = {
  clientVersion: "0.1.0",
  cpuArchitecture: "arm64",
  hostOS: "macos",
  hostContext: "native",
  location: EMPTY_TELEMETRY_LOCATION,
  sentAt,
} satisfies GxtEnvelopeContext;

const configuration: TelemetryConfiguration = {
  ...UNKNOWN_TELEMETRY_CONFIGURATION,
  agentHarnessId: "hermes",
  agentHarnessStatus: "reported",
  modelId: "nvidia/nemotron-3-ultra-550b-a55b",
  modelStatus: "reported",
  providerProfile: "vllm",
  apiFamily: "openai-completions",
  sandboxOS: "linux",
  sandboxOSStatus: "reported",
  computeDriver: "docker",
  gpuState: "verified",
  webSearchEnabled: true,
  observabilityEnabled: false,
  imageOwnership: "managed",
  configuredMessagingChannels: ["slack", "discord"],
  messagingStatus: "reported",
};

const location: TelemetryLocation = {
  countryCode: "US",
  countryName: "United States",
  regionName: "California",
  cityName: "San Jose",
  locationSource: "approved_network_origin",
  locationStatus: "reported",
  locationPrecision: "city",
  locationObservedAt: "2026-09-30T12:34:55.000Z",
};

const operationParameters = {
  nvidiaSource: "nemoclaw",
  testLabel: "",
  operation: "install",
  configurationScope: "operation",
  hostOS: "macos",
  hostContext: "native",
  hostArch: "arm64",
  agentHarnessId: "unknown",
  agentHarnessStatus: "not_observed",
  modelId: "unknown",
  modelStatus: "not_observed",
  providerProfile: "unknown",
  apiFamily: "unknown",
  sandboxOS: "unknown",
  sandboxOSStatus: "not_observed",
  computeDriver: "unknown",
  gpuState: "unknown",
  webSearchEnabled: "unknown",
  observabilityEnabled: "unknown",
  imageOwnership: "unknown",
  policyTier: "unknown",
  policyTierStatus: "not_persisted",
  configuredMessagingChannels: [],
  messagingStatus: "not_observed",
  countryCode: "",
  countryName: "",
  regionName: "",
  cityName: "",
  locationSource: "none",
  locationStatus: "not_configured",
  locationPrecision: "none",
  locationObservedAt: "",
};

describe("GXT installer telemetry envelope", () => {
  it("builds the fixed anonymous envelope around one closed event (#11109)", () => {
    expect(
      buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), context),
    ).toEqual({
      browserType: "undefined",
      clientId: NEMOCLAW_TELEMETRY_CLIENT_ID,
      clientType: "Native",
      clientVariant: "Release",
      clientVer: "0.1.0",
      cpuArchitecture: "aarch64",
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
      sentTs: "2026-09-30T12:34:56.789Z",
      sessionId: "undefined",
      userId: "undefined",
      events: [
        {
          name: "nemoclaw_install_completed",
          parameters: operationParameters,
          ts: "2026-09-30T12:34:56.789Z",
        },
      ],
    });
  });

  it.each(["install", "update"] as const)(
    "keeps %s parameters compatible with the upload-ready schema (#11109)",
    (operation) => {
      const payload = buildInstallCompletedTelemetryPayload(
        buildInstallCompletedEvent(operation),
        context,
      );

      expect(payload).not.toBeNull();
      expect(hasCompatibleTelemetryMetadata(payload)).toBe(true);
      expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
    },
  );

  it.each([
    { name: "missing payload", payload: null },
    {
      name: "different client",
      payload: { clientId: "different-client", eventSchemaVer: NEMOCLAW_TELEMETRY_SCHEMA_VERSION },
    },
    {
      name: "different schema version",
      payload: { clientId: NEMOCLAW_TELEMETRY_CLIENT_ID, eventSchemaVer: "1.0" },
    },
  ])("rejects incompatible telemetry metadata for $name (#11109)", ({ payload }) => {
    expect(hasCompatibleTelemetryMetadata(payload)).toBe(false);
  });

  it("rejects invalid events and envelope metadata before serialization (#11109)", () => {
    expect(
      buildInstallCompletedTelemetryPayload(
        { event: "nemoclaw_install_completed", operation: "install", detail: "free-form" },
        context,
      ),
    ).toBeNull();
    expect(
      buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), {
        ...context,
        clientVersion: "free-form",
      }),
    ).toBeNull();
    expect(
      buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), {
        ...context,
        sentAt: new Date(Number.NaN),
      }),
    ).toBeNull();
  });

  it("maps an unknown architecture to the anonymous sentinel (#11109)", () => {
    const payload = buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("update"), {
      ...context,
      cpuArchitecture: "custom-host-architecture",
    });

    expect(payload?.cpuArchitecture).toBe("undefined");
    expect(payload?.events[0].parameters.hostArch).toBe("unknown");
  });

  it.each(["onboard", "inference_set"] as const)(
    "preserves every approved field in a completed %s configuration (#10440)",
    (operation) => {
      const payload = buildInstallCompletedTelemetryPayload(
        { event: "nemoclaw_configuration_completed", operation, configuration },
        { ...context, location },
      );

      expect(payload?.events).toEqual([
        {
          name: "nemoclaw_configuration_completed",
          parameters: {
            ...operationParameters,
            ...configuration,
            ...location,
            webSearchEnabled: "true",
            observabilityEnabled: "false",
            policyTier: "unknown",
            operation,
            configurationScope: "primary_configuration",
          },
          ts: "2026-09-30T12:34:56.789Z",
        },
      ]);
      expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
      expect(payload?.cpuArchitecture).toBe("aarch64");
      expect(payload?.events[0].parameters.hostArch).toBe("arm64");
      expect(JSON.stringify(payload)).not.toContain("NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4");
    },
  );

  it.each(
    (["openclaw", "hermes", "langchain-deepagents-code"] as const).flatMap((agentHarnessId) =>
      (
        [
          "Qwen/Qwen3.6-27B-FP8",
          "nvidia/nemotron-3-ultra-550b-a55b",
          "nvidia/nvidia/nemotron-3-ultra",
          "deepseek-ai/DeepSeek-V4-Flash",
        ] as const
      ).map((modelId) => ({ agentHarnessId, modelId })),
    ),
  )(
    "retains the approved $agentHarnessId runtime with public model $modelId (#10440)",
    ({ agentHarnessId, modelId }) => {
      const payload = buildInstallCompletedTelemetryPayload(
        {
          event: "nemoclaw_configuration_completed",
          operation: "onboard",
          configuration: { ...configuration, agentHarnessId, modelId },
        },
        context,
      );
      expect(payload?.events[0].parameters.agentHarnessId).toBe(agentHarnessId);
      expect(payload?.events[0].parameters.modelId).toBe(modelId);
      expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
    },
  );

  it("keeps partial geography and its collection status in the complete payload (#10440)", () => {
    const payload = buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), {
      ...context,
      location: {
        ...location,
        regionName: null,
        cityName: null,
        locationStatus: "partial",
        locationPrecision: "country",
      },
    });

    expect(payload?.events[0].parameters).toEqual({
      ...operationParameters,
      ...location,
      regionName: "",
      cityName: "",
      locationStatus: "partial",
      locationPrecision: "country",
    });
    expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
  });

  it.each([
    { name: "private model", extra: { modelId: "private-company/secret-model" } },
    { name: "private endpoint", extra: { endpointUrl: "https://private.example/v1" } },
    { name: "synthetic record ID", extra: { recordId: "synthetic:fixture:1" } },
    { name: "synthetic marker", extra: { isSynthetic: true } },
    { name: "synthetic data kind", extra: { dataKind: "synthetic" } },
    { name: "synthetic batch ID", extra: { batchId: "test-batch" } },
    { name: "synthetic schema version", extra: { testSchemaVersion: "1.0" } },
    { name: "contradictory agent status", extra: { agentHarnessStatus: "not_observed" } },
    { name: "unpersisted policy tier", extra: { policyTier: "balanced" } },
    {
      name: "duplicate messaging channel",
      extra: { configuredMessagingChannels: ["slack", "slack"] },
    },
  ])("rejects completed configuration containing $name (#10440)", ({ extra }) => {
    expect(
      buildInstallCompletedTelemetryPayload(
        {
          event: "nemoclaw_configuration_completed",
          operation: "onboard",
          configuration: { ...configuration, ...extra },
        },
        context,
      ),
    ).toBeNull();
  });

  it("rejects a synthetic marker outside completed configuration (#10440)", () => {
    const event = {
      event: "nemoclaw_configuration_completed",
      operation: "onboard",
      configuration,
    };
    expect(
      buildInstallCompletedTelemetryPayload({ ...event, isSynthetic: true }, context),
    ).toBeNull();
  });

  it.each(Object.keys(operationParameters))("requires telemetry parameter %s (#10440)", (field) => {
    const payload = buildInstallCompletedTelemetryPayload(
      { event: "nemoclaw_configuration_completed", operation: "onboard", configuration },
      { ...context, location },
    );
    const parameters = payload?.events[0].parameters;
    expect(parameters).toBeDefined();
    const incomplete: Record<string, unknown> = { ...parameters };
    delete incomplete[field];
    expect(acceptsTelemetryParameters(incomplete)).toBe(false);
  });

  it.each([
    { name: "private model", invalid: { modelId: "private-model" } },
    { name: "contradictory model status", invalid: { modelStatus: "not_observed" } },
    { name: "invalid sandbox status", invalid: { sandboxOSStatus: "unapproved" } },
    { name: "invalid country code", invalid: { countryCode: "USA" } },
    { name: "contradictory geography precision", invalid: { locationPrecision: "country" } },
    { name: "contradictory geography source", invalid: { locationSource: "none" } },
    { name: "contradictory geography status", invalid: { locationStatus: "partial" } },
    { name: "private city URL", invalid: { cityName: "https://private.example" } },
    { name: "IP address as city", invalid: { cityName: "192.0.2.1" } },
    { name: "embedded IP address in city", invalid: { cityName: "San Jose (192.0.2.1)" } },
    { name: "embedded coordinates in city", invalid: { cityName: "San Jose 37.123,-121.456" } },
    { name: "leading city whitespace", invalid: { cityName: " San Jose" } },
    { name: "trailing city whitespace", invalid: { cityName: "San Jose " } },
    { name: "city control character", invalid: { cityName: "San\nJose" } },
    { name: "overlong city", invalid: { cityName: "x".repeat(97) } },
    { name: "invalid calendar date", invalid: { locationObservedAt: "2026-02-30T12:34:55.000Z" } },
    { name: "invalid hour", invalid: { locationObservedAt: "2026-09-30T25:34:55.000Z" } },
    { name: "device identifier", invalid: { deviceId: "private-device" } },
    { name: "synthetic marker", invalid: { isSynthetic: true } },
    { name: "contradictory messaging status", invalid: { messagingStatus: "not_observed" } },
    { name: "contradictory host context", invalid: { hostContext: "wsl" } },
  ])("rejects telemetry parameters containing $name (#10440)", ({ invalid }) => {
    const payload = buildInstallCompletedTelemetryPayload(
      { event: "nemoclaw_configuration_completed", operation: "onboard", configuration },
      { ...context, location },
    );
    expect(payload).not.toBeNull();
    expect(acceptsTelemetryParameters({ ...payload?.events[0].parameters, ...invalid })).toBe(
      false,
    );
  });

  it("rejects duplicate channels before encoding even though SMS cannot enforce uniqueness (#11109)", () => {
    const event = {
      event: "nemoclaw_configuration_completed",
      operation: "onboard",
      configuration,
    };
    const payload = buildInstallCompletedTelemetryPayload(event, context);
    expect(payload).not.toBeNull();
    const parameters = payload?.events[0].parameters;
    // SMS rejects uniqueItems; client and receiver validation own channel uniqueness.
    expect(
      acceptsTelemetryParameters({
        ...parameters,
        configuredMessagingChannels: ["slack", "slack"],
      }),
    ).toBe(true);
    expect(
      acceptsTelemetryParameters({
        ...parameters,
        configuredMessagingChannels: ["private-channel"],
      }),
    ).toBe(false);
    expect(
      acceptsTelemetryParameters({
        ...parameters,
        configuredMessagingChannels: Array(9).fill("slack"),
      }),
    ).toBe(false);
    const duplicate = {
      ...event,
      configuration: { ...configuration, configuredMessagingChannels: ["slack", "slack"] },
    };
    expect(buildInstallCompletedTelemetryPayload(duplicate, context)).toBeNull();
    expect(buildTelemetryBatchPayload([duplicate], context)).toBeNull();
  });

  it("copies only validated fields without serialization or iterator overrides (#10440)", () => {
    const channels = ["slack"];
    Object.defineProperty(channels, Symbol.iterator, {
      value: () => ["private-channel"][Symbol.iterator](),
    });
    Object.defineProperty(channels, "toJSON", { value: () => ["private-channel"] });
    const observedConfiguration = { ...configuration, configuredMessagingChannels: channels };
    Object.defineProperty(observedConfiguration, "toJSON", {
      value: () => ({ privateModel: "private-company/model" }),
    });
    const observedLocation = { ...location };
    Object.defineProperty(observedLocation, "toJSON", {
      value: () => ({ privateAddress: "private-host.example" }),
    });
    const payload = buildInstallCompletedTelemetryPayload(
      {
        event: "nemoclaw_configuration_completed",
        operation: "onboard",
        configuration: observedConfiguration,
      },
      { ...context, location: observedLocation },
    );
    expect(payload?.events[0].parameters.configuredMessagingChannels).toEqual(["slack"]);
    expect(payload?.events[0].parameters.cityName).toBe("San Jose");
    expect(JSON.stringify(payload)).not.toContain("private-");
    expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
  });

  it("uses the actual Date value rather than an overridden timestamp method (#10440)", () => {
    const timestamp = new Date(sentAt);
    timestamp.toISOString = () => "private-timestamp";
    const payload = buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), {
      ...context,
      sentAt: timestamp,
    });
    expect(payload?.sentTs).toBe("2026-09-30T12:34:56.789Z");
  });

  it("validates and serializes the same observed context values (#10440)", () => {
    const observed = { ...context };
    const reads = { clientVersion: 0, hostOS: 0, hostContext: 0 };
    Object.defineProperty(observed, "clientVersion", {
      get: () => (++reads.clientVersion === 1 ? "0.1.0" : "private-version"),
    });
    Object.defineProperty(observed, "hostOS", {
      get: () => (++reads.hostOS === 1 ? "macos" : "private-host"),
    });
    Object.defineProperty(observed, "hostContext", {
      get: () => (++reads.hostContext === 1 ? "native" : "private-context"),
    });
    const payload = buildInstallCompletedTelemetryPayload(
      buildInstallCompletedEvent("install"),
      observed,
    );
    expect(payload?.clientVer).toBe("0.1.0");
    expect(payload?.events[0].parameters.hostOS).toBe("macos");
    expect(payload?.events[0].parameters.hostContext).toBe("native");
    expect(reads).toEqual({ clientVersion: 1, hostOS: 1, hostContext: 1 });
    expect(JSON.stringify(payload)).not.toContain("private-");
  });

  it.each([
    {
      hostOS: "linux",
      hostContext: "wsl",
      cpuArchitecture: "x64",
      hostArch: "x64",
      normalized: "x86_64",
    },
    {
      hostOS: "windows",
      hostContext: "native",
      cpuArchitecture: "arm64",
      hostArch: "arm64",
      normalized: "aarch64",
    },
    {
      hostOS: "unknown",
      hostContext: "unknown",
      cpuArchitecture: "private-architecture",
      hostArch: "unknown",
      normalized: "undefined",
    },
  ] as const)(
    "preserves host fields separately from sandbox fields on $hostOS/$hostContext (#10440)",
    (host) => {
      const payload = buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), {
        ...context,
        ...host,
      });
      expect(payload?.events[0].parameters.hostOS).toBe(host.hostOS);
      expect(payload?.events[0].parameters.hostArch).toBe(host.hostArch);
      expect(payload?.events[0].parameters.sandboxOS).toBe("unknown");
      expect(payload?.cpuArchitecture).toBe(host.normalized);
      expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
    },
  );
});

const familyFixtures: TelemetryEvent[] = [
  { event: "nemoclaw_install_completed", operation: "install" },
  {
    event: "nemoclaw_configuration_completed",
    operation: "onboard",
    configuration: { ...configuration, policyTier: "balanced", policyTierStatus: "reported" },
    scope: "published_configuration",
  },
  { event: "nemoclaw_sandbox_count_observed", operation: "onboard", count: 2 },
  {
    event: "nemoclaw_agent_runtime_observed",
    operation: "onboard",
    agent_runtime: "hermes",
    count: 2,
  },
  {
    event: "nemoclaw_managed_agent_version_observed",
    operation: "onboard",
    agent_runtime: "hermes",
    managed_agent_version: "other",
    count: 2,
  },
  {
    event: "nemoclaw_model_observed",
    operation: "onboard",
    model_source: "custom",
    known_model_key: publicModelCodes.qwen,
    modelId: "Qwen/Qwen3.6-27B-FP8",
    provider_profile: "nvidia",
    api_family: "openai-completions",
    count: 2,
  },
  {
    event: "nemoclaw_messaging_observed",
    operation: "onboard",
    messaging_channel: "slack",
    count: 2,
  },
  {
    event: "nemoclaw_configuration_observed",
    operation: "onboard",
    scope: "sandbox",
    signal: "policy_tier",
    value: "balanced",
    count: 2,
  },
  {
    event: "nemoclaw_configuration_observed",
    operation: "onboard",
    scope: "host",
    signal: "host_platform",
    value: "macos",
  },
];

const measurementFields: Record<TelemetryEvent["event"], readonly string[]> = {
  nemoclaw_install_completed: [],
  nemoclaw_configuration_completed: [],
  nemoclaw_sandbox_count_observed: ["count"],
  nemoclaw_agent_runtime_observed: ["agent_runtime", "count"],
  nemoclaw_managed_agent_version_observed: ["agent_runtime", "managed_agent_version", "count"],
  nemoclaw_model_observed: [
    "model_source",
    "known_model_key",
    "provider_profile",
    "api_family",
    "count",
  ],
  nemoclaw_messaging_observed: ["messaging_channel", "count"],
  nemoclaw_configuration_observed: ["scope", "signal", "value", "count"],
};

const publishedFamilyFixtures = familyFixtures.filter(
  (event) =>
    event.event !== "nemoclaw_install_completed" &&
    !(event.event === "nemoclaw_configuration_observed" && event.scope === "host"),
);

describe("complete telemetry wire batches", () => {
  it("rejects an invalid QA event before reading envelope context", () => {
    let reads = 0;
    const observed = Object.defineProperty({ ...context }, "location", {
      get: () => {
        reads += 1;
        return location;
      },
    });
    expect(
      buildInstallCompletedTelemetryPayload(
        { ...familyFixtures[0], testLabel: "private@example.com" },
        observed,
      ),
    ).toBeNull();
    expect(
      buildTelemetryBatchPayload(
        [{ ...familyFixtures[2], testLabel: "private@example.com" }],
        observed,
      ),
    ).toBeNull();
    expect(reads).toBe(0);
  });

  it.each(familyFixtures)("retains a temporary test label in every $event", (event) => {
    const testLabel = "qa-shanghai-20261005:linux-docker-openclaw:attempt-1";
    const payload = buildInstallCompletedTelemetryPayload({ ...event, testLabel }, context);
    expect(payload?.events[0].parameters.testLabel).toBe(testLabel);
    expect(acceptsFamilyParameters(event.event, payload?.events[0].parameters)).toBe(true);
    const ordinary = buildInstallCompletedTelemetryPayload(event, context);
    expect(ordinary?.events[0].parameters.testLabel).toBe("");
    expect(
      acceptsFamilyParameters(event.event, { ...ordinary?.events[0].parameters, testLabel }),
    ).toBe(true);
  });

  it.each(["qa-a:b:attempt-0", "qa-a:b:attempt-1\n", "private@example.com"])(
    "rejects malformed test label %j in runtime and registered schema",
    (testLabel) => {
      const event = familyFixtures[0];
      expect(buildInstallCompletedTelemetryPayload({ ...event, testLabel }, context)).toBeNull();
      expect(
        acceptsFamilyParameters("nemoclaw_install_completed", {
          ...operationParameters,
          testLabel,
        }),
      ).toBe(false);
    },
  );

  it("retains a uniform label in the whole batch and host row but rejects mixed labels", () => {
    const testLabel = "qa-shanghai-20261005:linux-docker-openclaw:attempt-1";
    const labeled = familyFixtures
      .filter(
        (event) =>
          event.event !== "nemoclaw_install_completed" &&
          !(event.event === "nemoclaw_configuration_observed" && event.scope === "host"),
      )
      .map((event) => ({ ...event, testLabel }));
    const payload = buildTelemetryBatchPayload(labeled, context);
    expect(payload).not.toBeNull();
    expect(payload?.events.every((event) => event.parameters.testLabel === testLabel)).toBe(true);
    expect(
      payload?.events.some(
        (event) =>
          event.name === "nemoclaw_configuration_observed" && event.parameters.scope === "host",
      ),
    ).toBe(true);
    expect(
      buildTelemetryBatchPayload(
        [labeled[0], { ...labeled[1], testLabel: "qa-other:case:attempt-2" }],
        context,
      ),
    ).toBeNull();
    expect(buildTelemetryBatchPayload([labeled[0], familyFixtures[2]], context)).toBeNull();
  });

  it("requires an explicit ordinary empty string or a valid QA marker on the wire", () => {
    const { testLabel: _ordinary, ...missing } = operationParameters;
    expect(acceptsTelemetryParameters(missing)).toBe(false);
    expect(acceptsTelemetryParameters({ ...operationParameters, testLabel: null })).toBe(false);
    expect(
      buildInstallCompletedTelemetryPayload({ ...familyFixtures[0], testLabel: "" }, context),
    ).toBeNull();
    expect(acceptsTelemetryParameters(operationParameters)).toBe(true);
  });

  it.each(familyFixtures)(
    "validates synthetic $event parameters through their registered family (#10435)",
    (event) => {
      const payload = buildInstallCompletedTelemetryPayload(event, context);
      expect(payload).not.toBeNull();
      expect(acceptsFamilyParameters(event.event, payload?.events[0].parameters)).toBe(true);
      expect(acceptsTelemetryParameters(payload?.events[0].parameters)).toBe(true);
      expect(payload?.clientVer).toBe("0.1.0");
      expect(payload?.cpuArchitecture).toBe("aarch64");
      expect(payload?.events[0].ts).toBe(payload?.sentTs);
      expect(payload?.events[0].parameters.locationStatus).toBe("not_configured");
      expect(payload?.events[0].parameters).toMatchObject({
        countryCode: "",
        countryName: "",
        regionName: "",
        cityName: "",
        locationObservedAt: "",
      });
      expect(typeof payload?.events[0].parameters.webSearchEnabled).toBe("string");
      expect(typeof payload?.events[0].parameters.observabilityEnabled).toBe("string");
      expect(typeof payload?.events[0].parameters.count).toBe(
        measurementFields[event.event].includes("count") ? "number" : "undefined",
      );
    },
  );

  it.each(
    ([true, false, "unknown"] as const).flatMap((webSearchEnabled) =>
      ([true, false, "unknown"] as const).map((observabilityEnabled) => ({
        webSearchEnabled,
        observabilityEnabled,
      })),
    ),
  )(
    "encodes flags losslessly as scalar strings: $webSearchEnabled / $observabilityEnabled",
    (flags) => {
      const original = { ...configuration, ...flags };
      const payload = buildInstallCompletedTelemetryPayload(
        {
          event: "nemoclaw_configuration_completed",
          operation: "onboard",
          configuration: original,
        },
        context,
      );
      expect(payload?.events[0].parameters.webSearchEnabled).toBe(String(flags.webSearchEnabled));
      expect(payload?.events[0].parameters.observabilityEnabled).toBe(
        String(flags.observabilityEnabled),
      );
      expect(original.webSearchEnabled).toBe(flags.webSearchEnabled);
      expect(original.observabilityEnabled).toBe(flags.observabilityEnabled);
      expect(
        acceptsFamilyParameters("nemoclaw_configuration_completed", payload?.events[0].parameters),
      ).toBe(true);
    },
  );

  it.each([
    { status: "not_configured", source: "none", precision: "none", region: null, city: null },
    {
      status: "unavailable",
      source: "approved_deployment",
      precision: "none",
      region: null,
      city: null,
    },
    {
      status: "partial",
      source: "approved_deployment",
      precision: "country",
      region: null,
      city: null,
    },
    {
      status: "partial",
      source: "approved_deployment",
      precision: "region",
      region: "California",
      city: null,
    },
    {
      status: "partial",
      source: "approved_deployment",
      precision: "city",
      region: null,
      city: "San Jose",
    },
    {
      status: "reported",
      source: "approved_deployment",
      precision: "city",
      region: "unknown",
      city: "unknown",
    },
  ] as const)("preserves empty-value geography semantics for $status / $precision", (sample) => {
    const observed =
      sample.precision === "none"
        ? {
            ...EMPTY_TELEMETRY_LOCATION,
            locationStatus: sample.status,
            locationSource: sample.source,
          }
        : {
            ...location,
            regionName: sample.region,
            cityName: sample.city,
            locationStatus: sample.status,
            locationSource: sample.source,
            locationPrecision: sample.precision,
          };
    const payload = buildInstallCompletedTelemetryPayload(familyFixtures[0], {
      ...context,
      location: observed,
    });
    expect(payload).not.toBeNull();
    expect(payload?.events[0].parameters.countryCode).toBe(observed.countryCode ?? "");
    expect(payload?.events[0].parameters.countryName).toBe(observed.countryName ?? "");
    expect(payload?.events[0].parameters.regionName).toBe(observed.regionName ?? "");
    expect(payload?.events[0].parameters.cityName).toBe(observed.cityName ?? "");
    expect(payload?.events[0].parameters.locationObservedAt).toBe(
      observed.locationObservedAt ?? "",
    );
    expect(
      acceptsFamilyParameters("nemoclaw_install_completed", payload?.events[0].parameters),
    ).toBe(true);
  });

  it.each([
    { countryCode: null },
    { countryName: null },
    { regionName: null },
    { cityName: null },
    { locationObservedAt: null },
    { policyTier: null },
    { webSearchEnabled: true },
    { webSearchEnabled: false },
    { webSearchEnabled: "False" },
    { observabilityEnabled: true },
    { observabilityEnabled: false },
    { observabilityEnabled: 0 },
    { policyTier: "unknown", policyTierStatus: "reported" },
    { countryCode: "US" },
    { cityName: "San Jose" },
    { locationObservedAt: "2026-09-30T12:34:55.000Z" },
  ])("rejects non-scalar or contradictory unavailable wire values %j", (invalid) => {
    expect(
      acceptsFamilyParameters("nemoclaw_install_completed", { ...operationParameters, ...invalid }),
    ).toBe(false);
  });

  it.each([
    { countryCode: "" },
    { countryName: "" },
    { regionName: "" },
    { cityName: "" },
    { locationObservedAt: "" },
    { locationObservedAt: "2026-02-30T12:34:55.000Z" },
    { locationObservedAt: "2026-09-30T12:34:55.000Z\n" },
    { cityName: "San Jose\n" },
    { locationStatus: "unavailable" },
    { locationPrecision: "country" },
  ])("rejects incomplete or contradictory reported scalar geography %j", (invalid) => {
    const payload = buildInstallCompletedTelemetryPayload(familyFixtures[0], {
      ...context,
      location,
    });
    expect(
      acceptsFamilyParameters("nemoclaw_install_completed", {
        ...payload?.events[0].parameters,
        ...invalid,
      }),
    ).toBe(false);
  });

  it.each(familyFixtures)(
    "rejects unrelated measurement fields from $event parameters (#10435)",
    (event) => {
      const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0]
        .parameters;
      const unrelated =
        event.event === "nemoclaw_model_observed"
          ? { messaging_channel: "slack" }
          : { model_source: "custom" };
      expect(acceptsFamilyParameters(event.event, { ...parameters, ...unrelated })).toBe(false);
      expect(
        acceptsFamilyParameters(event.event, {
          ...parameters,
          endpointUrl: "https://private.invalid",
        }),
      ).toBe(false);
      expect(acceptsFamilyParameters(event.event, { ...parameters, isSynthetic: true })).toBe(
        false,
      );
    },
  );

  it.each(familyFixtures)(
    "keeps $event measurements separate from the common complete-record fields (#10435)",
    (event) => {
      const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0]
        .parameters;
      expect(Object.keys(parameters ?? {}).sort()).toEqual(
        [...Object.keys(operationParameters), ...measurementFields[event.event]].sort(),
      );
    },
  );

  it.each(
    familyFixtures.flatMap((event) =>
      measurementFields[event.event].map((field) => ({ event, field })),
    ),
  )("requires owned measurement $field on $event.event (#10435)", ({ event, field }) => {
    const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0].parameters;
    const incomplete: Record<string, unknown> = { ...parameters };
    delete incomplete[field];
    expect(acceptsFamilyParameters(event.event, incomplete)).toBe(false);
  });

  it("sends one shared envelope and adds one host observation to a published snapshot (#10442)", () => {
    const events = familyFixtures.filter(
      (event) =>
        event.event !== "nemoclaw_install_completed" &&
        !(event.event === "nemoclaw_configuration_observed" && event.scope === "host"),
    );
    const payload = buildTelemetryBatchPayload(events, context);
    expect(payload?.events).toHaveLength(events.length + 1);
    expect(
      payload?.events.filter(
        (event) =>
          event.name === "nemoclaw_configuration_observed" && event.parameters.scope === "host",
      ),
    ).toEqual([
      {
        name: "nemoclaw_configuration_observed",
        ts: context.sentAt.toISOString(),
        parameters: {
          ...operationParameters,
          operation: "onboard",
          configurationScope: "aggregate",
          scope: "host",
          signal: "host_platform",
          value: "macos",
          count: 1,
        },
      },
    ]);
    expect(payload).toMatchObject({
      gdprTechOptIn: "None",
      gdprBehOptIn: "None",
      gdprFuncOptIn: "None",
      deviceGdprTechOptIn: "None",
      deviceGdprBehOptIn: "None",
      deviceGdprFuncOptIn: "None",
    });
  });

  it.each(Array.from({ length: publishedFamilyFixtures.length + 1 }, (_, index) => index))(
    "validates published batch record %s with its family schema and shared timestamp (#10442)",
    (index) => {
      const payload = buildTelemetryBatchPayload(publishedFamilyFixtures, context);
      const event = payload?.events[index];
      expect(event?.ts).toBe(payload?.sentTs);
      expect(acceptsFamilyParameters(event!.name, event!.parameters)).toBe(true);
    },
  );

  it("rejects an invalid middle record without retaining a partial batch (#10435)", () => {
    const valid = familyFixtures[2];
    expect(
      buildTelemetryBatchPayload([valid, { ...valid, endpointUrl: "private" }, valid], context),
    ).toBeNull();
    expect(
      buildTelemetryBatchPayload([valid, { ...valid, operation: "restore" }], context),
    ).toBeNull();
    expect(buildTelemetryBatchPayload([familyFixtures[0], valid], context)).toBeNull();
  });

  it("reserves the final batch slot for the automatically collected host observation (#10442)", () => {
    const count = familyFixtures[2];
    expect(
      buildTelemetryBatchPayload(
        Array.from({ length: MAX_TELEMETRY_BATCH_EVENTS }, () => count),
        context,
      ),
    ).toBeNull();
    expect(buildTelemetryBatchPayload([], context)).toBeNull();
    expect(buildTelemetryBatchPayload([count, familyFixtures[8]], context)).toBeNull();
  });

  it.each([
    { policyTier: null, policyTierStatus: "reported" },
    { policyTier: "balanced", policyTierStatus: "invalid" },
    { policyTier: "balanced", policyTierStatus: "not_observed" },
    { policyTier: "balanced", policyTierStatus: "not_persisted" },
  ])("rejects policy value and status contradictions in wire parameters (#10448)", (invalid) => {
    const event = familyFixtures[1];
    const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0].parameters;
    expect(acceptsFamilyParameters(event.event, { ...parameters, ...invalid })).toBe(false);
  });

  it.each([
    { known_model_key: "deepseek_v4_flash" },
    { providerProfile: "openai" },
    { apiFamily: "openai-responses" },
    { modelId: "private-company/model" },
    { count: 0 },
    { count: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects contradictory or private model wire parameters (#10445)", (invalid) => {
    const event = familyFixtures[5];
    const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0].parameters;
    expect(acceptsFamilyParameters(event.event, { ...parameters, ...invalid })).toBe(false);
  });

  it.each([
    ["nvidia/nvidia/nemotron-3-ultra", "nemotron3_ultra"],
    ["nvidia/nemotron-3-ultra-550b-a55b", "nemotron3_ultra_550b_a55b"],
  ] as const)(
    "encodes public model %s with its own key and recorded route (#10445)",
    (modelId, known_model_key) => {
      const event = {
        event: "nemoclaw_model_observed",
        operation: "inference_set",
        model_source: "custom",
        modelId,
        known_model_key,
        provider_profile: "compatible-endpoint",
        api_family: "openai-completions",
        count: 1,
      } as const;
      const payload = buildInstallCompletedTelemetryPayload(event, context);
      const parameters = payload?.events[0].parameters;
      expect(payload?.eventSchemaVer).toBe("2.2");
      expect(hasCompatibleTelemetryMetadata(payload)).toBe(true);
      expect(parameters).toMatchObject({
        modelId,
        modelStatus: "reported",
        known_model_key,
        model_source: "custom",
        provider_profile: "compatible-endpoint",
        providerProfile: "compatible-endpoint",
        api_family: "openai-completions",
        apiFamily: "openai-completions",
      });
      expect(acceptsFamilyParameters(event.event, parameters)).toBe(true);
      const otherKey =
        known_model_key === "nemotron3_ultra" ? "nemotron3_ultra_550b_a55b" : "nemotron3_ultra";
      expect(
        buildInstallCompletedTelemetryPayload({ ...event, known_model_key: otherKey }, context),
      ).toBeNull();
      expect(
        acceptsFamilyParameters(event.event, { ...parameters, known_model_key: otherKey }),
      ).toBe(false);
    },
  );

  it.each(
    [
      ["nvidia/nvidia/nemotron-3-ultra", "nemotron3_ultra"],
      ["nvidia/nemotron-3-ultra-550b-a55b", "nemotron3_ultra_550b_a55b"],
    ].flatMap(([modelId, modelCode]) =>
      ["private-company/model", `${modelId}/private-alias`, "nvidia/nemotron-3-ultra"].map(
        (privateModel) => ({ modelId, modelCode, privateModel }),
      ),
    ),
  )(
    "rejects private model $privateModel for public model $modelId (#10445)",
    ({ modelId, modelCode, privateModel }) => {
      const event = {
        event: "nemoclaw_model_observed",
        operation: "inference_set",
        model_source: "custom",
        modelId,
        known_model_key: modelCode,
        provider_profile: "compatible-endpoint",
        api_family: "openai-completions",
        count: 1,
      } as const;
      const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0]
        .parameters;
      expect(
        buildInstallCompletedTelemetryPayload({ ...event, modelId: privateModel }, context),
      ).toBeNull();
      const invalid = { ...parameters, modelId: privateModel };
      expect(acceptsFamilyParameters(event.event, invalid)).toBe(false);
      expect(acceptsSmsRegistrationParameters(invalid, event.event)).toBe(false);
    },
  );

  it("rejects a managed runtime and version mismatch through its family schema (#10442)", () => {
    const event = familyFixtures[4];
    const parameters = buildInstallCompletedTelemetryPayload(event, context)?.events[0].parameters;
    expect(
      acceptsFamilyParameters(event.event, {
        ...parameters,
        agent_runtime: "openclaw",
        managed_agent_version: "0.21.3",
      }),
    ).toBe(false);
  });

  it.each([
    ...(["linux", "wsl", "macos", "other", "unknown"] as const).map((value) => ({
      scope: "host",
      signal: "host_platform",
      value,
    })),
    ...Object.entries(SANDBOX_SIGNALS).flatMap(([signal, values]) =>
      values.map((value) => ({ scope: "sandbox", signal, value })),
    ),
  ])(
    "keeps public $scope/$signal/$value valid in strict and SMS schemas (#10448)",
    ({ scope, signal, value }) => {
      const event = {
        event: "nemoclaw_configuration_observed",
        operation: "onboard",
        scope,
        signal,
        value,
        ...(scope === "sandbox" ? { count: 3 } : {}),
      };
      const payload = buildInstallCompletedTelemetryPayload(event, context);
      expect(payload).not.toBeNull();
      const parameters = payload?.events[0].parameters;
      expect(acceptsFamilyParameters("nemoclaw_configuration_observed", parameters)).toBe(true);
      expect(
        acceptsSmsRegistrationParameters(
          { ...parameters, value: "private-hostname" },
          "nemoclaw_configuration_observed",
        ),
      ).toBe(false);
    },
  );

  it.each(
    ["countryName", "regionName", "cityName"].flatMap((field) =>
      ["Location 192.0.2.1", "Location 37.123,-121.456"].map((value) => ({ field, value })),
    ),
  )(
    "rejects private location $value in collected $field before encoding (#10448)",
    ({ field, value }) => {
      expect(
        buildInstallCompletedTelemetryPayload(buildInstallCompletedEvent("install"), {
          ...context,
          location: { ...location, [field]: value },
        }),
      ).toBeNull();
    },
  );

  it("requires one host observation and rejects sandbox signal/value mismatches through their family schema (#10448)", () => {
    const host = buildInstallCompletedTelemetryPayload(familyFixtures[8], context)?.events[0]
      .parameters;
    const sandbox = buildInstallCompletedTelemetryPayload(familyFixtures[7], context)?.events[0]
      .parameters;
    expect(host?.count).toBe(1);
    expect(acceptsFamilyParameters("nemoclaw_configuration_observed", host)).toBe(true);
    expect(
      buildInstallCompletedTelemetryPayload({ ...familyFixtures[8], count: 1 }, context),
    ).toBeNull();
    expect(
      acceptsFamilyParameters("nemoclaw_configuration_observed", {
        ...sandbox,
        signal: "gpu_state",
        value: "docker",
      }),
    ).toBe(false);
  });

  it.each([0, 2, undefined])(
    "rejects host observation count %s through its family schema (#10448)",
    (count) => {
      const host = buildInstallCompletedTelemetryPayload(familyFixtures[8], context)?.events[0]
        .parameters;
      expect(acceptsFamilyParameters("nemoclaw_configuration_observed", { ...host, count })).toBe(
        false,
      );
    },
  );
});
