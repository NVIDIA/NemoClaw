// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { OpenShellProviderAdapter } from "../adapters/openshell/provider-adapter";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfigUpdate } from "../sandbox/config";
import type { ConfigObject } from "../security/credential-filter";
import { NATIVE_HOSTED_PROFILES } from "../inference/native-hosted/profiles";
import { runInferenceSet } from "./inference-set";
import { baseSession, createDeps } from "./inference-set.test-support";

describe("runInferenceSet OpenClaw routing", () => {
  it("refuses publication after failed detach and permits a later clean switch", async () => {
    const old = {
      schemaVersion: 1 as const,
      profileId: "nemoclaw-nvidia-inference-v1",
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId: "old-provider",
    };
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        provider: "nvidia-prod",
        model: "old",
        nativeHostedProviderAttachment: old,
      },
    });
    const detach = vi.spyOn(deps.providerAdapter, "detachProvider");
    detach.mockResolvedValueOnce({
      ok: false,
      error: { kind: "command", reason: "unknown", message: "detach failed", status: 1 },
    } as any);
    await expect(
      runInferenceSet({ provider: "openai-api", model: "gpt-5.4", noVerify: true }, deps),
    ).rejects.toThrow("detach failed");
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toEqual({ ok: true, value: { names: [old.providerName] } });
    await runInferenceSet({ provider: "gemini-api", model: "gemini-test", noVerify: true }, deps);
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toEqual({
      ok: true,
      value: { names: ["nemoclaw-gemini-api-v1"] },
    });
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        provider: "gemini-api",
        nativeHostedProviderAuthorities: expect.arrayContaining([old]),
      }),
    );
  });

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

  it("reuses a same-gateway native NVIDIA provider authority from a peer sandbox", async () => {
    const peerAttachment = {
      schemaVersion: 1 as const,
      profileId: "nemoclaw-nvidia-inference-v1" as const,
      providerName: "nemoclaw-nvidia-prod-v1" as const,
      providerId: "11111111-2222-4333-8444-555555555555",
    };
    const deps = createDeps({
      config: {},
      entries: [
        {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          provider: "",
          model: "",
        },
        {
          name: "beta",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          provider: "nvidia-prod",
          model: "nvidia/peer-model",
          nativeNvidiaProviderAttachment: peerAttachment,
        },
      ],
      defaultSandbox: "alpha",
      resolveCredentialValue: () => "",
    });

    vi.spyOn(deps.providerAdapter, "getProvider").mockResolvedValue({
      ok: true,
      value: {
        name: peerAttachment.providerName,
        type: peerAttachment.profileId,
        credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
        configKeys: [],
        revision: { id: peerAttachment.providerId, resourceVersion: 1 },
      },
    });

    let attachedToAlpha = false;
    vi.spyOn(deps.providerAdapter, "attachProvider").mockImplementation(async () => {
      attachedToAlpha = true;
      return { ok: true };
    });
    vi.spyOn(deps.providerAdapter, "listProviderAttachments").mockImplementation(async () => ({
      ok: true,
      value: { names: attachedToAlpha ? [peerAttachment.providerName] : [] },
    }));

    await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/new-model", noVerify: true },
      deps,
    );

    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ nativeHostedProviderAttachment: peerAttachment }),
    );
  });

  it.each(
    NATIVE_HOSTED_PROFILES.filter((profile) => profile.logicalProvider !== "hermes-provider"),
  )("selects a native $label provider registered before any sandbox used it", async (profile) => {
    const gatewayAuthority = {
      schemaVersion: 1 as const,
      profileId: profile.profileId,
      providerName: profile.providerName,
      providerId: "11111111-2222-4333-8444-555555555555",
    };
    let attached = false;
    const providerAdapter = {
      importProviderProfile: vi.fn(async () => ({ ok: true as const })),
      getProvider: vi.fn(async () => ({
        ok: true as const,
        value: {
          name: profile.providerName,
          type: profile.profileId,
          credentialKeys: [profile.credentialEnv],
          configKeys: [],
          revision: { id: gatewayAuthority.providerId, resourceVersion: 1 },
        },
      })),
      listProviderAttachments: vi.fn(async () => ({
        ok: true as const,
        value: { names: attached ? [profile.providerName] : [] },
      })),
      attachProvider: vi.fn(async () => {
        attached = true;
        return { ok: true as const };
      }),
    } as unknown as OpenShellProviderAdapter;
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        provider: "",
        model: "",
      },
      getNativeHostedProviderAuthority: () => gatewayAuthority,
      getNativeNvidiaProviderAuthority: () => ({
        ...gatewayAuthority,
        profileId: "nemoclaw-nvidia-inference-v1",
        providerName: "nemoclaw-nvidia-prod-v1",
      }),
      providerAdapter,
      resolveCredentialValue: () => "",
    });

    await runInferenceSet(
      { provider: profile.logicalProvider, model: "selected-model", noVerify: true },
      deps,
    );

    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: gatewayAuthority,
        nativeHostedProviderAuthorities: expect.arrayContaining([gatewayAuthority]),
      }),
    );
  });

  it("creates a new native NVIDIA provider after reset removes retained authority", async () => {
    const deps = createDeps({
      config: {},
      entry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        provider: "openai-api",
        model: "gpt-5.4",
        nativeHostedProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-openai-inference-v1",
          providerName: "nemoclaw-openai-api-v1",
          providerId: "openai-owned",
        },
      },
      resolveCredentialValue: () => "replacement-credential",
    });
    const createProvider = vi.spyOn(deps.providerAdapter, "createProvider");
    await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/new-model", noVerify: true },
      deps,
    );
    expect(createProvider).toHaveBeenCalledExactlyOnceWith({
      target: { kind: "named", gatewayName: "nemoclaw" },
      name: "nemoclaw-nvidia-prod-v1",
      type: "nemoclaw-nvidia-inference-v1",
      credentials: [{ name: "NVIDIA_INFERENCE_API_KEY", value: "replacement-credential" }],
      config: [],
      fromExisting: false,
    });
    const receipt = expect.objectContaining({
      providerName: "nemoclaw-nvidia-prod-v1",
      providerId: "id-nemoclaw-nvidia-prod-v1",
    });
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: receipt,
        nativeHostedProviderAuthorities: expect.arrayContaining([receipt]),
      }),
    );
  });

  it("detaches previous native access before publishing another provider", async () => {
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
        nativeHostedProviderAttachment: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "11111111-2222-4333-8444-555555555555",
        },
      },
    });

    const detachProvider = vi.spyOn(deps.providerAdapter, "detachProvider");

    await runInferenceSet({ provider: "openai-api", model: "gpt-5.4", noVerify: true }, deps);

    expect(detachProvider).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        sandboxName: "alpha",
        providerName: "nemoclaw-nvidia-prod-v1",
      }),
    );
    expect(deps.calls.restartSandboxGateway).toHaveBeenCalledOnce();
    expect(detachProvider.mock.invocationCallOrder[0]).toBeLessThan(
      deps.calls.updateSandbox.mock.invocationCallOrder[0],
    );
    expect(deps.calls.updateSandbox).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({
        nativeHostedProviderAttachment: expect.objectContaining({
          profileId: "nemoclaw-openai-inference-v1",
          providerName: "nemoclaw-openai-api-v1",
        }),
      }),
    );
    expect(
      deps.calls.updateSandbox.mock.calls.some(
        ([, patch]) =>
          Object.hasOwn(patch, "nativeHostedProviderAttachment") &&
          patch.nativeHostedProviderAttachment === undefined,
      ),
    ).toBe(false);
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
  });

  it.each(
    NATIVE_HOSTED_PROFILES.filter((profile) => profile.logicalProvider !== "hermes-provider"),
  )("changes only the selected sandbox's native $label attachment (#12589)", async (profile) => {
    const original = NATIVE_HOSTED_PROFILES.find(
      (candidate) => candidate.logicalProvider === "nvidia-prod",
    )!;
    const receipt = {
      schemaVersion: 1 as const,
      profileId: original.profileId,
      providerName: original.providerName,
      providerId: "original-provider",
    };
    const deps = createDeps({
      config: {},
      entries: [
        {
          name: "alpha",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          provider: "nvidia-prod",
          model: "old",
          nativeHostedProviderAttachment: receipt,
        },
        {
          name: "beta",
          agent: "openclaw",
          gatewayName: "nemoclaw",
          provider: "nvidia-prod",
          model: "peer-model",
          nativeHostedProviderAttachment: receipt,
        },
      ],
    });
    await runInferenceSet(
      {
        sandboxName: "alpha",
        provider: profile.logicalProvider,
        model: "new-model",
        noVerify: true,
      },
      deps,
    );
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "alpha",
      }),
    ).toEqual({ ok: true, value: { names: [profile.providerName] } });
    expect(
      await deps.providerAdapter.listProviderAttachments({
        target: { kind: "named", gatewayName: "nemoclaw" },
        sandboxName: "beta",
      }),
    ).toEqual({ ok: true, value: { names: [original.providerName] } });
    expect(deps.calls.updateSandbox.mock.calls.every(([name]) => name === "alpha")).toBe(true);
    expect(
      deps.calls.captureOpenshell.mock.calls.some(
        ([args]) => args[0] === "inference" && args[1] === "set",
      ),
    ).toBe(false);
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
        nativeHostedProviderAttachment: expect.objectContaining({
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
  it("verifies retained NVIDIA authority across a single-sandbox round trip", async () => {
    const attachment = {
      schemaVersion: 1 as const,
      profileId: "nemoclaw-nvidia-inference-v1" as const,
      providerName: "nemoclaw-nvidia-prod-v1" as const,
      providerId: "11111111-2222-4333-8444-555555555555",
    };
    const entry = {
      name: "alpha",
      agent: "openclaw" as const,
      gatewayName: "nemoclaw",
      provider: "nvidia-prod",
      model: "nvidia/old-model",
      nativeNvidiaProviderAttachment: attachment,
      nativeHostedProviderAttachment: attachment,
      nativeHostedProviderAuthorities: [attachment],
    };
    const updateSandbox = vi.fn((name: string, updates: Record<string, unknown>) => {
      expect(name).toBe(entry.name);
      Object.assign(entry, updates);
      return true;
    });
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/nvidia/old-model" } } },
        models: { providers: {} },
      },
      entry,
      updateSandbox,
      resolveCredentialValue: (key) => (key === "OPENAI_API_KEY" ? "synthetic-openai-key" : ""),
    });

    await runInferenceSet({ provider: "openai-api", model: "gpt-5.4", noVerify: true }, deps);

    expect(entry).toMatchObject({
      provider: "openai-api",
      nativeHostedProviderAuthorities: expect.arrayContaining([attachment]),
    });
    expect(entry.nativeNvidiaProviderAttachment).toBeUndefined();
    expect(entry.nativeHostedProviderAttachment).toMatchObject({
      profileId: "nemoclaw-openai-inference-v1",
    });

    await runInferenceSet(
      { provider: "nvidia-prod", model: "nvidia/new-model", noVerify: true },
      deps,
    );

    expect(entry).toMatchObject({
      provider: "nvidia-prod",
      nativeHostedProviderAttachment: attachment,
      nativeHostedProviderAuthorities: expect.arrayContaining([attachment]),
    });
  });

  it("rejects a replaced NVIDIA provider before restoring detached access", async () => {
    const attachProvider = vi.fn<OpenShellProviderAdapter["attachProvider"]>();
    const providerAdapter = {
      importProviderProfile: vi.fn(async () => ({ ok: true })),
      getProvider: vi.fn(async () => ({
        ok: true,
        value: {
          name: "nemoclaw-nvidia-prod-v1",
          type: "nemoclaw-nvidia-inference-v1",
          credentialKeys: ["NVIDIA_INFERENCE_API_KEY"],
          configKeys: [],
          revision: {
            id: "replacement-provider-id",
            resourceVersion: 1,
          },
        },
      })),
      attachProvider,
    } as unknown as OpenShellProviderAdapter;
    const deps = createDeps({
      config: {
        agents: { defaults: { model: { primary: "inference/gpt-5.4" } } },
        models: { providers: {} },
      },
      entry: {
        name: "alpha",
        agent: "openclaw",
        gatewayName: "nemoclaw",
        provider: "ollama-local",
        model: "gpt-5.4",
        nativeNvidiaProviderAuthority: {
          schemaVersion: 1,
          profileId: "nemoclaw-nvidia-inference-v1",
          providerName: "nemoclaw-nvidia-prod-v1",
          providerId: "recorded-provider-id",
        },
      },
      providerAdapter,
      resolveCredentialValue: () => "",
    });

    await expect(
      runInferenceSet({ provider: "nvidia-prod", model: "nvidia/new-model", noVerify: true }, deps),
    ).rejects.toThrow(/changed identity.*No provider was changed/u);
    expect(attachProvider).not.toHaveBeenCalled();
    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
  });

  it("does not publish a non-native route when native NVIDIA detach fails", async () => {
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
      detachProvider: vi.fn(async () => ({
        ok: false,
        error: { kind: "command", reason: "failed", message: "detach denied" },
      })),
    } as unknown as OpenShellProviderAdapter;
    const config: ConfigObject = {
      agents: { defaults: { model: { primary: "inference/nvidia/old-model" } } },
      models: { providers: {} },
    };
    const deps = createDeps({
      config,
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

    await expect(
      runInferenceSet({ provider: "ollama-local", model: "model-a", noVerify: true }, deps),
    ).rejects.toThrow("Could not detach native NVIDIA provider from sandbox 'alpha'");

    expect(deps.calls.updateSandbox).not.toHaveBeenCalled();
    expect(deps.calls.setOpenClawConfigValues).not.toHaveBeenCalled();
    expect(deps.calls.restartSandboxGateway).not.toHaveBeenCalled();
    expect(config.agents).toEqual({
      defaults: { model: { primary: "inference/nvidia/old-model" } },
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
});
