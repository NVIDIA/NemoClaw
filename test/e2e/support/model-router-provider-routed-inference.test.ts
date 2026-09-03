// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  buildProviderRoutedEnv,
  modelRouterPoolModelNames,
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
    const selectedModel = "selected-model";
    expect(
      modelRouterSelectedModel(
        JSON.stringify({
          choices: [{ message: { content: "Hello" } }],
          model: selectedModel,
        }),
      ),
    ).toBe(selectedModel);
    expect(modelRouterSelectedModel('{"choices":[]}')).toBeNull();
    expect(modelRouterSelectedModel("not-json-with-sensitive-response-data")).toBeNull();
  });

  it("parses configured logical model names for routed-selection evidence (#10969)", () => {
    expect(
      modelRouterPoolModelNames(`
models:
  - name: first-model
  - name: second-model
`),
    ).toEqual(["first-model", "second-model"]);
    expect(modelRouterPoolModelNames("models: invalid")).toEqual([]);
    expect(modelRouterPoolModelNames("not: [valid")).toEqual([]);
  });
});
