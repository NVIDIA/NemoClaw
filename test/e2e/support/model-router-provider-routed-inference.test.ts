// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildProviderRoutedEnv,
  requireModelRouterPublicKey,
} from "../live/model-router-provider-routed-inference-helpers.ts";

describe("Model Router provider-routed live support", () => {
  it("requires the public NVIDIA secret", () => {
    const requested: string[] = [];
    const apiKey = requireModelRouterPublicKey({
      required(name) {
        requested.push(name);
        return "nvapi-public-test-key";
      },
    });

    expect(requested).toEqual(["NVIDIA_API_KEY"]);
    expect(apiKey).toBe("nvapi-public-test-key");
    expect(() => requireModelRouterPublicKey({ required: () => "hosted-compatible-key" })).toThrow(
      "NVIDIA_API_KEY must be a public NVIDIA Endpoints nvapi-* key",
    );
  });

  it("stages the public key under the credential names consumed by the router", () => {
    expect(buildProviderRoutedEnv("nvapi-public-test-key", "e2e-router", {})).toMatchObject({
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
      NEMOCLAW_PROVIDER_KEY: "nvapi-public-test-key",
      NEMOCLAW_PROVIDER: "routed",
      NEMOCLAW_SANDBOX_NAME: "e2e-router",
    });
  });
});
