// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { buildConfig } from "../../scripts/generate-openclaw-config.mts";
import { applyHermesManagedRoute } from "../../src/lib/hermes-managed-route";
import { HOSTED_NATIVE_PROVIDERS } from "../../src/lib/inference/native-provider/hosted";
import { baseOpenClawGenerationEnv } from "../helpers/openclaw-env-fixture";

describe.each(HOSTED_NATIVE_PROVIDERS)("native $label agent configuration", (provider) => {
  it("renders OpenClaw credentials as placeholders and keeps the native protocol (#12589)", () => {
    const config = buildConfig({
      ...baseOpenClawGenerationEnv(),
      NEMOCLAW_UPSTREAM_PROVIDER: provider.logicalProvider,
      NEMOCLAW_INFERENCE_BASE_URL: provider.endpoint,
      NEMOCLAW_INFERENCE_API: provider.api,
      [provider.credentialEnv]: "host-secret-must-not-appear",
    });
    expect(config.models.providers["test-provider"]).toEqual(
      expect.objectContaining({
        baseUrl: provider.endpoint,
        api: provider.api,
        apiKey: `openshell:resolve:env:${provider.credentialEnv}`,
        timeoutSeconds: 600,
      }),
    );
    expect(JSON.stringify(config)).not.toContain("host-secret-must-not-appear");
  });
  it("renders Hermes native routing with the correct credential and headers (#12589)", () => {
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, {
      model: "supported-model",
      upstreamProvider: provider.logicalProvider,
      baseUrl: provider.endpoint,
      inferenceApi: provider.api,
    });
    expect(config.model).toEqual(
      expect.objectContaining({
        base_url: provider.endpoint,
        api_key: `\${${provider.credentialEnv}}`,
      }),
    );
  });
});

describe("native provider protocol details", () => {
  const headers = {
    "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
    "X-OpenRouter-Title": "NVIDIA NemoClaw",
  };
  it("preserves OpenRouter attribution headers in OpenClaw", () => {
    const config = buildConfig({
      ...baseOpenClawGenerationEnv(),
      NEMOCLAW_UPSTREAM_PROVIDER: "openrouter-api",
      NEMOCLAW_INFERENCE_BASE_URL: "https://openrouter.ai/api/v1",
      NEMOCLAW_INFERENCE_API: "openai-completions",
    });
    expect(config.models.providers["test-provider"].headers).toEqual(headers);
  });
  it("preserves OpenRouter attribution headers in Hermes", () => {
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, {
      model: "supported-model",
      upstreamProvider: "openrouter-api",
      baseUrl: "https://openrouter.ai/api/v1",
      inferenceApi: "openai-completions",
    });
    expect(config.model).toEqual(expect.objectContaining({ default_headers: headers }));
  });
  it("uses Anthropic messages in Hermes", () => {
    const config: Record<string, unknown> = {};
    applyHermesManagedRoute(config, {
      model: "supported-model",
      upstreamProvider: "anthropic-prod",
      baseUrl: "https://api.anthropic.com",
      inferenceApi: "anthropic-messages",
    });
    expect(config.model).toEqual(expect.objectContaining({ api_mode: "anthropic_messages" }));
  });
});
