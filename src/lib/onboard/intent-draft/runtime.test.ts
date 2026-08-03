// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { OnboardOptions } from "../types";
import { applyAcceptedOnboardIntentDraft, captureOnboardIntentEnvironment } from "./runtime";
import { createOnboardIntentDraft } from "./schema";

describe("accepted onboarding intent projection (#6005)", () => {
  it("projects choices without introducing credential values", () => {
    const draft = {
      ...createOnboardIntentDraft({
        agent: "hermes",
        inference: {
          provider: "custom",
          model: "model-1",
          endpointUrl: "https://inference.example.com/v1",
          authMethod: "api_key",
        },
        sandbox: "demo",
        web_search: null,
        messaging: ["telegram"],
        tools: { hermesGateways: ["nous-web", "nous-image"] },
        resources: { profile: "large", gpu: "enable" },
        policy: "restricted",
      }),
      phase: "accepted" as const,
    };
    const env: NodeJS.ProcessEnv = {};
    const opts: OnboardOptions = {};

    applyAcceptedOnboardIntentDraft(draft, opts, env);

    expect(opts).toMatchObject({
      agent: "hermes",
      sandboxName: "demo",
      sandboxGpu: "enable",
      policyTier: "restricted",
    });
    expect(env).toEqual({
      NEMOCLAW_AGENT: "hermes",
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_MODEL: "model-1",
      NEMOCLAW_ENDPOINT_URL: "https://inference.example.com/v1",
      NEMOCLAW_HERMES_AUTH_METHOD: "api_key",
      NEMOCLAW_SANDBOX_NAME: "demo",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "none",
      NEMOCLAW_HERMES_TOOL_GATEWAYS: "nous-web,nous-image",
      NEMOCLAW_RESOURCE_PROFILE: "large",
      NEMOCLAW_POLICY_TIER: "restricted",
      NEMOCLAW_ONBOARD_INTENT_ACCEPTED: "1",
    });
    expect(Object.keys(env).some((key) => /key|token|password|secret/i.test(key))).toBe(false);
  });

  it("refuses incomplete or unaccepted drafts", () => {
    expect(() => applyAcceptedOnboardIntentDraft(createOnboardIntentDraft(), {}, {})).toThrow(
      "accepted before materialization",
    );
    expect(() =>
      applyAcceptedOnboardIntentDraft(
        { ...createOnboardIntentDraft({ agent: "openclaw" }), phase: "accepted" },
        {},
        {},
      ),
    ).toThrow("incomplete");
  });

  it("restores every projected environment value", () => {
    const env: NodeJS.ProcessEnv = { NEMOCLAW_AGENT: "before", NEMOCLAW_MODEL: "before-model" };
    const restore = captureOnboardIntentEnvironment(env);
    env.NEMOCLAW_AGENT = "after";
    env.NEMOCLAW_MODEL = "after-model";
    env.NEMOCLAW_ONBOARD_INTENT_ACCEPTED = "1";

    restore();

    expect(env).toEqual({ NEMOCLAW_AGENT: "before", NEMOCLAW_MODEL: "before-model" });
  });
});
