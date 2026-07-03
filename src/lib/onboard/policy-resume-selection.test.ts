// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { preparePolicyPresetResumeSelection } from "./policy-resume-selection";

type Preset = { name: string; access?: string };

function policies(options: { applied?: string[]; custom?: string[] } = {}) {
  const setupPresets = ["npm", "brave", "tavily"].map((name) => ({ name }));
  const customPresets = (options.custom ?? []).map((name) => ({ name }));
  return {
    setupPolicyPresetSupported: () => true,
    listSetupPolicyPresets: () => setupPresets,
    listCustomPresets: () => customPresets,
    getAppliedPresets: () => options.applied ?? [],
    clampSetupPolicyPresetNames(
      names: string[],
      selectablePresets: Preset[],
      _supportOptions: { webSearchSupported?: boolean | null } | undefined,
      customPresetNames: Set<string> = new Set(),
    ) {
      const selectable = new Set(selectablePresets.map((preset) => preset.name));
      return names.filter((name) => selectable.has(name) || customPresetNames.has(name));
    },
  };
}

function prepare(
  recordedPolicyPresets: string[],
  provider: "brave" | "tavily",
  webSearchConfigChanged = false,
) {
  return preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
    recordedPolicyPresets,
    agent: "openclaw",
    webSearchConfig: { fetchEnabled: true, provider },
    webSearchConfigChanged,
    webSearchSupported: true,
  });
}

describe("preparePolicyPresetResumeSelection web search reconciliation", () => {
  it("replaces stale Brave policy with Tavily during a provider switch", () => {
    const result = prepare(["brave"], "tavily");

    expect(result.policyPresets).toEqual(["tavily"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(true);
  });

  it("adds Tavily when web search becomes enabled on resume", () => {
    const result = prepare(["npm"], "tavily", true);

    expect(result.policyPresets).toEqual(["npm", "tavily"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(true);
  });

  it("preserves an intentionally removed provider preset when configuration is unchanged", () => {
    const result = prepare(["npm"], "tavily");

    expect(result.policyPresets).toEqual(["npm"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(false);
  });

  it("preserves an operator-owned preset name while adding the active provider", () => {
    const result = preparePolicyPresetResumeSelection(
      { policies: policies({ custom: ["brave"] }) },
      "alpha",
      {
        recordedPolicyPresets: ["brave"],
        agent: "openclaw",
        webSearchConfig: { fetchEnabled: true, provider: "tavily" },
        webSearchConfigChanged: true,
        webSearchSupported: true,
      },
    );

    expect(result.policyPresets).toEqual(["brave", "tavily"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(true);
  });
});
