// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { REASONING_EFFORT_ENV } from "../onboard/reasoning-mode";
import type { ConfigObject } from "../security/credential-filter";
import { patchOpenClawInferenceConfig, runInferenceSet } from "./inference-set";
import { baseSession, createDeps, OPENAI_ENDPOINTLESS_PROFILE } from "./inference-set.test-support";

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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

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

  it("does not write the effort for a provider whose registry row cannot record it", () => {
    const config = compatibleEndpointConfig({
      params: {
        extra_body: {
          reasoning_effort: "low",
          preserve_me: true,
        },
      },
    });

    const result = patchOpenClawInferenceConfig(
      config,
      "nvidia-prod",
      "nvidia/nemotron-3-super-120b-a12b",
      "openai-completions",
      undefined,
      undefined,
    );

    expect(patchedModel(config, result.route.providerKey).params).toEqual({
      extra_body: { preserve_me: true },
    });
  });

  it("removes an inherited effort when the selected API family cannot carry it", () => {
    const config = compatibleEndpointConfig({
      params: {
        extra_body: {
          reasoning_effort: "low",
          preserve_me: true,
        },
      },
    });

    const result = patchOpenClawInferenceConfig(
      config,
      "compatible-endpoint",
      "nemotron-3-super",
      "anthropic-messages",
    );

    expect(patchedModel(config, result.route.providerKey).params).toEqual({
      extra_body: { preserve_me: true },
    });
  });

  it("rejects a non-null effort for an unsupported provider before any mutation", async () => {
    const deps = createDeps({ config: compatibleEndpointConfig() });

    await expect(
      runInferenceSet(
        {
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          reasoningEffort: "high",
        },
        deps,
      ),
    ).rejects.toThrow(/only to the compatible-endpoint provider/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("validates an explicit effort even when the provider cannot record it", async () => {
    const deps = createDeps({ config: compatibleEndpointConfig() });

    await expect(
      runInferenceSet(
        {
          provider: "nvidia-prod",
          model: "nvidia/nemotron-3-super-120b-a12b",
          reasoningEffort: "extreme",
        },
        deps,
      ),
    ).rejects.toThrow(/must be one of: low, medium, high, default/);

    expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["extreme", /must be one of: low, medium, high, default/],
    ["default", /only to the compatible-endpoint provider/],
  ] as const)(
    "rejects the %s environment effort before mutating an unsupported provider",
    async (environmentEffort, expectedError) => {
      vi.stubEnv(REASONING_EFFORT_ENV, environmentEffort);
      const deps = createDeps({ config: compatibleEndpointConfig() });

      await expect(
        runInferenceSet(
          {
            provider: "nvidia-prod",
            model: "nvidia/nemotron-3-super-120b-a12b",
          },
          deps,
        ),
      ).rejects.toThrow(expectedError);

      expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
      expect(deps.calls.ensureHttpsPinRuntimeAdapter).not.toHaveBeenCalled();
      expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.updateSession).not.toHaveBeenCalled();
    },
  );

  it("clears the matching session effort when switching to an unsupported provider", async () => {
    const deps = createDeps({
      config: compatibleEndpointConfig(),
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "nemotron-3-super",
        compatibleEndpointReasoningEffort: "low",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "nemotron-3-super",
        compatibleEndpointReasoningEffort: "low",
      }),
    });

    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      },
      deps,
    );

    expect(deps.getSession()?.compatibleEndpointReasoningEffort).toBeNull();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ compatibleEndpointReasoningEffort: null }),
    ]);
  });

  it.each(["high", "default"] as const)(
    "rejects an explicit %s effort before mutating a non-Completions route",
    async (reasoningEffort) => {
      const deps = createDeps({
        config: compatibleEndpointConfig(),
        entry: {
          name: "alpha",
          agent: "openclaw",
          provider: "compatible-endpoint",
          model: "nemotron-3-super",
          endpointUrl: "https://compatible.example.test/v1",
          credentialEnv: "COMPATIBLE_API_KEY",
          preferredInferenceApi: "openai-completions",
        },
      });

      await expect(
        runInferenceSet(
          {
            provider: "compatible-endpoint",
            model: "nemotron-3-super",
            endpointUrl: "https://compatible.example.test/v1",
            credentialEnv: "COMPATIBLE_API_KEY",
            inferenceApi: "openai-responses",
            reasoningEffort,
          },
          deps,
        ),
      ).rejects.toThrow(/only to compatible-endpoint routes using openai-completions/);

      expect(deps.calls.rewriteConfigUrlsWithDnsPinning).not.toHaveBeenCalled();
      expect(deps.calls.ensureHttpsPinRuntimeAdapter).not.toHaveBeenCalled();
      expect(deps.calls.captureOpenshell).not.toHaveBeenCalled();
      expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
      expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
      expect(deps.calls.updateSession).not.toHaveBeenCalled();
    },
  );

  it("clears the matching session effort when switching to an unsupported API", async () => {
    let providerVersion = 1;
    const captureOpenshell = vi.fn((args: string[]) => {
      switch (`${args[0]}:${args[1]}`) {
        case "provider:get": {
          const output = [
            "Name: compatible-endpoint",
            "Id: 11111111-2222-4333-8444-555555555555",
            "Type: openai",
            `Resource version: ${providerVersion}`,
            "Credential keys: COMPATIBLE_API_KEY",
            "Config keys: OPENAI_BASE_URL",
          ].join("\n");
          return { status: 0, output, stdout: output, stderr: "" };
        }
        case "provider:update":
          providerVersion += 1;
          return { status: 0, output: "", stdout: "", stderr: "" };
        case "provider:profile":
          return {
            status: 0,
            output: OPENAI_ENDPOINTLESS_PROFILE,
            stdout: OPENAI_ENDPOINTLESS_PROFILE,
            stderr: "",
          };
        default:
          return { status: 0, output: "", stdout: "", stderr: "" };
      }
    });
    const deps = createDeps({
      config: compatibleEndpointConfig(),
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "nemotron-3-super",
        endpointUrl: "https://compatible.example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoningEffort: "low",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "nemotron-3-super",
        endpointUrl: "https://compatible.example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
        compatibleEndpointReasoningEffort: "low",
      }),
      captureOpenshell,
    });

    await runInferenceSet(
      {
        provider: "compatible-endpoint",
        model: "nemotron-3-super",
        endpointUrl: "https://compatible.example.test/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        inferenceApi: "openai-responses",
      },
      deps,
    );

    expect(deps.getSession()?.compatibleEndpointReasoningEffort).toBeNull();
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({ compatibleEndpointReasoningEffort: null }),
    ]);
  });
});
