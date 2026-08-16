// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mergeRequiredSetupPolicyPresets } from "./policy-preset-reconciliation";

const KNOWN_PRESET_NAMES = [
  "personal-open-internet",
  "openclaw-pricing",
  "openclaw-diagnostics-otel-local",
  "github",
  "npm",
  "weather",
];

describe("portable onboarding default policy composition", () => {
  it("the authoritative default portable preset list is not widened by required-preset reconciliation (#9206)", () => {
    const merged = mergeRequiredSetupPolicyPresets(["personal-open-internet"], {
      agent: "openclaw",
      tierName: "personal",
      env: {},
      observabilityEnabled: false,
      enabledChannels: [],
      hermesToolGateways: [],
      knownPresetNames: KNOWN_PRESET_NAMES,
    });

    expect(merged).toEqual(["personal-open-internet"]);
  });

  it("enabling OpenClaw OTEL on a local endpoint widens the default portable preset list (#9206)", () => {
    const merged = mergeRequiredSetupPolicyPresets(["personal-open-internet"], {
      agent: "openclaw",
      tierName: "personal",
      env: { NEMOCLAW_OPENCLAW_OTEL: "1" },
      observabilityEnabled: false,
      enabledChannels: [],
      hermesToolGateways: [],
      knownPresetNames: KNOWN_PRESET_NAMES,
    });

    expect(merged).toEqual(["personal-open-internet", "openclaw-diagnostics-otel-local"]);
  });
});
