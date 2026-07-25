// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import { MIN_HERMES_OLLAMA_CONTEXT_WINDOW } from "../inference/ollama-runtime-context";
import type { VllmProfile } from "../inference/vllm";
import { OnboardInferenceCapabilityCache } from "./inference-capability-cache";
import { getWindowsHostOllamaDockerRequirement } from "./local-inference-topology";
import type { InferenceProviderHostState } from "./provider-host-state";
import { createSetupNim, type SetupNimFlowDeps } from "./setup-nim-flow";

const REMOTE_PROVIDER_CONFIG: SetupNimFlowDeps["remoteProviderConfig"] = {
  build: {
    label: "NVIDIA Endpoints",
    providerName: "nvidia-prod",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    credentialEnv: "NVIDIA_INFERENCE_API_KEY",
  },
  openai: {
    label: "OpenAI",
    providerName: "openai-api",
    endpointUrl: "https://api.openai.com/v1",
    credentialEnv: "OPENAI_API_KEY",
  },
  openrouter: {
    label: "OpenRouter",
    providerName: "openrouter-api",
    endpointUrl: "https://openrouter.ai/api/v1",
    credentialEnv: "OPENROUTER_API_KEY",
  },
  custom: {
    label: "Other OpenAI-compatible endpoint",
    providerName: "compatible-endpoint",
    endpointUrl: "",
    credentialEnv: "COMPATIBLE_API_KEY",
  },
  anthropic: {
    label: "Anthropic",
    providerName: "anthropic-api",
    endpointUrl: "https://api.anthropic.com",
    credentialEnv: "ANTHROPIC_API_KEY",
  },
  anthropicCompatible: {
    label: "Other Anthropic-compatible endpoint",
    providerName: "compatible-anthropic-endpoint",
    endpointUrl: "",
    credentialEnv: "ANTHROPIC_COMPATIBLE_API_KEY",
  },
  gemini: {
    label: "Google Gemini",
    providerName: "gemini-api",
    endpointUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    credentialEnv: "GEMINI_API_KEY",
  },
};

function makeHostState(
  overrides: Partial<InferenceProviderHostState> = {},
): InferenceProviderHostState {
  return {
    hasOllama: false,
    ollamaHost: null,
    ollamaRunning: false,
    isWindowsHostOllama: false,
    isWsl: false,
    hasWindowsOllama: false,
    winOllamaInstalledPath: "",
    winOllamaLoopbackOnly: false,
    windowsOllamaReachable: false,
    windowsHostOllamaDockerRequirement: getWindowsHostOllamaDockerRequirement(null),
    vllmRunning: false,
    vllmProfile: null,
    hasVllmImage: false,
    vllmEntries: [],
    ollamaInstallMenu: { entry: null, hasUpgradableOllama: false },
    gpuNimCapable: false,
    ...overrides,
  };
}

function unexpected(name: string): never {
  throw new Error(`Unexpected ${name} call`);
}

function selectFromNumberedMenu(
  rawChoice: string,
  defaultIndex: number,
  options: Parameters<SetupNimFlowDeps["selectFromNumberedMenu"]>[2],
) {
  const selectedIndex = rawChoice.trim() ? Number(rawChoice) : defaultIndex;
  const selected = options[selectedIndex - 1];
  expect(selected, `Invalid test provider selection: ${rawChoice}`).toBeDefined();
  return selected!;
}

function makeDeps(overrides: Partial<SetupNimFlowDeps> = {}): SetupNimFlowDeps {
  const defaults: SetupNimFlowDeps = {
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
    experimental: false,
    ollamaPort: 11434,
    vllmPort: 8000,
    step: vi.fn(),
    isNonInteractive: () => false,
    getNonInteractiveProvider: () => null,
    getNonInteractiveModel: () => null,
    createNvidiaFeaturedModelSession: () => ({
      select: async () => unexpected("featured model selection"),
    }),
    detectInferenceProviderHostState: () => makeHostState(),
    getAgentInferenceProviderOptions: () => [],
    loadRoutedProfile: () => null,
    readRecordedProvider: () => null,
    readRecordedNimContainer: () => null,
    readRecordedModel: () => null,
    rejectWindowsHostOllama: () => false,
    prompt: async () => "",
    selectFromNumberedMenu,
    note: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    exitProcess: (code) => unexpected(`exitProcess(${code})`),
    abortNonInteractive: (message) => unexpected(`abortNonInteractive(${message})`),
    handleRemoteProviderSelection: async () => unexpected("remote provider selection"),
    handleNimLocalSelection: async () => unexpected("local NIM selection"),
    handleRunningOllamaSelection: async () => unexpected("running Ollama selection"),
    handleWindowsHostOllamaSelection: async () => unexpected("Windows Ollama selection"),
    handleInstallOllamaSelection: async () => unexpected("Ollama install selection"),
    installVllm: async () => unexpected("vLLM install"),
    handleVllmSelection: async () => unexpected("vLLM selection"),
    handleRoutedSelection: async () => unexpected("routed selection"),
    coerceAgentInferenceApi: (_agent, preferredInferenceApi) => preferredInferenceApi,
    resolveAgentInferenceApi: (_agentName, _provider, preferredInferenceApi) =>
      preferredInferenceApi,
    clearCompatibleEndpointReasoning: () => null,
    maybePromptForInferenceInputCapability: vi.fn(async () => {}),
  };
  return { ...defaults, ...overrides };
}

afterEach(() => {
  vi.unstubAllEnvs();
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
      nimContainer: null,
      allowToolsIncompatible: false,
      skipHostInferenceSmoke: false,
      reuseGatewayCredentialWithoutLocalKey: false,
    });
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

  it("passes the Hermes Ollama context floor into local Ollama selection state (#6760)", async () => {
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
      }),
    );

    const result = await setupNim(null, null, { name: "hermes" } as AgentDefinition);

    expect(result.provider).toBe("ollama-local");
    expect(handleRunningOllamaSelection).toHaveBeenCalledTimes(1);
  });

  it("reuses reachable Windows-host Ollama when PowerShell cannot find its executable (#7472)", async () => {
    const model = "qwen3.6:35b";
    const handleRunningOllamaSelection = vi.fn<SetupNimFlowDeps["handleRunningOllamaSelection"]>(
      async (_gpu, requestedModel, _recoveredModel, ollamaRunning, state) => {
        expect(requestedModel).toBe(model);
        expect(ollamaRunning).toBe(true);
        state.model = model;
        state.provider = "ollama-local";
        state.endpointUrl = "http://host.docker.internal:11434/v1";
        state.credentialEnv = null;
        state.preferredInferenceApi = "openai-completions";
        return "selected";
      },
    );
    const setupNim = createSetupNim(
      makeDeps({
        isNonInteractive: () => true,
        getNonInteractiveProvider: () => "install-windows-ollama",
        getNonInteractiveModel: () => model,
        detectInferenceProviderHostState: () =>
          makeHostState({
            ollamaHost: "host.docker.internal",
            ollamaRunning: true,
            isWindowsHostOllama: true,
            isWsl: true,
            hasWindowsOllama: false,
            windowsHostOllamaDockerRequirement:
              getWindowsHostOllamaDockerRequirement("docker-desktop"),
          }),
        handleRunningOllamaSelection,
      }),
    );

    await setupNim(null, null);

    expect(handleRunningOllamaSelection).toHaveBeenCalledTimes(1);
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
      { managedInstall: true, sparkHost: false },
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
  });

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
      { managedInstall: true, sparkHost: false },
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

  it("refuses managed install when an existing vLLM occupies the port", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
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
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
      }),
    );

    await expect(setupNim(null)).rejects.toThrow("vLLM is already running on localhost:8000");

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Select Local vLLM"));
    expect(error).toHaveBeenCalledWith(expect.stringContaining("stop the existing server"));
    expect(abortNonInteractive).toHaveBeenCalledOnce();
    expect(installVllm).not.toHaveBeenCalled();
    expect(handleVllmSelection).not.toHaveBeenCalled();
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
