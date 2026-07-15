// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { preparePolicyPresetResumeSelection } from "./policy-resume-selection";

type Preset = { name: string; access?: string };

function policies(
  options: { applied?: string[]; custom?: string[]; customOwnsObservability?: boolean } = {},
) {
  const setupPresets = ["npm", "brave", "tavily", "observability-otlp-local"].map((name) => ({
    name,
  }));
  const customPresets = (options.custom ?? []).map((name) => ({ name }));
  return {
    setupPolicyPresetSupported: () => true,
    listSetupPolicyPresets: () => setupPresets,
    listCustomPresets: () => customPresets,
    customPresetOwnsNetworkPolicyKey: () => options.customOwnsObservability === true,
    removeBuiltinPresetAttribution: () => undefined,
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

describe("preparePolicyPresetResumeSelection tier-default preservation (#6844)", () => {
  // These exercise the real tiers.yaml through classifyPresetProvenance (no tier
  // stub): `brave` is a Balanced default, and Restricted lists no such default.

  it("preserves brave on reuse when it is a Balanced-tier default and web search is off", () => {
    const result = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm", "brave"],
      agent: "openclaw",
      webSearchConfig: null,
      webSearchSupported: true,
      tierName: "balanced",
    });

    // brave is a Balanced default (an egress preset), not a stale web-search
    // leftover — it must survive reuse just like npm, and no reconcile is needed.
    expect(result.policyPresets).toEqual(["npm", "brave"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(false);
  });

  it("still prunes a stale brave on the Restricted tier (no brave default)", () => {
    const result = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm", "brave"],
      agent: "openclaw",
      webSearchConfig: null,
      webSearchSupported: true,
      tierName: "restricted",
    });

    expect(result.policyPresets).toEqual(["npm"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(true);
  });

  it("keeps brave on Balanced even when web search is set to a different provider", () => {
    const result = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm", "brave"],
      agent: "openclaw",
      webSearchConfig: { fetchEnabled: true, provider: "tavily" },
      webSearchConfigChanged: true,
      webSearchSupported: true,
      tierName: "balanced",
    });

    // brave stays as the tier egress default; tavily is added as the active provider.
    expect(result.policyPresets).toEqual(["npm", "brave", "tavily"]);
  });

  it("still prunes tavily on Balanced when it is not a tier default and web search is off", () => {
    // Boundary: the exemption is scoped to real tier defaults. tavily is NOT a
    // Balanced default (brave is), so a leftover tavily with no matching provider
    // is still a stale web-search preset and must be pruned.
    const result = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm", "tavily"],
      agent: "openclaw",
      webSearchConfig: null,
      webSearchSupported: true,
      tierName: "balanced",
    });

    expect(result.policyPresets).toEqual(["npm"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(true);
  });
});

describe("preparePolicyPresetResumeSelection observability reconciliation", () => {
  it("adds the local OTLP preset only while Deep Agents Code observability is enabled", () => {
    const enabled = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm"],
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      webSearchConfig: null,
      webSearchSupported: true,
    });
    const disabled = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm", "observability-otlp-local"],
      agent: "langchain-deepagents-code",
      observabilityEnabled: false,
      webSearchConfig: null,
      webSearchSupported: true,
    });

    expect(enabled.policyPresets).toEqual(["npm", "observability-otlp-local"]);
    expect(enabled.recordedPolicyPresetsNeedReconcile).toBe(true);
    expect(disabled.policyPresets).toEqual(["npm"]);
    expect(disabled.recordedPolicyPresetsNeedReconcile).toBe(true);
  });

  it("suppresses the enabled local OTLP preset on the restricted tier", () => {
    const result = preparePolicyPresetResumeSelection({ policies: policies() }, "alpha", {
      recordedPolicyPresets: ["npm"],
      agent: "langchain-deepagents-code",
      observabilityEnabled: true,
      webSearchConfig: null,
      webSearchSupported: true,
      tierName: "restricted",
    });

    expect(result.policyPresets).toEqual(["npm"]);
  });

  it("keeps exact custom OTLP ownership without carrying built-in attribution on resume", () => {
    const result = preparePolicyPresetResumeSelection(
      {
        policies: policies({
          applied: ["observability-otlp-local", "corp-otel"],
          custom: ["corp-otel"],
          customOwnsObservability: true,
        }),
      },
      "alpha",
      {
        recordedPolicyPresets: ["observability-otlp-local", "corp-otel"],
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        webSearchConfig: null,
        webSearchSupported: true,
      },
    );

    expect(result.policyPresets).toEqual(["corp-otel"]);
    expect(result.recordedPolicyPresetsNeedReconcile).toBe(true);
  });

  it("preserves same-name different-key custom collision semantics on resume", () => {
    const result = preparePolicyPresetResumeSelection(
      { policies: policies({ custom: ["observability-otlp-local"] }) },
      "alpha",
      {
        recordedPolicyPresets: ["observability-otlp-local"],
        agent: "langchain-deepagents-code",
        observabilityEnabled: true,
        webSearchConfig: null,
        webSearchSupported: true,
      },
    );

    expect(result.policyPresets).toEqual(["observability-otlp-local"]);
  });
});
