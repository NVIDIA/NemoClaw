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
  it("requires an nvapi-prefixed NVIDIA key by default", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({ NVIDIA_INFERENCE_API_KEY: "nvapi-test-key" }),
      {},
    );

    expect(cfg.provider).toBe("nvidia");
    expect(cfg.credentialEnv).toBe("NVIDIA_INFERENCE_API_KEY");
    expect(cfg.env.NVIDIA_INFERENCE_API_KEY).toBe("nvapi-test-key");
  });

  it("rejects a non-NVIDIA key unless the compatible-provider flag is set", () => {
    expect(() =>
      requireHostedInferenceConfig(secrets({ NVIDIA_INFERENCE_API_KEY: "sk-compatible-key" }), {}),
    ).toThrow(/must start with nvapi-/);
  });

  it("accepts a compatible-provider credential when CI enables the compatibility flag", () => {
    const cfg = requireHostedInferenceConfig(
      secrets({
        COMPATIBLE_API_KEY: "sk-compatible-key",
      }),
      { NEMOCLAW_E2E_USE_NVIDIA_SECRET_AS_COMPATIBLE: "1" },
    );

    expect(cfg.provider).toBe("compatible");
    expect(cfg.credentialEnv).toBe("COMPATIBLE_API_KEY");
    expect(cfg.env).toMatchObject({
      NEMOCLAW_PROVIDER: "custom",
      NEMOCLAW_ENDPOINT_URL: "https://inference-api.nvidia.com/v1",
      NEMOCLAW_MODEL: "nvidia/nvidia/nemotron-3-super-v3",
      COMPATIBLE_API_KEY: "sk-compatible-key",
    });
  });
});
