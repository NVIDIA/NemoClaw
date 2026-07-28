// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { patchOpenClawInferenceConfig } from "./inference-set";

function compatibleEndpointConfig(modelOverrides: ConfigObject = {}): ConfigObject {
  return {
    agents: { defaults: { model: { primary: "inference/nemotron-3-super" } } },
    models: {
      mode: "merge",
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          apiKey: "unused",
          api: "openai-completions",
          models: [
            {
              id: "nemotron-3-super",
              name: "inference/nemotron-3-super",
              contextWindow: 131072,
              maxTokens: 4096,
              reasoning: true,
              ...modelOverrides,
            },
          ],
        },
      },
    },
  };
}

function patchedModel(config: ConfigObject, providerKey: string): ConfigObject {
  const providers = (config.models as ConfigObject).providers as ConfigObject;
  const provider = providers[providerKey] as ConfigObject;
  return (provider.models as ConfigObject[])[0];
}

describe("inference set reasoning effort (#7659)", () => {
  it("writes the requested effort into the request body of the routed model", () => {
    const config = compatibleEndpointConfig();

    const result = patchOpenClawInferenceConfig(
      config,
      "compatible-endpoint",
      "nemotron-3-super",
      "openai-completions",
      undefined,
      undefined,
      { effort: "high", explicit: true },
    );

    expect(patchedModel(config, result.route.providerKey).params).toEqual({
      extra_body: { reasoning_effort: "high" },
    });
  });

  it("preserves an already-recorded effort when the mutation does not request one", () => {
    const config = compatibleEndpointConfig({
      params: { extra_body: { reasoning_effort: "low" } },
    });

    const result = patchOpenClawInferenceConfig(
      config,
      "compatible-endpoint",
      "nemotron-3-nano",
      "openai-completions",
    );

    expect(patchedModel(config, result.route.providerKey).params).toEqual({
      extra_body: { reasoning_effort: "low" },
    });
  });

  it("clears the effort on an explicit request for the unset state", () => {
    const config = compatibleEndpointConfig({
      params: { extra_body: { reasoning_effort: "low" } },
    });

    const result = patchOpenClawInferenceConfig(
      config,
      "compatible-endpoint",
      "nemotron-3-super",
      "openai-completions",
      undefined,
      undefined,
      { effort: null, explicit: true },
    );

    expect(patchedModel(config, result.route.providerKey).params).toBeUndefined();
  });

  it("keeps unrelated request-body entries while clearing the effort", () => {
    const config = compatibleEndpointConfig({
      params: { extra_body: { reasoning_effort: "low", chat_template_kwargs: { thinking: true } } },
    });

    const result = patchOpenClawInferenceConfig(
      config,
      "compatible-endpoint",
      "nemotron-3-super",
      "openai-completions",
      undefined,
      undefined,
      { effort: null, explicit: true },
    );

    expect(patchedModel(config, result.route.providerKey).params).toEqual({
      extra_body: { chat_template_kwargs: { thinking: true } },
    });
  });

  it("does not write the effort for an API family that does not carry it", () => {
    const config = compatibleEndpointConfig();

    const result = patchOpenClawInferenceConfig(
      config,
      "compatible-anthropic-endpoint",
      "claude-opus-4-6",
      "anthropic-messages",
      undefined,
      undefined,
      { effort: "high", explicit: true },
    );

    expect(patchedModel(config, result.route.providerKey).params).toBeUndefined();
  });
});
