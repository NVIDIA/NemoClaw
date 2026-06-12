// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { resolveRunningOllamaMenuEntry } from "./ollama-install-menu";

export interface ProviderMenuChoice {
  key: string;
  label: string;
}

interface RemoteProviderMenuConfig {
  label: string;
}

type WindowsHostOllamaStartLabel = (opts: { reachable: boolean; loopbackOnly: boolean }) => string;

export interface BuildInferenceProviderMenuInput {
  remoteProviderConfig: Record<string, RemoteProviderMenuConfig | undefined>;
  agentProviderOptions: readonly string[];
  experimental: boolean;
  gpuNimCapable: boolean;
  hasOllama: boolean;
  ollamaRunning: boolean;
  ollamaHost: string | null;
  ollamaPort: number;
  isWsl: boolean;
  hasWindowsOllama: boolean;
  isWindowsHostOllama: boolean;
  windowsHostLabelSuffix: string;
  windowsHostInstallLabel: string;
  windowsHostStartLabel: WindowsHostOllamaStartLabel;
  windowsOllamaReachable: boolean;
  winOllamaLoopbackOnly: boolean;
  ollamaInstallEntry: ProviderMenuChoice | null;
  vllmEntries: readonly ProviderMenuChoice[];
  routedEnabled: boolean;
}

export interface InferenceProviderMenu {
  options: ProviderMenuChoice[];
  hermesProviderAvailable: boolean;
}

const BASE_REMOTE_PROVIDER_OPTIONS: readonly ProviderMenuChoice[] = [
  { key: "build", label: "NVIDIA Endpoints" },
  { key: "openai", label: "OpenAI" },
  { key: "custom", label: "Other OpenAI-compatible endpoint" },
  { key: "anthropic", label: "Anthropic" },
  { key: "anthropicCompatible", label: "Other Anthropic-compatible endpoint" },
  { key: "gemini", label: "Google Gemini" },
];

function configuredRemoteOption(
  config: Record<string, RemoteProviderMenuConfig | undefined>,
  fallback: ProviderMenuChoice,
): ProviderMenuChoice {
  return {
    key: fallback.key,
    label: config[fallback.key]?.label ?? fallback.label,
  };
}

function pushUniqueRemoteProviderOption(
  options: ProviderMenuChoice[],
  config: Record<string, RemoteProviderMenuConfig | undefined>,
  providerKey: string,
): void {
  const remoteConfig = config[providerKey];
  if (!remoteConfig || options.some((option) => option.key === providerKey)) return;
  options.push({ key: providerKey, label: remoteConfig.label });
}

export function buildInferenceProviderMenu(
  input: BuildInferenceProviderMenuInput,
): InferenceProviderMenu {
  const options: ProviderMenuChoice[] = BASE_REMOTE_PROVIDER_OPTIONS.map((option) =>
    configuredRemoteOption(input.remoteProviderConfig, option),
  );

  const runningOllamaMenu = resolveRunningOllamaMenuEntry({
    hasOllama: input.hasOllama,
    ollamaRunning: input.ollamaRunning,
    ollamaHost: input.ollamaHost,
    isWsl: input.isWsl,
    ollamaPort: input.ollamaPort,
    windowsHostLabelSuffix: input.windowsHostLabelSuffix,
  });
  if (runningOllamaMenu) options.push(runningOllamaMenu);

  if (input.experimental && input.gpuNimCapable) {
    options.push({ key: "nim-local", label: "Local NVIDIA NIM [experimental]" });
  }

  options.push(...input.vllmEntries);

  if (input.hasWindowsOllama && !input.isWindowsHostOllama) {
    options.push({
      key: "start-windows-ollama",
      label: input.windowsHostStartLabel({
        reachable: input.windowsOllamaReachable,
        loopbackOnly: input.winOllamaLoopbackOnly,
      }),
    });
  }

  if (input.isWsl && !input.hasWindowsOllama) {
    options.push({
      key: "install-windows-ollama",
      label: input.windowsHostInstallLabel,
    });
  }

  if (input.ollamaInstallEntry) options.push(input.ollamaInstallEntry);

  if (input.routedEnabled) {
    options.push({ key: "routed", label: "Model Router (experimental)" });
  }

  for (const providerKey of input.agentProviderOptions) {
    pushUniqueRemoteProviderOption(options, input.remoteProviderConfig, providerKey);
  }

  return {
    options,
    hermesProviderAvailable: input.agentProviderOptions.includes("hermesProvider"),
  };
}
