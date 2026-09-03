// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildProviderRoutedEnv,
  EXPECTED_MODEL_ROUTER_SELECTED_MODEL,
  modelRouterSelectedModel,
} from "../live/model-router-provider-routed-inference-helpers.ts";

describe("Model Router provider-routed live support", () => {
  it("stages the public key under the credential names consumed by the router", () => {
    expect(buildProviderRoutedEnv("nvapi-public-test-key", "e2e-router", {})).toMatchObject({
      NVIDIA_INFERENCE_API_KEY: "nvapi-public-test-key",
      NEMOCLAW_PROVIDER_KEY: "nvapi-public-test-key",
      NEMOCLAW_POLICY_MODE: "skip",
      NEMOCLAW_PROVIDER: "routed",
      NEMOCLAW_SANDBOX_NAME: "e2e-router",
    });
  });

  it("reads the router-produced selected model without inventing missing evidence (#10969)", () => {
    expect(
      modelRouterSelectedModel(
        JSON.stringify({
          choices: [{ message: { content: "Hello" } }],
          model: EXPECTED_MODEL_ROUTER_SELECTED_MODEL,
        }),
      ),
    ).toBe(EXPECTED_MODEL_ROUTER_SELECTED_MODEL);
    expect(modelRouterSelectedModel('{"choices":[]}')).toBeNull();
    expect(modelRouterSelectedModel("not-json-with-sensitive-response-data")).toBeNull();
  });
});
