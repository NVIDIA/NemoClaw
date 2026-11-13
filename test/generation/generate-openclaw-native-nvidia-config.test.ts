// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";
import {
  INVALID_NATIVE_NVIDIA_URLS,
  NATIVE_NVIDIA_URLS,
} from "../fixtures/native-nvidia-inference-urls";

it("rejects the retired native Model Router before serializing configuration", () => {
  expect(() =>
    buildConfig({
      ...baseOpenClawGenerationEnv(),
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-router",
      NEMOCLAW_INFERENCE_BASE_URL: "http://host.openshell.internal:4000/v1",
      NEMOCLAW_LOCAL_INFERENCE_TOKEN: "test-only-secret",
    }),
  ).toThrow("Model Router has been removed");
});

it.each(NATIVE_NVIDIA_URLS)(
  "uses a resolvable credential for native NVIDIA inference at %s",
  (baseUrl) => {
    const config = buildConfig({
      ...baseOpenClawGenerationEnv(),
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: baseUrl,
    });
    expect(config.models.providers.inference.apiKey).toBe("${NVIDIA_INFERENCE_API_KEY}");
  },
);

it.each(INVALID_NATIVE_NVIDIA_URLS)("rejects an ambiguous native NVIDIA URL %j", (baseUrl) => {
  expect(() =>
    buildConfig({
      ...baseOpenClawGenerationEnv(),
      NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
      NEMOCLAW_INFERENCE_BASE_URL: baseUrl,
    }),
  ).toThrow("Native NVIDIA inference requires https://integrate.api.nvidia.com/v1.");
});

it.each([
  "https://inference.local/v1",
  "https://integrate.api.nvidia.com.example/v1",
  "https://other.example/v1",
  "http://integrate.api.nvidia.com/v1",
  "https://integrate.api.nvidia.com:8443/v1",
])("retains the route sentinel outside native NVIDIA inference at %s", (baseUrl) => {
  const config = buildConfig({
    ...baseOpenClawGenerationEnv(),
    NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    NEMOCLAW_INFERENCE_BASE_URL: baseUrl,
  });
  expect(config.models.providers.inference.apiKey).toBe("unused");
});
