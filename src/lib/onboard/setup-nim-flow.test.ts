// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentDefinition } from "../agent/defs";
import type { VllmProfile } from "../inference/vllm";
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
    clearCompatibleEndpointReasoning: () => null,
    maybePromptForInferenceInputCapability: vi.fn(async () => {}),
  };
  return { ...defaults, ...overrides };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("createSetupNim", () => {
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

    const result = await setupNim(null);

    expect(step).toHaveBeenCalledWith(3, 8, "Configuring inference provider");
    expect(log).toHaveBeenCalledWith("  Detected local inference option: Ollama");
    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt).toHaveBeenCalledWith("  Choose [1]: ");
    expect(handleRemoteProviderSelection).toHaveBeenCalledOnce();
    expect(maybePromptForInferenceInputCapability).toHaveBeenCalledWith(
      "nvidia/nemotron-3-super-120b-a12b",
    );
    expect(result).toEqual({
      model: "nvidia/nemotron-3-super-120b-a12b",
      provider: "nvidia-prod",
      endpointUrl: "https://integrate.api.nvidia.com/v1",
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

  it("recovers a recorded provider and model without prompting in non-interactive mode (#6245)", async () => {
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

    const result = await setupNim(null, "existing-sandbox");

    expect(prompt).not.toHaveBeenCalled();
    expect(readRecordedProvider).toHaveBeenCalledWith("existing-sandbox");
    expect(readRecordedNimContainer).toHaveBeenCalledWith("existing-sandbox");
    expect(readRecordedModel).toHaveBeenCalledWith("existing-sandbox");
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
      preferredInferenceApi: "openai-completions",
      compatibleEndpointReasoning: null,
      skipHostInferenceSmoke: true,
      reuseGatewayCredentialWithoutLocalKey: true,
    });
  });

  it("continues from a successful managed vLLM install into provider selection (#6245)", async () => {
    const profile = { name: "DGX Spark" } as VllmProfile;
    const prompt = vi.fn(async () => unexpected("provider prompt"));
    const installVllm = vi.fn<SetupNimFlowDeps["installVllm"]>(async () => ({ ok: true }));
    const handleVllmSelection = vi.fn<SetupNimFlowDeps["handleVllmSelection"]>(async (state) => {
      state.model = "vllm-model";
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
        detectInferenceProviderHostState: () =>
          makeHostState({
            vllmProfile: profile,
            hasVllmImage: true,
            vllmEntries: [{ key: "install-vllm", label: "Start vLLM (DGX Spark)" }],
          }),
        installVllm,
        handleVllmSelection,
      }),
    );

    const result = await setupNim(null);

    expect(installVllm).toHaveBeenCalledWith(profile, {
      hasImage: true,
      nonInteractive: true,
      promptFn: prompt,
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(handleVllmSelection).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      model: "vllm-model",
      provider: "vllm",
      endpointUrl: "http://127.0.0.1:8000/v1",
      credentialEnv: null,
      preferredInferenceApi: "openai-completions",
    });
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
});
