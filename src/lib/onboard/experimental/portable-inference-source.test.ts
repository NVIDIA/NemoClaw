// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  PortableInferenceSourceError,
  resolvePortableInferenceSource,
} from "./portable-inference-source";

const configuredEnvironment = (): NodeJS.ProcessEnv => ({
  COMPATIBLE_API_KEY: "nvapi-test-value-12345",
  NEMOCLAW_ENDPOINT_URL: "https://inference.example.test/v1/chat/completions",
  NEMOCLAW_MODEL: "vendor/model-v1",
});

describe("resolvePortableInferenceSource", () => {
  it("returns null when compatible-endpoint inputs are absent", () => {
    expect(resolvePortableInferenceSource({})).toBeNull();
  });

  it("resolves a preconfigured compatible endpoint without fetching configuration", () => {
    expect(resolvePortableInferenceSource(configuredEnvironment())).toEqual({
      apiKey: "nvapi-test-value-12345",
      baseUrl: "https://inference.example.test/v1",
      model: "vendor/model-v1",
    });
  });

  it("rejects incomplete compatible-endpoint configuration", () => {
    expect(() =>
      resolvePortableInferenceSource({
        NEMOCLAW_ENDPOINT_URL: "https://inference.example.test/v1",
        NEMOCLAW_MODEL: "vendor/model-v1",
      }),
    ).toThrow(PortableInferenceSourceError);
  });

  it("rejects endpoint URLs containing credentials", () => {
    expect(() =>
      resolvePortableInferenceSource({
        ...configuredEnvironment(),
        NEMOCLAW_ENDPOINT_URL: "https://user:password@inference.example.test/v1",
      }),
    ).toThrow("credential-free HTTPS endpoint URL");
  });
});
