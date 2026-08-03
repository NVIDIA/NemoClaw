// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createOnboardIntentDraft,
  type OnboardIntentCompatibility,
  type OnboardIntentDraft,
  type OnboardIntentStepId,
  parseOnboardIntentDraft,
  reconcileOnboardIntentDraft,
} from "./schema";

const complete = createOnboardIntentDraft({
  agent: "openclaw",
  inference: {
    provider: "openai",
    model: "gpt-5.4",
    endpointUrl: null,
    authMethod: "api_key",
  },
  sandbox: "demo",
  web_search: "brave",
  messaging: ["slack", "telegram"],
  tools: { hermesGateways: [] },
  resources: { profile: "default", gpu: "auto" },
  policy: "balanced",
});

const compatible: OnboardIntentCompatibility = {
  provider: () => true,
  model: () => true,
  webSearch: () => true,
  messaging: () => true,
};

function edit(
  step: OnboardIntentStepId,
  answers: Partial<OnboardIntentDraft["answers"]>,
  rules: OnboardIntentCompatibility = compatible,
): OnboardIntentDraft {
  return reconcileOnboardIntentDraft(
    complete,
    { ...complete, answers: { ...complete.answers, ...answers } },
    step,
    rules,
  );
}

describe("onboarding intent dependency invalidation (#6005)", () => {
  it.each([
    ["sandbox", { sandbox: "renamed" }],
    ["resources", { resources: { profile: "large", gpu: "enable" } }],
  ] as const)("preserves unrelated answers after a %s edit", (step, answers) => {
    expect(edit(step, answers).answers).toEqual({ ...complete.answers, ...answers });
  });

  it.each([
    ["inference", { inference: { ...complete.answers.inference!, model: "gpt-5" } }],
    ["web_search", { web_search: "tavily" }],
    ["messaging", { messaging: ["slack"] }],
    ["tools", { tools: { hermesGateways: ["nous-web"] } }],
  ] as const)("invalidates policy planning after a %s edit", (step, answers) => {
    expect(edit(step, answers).answers.policy).toBeUndefined();
  });

  it("keeps compatible downstream answers after an agent edit", () => {
    const result = edit("agent", { agent: "hermes" });

    expect(result.answers).toMatchObject({
      agent: "hermes",
      inference: complete.answers.inference,
      web_search: "brave",
      messaging: ["slack", "telegram"],
    });
    expect(result.answers.policy).toBeUndefined();
    expect(result.answers.tools).toBeUndefined();
  });

  it("reopens only incompatible agent-dependent answers", () => {
    const result = edit(
      "agent",
      { agent: "hermes" },
      {
        provider: () => false,
        model: () => true,
        webSearch: (_agent, provider) => provider !== "brave",
        messaging: (_agent, channel) => channel === "telegram",
      },
    );

    expect(result.answers.inference).toBeUndefined();
    expect(result.answers.web_search).toBeUndefined();
    expect(result.answers.messaging).toEqual(["telegram"]);
    expect(result.answers.tools).toBeUndefined();
    expect(result.answers.sandbox).toBe("demo");
    expect(result.answers.resources).toEqual({ profile: "default", gpu: "auto" });
  });

  it("keeps the provider but resets an incompatible model to its displayed default", () => {
    const result = edit("agent", { agent: "hermes" }, { ...compatible, model: () => false });

    expect(result.answers.inference).toEqual({
      provider: "openai",
      model: null,
      endpointUrl: null,
      authMethod: "api_key",
    });
  });

  it("parses the fixed schema without retaining credential-shaped unknown fields", () => {
    const parsed = parseOnboardIntentDraft({
      ...complete,
      apiKey: "top-level-secret",
      answers: {
        ...complete.answers,
        password: "nested-secret",
        inference: { ...complete.answers.inference, credential: "provider-secret" },
      },
    });

    expect(parsed).toEqual(complete);
    expect(JSON.stringify(parsed)).not.toContain("secret");
  });

  it("rejects malformed draft values instead of partially trusting them", () => {
    expect(
      parseOnboardIntentDraft({
        version: 1,
        phase: "collecting",
        answers: { messaging: ["slack", 42] },
      }),
    ).toBeNull();
  });

  it.each([
    "https://user:password@example.com/v1",
    "https://example.com/v1?api_key=secret",
    "https://inference.example/v1?sig=opaque-signed-value",
    "https://example.com/v1#token=secret",
    "ftp://example.com/v1",
  ])("rejects unsafe or unsupported endpoint metadata: %s", (endpointUrl) => {
    expect(
      parseOnboardIntentDraft({
        version: 1,
        phase: "collecting",
        answers: {
          inference: {
            provider: "custom",
            model: "model-1",
            endpointUrl,
            authMethod: null,
          },
        },
      }),
    ).toBeNull();
  });
});
