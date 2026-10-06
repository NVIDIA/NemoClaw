// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { parseTelemetryEvent } from "./event";
import { UNKNOWN_TELEMETRY_CONFIGURATION } from "./dimensions";
import {
  approvedManagedVersion,
  knownTelemetryModelKey,
  parseAggregateTelemetryEvent,
  sandboxSignalValue,
  type AggregateTelemetryEvent,
} from "./observations";

const publicModelCodes = {
  qwen: "qwen3_6_27b_fp8",
  sizedUltra: "nemotron3_ultra_550b_a55b",
};

const observations: AggregateTelemetryEvent[] = [
  { event: "nemoclaw_sandbox_count_observed", operation: "onboard", count: 0 },
  {
    event: "nemoclaw_agent_runtime_observed",
    operation: "onboard",
    agent_runtime: "other",
    count: 2,
  },
  {
    event: "nemoclaw_managed_agent_version_observed",
    operation: "onboard",
    agent_runtime: "openclaw",
    managed_agent_version: "other",
    count: 1,
  },
  {
    event: "nemoclaw_model_observed",
    operation: "onboard",
    model_source: "custom",
    known_model_key: publicModelCodes.qwen,
    modelId: "Qwen/Qwen3.6-27B-FP8",
    provider_profile: "nvidia",
    api_family: "openai-completions",
    count: 1,
  },
  {
    event: "nemoclaw_messaging_observed",
    operation: "onboard",
    messaging_channel: "slack",
    count: 1,
  },
  {
    event: "nemoclaw_configuration_observed",
    operation: "onboard",
    scope: "host",
    signal: "host_platform",
    value: "wsl",
  },
  {
    event: "nemoclaw_configuration_observed",
    operation: "onboard",
    scope: "sandbox",
    signal: "policy_tier",
    value: "balanced",
    count: 1,
  },
];

const countedObservations = observations.filter((event) => "count" in event);

describe("closed aggregate telemetry events", () => {
  it.each(observations)("accepts the closed $event measurement (#10442)", (event) => {
    expect(parseAggregateTelemetryEvent(event)).toEqual(event);
    expect(parseTelemetryEvent(event)).toEqual(event);
    expect(Object.isFrozen(parseAggregateTelemetryEvent(event))).toBe(true);
  });

  it.each(observations)("rejects private extra fields on $event (#10435)", (event) => {
    expect(
      parseAggregateTelemetryEvent({ ...event, endpointUrl: "https://private.invalid" }),
    ).toBeNull();
    expect(parseAggregateTelemetryEvent({ ...event, isSynthetic: true })).toBeNull();
    expect(parseAggregateTelemetryEvent({ ...event, operation: "start" })).toBeNull();
  });

  it.each(
    countedObservations.flatMap((event) =>
      [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1"].map(
        (count) => ({ event, count }),
      ),
    ),
  )("rejects invalid count $count for $event.event (#10442)", ({ event, count }) => {
    expect(parseAggregateTelemetryEvent({ ...event, count })).toBeNull();
  });

  it.each(countedObservations)(
    "allows zero only for the published environment total: $event (#10442)",
    (event) => {
      expect(parseAggregateTelemetryEvent({ ...event, count: 0 }) !== null).toBe(
        event.event === "nemoclaw_sandbox_count_observed",
      );
    },
  );
  it("accepts the largest safe published environment count (#10442)", () => {
    expect(
      parseAggregateTelemetryEvent({ ...observations[0], count: Number.MAX_SAFE_INTEGER }),
    ).not.toBeNull();
  });

  it("rejects a count on the host-platform observation (#10448)", () => {
    expect(parseAggregateTelemetryEvent({ ...observations[5], count: 1 })).toBeNull();
  });

  it.each([
    ["compute_driver", "podman"],
    ["gpu_state", "configured_unverified"],
    ["web_search_enabled", "false"],
    ["observability_enabled", "true"],
    ["image_ownership", "custom"],
    ["policy_tier", "personal"],
  ])("accepts only the values owned by sandbox signal %s (#10448)", (signal, value) => {
    const event = {
      event: "nemoclaw_configuration_observed",
      operation: "rebuild",
      scope: "sandbox",
      signal,
      value,
      count: 3,
    };
    expect(parseAggregateTelemetryEvent(event)).toEqual(event);
    expect(parseAggregateTelemetryEvent({ ...event, value: "private-value" })).toBeNull();
    expect(parseAggregateTelemetryEvent({ ...event, scope: "host" })).toBeNull();
  });

  it("rejects a signal value that belongs to another signal (#10448)", () => {
    expect(
      parseAggregateTelemetryEvent({
        event: "nemoclaw_configuration_observed",
        operation: "restore",
        scope: "sandbox",
        signal: "gpu_state",
        value: "docker",
        count: 1,
      }),
    ).toBeNull();
  });

  it.each([
    ["Qwen/Qwen3.6-27B-FP8", "qwen3_6_27b_fp8"],
    ["nvidia/nemotron-3-ultra-550b-a55b", "nemotron3_ultra_550b_a55b"],
    ["nvidia/nvidia/nemotron-3-ultra", "nemotron3_ultra"],
    ["deepseek-ai/DeepSeek-V4-Flash", "deepseek_v4_flash"],
    ["other", "other"],
    ["unknown", "unknown"],
  ] as const)("binds public model %s to its approved key (#10445)", (modelId, key) => {
    const event = { ...observations[3], modelId, known_model_key: key };
    expect(knownTelemetryModelKey(modelId)).toBe(key);
    expect(parseAggregateTelemetryEvent(event)).not.toBeNull();
    expect(parseAggregateTelemetryEvent({ ...event, known_model_key: "different-key" })).toBeNull();
    expect(
      parseAggregateTelemetryEvent({ ...event, modelId: `${modelId}/private-alias` }),
    ).toBeNull();
  });

  it("rejects a Hub model paired with the sized Nemotron model key (#10445)", () => {
    expect(
      parseAggregateTelemetryEvent({
        ...observations[3],
        modelId: "nvidia/nvidia/nemotron-3-ultra",
        known_model_key: publicModelCodes.sizedUltra,
      }),
    ).toBeNull();
  });

  it("rejects a version approved for a different runtime (#10442)", () => {
    expect(
      parseAggregateTelemetryEvent({
        ...observations[2],
        agent_runtime: "openclaw",
        managed_agent_version: "0.21.3",
      }),
    ).toBeNull();
    expect(parseAggregateTelemetryEvent({ ...observations[2], agent_runtime: "other" })).toBeNull();
  });

  it.each([
    ["openclaw", "2026.9.2"],
    ["hermes", "0.21.3"],
    ["langchain-deepagents-code", "0.1.55"],
  ] as const)(
    "accepts an approved managed version for runtime %s (#10442)",
    (agent_runtime, managed_agent_version) => {
      const event = {
        event: "nemoclaw_managed_agent_version_observed",
        operation: "rebuild",
        agent_runtime,
        managed_agent_version,
        count: 1,
      };
      expect(parseAggregateTelemetryEvent(event)).toEqual(event);
    },
  );

  it.each([
    "telegram",
    "discord",
    "wechat",
    "slack",
    "whatsapp",
    "teams",
    "googlechat",
    "other",
  ] as const)(
    "accepts configured messaging category %s without dynamic values (#10447)",
    (messaging_channel) => {
      const event = {
        event: "nemoclaw_messaging_observed",
        operation: "restore",
        messaging_channel,
        count: 1,
      };
      expect(parseAggregateTelemetryEvent(event)).toEqual(event);
      expect(
        parseAggregateTelemetryEvent({
          ...event,
          messaging_channel: `${messaging_channel}-private`,
        }),
      ).toBeNull();
    },
  );

  it.each([
    "onboard",
    "inference_set",
    "destroy",
    "clone",
    "restore",
    "rebuild",
    "recovery",
    "messaging_add",
    "messaging_remove",
  ] as const)("accepts completed observation operation %s (#10442)", (operation) =>
    expect(parseAggregateTelemetryEvent({ ...observations[0], operation })).not.toBeNull(),
  );

  it.each([undefined, null, "private-build", "2026.9.2-private", {}])(
    "maps unapproved managed version %s to other without retaining it (#10442)",
    (version) => expect(approvedManagedVersion("openclaw", version)).toBe("other"),
  );

  it("maps only the approved configuration values to signal strings (#10448)", () => {
    const configuration = {
      ...UNKNOWN_TELEMETRY_CONFIGURATION,
      webSearchEnabled: false,
      policyTier: "restricted" as const,
      policyTierStatus: "reported" as const,
    };
    expect(sandboxSignalValue(configuration, "web_search_enabled")).toBe("false");
    expect(sandboxSignalValue(configuration, "policy_tier")).toBe("restricted");
    expect(sandboxSignalValue(UNKNOWN_TELEMETRY_CONFIGURATION, "policy_tier")).toBe("unknown");
  });
});
