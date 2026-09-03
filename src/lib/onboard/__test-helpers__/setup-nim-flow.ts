// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, vi } from "vitest";

import { getWindowsHostOllamaDockerRequirement } from "../local-inference-topology";
import type { InferenceProviderHostState } from "../provider-host-state";
import { createDockerRuntimeProviderBundle } from "../runtime-provider/docker";
import type { SetupNimFlowDeps } from "../setup-nim-flow";

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

export function makeHostState(
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
    ollamaInstallMenu: { entry: null, hasUpgradableOllama: false, binaryNeedsUpgrade: false },
    gpuNimCapable: false,
    ...overrides,
  };
}

export function unexpected(name: string): never {
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

export function makeDeps(overrides: Partial<SetupNimFlowDeps> = {}): SetupNimFlowDeps {
  const defaults: SetupNimFlowDeps = {
    remoteProviderConfig: REMOTE_PROVIDER_CONFIG,
    experimental: false,
    ollamaPort: 11434,
    vllmPort: 8000,
    getGatewayPort: () => 8080,
    getRuntimeProvider: () => createDockerRuntimeProviderBundle(),
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
    handleLlamaCppSelection: async () => unexpected("llama.cpp selection"),
    handleRemoteProviderSelection: async () => unexpected("remote provider selection"),
    handleNimLocalSelection: async () => unexpected("local NIM selection"),
    handleRunningOllamaSelection: async () => unexpected("running Ollama selection"),
    handleWindowsHostOllamaSelection: async () => unexpected("Windows Ollama selection"),
    handleInstallOllamaSelection: async () => unexpected("Ollama install selection"),
    installVllm: async () => unexpected("vLLM install"),
    handleVllmSelection: async () => unexpected("vLLM selection"),
    selectVllmModelFromEnv: () => null,
    handleRoutedSelection: async () => unexpected("routed selection"),
    coerceAgentInferenceApi: (_agent, preferredInferenceApi) => preferredInferenceApi,
    resolveAgentInferenceApi: (_agentName, _provider, preferredInferenceApi) =>
      preferredInferenceApi,
    clearCompatibleEndpointReasoning: () => null,
    maybePromptForInferenceInputCapability: vi.fn(async () => {}),
  };
  return { ...defaults, ...overrides };
}
