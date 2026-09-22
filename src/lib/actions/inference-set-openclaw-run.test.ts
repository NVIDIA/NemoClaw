// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet OpenClaw routing", () => {
  it("keeps a large unrelated agent roster out of the native config transaction", async () => {
    const oversizedInstructions = "x".repeat(1_100_000);
    const config: ConfigObject = {
      agents: {
        defaults: { model: { primary: "inference/nvidia/old-model" } },
        list: [
          { id: "main", model: "inference/nvidia/old-model" },
          {
            id: "research",
            model: "inference/nvidia/secondary-model",
            instructions: oversizedInstructions,
          },
        ],
      },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [{ id: "old-model", name: "inference/nvidia/old-model" }],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });

    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/new-model",
        noVerify: true,
      },
      deps,
    );

    const updates = deps.calls.setOpenClawConfigValues.mock.calls[0]?.[1];
    expect(updates).toContainEqual({
      dotpath: "agents.list[0].model",
      value: "inference/nvidia/new-model",
    });
    expect(updates).not.toContainEqual(expect.objectContaining({ dotpath: "agents.list" }));
    expect(Buffer.byteLength(JSON.stringify(updates), "utf8")).toBeLessThan(16 * 1024);
    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/new-model" } },
      list: [
        { id: "main", model: "inference/nvidia/new-model" },
        {
          id: "research",
          model: "inference/nvidia/secondary-model",
          instructions: oversizedInstructions,
        },
      ],
    });
  });

  it("completes a same-API switch and pairing when audit persistence initially fails (#9527)", async () => {
    const config: ConfigObject = {
      agents: {
        defaults: { model: { primary: "inference/moonshotai/kimi-k2.6" } },
      },
      models: {
        providers: {
          inference: {
            api: "openai-completions",
            models: [
              {
                id: "moonshotai/kimi-k2.6",
                name: "inference/moonshotai/kimi-k2.6",
              },
            ],
          },
        },
      },
    };
    const deps = createDeps({ config, session: baseSession() });
    deps.calls.appendAuditEntry.mockImplementationOnce(() => {
      throw new Error("audit storage unavailable: credential=do-not-report");
    });

    const result = await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        noVerify: true,
      },
      deps,
    );

    expect(deps.calls.captureOpenshell).toHaveBeenCalledWith(
      [
        "inference",
        "set",
        "-g",
        "nemoclaw",
        "--provider",
        "nvidia-prod",
        "--model",
        "nvidia/nemotron-3-super-120b-a12b",
        "--no-verify",
      ],
      { ignoreError: true, includeStreams: true, maxBuffer: 64 * 1024 },
    );
    expect(config.agents).toEqual({
      defaults: {
        model: { primary: "inference/nvidia/nemotron-3-super-120b-a12b" },
      },
    });
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalledOnce();
    expect(deps.calls.setOpenClawConfigValues).toHaveBeenCalledWith(
      "alpha",
      [
        {
          dotpath: "agents.defaults.model.primary",
          value: "inference/nvidia/nemotron-3-super-120b-a12b",
        },
        { dotpath: "models.mode", value: "merge" },
        {
          dotpath: "models.providers.inference",
          value: expect.objectContaining({
            models: [expect.objectContaining({ id: "nvidia/nemotron-3-super-120b-a12b" })],
          }),
        },
      ],
      "nemoclaw",
    );
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    // The dashboard re-seed is Hermes-only; OpenClaw has no isolated dashboard config. (#6893)
    expect(deps.calls.seedHermesDashboardConfig).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(deps.calls.updateSandbox.mock.calls.at(-1)).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        credentialEnv: null,
        endpointUrl: null,
        nimContainer: null,
        preferredInferenceApi: null,
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      endpointUrl: "https://inference.local/v1",
    });
    expect(result).toMatchObject({
      sandboxName: "alpha",
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      primaryModelRef: "inference/nvidia/nemotron-3-super-120b-a12b",
      configChanged: true,
      sessionUpdated: true,
      inSandboxConfigSynced: true,
    });
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledWith("alpha", "nemoclaw");
    expect(deps.calls.settleOpenClawPairing).toHaveBeenCalledWith({
      sandboxName: "alpha",
      gatewayName: "nemoclaw",
      openclawVersion: "",
      stateDirectory: "/sandbox/.openclaw",
    });
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "alpha",
        reason:
          "inference set openclaw:nvidia-prod:nvidia/nemotron-3-super-120b-a12b (gateway restart and pairing convergence pending)",
      }),
    );
    expect(deps.calls.appendAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "inference_set",
        sandbox: "alpha",
        reason:
          "inference set openclaw:nvidia-prod:nvidia/nemotron-3-super-120b-a12b (gateway restart and pairing convergence completed)",
      }),
    );
    expect(JSON.stringify(deps.calls.appendAuditEntry.mock.calls)).not.toContain("do-not-report");
    expect(deps.calls.log).toHaveBeenCalledWith(
      "  Warning: could not record the post-commit inference audit entry for 'alpha'.",
    );
  });

  it("preserves same-provider Bedrock Runtime adapter routing for OpenClaw switches", async () => {
    const config: ConfigObject = {
      agents: {
        defaults: {
          model: {
            primary: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
          },
        },
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            models: [
              {
                id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
                name: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
              },
            ],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        endpointUrl: "https://inference.local/v1",
        credentialEnv: "COMPATIBLE_ANTHROPIC_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      session: baseSession({
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        preferredInferenceApi: "openai-completions",
      }),
    });

    const result = await runInferenceSet(
      {
        provider: "compatible-anthropic-endpoint",
        model: "anthropic.claude-sonnet-4-6-20260101-v1:0",
        noVerify: true,
      },
      deps,
    );

    expect(config.agents).toEqual({
      defaults: {
        model: {
          primary: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
        },
      },
    });
    expect(config.models).toMatchObject({
      providers: {
        inference: {
          baseUrl: "https://inference.local/v1",
          api: "openai-completions",
          models: [
            {
              id: "anthropic.claude-sonnet-4-6-20260101-v1:0",
              name: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
            },
          ],
        },
      },
    });
    expect(result).toMatchObject({
      providerKey: "inference",
      primaryModelRef: "inference/anthropic.claude-sonnet-4-6-20260101-v1:0",
    });
  });

  it("replaces a prior runtime provider marker when switching back to NVIDIA Build", async () => {
    const config: ConfigObject = {
      agents: {
        defaults: { model: { primary: "inference/openai/gpt-5.4-mini" } },
      },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            api: "openai-completions",
            headers: {
              "X-NemoClaw-Upstream-Provider": "compatible-endpoint",
            },
            models: [
              {
                id: "openai/gpt-5.4-mini",
                name: "inference/openai/gpt-5.4-mini",
              },
            ],
          },
        },
      },
    };
    const deps = createDeps({
      config,
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "compatible-endpoint",
        model: "openai/gpt-5.4-mini",
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      },
      session: baseSession({
        provider: "compatible-endpoint",
        model: "openai/gpt-5.4-mini",
        endpointUrl: "https://compatible.example/v1",
        credentialEnv: "COMPATIBLE_API_KEY",
        preferredInferenceApi: "openai-completions",
      }),
    });

    await runInferenceSet(
      {
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        noVerify: true,
      },
      deps,
    );

    expect(config.models).toMatchObject({
      providers: {
        inference: {
          headers: {
            "X-NemoClaw-Upstream-Provider": "nvidia-prod",
          },
        },
      },
    });
  });
});
