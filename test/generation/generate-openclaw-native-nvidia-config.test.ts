// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";
import {
  INVALID_NATIVE_NVIDIA_URLS,
  NATIVE_NVIDIA_URLS,
} from "../fixtures/native-nvidia-inference-urls";

it("uses an opaque native Model Router credential without serializing the key (#13560)", () => {
  const endpoint = "http://host.openshell.internal:4000/v1";
  const config = buildConfig({
    ...baseOpenClawGenerationEnv(),
    NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    NEMOCLAW_UPSTREAM_PROVIDER: "nvidia-router",
    NEMOCLAW_INFERENCE_BASE_URL: endpoint,
    NVIDIA_INFERENCE_API_KEY: "test-only-secret",
    NEMOCLAW_LOCAL_INFERENCE_TOKEN: "test-only-secret",
  });
  expect(config.models.providers.inference.baseUrl).toBe(endpoint);
  expect(config.models.providers.inference.apiKey).toBe(
    "openshell:resolve:env:NEMOCLAW_LOCAL_INFERENCE_TOKEN",
  );
  expect(JSON.stringify(config)).not.toContain("test-only-secret");
  expect(JSON.stringify(config)).not.toContain("inference.local");
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
