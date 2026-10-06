// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  UNKNOWN_TELEMETRY_CONFIGURATION,
  EMPTY_TELEMETRY_LOCATION,
  classifyTelemetryAgent,
  classifyTelemetryModel,
  classifyTelemetryProvider,
  classifyTelemetryApi,
  classifyTelemetryHostOS,
  normalizeTelemetryArchitecture,
  parseTelemetryConfiguration,
  parseTelemetryLocation,
} from "./dimensions";

describe("approved telemetry dimensions", () => {
  it("retains every configuration field when nothing has been observed (#10448)", () => {
    expect(parseTelemetryConfiguration(UNKNOWN_TELEMETRY_CONFIGURATION)).toEqual(
      UNKNOWN_TELEMETRY_CONFIGURATION,
    );
    expect(UNKNOWN_TELEMETRY_CONFIGURATION.policyTier).toBeNull();
    expect(UNKNOWN_TELEMETRY_CONFIGURATION.policyTierStatus).toBe("not_persisted");
  });

  it.each([
    "Qwen/Qwen3.6-27B-FP8",
    "nvidia/nemotron-3-ultra-550b-a55b",
    "nvidia/nvidia/nemotron-3-ultra",
    "deepseek-ai/DeepSeek-V4-Flash",
  ])("reports approved public model %s without an alias (#10445)", (modelId) => {
    expect(classifyTelemetryModel(modelId)).toEqual({ modelId, modelStatus: "reported" });
  });

  it.each([
    "private-company/model",
    "nvidia/nvidia/nemotron-3-ultra-private",
    "nvidia/nemotron-3-ultra",
    "NVIDIA/NVIDIA/NEMOTRON-3-ULTRA",
    " nvidia/nvidia/nemotron-3-ultra",
    "nvidia/nvidia/nemotron-3-ultra ",
    "https://example.invalid/private",
    "/home/private/model",
    "other",
    "__proto__",
  ])("replaces an unapproved model value with a category (#10445)", (value) => {
    expect(classifyTelemetryModel(value)).toEqual({ modelId: "other", modelStatus: "unapproved" });
    expect(JSON.stringify(classifyTelemetryModel(value))).not.toContain(
      value === "other" ? "private" : value,
    );
  });

  it.each([undefined, null, "", "  ", 5])(
    "does not infer an agent or model from missing state (#10442)",
    (value) => {
      expect(classifyTelemetryAgent(value)).toEqual({
        agentHarnessId: "unknown",
        agentHarnessStatus: "not_observed",
      });
      expect(classifyTelemetryModel(value)).toEqual({
        modelId: "unknown",
        modelStatus: "not_observed",
      });
    },
  );

  it.each(["openclaw", "hermes", "langchain-deepagents-code"] as const)(
    "reports the approved %s harness (#10442)",
    (agentHarnessId) => {
      expect(classifyTelemetryAgent(agentHarnessId)).toEqual({
        agentHarnessId,
        agentHarnessStatus: "reported",
      });
    },
  );

  it("does not send custom harness or provider names (#10445)", () => {
    expect(classifyTelemetryAgent("private-agent")).toEqual({
      agentHarnessId: "other",
      agentHarnessStatus: "unapproved",
    });
    expect(classifyTelemetryProvider("private-provider")).toBe("custom");
    expect(classifyTelemetryProvider("__proto__")).toBe("custom");
    expect(classifyTelemetryApi("https://private.invalid")).toBe("unknown");
  });

  it.each(["nvidia-prod", "nvidia-nim", "nvidia-router"])(
    "maps the recorded %s provider without inspecting an endpoint (#10445)",
    (provider) => {
      expect(classifyTelemetryProvider(provider)).toBe("nvidia");
    },
  );

  it.each([
    ["linux", "linux"],
    ["darwin", "macos"],
    ["win32", "windows"],
    ["freebsd", "other"],
    ["private-host", "unknown"],
  ])(
    "classifies host platform %s without collecting host details (#10448)",
    (platform, expected) => {
      expect(classifyTelemetryHostOS(platform)).toBe(expected);
    },
  );

  it.each([
    ["arm64", "aarch64"],
    ["x64", "x86_64"],
    ["ia32", "x86"],
  ])(
    "derives both architecture fields from one %s observation (#10448)",
    (hostArch, cpuArchitecture) => {
      expect(normalizeTelemetryArchitecture(hostArch)).toEqual({ hostArch, cpuArchitecture });
    },
  );

  it.each(["private-hardware", "__proto__", null])(
    "replaces unknown architecture instead of sending it (#10448)",
    (value) => {
      expect(normalizeTelemetryArchitecture(value)).toEqual({
        hostArch: "unknown",
        cpuArchitecture: "undefined",
      });
    },
  );

  it.each([
    { modelId: "private-model" },
    { endpoint: "https://private.invalid" },
    { gpuState: "healthy" },
    { policyTier: "restricted" },
    { modelId: "unknown", modelStatus: "reported" },
    { configuredMessagingChannels: ["private-channel"], messagingStatus: "reported" },
    { configuredMessagingChannels: ["slack", "slack"], messagingStatus: "reported" },
    { configuredMessagingChannels: ["slack"], messagingStatus: "invalid" },
  ])("rejects fields or status combinations outside the approved record (#10448)", (patch) => {
    expect(
      parseTelemetryConfiguration({ ...UNKNOWN_TELEMETRY_CONFIGURATION, ...patch }),
    ).toBeNull();
  });

  it("rejects sparse channel arrays and discards custom serialization (#10447)", () => {
    expect(
      parseTelemetryConfiguration({
        ...UNKNOWN_TELEMETRY_CONFIGURATION,
        configuredMessagingChannels: Array(1),
        messagingStatus: "reported",
      }),
    ).toBeNull();
    const channels = ["slack"];
    Object.defineProperty(channels, Symbol.iterator, {
      value: function* () {
        yield "private-channel";
      },
    });
    Object.defineProperty(channels, "toJSON", { value: () => ["private-channel"] });
    const result = parseTelemetryConfiguration({
      ...UNKNOWN_TELEMETRY_CONFIGURATION,
      configuredMessagingChannels: channels,
      messagingStatus: "reported",
    });
    expect(result?.configuredMessagingChannels).toEqual(["slack"]);
    expect(JSON.stringify(result)).not.toContain("private-channel");
  });
});

const LOCATION = {
  countryCode: "US",
  countryName: "United States",
  regionName: "California",
  cityName: "San Jose",
  locationSource: "approved_network_origin",
  locationStatus: "reported",
  locationPrecision: "city",
  locationObservedAt: "2026-10-02T18:00:00.000Z",
} as const;

describe("approximate telemetry location", () => {
  it("retains four empty location fields when no source is configured (#11109)", () => {
    expect(parseTelemetryLocation(EMPTY_TELEMETRY_LOCATION)).toEqual(EMPTY_TELEMETRY_LOCATION);
  });

  it("accepts an approved source and partial country-only observation (#10448)", () => {
    expect(parseTelemetryLocation(LOCATION)).toEqual(LOCATION);
    const partial = {
      ...LOCATION,
      regionName: null,
      cityName: null,
      locationStatus: "partial",
      locationPrecision: "country",
    };
    expect(parseTelemetryLocation(partial)).toEqual(partial);
  });

  it("accepts ordinary location labels containing punctuation and digits (#10448)", () => {
    const ordinaryLocation = {
      ...LOCATION,
      regionName: "District 9",
      cityName: "St. Louis",
    };
    expect(parseTelemetryLocation(ordinaryLocation)).toEqual(ordinaryLocation);
  });

  it.each([
    { countryCode: "usa" },
    { countryCode: "US\n" },
    { cityName: "https://private.invalid" },
    { cityName: "/home/private" },
    { cityName: "192.0.2.1" },
    { countryName: "United States 192.0.2.1" },
    { regionName: "California (198.51.100.2)" },
    { cityName: "San Jose 203.0.113.3" },
    { countryName: "37.123,121.456" },
    { regionName: "-37.123 121.456" },
    { cityName: "San Jose 37.123 -121.456" },
    { cityName: "City\nsecret" },
    { cityName: "x".repeat(97) },
    { locationSource: "none" },
    { locationStatus: "not_configured" },
    { locationPrecision: "country" },
    { locationObservedAt: "yesterday" },
    { latitude: 37.33 },
    { ipAddress: "192.0.2.1" },
    { locationObservedAt: "2026-02-30T18:00:00.000Z" },
  ])("rejects private detail or unsupported location claims (#10448)", (patch) => {
    expect(parseTelemetryLocation({ ...LOCATION, ...patch })).toBeNull();
  });
});
