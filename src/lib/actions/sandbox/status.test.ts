// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ProviderHealthProbeOptions } from "../../../../dist/lib/inference/health";
import { getSandboxStatusInferenceHealth } from "../../../../dist/lib/actions/sandbox/status";

describe("sandbox status inference health", () => {
  it("passes the current model with the current provider", () => {
    let observed: { provider: string; options?: ProviderHealthProbeOptions } | null = null;

    const result = getSandboxStatusInferenceHealth(
      true,
      "nvidia-prod",
      "moonshotai/kimi-k2.6",
      (provider, options) => {
        observed = { provider, options };
        return {
          ok: true,
          probed: true,
          providerLabel: "NVIDIA Endpoints",
          endpoint: "https://integrate.api.nvidia.com/v1/chat/completions",
          detail: "healthy",
        };
      },
    );

    expect(result?.ok).toBe(true);
    expect(observed).toEqual({
      provider: "nvidia-prod",
      options: { model: "moonshotai/kimi-k2.6" },
    });
  });

  it("does not probe when the sandbox gateway is not present", () => {
    let called = false;

    const result = getSandboxStatusInferenceHealth(
      false,
      "nvidia-prod",
      "moonshotai/kimi-k2.6",
      () => {
        called = true;
        return null;
      },
    );

    expect(result).toBeNull();
    expect(called).toBe(false);
  });
});
