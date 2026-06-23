// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Regression test for issue #5667: onboarding a Deep Agents / OpenAI-compatible
// sandbox without an explicit NEMOCLAW_MODEL recorded the default model id as
// "nvidia/nvidia/nemotron-3-super-v3" — a doubled "nvidia/" namespace prefix.
// Standard NIM model ids carry exactly one namespace segment, so the default
// fallback must be the canonical single-prefix id and the staged onboarding env
// must never contain "nvidia/nvidia/".

import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const providers = require("../dist/lib/onboard/providers.js") as {
  HOSTED_INFERENCE_MODEL: string;
  stageHostedInferenceSourceSecretEnv: () => boolean;
};

// Env keys touched by stageHostedInferenceSourceSecretEnv that we save/restore.
const TOUCHED_ENV = [
  "NVIDIA_INFERENCE_API_KEY",
  "COMPATIBLE_API_KEY",
  "NEMOCLAW_PROVIDER",
  "NEMOCLAW_ENDPOINT_URL",
  "NEMOCLAW_MODEL",
  "NEMOCLAW_COMPAT_MODEL",
  "NEMOCLAW_CLOUD_EXPERIMENTAL_MODEL",
  "NEMOCLAW_PREFERRED_API",
  "NEMOCLAW_E2E_USE_HOSTED_INFERENCE",
];

describe("issue #5667: hosted inference default model namespace", () => {
  // Snapshot the whole environment and restore it wholesale so the teardown
  // stays linear (no per-key conditional): clear every key, then repopulate
  // from the snapshot. Keys added during a test are dropped; original values
  // (all strings) are reinstated exactly.
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = { ...process.env };
    for (const key of TOUCHED_ENV) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    Object.assign(process.env, envSnapshot);
  });

  it("default hosted inference model has a single nvidia/ namespace segment", () => {
    expect(providers.HOSTED_INFERENCE_MODEL).not.toContain("nvidia/nvidia/");
    expect(providers.HOSTED_INFERENCE_MODEL).toBe("nvidia/nemotron-3-super-v3");
  });

  it("staging the hosted inference secret without NEMOCLAW_MODEL records a single-prefix model", () => {
    // Reproduce the reported flow: an Inference Hub OpenAI-compatible key with no
    // explicit NEMOCLAW_MODEL, so onboarding falls back to the default model id.
    process.env.NVIDIA_INFERENCE_API_KEY = "sk-test-inference-hub-key";
    process.env.NEMOCLAW_PROVIDER = "custom";

    const staged = providers.stageHostedInferenceSourceSecretEnv();

    expect(staged).toBe(true);
    expect(process.env.NEMOCLAW_MODEL).not.toContain("nvidia/nvidia/");
    expect(process.env.NEMOCLAW_MODEL).toBe("nvidia/nemotron-3-super-v3");
    expect(process.env.NEMOCLAW_COMPAT_MODEL).toBe("nvidia/nemotron-3-super-v3");
  });
});
