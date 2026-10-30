// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export function gatewayControlModelProviders(port: number, configured: boolean) {
  const origin = `http://127.0.0.1:${port}`;
  return {
    // Local discovery must not borrow a model from the machine running the control.
    ollama: {
      baseUrl: origin,
      apiKey: "ollama-local",
      api: "ollama",
      models: [],
    },
    lmstudio: {
      baseUrl: `${origin}/v1`,
      apiKey: "lmstudio-local",
      api: "openai-completions",
      models: [],
    },
    ...(configured
      ? {
          nemoclawnative: {
            baseUrl: `${origin}/v1`,
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
          },
        }
      : {}),
  };
}

export function isGatewayControlDiscoveryRequest(method?: string, url?: string) {
  return method === "GET" && ["/api/ps", "/api/tags", "/api/v1/models"].includes(url ?? "");
}
