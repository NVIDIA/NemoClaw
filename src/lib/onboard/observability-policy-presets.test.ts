// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  hasDcodeObservabilityDrift,
  hasRegisteredDcodeObservabilityDrift,
  isInactiveObservabilityPolicyPreset,
  mergeRequiredObservabilityPolicyPresets,
  OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
  requiredObservabilityPolicyPresets,
} from "./observability-policy-presets";
import { suppressedAgentRequiredPresets } from "./policy-tier-suppression";

describe("observability policy presets", () => {
  it("detects enabled and disabled drift for a live managed DCode sandbox", () => {
    const base = {
      liveExists: true,
      managedDcodeAgent: true,
      hasRegistryEntry: true,
    };

    expect(
      hasDcodeObservabilityDrift({
        ...base,
        recordedObservabilityEnabled: true,
        requestedObservabilityEnabled: false,
      }),
    ).toBe(true);
    expect(
      hasDcodeObservabilityDrift({
        ...base,
        recordedObservabilityEnabled: false,
        requestedObservabilityEnabled: true,
      }),
    ).toBe(true);
    expect(
      hasDcodeObservabilityDrift({
        ...base,
        recordedObservabilityEnabled: undefined,
        requestedObservabilityEnabled: false,
      }),
    ).toBe(true);
    expect(
      hasDcodeObservabilityDrift({
        ...base,
        recordedObservabilityEnabled: undefined,
        requestedObservabilityEnabled: true,
      }),
    ).toBe(true);
    expect(
      hasDcodeObservabilityDrift({
        ...base,
        recordedObservabilityEnabled: true,
        requestedObservabilityEnabled: true,
      }),
    ).toBe(false);
    expect(
      hasDcodeObservabilityDrift({
        ...base,
        liveExists: false,
        recordedObservabilityEnabled: true,
        requestedObservabilityEnabled: false,
      }),
    ).toBe(false);
    expect(
      hasRegisteredDcodeObservabilityDrift(true, true, { observabilityEnabled: false }, true),
    ).toBe(true);
    expect(hasRegisteredDcodeObservabilityDrift(true, true, null, true)).toBe(false);
  });

  it("requires the fixed local OTLP preset only for enabled Deep Agents Code", () => {
    expect(requiredObservabilityPolicyPresets("langchain-deepagents-code", true)).toEqual([
      OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
    ]);
    expect(requiredObservabilityPolicyPresets("langchain-deepagents-code", false)).toEqual([]);
    expect(requiredObservabilityPolicyPresets("openclaw", true)).toEqual([]);
    expect(requiredObservabilityPolicyPresets("hermes", true)).toEqual([]);
  });

  it("adds only a known preset and prunes an inactive built-in selection", () => {
    expect(
      mergeRequiredObservabilityPolicyPresets(["npm"], {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        knownPresetNames: ["npm", OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET],
      }),
    ).toEqual(["npm", OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET]);
    expect(
      mergeRequiredObservabilityPolicyPresets(["npm"], {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        knownPresetNames: ["npm"],
      }),
    ).toEqual(["npm"]);
    expect(
      isInactiveObservabilityPolicyPreset(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET, {
        agent: "langchain-deepagents-code",
        observabilityEnabled: false,
      }),
    ).toBe(true);
  });

  it("suppresses the built-in when exact custom content owns its policy key", () => {
    expect(
      mergeRequiredObservabilityPolicyPresets(["npm"], {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        knownPresetNames: ["npm", OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET],
        customOwnsObservability: true,
      }),
    ).toEqual(["npm"]);
    expect(
      isInactiveObservabilityPolicyPreset(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET, {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        customOwnsObservability: true,
      }),
    ).toBe(true);
    expect(
      isInactiveObservabilityPolicyPreset(OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET, {
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        customPresetNames: new Set([OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET]),
        customOwnsObservability: false,
      }),
    ).toBe(false);
  });

  it("suppresses local trace egress on the restricted tier", () => {
    expect(suppressedAgentRequiredPresets("restricted", "langchain-deepagents-code")).toEqual([
      OBSERVABILITY_OTLP_LOCAL_POLICY_PRESET,
    ]);
    expect(suppressedAgentRequiredPresets("balanced", "langchain-deepagents-code")).toEqual([]);
  });
});
