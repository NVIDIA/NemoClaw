// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import { MIN_HERMES_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import type { VllmProfile } from "../inference/vllm";
import { makeDeps, makeHostState, unexpected } from "./__test-helpers__/setup-nim-flow";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import type { LocalModelProfilePlan } from "./local-model-profile/integration";
import { createSetupNim, type SetupNimFlowDeps, withServingPortGuard } from "./setup-nim-flow";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("withServingPortGuard", () => {
  it("binds the serving-port probe without changing installer options (#8685)", async () => {
    const profile = {} as VllmProfile;
    type ServingPortProbe = (port: number) => Promise<{ ok: boolean; reason?: string }>;
    const checkServingPort = vi.fn<ServingPortProbe>(async () => ({ ok: true }));
    const install = vi.fn(
      async (
        receivedProfile: VllmProfile,
        options: {
          keepExisting: boolean;
          checkServingPort?: ServingPortProbe;
        },
      ) => ({ ok: receivedProfile === profile && options.keepExisting }),
    );
    const guardedInstall = withServingPortGuard<{ keepExisting: boolean }, typeof install>(
      install,
      checkServingPort,
    );

    await expect(guardedInstall(profile, { keepExisting: true })).resolves.toEqual({ ok: true });
    expect(install).toHaveBeenCalledWith(profile, {
      keepExisting: true,
      checkServingPort,
    });
  });
});

describe("createSetupNim", () => {
  it("passes the Deep Agents manifest default to shared NVIDIA/OpenRouter model selection", async () => {
    const ultra = "nvidia/nemotron-3-ultra-550b-a55b";
    const log = vi.fn();
    const sharedSession = { select: async () => unexpected("featured model selection") };
    const createNvidiaFeaturedModelSession = vi.fn<
      SetupNimFlowDeps["createNvidiaFeaturedModelSession"]
    >(() => sharedSession);
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        expect(state.openRouterFeaturedModels).toBe(state.nvidiaFeaturedModels);
        state.model = ultra;
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({ createNvidiaFeaturedModelSession, handleRemoteProviderSelection, log }),
    );
    const dcodeAgent = {
      name: "langchain-deepagents-code",
      inference: { default_model: ultra },
    } as AgentDefinition;

    await setupNim(null, null, dcodeAgent);

    expect(createNvidiaFeaturedModelSession).toHaveBeenCalledTimes(1);
    expect(createNvidiaFeaturedModelSession).toHaveBeenCalledWith({
      defaultModel: ultra,
      writeLine: log,
    });
  });

  it("lets a same-gateway route constraint override the Deep Agents default before probing", async () => {
    const ultra = "nvidia/nemotron-3-ultra-550b-a55b";
    const sharedModel = "nvidia/nemotron-3-super-120b-a12b";
    const providerProbe = vi.fn();
    const select = vi.fn(async (requestedModel: string | null) => requestedModel ?? ultra);
    const createNvidiaFeaturedModelSession = vi.fn<
      SetupNimFlowDeps["createNvidiaFeaturedModelSession"]
    >(() => ({ select }));
    const routeGuard = vi.fn((route: { model: string | null }) => ({
      requiredModel: route.model ? null : sharedModel,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    }));
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "nvidia-prod";
        state.model = null;
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.assertRouteCompatible?.();
        state.model = await state.nvidiaFeaturedModels!.select(
          typeof state.model === "string" ? state.model : null,
          null,
          true,
        );
        state.assertRouteCompatible?.();
        providerProbe(state.model);
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "build",
        createNvidiaFeaturedModelSession,
        handleRemoteProviderSelection,
      }),
    );
    const dcodeAgent = {
      name: "langchain-deepagents-code",
      inference: { default_model: ultra },
    } as AgentDefinition;

    const result = await setupNim(null, "dcode", dcodeAgent, true, null, "nemoclaw", routeGuard);

    expect(createNvidiaFeaturedModelSession).toHaveBeenCalledWith({
      defaultModel: ultra,
      writeLine: expect.any(Function),
    });
    expect(select).toHaveBeenCalledWith(sharedModel, null, true);
    expect(routeGuard.mock.calls[0]?.[0]).toMatchObject({ model: null });
    expect(routeGuard.mock.calls.slice(1).map(([route]) => route.model)).toEqual([
      sharedModel,
      sharedModel,
      sharedModel,
    ]);
    expect(providerProbe).toHaveBeenCalledWith(sharedModel);
    expect(result.model).toBe(sharedModel);
  });

  it("announces detected Ollama but still prompts and defaults to NVIDIA Endpoints (#6245)", async () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "");
    const step = vi.fn();
    const log = vi.fn();
    const prompt = vi.fn(async () => "");
    const maybePromptForInferenceInputCapability = vi.fn(async () => {});
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async ({ selected }, state) => {
        expect(selected.key).toBe("build");
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        step,
        log,
        prompt,
        maybePromptForInferenceInputCapability,
        detectInferenceProviderHostState: () =>
          makeHostState({
            hasOllama: true,
            ollamaHost: "127.0.0.1",
            ollamaRunning: true,
          }),
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, null, null, true, null, "nemoclaw-9090");

    expect(step).toHaveBeenCalledWith(3, 8, "Configuring inference provider");
    expect(log).toHaveBeenCalledWith("  Detected local inference option: Ollama");
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("  Choose [1]: ");
    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
    expect(handleRemoteProviderSelection.mock.calls[0]?.[0].gatewayName).toBe("nemoclaw-9090");
    expect(maybePromptForInferenceInputCapability).toHaveBeenCalledWith(
      "nvidia/nemotron-3-super-120b-a12b",
    );
    const { inferenceCapabilityCache, ...resultWithoutCache } = result;
    expect(inferenceCapabilityCache).toBeInstanceOf(OnboardInferenceCapabilityCache);
    expect(resultWithoutCache).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      endpointSource: null,
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      hermesAuthMethod: null,
      hermesToolGateways: [],
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      nimContainer: null,
      allowToolsIncompatible: false,
      skipHostInferenceSmoke: false,
      reuseGatewayCredentialWithoutLocalKey: false,
    });
  });

  it("records a newly selected Bedrock Runtime endpoint as onboard provenance", async () => {
    const endpointUrl = "https://bedrock-runtime.us-east-1.amazonaws.com";
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.model = "anthropic.claude-3-5-sonnet-20240620-v1:0";
        state.provider = "compatible-anthropic-endpoint";
        state.endpointUrl = endpointUrl;
        state.credentialEnv = "ANTHROPIC_COMPATIBLE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "anthropicCompatible",
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null);

    expect(result).toMatchObject({
      provider: "compatible-anthropic-endpoint",
      endpointUrl,
      endpointSource: "onboard",
    });
    expect(result.endpointPinnedAddresses).toBeUndefined();
    expect(result.endpointTrustedPrivateCapability).toBeUndefined();
  });

  it("re-enters provider selection when a handler requests a retry (#6245)", async () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "");
    const prompt = vi.fn(async () => "");
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.model = "final-model";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        return "selected";
      },
    );
    handleRemoteProviderSelection.mockResolvedValueOnce("retry-selection");
    const setupNim = createSetupNim(
      makeDeps({
        prompt,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null);

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(handleRemoteProviderSelection).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ model: "final-model", provider: "nvidia-prod" });
  });

  it("suppresses unrelated local endpoint probes for an explicit remote selection (#6315)", async () => {
    const detectInferenceProviderHostState = vi.fn(() => makeHostState());
    const canProbeRoute = vi.fn(() => true);
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.model = "gpt-test";
        state.provider = "openai-api";
        state.endpointUrl = "https://api.openai.com/v1";
        state.credentialEnv = "OPENAI_API_KEY";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "openai",
        detectInferenceProviderHostState,
        handleRemoteProviderSelection,
      }),
    );

    await setupNim(null, null, null, true, null, "nemoclaw", undefined, canProbeRoute);

    expect(detectInferenceProviderHostState).toHaveBeenCalledWith({
      gpu: null,
      experimental: false,
      probeOllama: false,
      probeVllm: false,
    });
    expect(canProbeRoute).not.toHaveBeenCalled();
  });

  it("keeps interactive local discovery probes on when the route preflight reports a conflict (#6750)", async () => {
    const events: string[] = [];
    const canProbeRoute = vi.fn((provider: string) => {
      events.push(`preflight:${provider}`);
      return false;
    });
    const detectInferenceProviderHostState = vi.fn((input) => {
      events.push(`detect:${String(input.probeOllama)}:${String(input.probeVllm)}`);
      return makeHostState();
    });
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.model = "nvidia/test";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({ detectInferenceProviderHostState, handleRemoteProviderSelection }),
    );

    await setupNim(null, null, null, true, null, "nemoclaw", undefined, canProbeRoute);

    // Route conflicts are enforced at selection time; the interactive menu
    // still probes so a running daemon renders its status truthfully.
    expect(canProbeRoute).not.toHaveBeenCalled();
    expect(events).toEqual(["detect:true:true"]);
  });

  it("rejects a known local route before host detection when its model conflicts (#6315)", async () => {
    const detectInferenceProviderHostState = vi.fn(() => makeHostState());
    const routeGuard = vi.fn(() => {
      throw new Error("route conflict");
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "conflict/model",
        detectInferenceProviderHostState,
      }),
    );

    await expect(setupNim(null, null, null, true, null, "nemoclaw", routeGuard)).rejects.toThrow(
      "route conflict",
    );
    expect(routeGuard).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "ollama-local", model: "conflict/model" }),
    );
    expect(detectInferenceProviderHostState).not.toHaveBeenCalled();
  });

  it("passes the Hermes Ollama context floor without showing the OpenClaw Input capability prompt (#6760)", async () => {
    const maybePromptForInferenceInputCapability = vi.fn(async () => {});
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, _requestedModel, _recoveredModel, _ollamaRunning, state) => {
        expect(state.ollamaContextWindowFloor).toBe(MIN_HERMES_OLLAMA_CONTEXT_WINDOW);
        state.model = "llama3.2:1b";
        state.provider = "ollama-local";
        state.endpointUrl = "http://127.0.0.1:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "ollama",
        getNonInteractiveModel: () => "llama3.2:1b",
        detectInferenceProviderHostState: () =>
          makeHostState({ hasOllama: true, ollamaHost: "127.0.0.1", ollamaRunning: true }),
        handleRunningOllamaSelection,
        maybePromptForInferenceInputCapability,
      }),
    );

    const result = await setupNim(null, null, { name: "hermes" } as AgentDefinition);

    expect(result.provider).toBe("ollama-local");
    expect(handleRunningOllamaSelection).toHaveBeenCalledTimes(1);
    expect(maybePromptForInferenceInputCapability).not.toHaveBeenCalled();
  });

  it("applies same-gateway discovery constraints before a provider probe (#6315)", async () => {
    const providerProbe = vi.fn();
    const routeGuard = vi.fn(
      (route: { model: string | null; preferredInferenceApi?: string | null }) => ({
        requiredModel: route.model ? null : "shared/model",
        requiredEndpointUrl: "https://shared.example.test/v1",
        requiredInferenceApi: route.preferredInferenceApi ? null : "openai-responses",
      }),
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "compatible-endpoint";
        state.model = null;
        state.endpointUrl = "https://shared.example.test/v1";
        state.credentialEnv = "COMPATIBLE_API_KEY";
        state.preferredInferenceApi = null;
        state.assertRouteCompatible?.();
        expect(state.model).toBe("shared/model");
        expect(state.preferredInferenceApi).toBe("openai-responses");
        providerProbe();
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "custom",
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, null, null, true, null, "nemoclaw", routeGuard);

    expect(providerProbe).toHaveBeenCalledOnce();
    expect(routeGuard).toHaveBeenLastCalledWith(
      expect.objectContaining({
        provider: "compatible-endpoint",
        model: "shared/model",
        preferredInferenceApi: "openai-responses",
      }),
    );
    expect(result.model).toBe("shared/model");
  });

  it("guards custom Anthropic routes with the final Hermes API identity (#6315)", async () => {
    const agent = { name: "hermes" } as AgentDefinition;
    const routeGuard = vi.fn((route) => {
      expect(route.preferredInferenceApi).toBe("openai-completions");
      return { requiredModel: null, requiredEndpointUrl: null, requiredInferenceApi: null };
    });
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "compatible-anthropic-endpoint";
        state.model = "anthropic/model";
        state.endpointUrl = "https://anthropic.example.test";
        state.credentialEnv = "ANTHROPIC_COMPATIBLE_API_KEY";
        state.preferredInferenceApi = "anthropic-messages";
        state.assertRouteCompatible?.();
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "anthropicCompatible",
        resolveAgentInferenceApi: (agentName, provider, preferredInferenceApi) =>
          agentName === "hermes" && provider === "compatible-anthropic-endpoint"
            ? "openai-completions"
            : preferredInferenceApi,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, null, agent, true, null, "nemoclaw", routeGuard);

    expect(routeGuard).toHaveBeenCalled();
    expect(result.preferredInferenceApi).toBe("openai-completions");
  });

  it("recovers a recorded provider and model without prompting in non-interactive mode (#6245)", async () => {
    const recoverySessionId = "session-recovery";
    const prompt = vi.fn(async () => unexpected("interactive provider prompt"));
    const note = vi.fn();
    const readRecordedProvider = vi.fn(() => "openai-api");
    const readRecordedNimContainer = vi.fn(() => null);
    const readRecordedModel = vi.fn(() => "gpt-4.1");
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (args, state) => {
        expect(args).toMatchObject({
          selected: { key: "openai", label: "OpenAI" },
          requestedModel: null,
          recoveredFromSandbox: true,
          recoveredModel: "gpt-4.1",
          sandboxName: "existing-sandbox",
          recoverySessionId,
        });
        state.model = args.recoveredModel;
        state.provider = "openai-api";
        state.endpointUrl = "https://api.openai.com/v1";
        state.credentialEnv = "OPENAI_API_KEY";
        state.preferredInferenceApi = "openai-responses";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        prompt,
        note,
        readRecordedProvider,
        readRecordedNimContainer,
        readRecordedModel,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(
      null,
      "existing-sandbox",
      null,
      true,
      null,
      null,
      undefined,
      undefined,
      recoverySessionId,
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(readRecordedProvider).toHaveBeenCalledWith("existing-sandbox", recoverySessionId);
    expect(readRecordedNimContainer).toHaveBeenCalledWith("existing-sandbox", recoverySessionId);
    expect(readRecordedModel).toHaveBeenCalledWith("existing-sandbox", recoverySessionId);
    expect(note).toHaveBeenCalledWith(
      "  [non-interactive] Provider: openai (recovered from sandbox 'existing-sandbox')",
    );
    expect(result).toMatchObject({
      model: "gpt-4.1",
      provider: "openai-api",
      endpointUrl: "https://api.openai.com/v1",
      credentialEnv: "OPENAI_API_KEY",
      preferredInferenceApi: "openai-responses",
    });
  });

  it("ignores recorded provider state when fresh setup disables recovery (#6237)", async () => {
    const prompt = vi.fn(async () => unexpected("interactive provider prompt"));
    const note = vi.fn();
    const readRecordedProvider = vi.fn(() => "ollama-local");
    const readRecordedNimContainer = vi.fn(() => null);
    const readRecordedModel = vi.fn(() => "llama3.1");
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (args, state) => {
        expect(args).toMatchObject({
          selected: { key: "build", label: "NVIDIA Endpoints" },
          requestedModel: null,
          recoveredFromSandbox: false,
          recoveredModel: null,
          sandboxName: "dcode-station",
        });
        state.model = "nvidia/test-model";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        prompt,
        note,
        readRecordedProvider,
        readRecordedNimContainer,
        readRecordedModel,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, "dcode-station", null, false);

    expect(prompt).not.toHaveBeenCalled();
    expect(readRecordedProvider).not.toHaveBeenCalled();
    expect(readRecordedNimContainer).not.toHaveBeenCalled();
    expect(readRecordedModel).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith("  [non-interactive] Provider: build");
    expect(result).toMatchObject({
      model: "nvidia/test-model",
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      preferredInferenceApi: "openai-completions",
    });
  });

  it("does not carry the provider-model fallback across a provider switch (#8135)", async () => {
    const note = vi.fn();
    const readRecordedProvider = vi.fn(() => "nvidia-prod");
    const readRecordedNimContainer = vi.fn(() => null);
    const readRecordedModel = vi.fn(() => "nvidia/nemotron-3-super-120b-a12b");
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (args, state) => {
        expect(args).toMatchObject({
          selected: { key: "openai", label: "OpenAI" },
          requestedModel: null,
          recoveredFromSandbox: false,
          recoveredModel: null,
          sandboxName: "drift-sandbox",
        });
        state.model = "gpt-5.4";
        state.provider = "openai-api";
        state.endpointUrl = "https://api.openai.com/v1";
        state.credentialEnv = "OPENAI_API_KEY";
        state.preferredInferenceApi = "openai-responses";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "openai",
        getNonInteractiveModel: (_providerKey, options) =>
          options?.allowProviderModelFallback === false
            ? null
            : "nvidia/nemotron-3-super-120b-a12b",
        note,
        readRecordedProvider,
        readRecordedNimContainer,
        readRecordedModel,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, "drift-sandbox", null, true);

    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
    expect(note).toHaveBeenCalledWith("  [non-interactive] Provider: openai");
    expect(result).toMatchObject({
      model: "gpt-5.4",
      provider: "openai-api",
    });
  });

  it("preserves an explicit model that matches the recorded provider default after a provider switch (#8135)", async () => {
    const readRecordedProvider = vi.fn(() => "nvidia-prod");
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (args, state) => {
        expect(args).toMatchObject({
          selected: { key: "openai", label: "OpenAI" },
          requestedModel: "nvidia/nemotron-3-super-120b-a12b",
          sandboxName: "drift-sandbox",
        });
        state.model = args.requestedModel;
        state.provider = "openai-api";
        state.endpointUrl = "https://api.openai.com/v1";
        state.credentialEnv = "OPENAI_API_KEY";
        state.preferredInferenceApi = "openai-responses";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "openai",
        getNonInteractiveModel: () => "nvidia/nemotron-3-super-120b-a12b",
        readRecordedProvider,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, "drift-sandbox", null, true);

    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "openai-api",
    });
  });

  it("honors a rebuild route and preserves credential-reuse return contracts (#6245)", async () => {
    const agent = { name: "langchain-deepagents-code" } as AgentDefinition;
    const recoveredRegistryRoute = {
      provider: "openai-api",
      model: "handoff-model",
      endpointUrl: "https://handoff.example.com/v1",
      endpointSource: "inference-set",
      preferredInferenceApi: "openai-responses",
      source: "registry",
    } as const;
    const readRecordedProvider = vi.fn(() => "nvidia-prod");
    const readRecordedModel = vi.fn(() => "stale-model");
    const clearCompatibleEndpointReasoning = vi.fn(() => null);
    const coerceAgentInferenceApi = vi.fn<SetupNimFlowDeps["coerceAgentInferenceApi"]>(
      () => "openai-completions",
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (args, state, recoveredRoute) => {
        expect(args).toMatchObject({
          selected: { key: "openai", label: "OpenAI" },
          recoveredFromSandbox: true,
          recoveredModel: "handoff-model",
          sandboxName: "target-sandbox",
          intendedInferenceApi: null,
        });
        expect(recoveredRoute).toBe(recoveredRegistryRoute);
        state.model = args.recoveredModel;
        state.provider = "openai-api";
        state.endpointUrl = recoveredRoute?.endpointUrl ?? null;
        state.credentialEnv = "OPENAI_API_KEY";
        state.preferredInferenceApi = recoveredRoute?.preferredInferenceApi ?? null;
        state.compatibleEndpointReasoning = "stale-compatible-reasoning";
        state.reuseGatewayCredentialWithoutLocalKey = true;
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        readRecordedProvider,
        readRecordedModel,
        clearCompatibleEndpointReasoning,
        coerceAgentInferenceApi,
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, "target-sandbox", agent, true, {
      sandboxName: "target-sandbox",
      route: recoveredRegistryRoute,
    });

    expect(readRecordedProvider).not.toHaveBeenCalled();
    expect(readRecordedModel).not.toHaveBeenCalled();
    expect(clearCompatibleEndpointReasoning).toHaveBeenCalledOnce();
    expect(coerceAgentInferenceApi).toHaveBeenCalledWith(agent, "openai-responses");
    expect(result).toMatchObject({
      model: "handoff-model",
      provider: "openai-api",
      endpointUrl: "https://handoff.example.com/v1",
      endpointSource: "inference-set",
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      compatibleEndpointReasoningEffort: null,
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    });
  });

  it("continues from a successful managed vLLM install into provider selection (#6245)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    const prompt = vi.fn(async () => unexpected("provider prompt"));
    const detectInferenceProviderHostState = vi.fn(() =>
      makeHostState({
        vllmProfile: profile,
        hasVllmImage: true,
        vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
      }),
    );
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.beforeInstall?.("vllm-model");
      return { ok: true };
    });
    const routeGuard = vi.fn(() => ({
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    }));
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      expect(state.model).toBe("vllm-model");
      state.provider = "vllm";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-vllm",
        prompt,
        detectInferenceProviderHostState,
        installVllm,
        handleVllmSelection,
      }),
    );

    const result = await setupNim(null, null, null, true, null, "nemoclaw", routeGuard);

    expect(installVllm).toHaveBeenCalledWith(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: prompt,
      beforeInstall: expect.any(Function),
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(detectInferenceProviderHostState).toHaveBeenCalledWith({
      gpu: null,
      experimental: false,
      probeOllama: false,
      probeVllm: true,
    });
    expect(routeGuard).toHaveBeenCalledWith({
      provider: "vllm-local",
      model: "vllm-model",
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      credentialEnv: null,
    });
    expect(handleVllmSelection).toHaveBeenCalledOnce();
    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.objectContaining({ model: "vllm-model" }),
      { managedInstall: true, sparkHost: false, servingProfileModel: null },
    );
    expect(result).toMatchObject({
      model: "vllm-model",
      provider: "vllm",
      endpointUrl: "http://127.0.0.1:8000/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
  });

  it("auto-selects managed vLLM on a DGX Spark non-interactive run with no requested provider (#7293)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    const prompt = vi.fn(async () => unexpected("provider prompt"));
    const detectInferenceProviderHostState = vi.fn(() =>
      makeHostState({
        vllmProfile: profile,
        hasVllmImage: true,
        vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
      }),
    );
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.beforeInstall?.("vllm-model");
      return { ok: true };
    });
    const routeGuard = vi.fn(() => ({
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    }));
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        // No explicit provider: the DGX Spark platform default must still pick
        // managed vLLM instead of falling back to the cloud `build` handler
        // (handleRemoteProviderSelection stays `unexpected`, so a fallback throws).
        getNonInteractiveProvider: () => null,
        prompt,
        detectInferenceProviderHostState,
        installVllm,
        handleVllmSelection,
      }),
    );

    const sparkGpu = { platform: "spark" } as unknown as Parameters<typeof setupNim>[0];
    const result = await setupNim(sparkGpu, null, null, true, null, "nemoclaw", routeGuard);

    expect(installVllm).toHaveBeenCalledWith(
      profile,
      expect.objectContaining({ hasImage: true, nonInteractive: true }),
    );
    expect(handleVllmSelection).toHaveBeenCalledOnce();
    expect(prompt).not.toHaveBeenCalled();
    expect(result).toMatchObject({ provider: "vllm" });
  }, 15_000);

  it("reuses an already-running local vLLM on a DGX Spark non-interactive run with no requested provider (#7293)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    // vLLM already running → the menu exposes only `vllm`; the no-provider
    // default must reuse it (handleVllmSelection) and never reinstall
    // (installVllm stays `unexpected`) or fall back to the cloud handler.
    const detectInferenceProviderHostState = vi.fn(() =>
      makeHostState({
        vllmRunning: true,
        vllmProfile: profile,
        hasVllmImage: true,
        vllmEntries: [{ key: "vllm", label: "Local vLLM (localhost:8000) — running (suggested)" }],
      }),
    );
    const routeGuard = vi.fn(() => ({
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    }));
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm";
      state.model = "vllm-model";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => null,
        detectInferenceProviderHostState,
        handleVllmSelection,
      }),
    );

    const sparkGpu = { platform: "spark" } as unknown as Parameters<typeof setupNim>[0];
    const result = await setupNim(sparkGpu, null, null, true, null, "nemoclaw", routeGuard);

    expect(handleVllmSelection).toHaveBeenCalledOnce();
    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ managedInstall: false }),
    );
    expect(result).toMatchObject({ provider: "vllm" });
  });

  it("normalizes a catalog model alias before reusing managed vLLM", async () => {
    const servedModel = "nvidia-nemotron-3.5-lightning-30b-a3b-nvfp4";
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      expect(state.model).toBe(servedModel);
      state.provider = "vllm";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-vllm",
        getNonInteractiveModel: () => "nemotron-3.5-lightning-30b",
        selectVllmModelFromEnv: () => ({
          id: "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-NVFP4",
          servedModelId: servedModel,
        }),
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmProfile: { name: "DGX Spark" } as VllmProfile,
            vllmEntries: [{ key: "vllm", label: "Local vLLM (localhost:8000) — running" }],
          }),
        handleVllmSelection,
      }),
    );

    await setupNim(
      { platform: "spark" } as unknown as Parameters<typeof setupNim>[0],
      null,
      null,
      true,
      null,
      "nemoclaw",
    );

    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.objectContaining({ model: servedModel }),
      expect.objectContaining({ managedInstall: false }),
    );
  });

  it("does not extend the Spark automatic default to DGX Station (#7293)", async () => {
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async ({ selected }, state) => {
        expect(selected.key).toBe("build");
        state.model = "nvidia/nemotron-3-ultra-550b-a55b";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => null,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmProfile: { name: "DGX Station" } as VllmProfile,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Station)" }],
          }),
        handleRemoteProviderSelection,
      }),
    );

    const stationGpu = { platform: "station" } as unknown as Parameters<typeof setupNim>[0];
    const result = await setupNim(stationGpu);

    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ provider: "nvidia-prod" });
  });

  it("threads the DGX Station express model through the standard managed-vLLM selection contract", async () => {
    const profile = { name: "DGX Station", platform: "station" } as VllmProfile;
    const servedModel = "nvidia/nemotron-3-ultra-550b-a55b";
    const prompt = vi.fn(async () => unexpected("provider prompt"));
    const detectInferenceProviderHostState = vi.fn(() =>
      makeHostState({
        vllmProfile: profile,
        hasVllmImage: false,
        vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Station)" }],
      }),
    );
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.beforeInstall?.(servedModel);
      return { ok: true };
    });
    const routeGuard = vi.fn(() => ({
      requiredModel: null,
      requiredEndpointUrl: null,
      requiredInferenceApi: null,
    }));
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      expect(state).toMatchObject({
        provider: "vllm-local",
        model: servedModel,
        endpointUrl: null,
        credentialEnv: null,
        preferredInferenceApi: "openai-completions",
      });
      state.provider = "vllm-local";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.vllmModelIdentity = "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-vllm",
        prompt,
        detectInferenceProviderHostState,
        installVllm,
        handleVllmSelection,
      }),
    );

    const result = await setupNim(null, null, null, true, null, "nemoclaw", routeGuard);

    expect(prompt).not.toHaveBeenCalled();
    expect(installVllm).toHaveBeenCalledWith(profile, {
      hasImage: false,
      nonInteractive: true,
      promptFn: prompt,
      beforeInstall: expect.any(Function),
    });
    expect(routeGuard).toHaveBeenCalledWith({
      provider: "vllm-local",
      model: servedModel,
      endpointUrl: null,
      preferredInferenceApi: "openai-completions",
      credentialEnv: null,
    });
    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.objectContaining({ model: servedModel }),
      { managedInstall: true, sparkHost: false, servingProfileModel: null },
    );
    expect(result).toMatchObject({
      model: servedModel,
      provider: "vllm-local",
      endpointUrl: "http://127.0.0.1:8000/v1",
      preferredInferenceApi: "openai-completions",
      vllmModelIdentity: "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-NVFP4",
    });
  });

  it("passes sparkHost:true when detected GPU is Spark (firmware-unknown GB10 threading)", async () => {
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm-local";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const sparkGpu = { type: "nvidia", spark: true, platform: "spark" } as ReturnType<
      typeof import("../inference/nim").detectGpu
    >;
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "vllm",
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmEntries: [{ key: "vllm", label: "Local vLLM — running" }],
          }),
        handleVllmSelection,
      }),
    );

    await setupNim(sparkGpu);

    expect(handleVllmSelection).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ sparkHost: true }),
    );
  });

  it("validates DCode custom Anthropic selections on the OpenAI surface (#6294)", async () => {
    const agent = {
      name: "langchain-deepagents-code",
      inference: { provider_type: "openai_compatible" },
    } as AgentDefinition;
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (args, state) => {
        expect(args.intendedInferenceApi).toBe("openai-completions");
        state.model = "custom-model";
        state.provider = "compatible-anthropic-endpoint";
        state.endpointUrl = "https://compatible.example";
        state.credentialEnv = "COMPATIBLE_ANTHROPIC_API_KEY";
        state.preferredInferenceApi = args.intendedInferenceApi;
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "anthropicCompatible",
        getNonInteractiveModel: () => "custom-model",
        handleRemoteProviderSelection,
      }),
    );

    const result = await setupNim(null, null, agent);

    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
    expect(result.preferredInferenceApi).toBe("openai-completions");
  });

  it("refuses the N1x managed preview when an existing vLLM occupies port 8000 (#8574)", async () => {
    const profile = { name: "N1x", platform: "n1x" } as VllmProfile;
    const error = vi.fn();
    const abortNonInteractive = vi.fn<SetupNimFlowDeps["abortNonInteractive"]>((message) => {
      throw new Error(message);
    });
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async (_profile, options) => {
      options.beforeInstall?.("vllm-model");
      return { ok: true };
    });
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm";
      state.endpointUrl = "http://127.0.0.1:8000/v1";
      state.credentialEnv = null;
      state.preferredInferenceApi = "openai-completions";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-vllm",
        error,
        abortNonInteractive,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [
              { key: "install-vllm", label: "Start vLLM (N1x) [Deferred preview]" },
            ],
          }),
        installVllm,
        handleVllmSelection,
      }),
    );

    await expect(
      setupNim({ type: "nvidia", platform: "n1x" } as ReturnType<
        typeof import("../inference/nim").detectGpu
      >),
    ).rejects.toThrow("The N1x Deferred preview requires managed vLLM");

    expect(error).toHaveBeenCalledWith(expect.stringContaining("requires managed vLLM"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("localhost:8000"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Stop the existing server"));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("NEMOCLAW_PROVIDER=install-vllm"),
    );
    expect(abortNonInteractive).toHaveBeenCalledOnce();
    expect(installVllm).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
  });

  it("dispatches llama.cpp existing-server selection without a managed install path (#8161)", async () => {
    const handleLlamaCppSelection = vi.fn<SetupNimFlowDeps["handleLlamaCppSelection"]>(
      async (selection, requestedModel) => {
        expect(requestedModel).toBe("team/model-alias");
        selection.provider = "llama-cpp-local";
        selection.model = "team/model-alias";
        selection.endpointUrl = "http://127.0.0.1:8081/v1";
        selection.credentialEnv = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
        selection.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const runtimeProvider = makeDeps().getRuntimeProvider();
    const getRuntimeProvider = vi.fn(() => runtimeProvider);
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "llama-cpp",
        getNonInteractiveModel: () => "team/model-alias",
        getRuntimeProvider,
        handleLlamaCppSelection,
      }),
    );

    await expect(setupNim(null)).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "team/model-alias",
      endpointUrl: "http://127.0.0.1:8081/v1",
      credentialEnv: "NEMOCLAW_LLAMACPP_LOCAL_TOKEN",
      preferredInferenceApi: "openai-completions",
    });
    expect(handleLlamaCppSelection).toHaveBeenCalledOnce();
    expect(getRuntimeProvider).not.toHaveBeenCalled();
  });

  it("activates a readiness-selected managed llama.cpp recipe for the selected gateway", async () => {
    const discoverySelection = {
      recipe: {
        metadata: { id: "test.llama.recipe.discovery" },
        spec: { model: { servedName: "stale-discovery-model" } },
      },
    } as never;
    const selection = {
      recipe: {
        metadata: { id: "test.llama.recipe" },
        spec: { model: { servedName: "nvidia-nemotron-3-nano-30b-a3b" } },
      },
    } as never;
    const resolveManagedLlamaCppSelection = vi
      .fn()
      .mockReturnValueOnce({ kind: "selected" as const, selection: discoverySelection })
      .mockReturnValueOnce({ kind: "selected" as const, selection });
    const installManagedLlamaCpp = vi.fn(async () => ({
      ok: true as const,
      apiKey: "a".repeat(64),
      model: "nvidia-nemotron-3-nano-30b-a3b",
      receipt: { schemaVersion: 1 } as never,
    }));
    const handleLlamaCppSelection = vi.fn<SetupNimFlowDeps["handleLlamaCppSelection"]>(
      async (state, requestedModel) => {
        expect(requestedModel).toBe("nvidia-nemotron-3-nano-30b-a3b");
        state.provider = "llama-cpp-local";
        state.model = requestedModel;
        state.endpointUrl = "http://127.0.0.1:8081/v1";
        state.credentialEnv = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const runtimeProvider = makeDeps().getRuntimeProvider();
    const getRuntimeProvider = vi.fn(() => runtimeProvider);
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        getGatewayPort: () => 8091,
        resolveManagedLlamaCppSelection,
        installManagedLlamaCpp,
        getRuntimeProvider,
        handleLlamaCppSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "llama-cpp-local",
      model: "nvidia-nemotron-3-nano-30b-a3b",
      preferredInferenceApi: "openai-completions",
    });
    expect(resolveManagedLlamaCppSelection).toHaveBeenCalledTimes(2);
    expect(installManagedLlamaCpp).toHaveBeenCalledWith(selection, {
      sandboxName: "spark-agent",
      gatewayPort: 8091,
      revalidateSandboxIdentity: expect.any(Function),
      runtimeProvider,
    });
    expect(getRuntimeProvider).toHaveBeenCalledOnce();
  });

  it("does not resolve a host-local-inference runtime provider for existing vLLM", async () => {
    const getRuntimeProvider = vi.fn(() => unexpected("runtime provider selection"));
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.provider = "vllm-local";
      state.model = "existing-vllm-model";
      return "selected";
    });
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "vllm",
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmEntries: [{ key: "vllm", label: "Local vLLM — running" }],
          }),
        getRuntimeProvider,
        handleVllmSelection,
      }),
    );

    await expect(setupNim(null)).resolves.toMatchObject({
      provider: "vllm-local",
      model: "existing-vllm-model",
    });
    expect(handleVllmSelection).toHaveBeenCalledOnce();
    expect(getRuntimeProvider).not.toHaveBeenCalled();
  });

  it("rejects an incompatible gateway route before managed llama.cpp install effects", async () => {
    const selection = {
      recipe: {
        metadata: { id: "test.llama.recipe" },
        spec: { model: { servedName: "nvidia-nemotron-3-nano-30b-a3b" } },
      },
    } as never;
    const installManagedLlamaCpp = vi.fn();
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-llama-cpp",
        resolveManagedLlamaCppSelection: () => ({ kind: "selected", selection }),
        installManagedLlamaCpp: installManagedLlamaCpp as never,
      }),
    );
    const routeConflict = new Error("gateway route conflicts with managed llama.cpp");
    const routeGuard = vi.fn(() => {
      throw routeConflict;
    });

    await expect(
      setupNim(
        { platform: "spark" } as never,
        "spark-agent",
        null,
        true,
        null,
        "nemoclaw",
        routeGuard,
      ),
    ).rejects.toThrow(routeConflict);
    expect(installManagedLlamaCpp).not.toHaveBeenCalled();
  });

  it("omits managed llama.cpp from the interactive menu when canonical readiness rejects it", async () => {
    const resolveManagedLlamaCppSelection = vi.fn(() => ({
      kind: "rejected" as const,
      reason: "host readiness requirements are unmet",
    }));
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.map(({ key }) => key)).not.toContain("install-llama-cpp");
        return options.find(({ key }) => key === "build")!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "nvidia-prod";
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection,
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
    expect(resolveManagedLlamaCppSelection).toHaveBeenCalledOnce();
  });

  it("keeps existing Spark providers available when optional managed llama.cpp discovery fails", async () => {
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        expect(options.map(({ key }) => key)).not.toContain("install-llama-cpp");
        return options.find(({ key }) => key === "build")!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async (_args, state) => {
        state.provider = "nvidia-prod";
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt: async () => "1",
        selectFromNumberedMenu,
        resolveManagedLlamaCppSelection: () => {
          throw new Error("managed-inference catalog is unavailable");
        },
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim({ platform: "spark" } as never, "spark-agent")).resolves.toMatchObject({
      provider: "nvidia-prod",
    });
  });

  it("routes a gated local model profile through its dedicated onboarder", async () => {
    const profile = { name: "DGX Spark", platform: "spark" } as VllmProfile;
    const plan = { runtime: "vllm" } as LocalModelProfilePlan;
    const onboard = vi.fn<NonNullable<SetupNimFlowDeps["localModelProfileIntegration"]>["onboard"]>(
      async (_plan, host, state) => {
        expect(host).toMatchObject({
          hasVllmImage: true,
          sparkHost: true,
          vllmProfile: profile,
          vllmRunning: false,
        });
        state.provider = "vllm-local";
        state.model = "catalog/model";
        state.endpointUrl = "http://127.0.0.1:8000/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        localModelProfileIntegration: { resolvePlan: () => plan, onboard },
        detectInferenceProviderHostState: () =>
          makeHostState({ vllmProfile: profile, hasVllmImage: true }),
        selectFromNumberedMenu: () => unexpected("provider menu"),
      }),
    );

    await expect(
      setupNim({ type: "nvidia", spark: true, platform: "spark" } as never),
    ).resolves.toMatchObject({ provider: "vllm-local", model: "catalog/model" });
    expect(onboard).toHaveBeenCalledOnce();
  });

  it("returns interactive occupied-port selection to the provider menu", async () => {
    vi.stubEnv("NEMOCLAW_PROVIDER", "");
    const profile = { name: "DGX Spark" } as VllmProfile;
    const prompt = vi.fn(async () => "1");
    const error = vi.fn();
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>();
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>();
    const selectedKeys = ["install-vllm", "build"];
    const selectFromNumberedMenu = vi.fn<SetupNimFlowDeps["selectFromNumberedMenu"]>(
      (_rawChoice, _defaultIndex, options) => {
        const key = selectedKeys.shift();
        const selected = options.find((option) => option.key === key);
        expect(selected, `missing provider option ${String(key)}`).toBeDefined();
        return selected!;
      },
    );
    const handleRemoteProviderSelection = vi.fn<SetupNimFlowDeps["handleRemoteProviderSelection"]>(
      async ({ selected }, state) => {
        expect(selected.key).toBe("build");
        state.model = "nvidia/nemotron-3-super-120b-a12b";
        state.provider = "nvidia-prod";
        state.endpointUrl = "https://integrate.api.nvidia.com/v1";
        state.credentialEnv = "NVIDIA_INFERENCE_API_KEY";
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        prompt,
        error,
        selectFromNumberedMenu,
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmRunning: true,
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
        handleRemoteProviderSelection,
      }),
    );

    await expect(setupNim(null)).resolves.toMatchObject({ provider: "nvidia-prod" });

    expect(prompt).toHaveBeenCalledTimes(2);
    expect(selectFromNumberedMenu).toHaveBeenCalledTimes(2);
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stop the existing server"));
    expect(installVllm).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
  });
});
