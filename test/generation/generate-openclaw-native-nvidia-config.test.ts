// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";

import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

it.each([
  "https://integrate.api.nvidia.com/v1",
  "HTTPS://INTEGRATE.API.NVIDIA.COM:443/v1/",
  "https://integrate.api.nvidia.com:0443/v1",
  "https://integrate.api.nvidia.com:000443/v1/",
])("uses a resolvable credential for native NVIDIA inference at %s", (baseUrl) => {
  const config = buildConfig({
    ...baseOpenClawGenerationEnv(),
    NEMOCLAW_INFERENCE_PROVIDER_ID: "inference",
    NEMOCLAW_INFERENCE_BASE_URL: baseUrl,
  });
  expect(config.models.providers.inference.apiKey).toBe("${NVIDIA_INFERENCE_API_KEY}");
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
