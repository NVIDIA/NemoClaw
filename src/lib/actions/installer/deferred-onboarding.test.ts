// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildDeferredOnboardingPlan } from "./deferred-onboarding";

const supported = { requested: true, runtimeSupported: true };

describe("deferred onboarding installer plan", () => {
  it.each(["hermes", "langchain-deepagents-code", "dcode"])(
    "defers opted-in runtime %s when hosted credentials are absent",
    (agent) => {
      expect(
        buildDeferredOnboardingPlan(
          { NEMOCLAW_AGENT: agent, NEMOCLAW_PROVIDER: "build" },
          supported,
        ),
      ).toMatchObject({ decision: "defer", requested: true });
    },
  );

  it("keeps an agent without the manifest opt-in unsupported", () => {
    expect(
      buildDeferredOnboardingPlan(
        { NEMOCLAW_AGENT: "openclaw", NEMOCLAW_PROVIDER: "build" },
        { requested: true },
      ),
    ).toMatchObject({
      agent: "openclaw",
      decision: "unsupported-agent",
    });
  });

  it.each(["build", "cloud", "routed"])("accepts hosted provider selector %s", (provider) => {
    expect(
      buildDeferredOnboardingPlan(
        { NEMOCLAW_AGENT: "langchain-deepagents-code", NEMOCLAW_PROVIDER: provider },
        supported,
      ).decision,
    ).toBe("defer");
  });

  it.each(["build", "custom", "inference", "routed"])(
    "does not treat provider-key selector %s as a credential",
    (providerKey) => {
      expect(
        buildDeferredOnboardingPlan(
          {
            NEMOCLAW_AGENT: "hermes",
            NEMOCLAW_PROVIDER: "build",
            NEMOCLAW_PROVIDER_KEY: providerKey,
          },
          supported,
        ).decision,
      ).toBe("defer");
    },
  );

  it.each(["NVIDIA_INFERENCE_API_KEY", "NVIDIA_API_KEY", "NEMOCLAW_PROVIDER_KEY"])(
    "runs normal onboarding when %s is present",
    (credentialName) => {
      const credential = "invalid-present-credential";
      const plan = buildDeferredOnboardingPlan(
        {
          NEMOCLAW_AGENT: "langchain-deepagents-code",
          NEMOCLAW_PROVIDER: "build",
          [credentialName]: credential,
        },
        supported,
      );

      expect(plan.decision).toBe("credential-present");
      expect(JSON.stringify(plan)).not.toContain(credential);
    },
  );

  it("preserves existing sandbox handling", () => {
    expect(
      buildDeferredOnboardingPlan(
        { NEMOCLAW_AGENT: "hermes", NEMOCLAW_PROVIDER: "build" },
        { ...supported, registeredSandboxCount: 1 },
      ).decision,
    ).toBe("existing-sandbox");
  });

  it("rejects unsupported local and remote provider profiles", () => {
    expect(
      buildDeferredOnboardingPlan(
        {
          NEMOCLAW_AGENT: "hermes",
          NEMOCLAW_ENABLE_LOCAL_MODEL_PROFILE: "1",
          NEMOCLAW_PROVIDER: "build",
        },
        supported,
      ).decision,
    ).toBe("unsupported-local-model");
    expect(
      buildDeferredOnboardingPlan(
        { NEMOCLAW_AGENT: "hermes", NEMOCLAW_PROVIDER: "openai" },
        supported,
      ).decision,
    ).toBe("unsupported-provider");
  });

  it("does nothing without explicit opt-in", () => {
    expect(
      buildDeferredOnboardingPlan({ NEMOCLAW_AGENT: "hermes", NEMOCLAW_PROVIDER: "build" })
        .decision,
    ).toBe("not-requested");
  });

  it("rejects an invalid sandbox count", () => {
    expect(() =>
      buildDeferredOnboardingPlan(
        { NEMOCLAW_AGENT: "hermes" },
        { registeredSandboxCount: -1, requested: true },
      ),
    ).toThrow("Registered sandbox count must be a non-negative integer");
  });
});
