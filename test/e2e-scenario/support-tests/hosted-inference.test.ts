// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { requireHostedInferenceConfig } from "../fixtures/hosted-inference.ts";

function secrets(values: Record<string, string | undefined>) {
  return {
    required: (name: string) => {
      const value = values[name];
      if (!value) throw new Error(`missing ${name}`);
      return value;
    },
  };
}

describe("hosted inference E2E config", () => {
  it("uses NVIDIA_INFERENCE_API_KEY as the hosted compatible endpoint source secret", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      {},
    );

    expect(cfg.sourceSecretName).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(cfg.provider).toBe("custom");
    expect(cfg.providerName).toBe("compatible-endpoint");
    expect(cfg.credentialEnv).toBe("COMPATIBLE_API_KEY");
    expect(cfg.env.COMPATIBLE_API_KEY).toBe("repo-hosted-key");
  });

  it("does not require an nvapi-prefixed source secret", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({
        NVIDIA_INFERENCE_API_KEY: "sk-compatible-key",
      }),
      {},
    );

    expect(cfg.apiKey).toBe("sk-compatible-key");
    expect(cfg.credentialEnv).toBe("COMPATIBLE_API_KEY");
  });

  it("configures the custom provider route for inference-api.nvidia.com", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "repo-hosted-key" }),
      { NEMOCLAW_MODEL: "nvidia/custom-model" },
    );

    expect(cfg.env).toMatchObject({
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/custom-model",
      NEMOCLAW_COMPAT_MODEL: "nvidia/custom-model",
      COMPATIBLE_API_KEY: "repo-hosted-key",
    });
  });
});
