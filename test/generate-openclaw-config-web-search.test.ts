// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildConfig } from "../scripts/generate-openclaw-config.mts";

const BASE_ENV: Record<string, string> = {
  NEMOCLAW_MODEL: "test-model",
  NEMOCLAW_PROVIDER_KEY: "test-provider",
  NEMOCLAW_PRIMARY_MODEL_REF: "test-ref",
  CHAT_UI_URL: "http://127.0.0.1:18789",
  NEMOCLAW_INFERENCE_BASE_URL: "http://localhost:8080",
  NEMOCLAW_INFERENCE_API: "openai",
  NEMOCLAW_INFERENCE_COMPAT_B64: Buffer.from("{}").toString("base64"),
  NEMOCLAW_PROXY_HOST: "10.200.0.1",
  NEMOCLAW_PROXY_PORT: "3128",
  NEMOCLAW_CONTEXT_WINDOW: "131072",
  NEMOCLAW_MAX_TOKENS: "4096",
  NEMOCLAW_REASONING: "false",
  NEMOCLAW_AGENT_TIMEOUT: "600",
};

function buildWebSearchConfig(env: Record<string, string>) {
  return buildConfig({ ...BASE_ENV, ...env });
}

describe("generate-openclaw-config.mts: Tavily web search", () => {
  it("emits the bundled plugin's credential path", () => {
    const config = buildWebSearchConfig({
      NEMOCLAW_WEB_SEARCH_ENABLED: "1",
      NEMOCLAW_WEB_SEARCH_PROVIDER: "tavily",
    });

    expect(config.tools?.web?.search).toEqual({ enabled: true, provider: "tavily" });
    expect(config.plugins?.entries?.tavily).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
    });
    expect(config.plugins?.entries?.brave).toBeUndefined();
    expect(config.tools?.web?.search?.apiKey).toBeUndefined();
    expect(config.tools?.web?.fetch).toEqual({ enabled: true, useTrustedEnvProxy: true });
  });

  it("rejects an unknown provider instead of silently selecting one", () => {
    expect(() =>
      buildWebSearchConfig({
        NEMOCLAW_WEB_SEARCH_ENABLED: "1",
        NEMOCLAW_WEB_SEARCH_PROVIDER: "unknown",
      }),
    ).toThrow('NEMOCLAW_WEB_SEARCH_PROVIDER must be "brave" or "tavily"');
  });
});
