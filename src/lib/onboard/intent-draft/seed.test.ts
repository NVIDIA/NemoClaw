// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { seedOnboardIntentDraft } from "./seed";

describe("onboarding intent draft input seeding (#6005)", () => {
  it("uses CLI choices over environment choices for review", () => {
    const draft = seedOnboardIntentDraft(
      {
        agent: "hermes",
        sandboxGpu: "enable",
        policyTier: "restricted",
      },
      "hermes-demo",
      {
        NEMOCLAW_AGENT: "openclaw",
        NEMOCLAW_PROVIDER: "hermesProvider",
        NEMOCLAW_MODEL: "claude",
        NEMOCLAW_HERMES_AUTH_METHOD: "oauth",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
        NEMOCLAW_RESOURCE_PROFILE: "large",
        NEMOCLAW_POLICY_TIER: "balanced",
      },
    );

    expect(draft.answers).toEqual({
      agent: "hermes",
      inference: {
        provider: "hermesProvider",
        model: "claude",
        endpointUrl: null,
        authMethod: "oauth",
      },
      sandbox: "hermes-demo",
      web_search: "tavily",
      resources: { profile: "large", gpu: "enable" },
      policy: "restricted",
    });
  });

  it("uses environment inputs when matching CLI inputs are absent", () => {
    const draft = seedOnboardIntentDraft(
      {},
      null,
      {
        NEMOCLAW_AGENT: "deepagents",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
        NEMOCLAW_POLICY_TIER: "balanced",
      },
      () => "langchain-deepagents-code",
    );

    expect(draft.answers).toEqual({
      agent: "langchain-deepagents-code",
      web_search: null,
      policy: "balanced",
    });
  });

  it("keeps credentials out and rejects endpoint URLs that carry them", () => {
    const draft = seedOnboardIntentDraft({}, null, {
      NEMOCLAW_PROVIDER_KEY: "opaque-secret",
      NEMOCLAW_PROVIDER: "build",
    });
    expect(JSON.stringify(draft)).not.toContain("opaque-secret");

    expect(() =>
      seedOnboardIntentDraft({}, null, {
        NEMOCLAW_PROVIDER: "custom",
        NEMOCLAW_ENDPOINT_URL: "https://example.test/v1?api_key=opaque-secret",
      }),
    ).toThrow("query parameters");
  });

  it("combines a single explicit resource input with safe defaults", () => {
    expect(seedOnboardIntentDraft({ sandboxGpu: "disable" }, null, {}).answers.resources).toEqual({
      profile: "default",
      gpu: "disable",
    });
    expect(
      seedOnboardIntentDraft({}, null, { NEMOCLAW_RESOURCE_PROFILE: "small" }).answers.resources,
    ).toEqual({ profile: "small", gpu: "auto" });
    expect(
      seedOnboardIntentDraft({}, null, {
        NEMOCLAW_CPU: "4",
        NEMOCLAW_RAM: "8Gi",
      }).answers.resources,
    ).toEqual({ profile: "custom", gpu: "auto", cpu: "4", memory: "8Gi" });
  });

  it.each([
    [{ gpu: true }, "enable"],
    [{ noGpu: true }, "disable"],
  ] as const)("seeds legacy GPU flags for review: %o", (options, gpu) => {
    expect(seedOnboardIntentDraft(options, null, {}).answers.resources).toEqual({
      profile: "default",
      gpu,
    });
  });
});
