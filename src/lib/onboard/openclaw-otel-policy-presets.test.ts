// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./messaging-policy-presets", () => ({
  mergeRequiredMessagingChannelPolicyPresets: (presets: string[]) => presets,
  requiredMessagingChannelPolicyPresets: () => [],
  pruneDisabledMessagingPolicyPresets: (presets: string[]) => presets,
  mergeAppliedPolicyPresetsForDisabledMessagingCleanup: (presets: string[]) => presets,
  hasDisabledMessagingPolicyPreset: () => false,
}));

vi.mock("./hermes-managed-tools", () => ({
  mergeRequiredHermesToolGatewayPolicyPresets: (presets: string[]) => presets,
  HERMES_TOOL_GATEWAY_PRESET_NAMES: new Set(),
}));

import { mergeRequiredSetupPolicyPresets } from "./policy-selection";

import {
  OPENCLAW_OTEL_LOCAL_POLICY_PRESET,
  isOpenclawOtelEnabled,
  mergeRequiredOpenclawOtelPolicyPresets,
  requiredOpenclawOtelPolicyPresets,
} from "./openclaw-otel-policy-presets";

describe("openclaw-otel-policy-presets", () => {
  const originalOtel = process.env.NEMOCLAW_OPENCLAW_OTEL;
  const originalEndpoint = process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;

  afterEach(() => {
    if (originalOtel === undefined) delete process.env.NEMOCLAW_OPENCLAW_OTEL;
    else process.env.NEMOCLAW_OPENCLAW_OTEL = originalOtel;
    if (originalEndpoint === undefined) delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
    else process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = originalEndpoint;
  });

  it("requires the local OTEL preset only for OpenClaw when OTEL is enabled", () => {
    delete process.env.NEMOCLAW_OPENCLAW_OTEL;
    expect(requiredOpenclawOtelPolicyPresets("openclaw")).toEqual([]);
    expect(requiredOpenclawOtelPolicyPresets("hermes")).toEqual([]);

    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
    expect(requiredOpenclawOtelPolicyPresets("openclaw")).toEqual([
      OPENCLAW_OTEL_LOCAL_POLICY_PRESET,
    ]);
    expect(requiredOpenclawOtelPolicyPresets(null)).toEqual([OPENCLAW_OTEL_LOCAL_POLICY_PRESET]);
    expect(requiredOpenclawOtelPolicyPresets("hermes")).toEqual([]);
  });

  it("does not require the local OTEL preset for remote collectors", () => {
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT = "https://otel.example.com:4318";

    expect(requiredOpenclawOtelPolicyPresets("openclaw")).toEqual([]);
  });

  it("mergeRequiredOpenclawOtelPolicyPresets appends the preset when missing", () => {
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
    const known = new Set(["npm", OPENCLAW_OTEL_LOCAL_POLICY_PRESET]);

    expect(
      mergeRequiredOpenclawOtelPolicyPresets(["npm"], {
        agent: "openclaw",
        knownPresetNames: known,
      }),
    ).toEqual(["npm", OPENCLAW_OTEL_LOCAL_POLICY_PRESET]);
  });

  it("mergeRequiredSetupPolicyPresets includes OTEL for OpenClaw sandboxes", () => {
    process.env.NEMOCLAW_OPENCLAW_OTEL = "1";
    delete process.env.NEMOCLAW_OPENCLAW_OTEL_ENDPOINT;
    const known = new Set(["npm", OPENCLAW_OTEL_LOCAL_POLICY_PRESET]);

    expect(
      mergeRequiredSetupPolicyPresets(["npm"], {
        agent: "openclaw",
        knownPresetNames: known,
      }),
    ).toContain(OPENCLAW_OTEL_LOCAL_POLICY_PRESET);
  });

  it("treats common false env values as disabled", () => {
    process.env.NEMOCLAW_OPENCLAW_OTEL = "0";
    expect(isOpenclawOtelEnabled()).toBe(false);
    process.env.NEMOCLAW_OPENCLAW_OTEL = "off";
    expect(isOpenclawOtelEnabled()).toBe(false);
  });
});
