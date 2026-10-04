// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import type { OpenClawConfigUpdate } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet OpenClaw routing", () => {
  it("requires recreation instead of silently migrating a legacy NVIDIA sandbox", async () => {
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/legacy-model",
      },
    });

    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "nvidia/new-model" }, deps),
    ).rejects.toThrow("Recreate this beta sandbox");
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
  });

  it("detaches native NVIDIA access only after another provider is healthy", async () => {
    let attached = true;
    const detachProvider = vi.fn<OpenShellProviderAdapter["detachProvider"]>(async () => {
      attached = false;
      return { ok: true, value: { changed: true } };
    });
    const providerAdapter = {
      getProvider: vi.fn(async () => ({
        ok: true,
        value: {
          name: "nemoclaw-nvidia-prod-v1",
          type: "nemoclaw-nvidia-inference-v1",
          credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
          configKeys: [],
          revision: {
            id: "11111111-2222-4333-8444-555555555555",
            resourceVersion: 1,
          },
        },
      })),
      detachProvider,
      listProviderAttachments: vi.fn(async () => ({
        ok: true,
        value: { names: attached ? ["nemoclaw-nvidia-prod-v1"] : [] },
      })),
    } as unknown as OpenShellProviderAdapter;
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/nvidia/old-model" } } },
        models: { providers: {} },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "nvidia/old-model",
        nativeNvidiaProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "11111111-2222-4333-8444-555555555555",
        },
      },
      providerAdapter,
    });

    await runInferenceSet({ provider: "openai-api", model: "gpt-5.4", noVerify: true }, deps);

    expect(detachProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sandboxName: "alpha",
        providerName: "nemoclaw-nvidia-prod-v1",
      }),
    );
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
    expect(deps.calls.restartSandboxGateway.mock.invocationCallOrder[0]).toBeLessThan(
      detachProvider.mock.invocationCallOrder[0],
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith("alpha", {
      nativeNvidiaProviderAttachment: undefined,
    });
  });

  it.each([
    ["adding", false],
    ["updating", true],
  ] as const)(
    "preserves other native models when %s the requested model",
    async (_operation, alreadyExists) => {
      const otherModel = {
        id: "nvidia/other-model",
        name: "Native custom model",
        contextWindow: 65536,
        compat: { supportsStore: false },
        params: { temperature: 0.3 },
      };
      const requestedModel = {
        id: "nvidia/new-model",
        name: "Native selected model",
        maxTokens: 8192,
      };
      const config: ConfigObject = {
        agents: { defaults: { model: { primary: "inference/nvidia/other-model" } } },
        models: {
          providers: {
            inference: {
              api: "openai-completions",
              models: alreadyExists ? [otherModel, requestedModel] : [otherModel],
            },
          },
        },
      };
      const deps = createDeps({ config, session: baseSession() });

      await runInferenceSet(
        { provider: "nvidia-prod", model: "nvidia/new-model", noVerify: true },
        deps,
      );

      const updates: OpenClawConfigUpdate[] | undefined =
        deps.calls.setOpenClawConfigValues.mock.calls[0]?.[1];
      const providerUpdate = updates?.find(
        (update) => update.dotpath === "models.providers.inference",
      );
      const selectedModel = alreadyExists
        ? {
            ...requestedModel,
            name: "inference/nvidia/new-model",
            compat: { supportsStore: false },
          }
        : {
            id: "nvidia/new-model",
            name: "inference/nvidia/new-model",
            params: { temperature: 0.3 },
            compat: { supportsStore: false },
          };
      expect(providerUpdate?.value).toEqual({
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "unused",
        headers: { "X-NemoClaw-Upstream-Provider": "nvidia-prod" },
        models: alreadyExists ? [otherModel, selectedModel] : [selectedModel, otherModel],
      });
      expect(otherModel).toEqual({
        id: "nvidia/other-model",
        name: "Native custom model",
        contextWindow: 65536,
        compat: { supportsStore: false },
        params: { temperature: 0.3 },
      });
    },
  );

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

expect(
      deps.calls.captureOpenshell.mock.calls.filter(
        ([args]) => args[0] === "inference" && args[1] === "set",
      ),
    ).toEqual([]);
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
            models: [
              expect.objectContaining({ id: "nvidia/nemotron-3-super-120b-a12b" }),
              { id: "moonshotai/kimi-k2.6", name: "inference/moonshotai/kimi-k2.6" },
            ],
          }),
        },
      ],
      "nemoclaw",
    );
    expect(deps.calls.writeSandboxConfig).not.toHaveBeenCalled();
    expect(deps.calls.recomputeSandboxConfigHash).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
      }),
    );
    expect(
      deps.calls.updateSandbox.mock.calls
        .filter(([, fields]) => fields.provider !== undefined)
        .at(-1),
    ).toEqual([
      "alpha",
      expect.objectContaining({
        provider: "nvidia-prod",
        model: "nvidia/nemotron-3-super-120b-a12b",
        endpointUrl: null,
        credentialEnv: null,
        nimContainer: null,
        preferredInferenceApi: null,
        nativeNvidiaProviderAttachment: expect.objectContaining({
          providerName: "nemoclaw-nvidia-prod-v1",
        }),
      }),
    ]);
    expect(deps.getSession()).toMatchObject({
      provider: "nvidia-prod",
      model: "nvidia/nemotron-3-super-120b-a12b",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
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
            {
              id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
              name: "inference/anthropic.claude-3-5-sonnet-20240620-v1:0",
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
