// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { nativeHostedAgentConfig } from "./agent-config";
import { HOSTED_NATIVE_PROVIDERS } from "./hosted";

describe.each(HOSTED_NATIVE_PROVIDERS)("$label agent credential binding", (provider) => {
  it("uses only an OpenShell placeholder for the native endpoint (#12589)", () => {
    expect(nativeHostedAgentConfig(provider.logicalProvider, provider.endpoint)?.apiKey).toBe(
      `openshell:resolve:env:${provider.credentialEnv}`,
    );
  });
});

describe.each(
  HOSTED_NATIVE_PROVIDERS.filter((provider) => provider.logicalProvider !== "hermes-provider"),
)("$label fixed destination", (provider) => {
  it.each(["https://attacker.example/v1"])(
    "rejects a different destination %s (#12589)",
    (endpoint) => {
      expect(() => nativeHostedAgentConfig(provider.logicalProvider, endpoint)).toThrow(
        /does not match/u,
      );
    },
  );
});

it("carries both OpenRouter attribution headers on native requests (#12589)", () => {
  expect(
    nativeHostedAgentConfig("openrouter-api", "https://openrouter.ai/api/v1")?.headers,
  ).toEqual({
    "HTTP-Referer": "https://www.nvidia.com/nemoclaw/",
    "X-OpenRouter-Title": "NVIDIA NemoClaw",
  });
});

it.each(HOSTED_NATIVE_PROVIDERS)(
  "preserves existing shared-route $label configuration until selection changes",
  (provider) => {
    expect(
      nativeHostedAgentConfig(provider.logicalProvider, "https://inference.local/v1"),
    ).toBeUndefined();
  },
);
