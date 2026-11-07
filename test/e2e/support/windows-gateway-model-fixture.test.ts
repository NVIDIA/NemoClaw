// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  gatewayControlModelProviders,
  isGatewayControlDiscoveryRequest,
} from "../../../packaging/windows/app/gateway-control-model-fixture.mts";

describe("Windows gateway model fixture", () => {
  it("keeps first-run discovery on the owned endpoint without configuring a model", () => {
    const providers = gatewayControlModelProviders(43210, false);
    expect(Object.keys(providers)).toEqual(["ollama", "lmstudio"]);
  });

  it.each(["ollama", "lmstudio"] as const)(
    "keeps %s discovery empty on the owned endpoint",
    (name) => {
      const provider = gatewayControlModelProviders(43210, false)[name];
      expect(new URL(provider.baseUrl).origin).toBe("http://127.0.0.1:43210");
      expect(provider.models).toEqual([]);
    },
  );

  it("preserves the configured verification model beside empty discovery providers", () => {
    const providers = gatewayControlModelProviders(43211, true);
    expect(providers.nemoclawnative).toEqual({
      baseUrl: "http://127.0.0.1:43211/v1",
      apiKey: "owned-local-model-control",
      api: "openai-completions",
      models: [
        {
          id: "fixture",
          name: "fixture",
          reasoning: false,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 4096,
        },
      ],
    });
    expect(providers.ollama.models).toEqual([]);
    expect(providers.lmstudio.models).toEqual([]);
  });

  it.each(["/api/ps", "/api/tags", "/api/v1/models"])("accepts GET discovery at %s", (url) => {
    expect(isGatewayControlDiscoveryRequest("GET", url)).toBe(true);
    expect(isGatewayControlDiscoveryRequest("POST", url)).toBe(false);
  });

  it.each([
    "/v1/chat/completions",
    "/api/chat",
    "/api/v1/models/load",
    "/api/ps?other=1",
    undefined,
  ])("does not classify %s as an empty discovery response", (url) => {
    expect(isGatewayControlDiscoveryRequest("GET", url)).toBe(false);
    expect(isGatewayControlDiscoveryRequest("POST", url)).toBe(false);
  });
});
