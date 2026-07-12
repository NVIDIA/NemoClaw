// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

export interface ProviderOption {
  key: string;
  label?: string;
}

export interface ProviderKeyFallbackContext {
  canUseWindowsHostOllama: boolean;
}

export function resolveProviderKeyFallback<T extends ProviderOption>(
  options: T[],
  providerKey: string | null | undefined,
  context: ProviderKeyFallbackContext,
): T | undefined {
  const find = (key: string) => options.find((option) => option.key === key);

  switch (providerKey) {
    case "install-ollama":
      return find("ollama");
    case "install-vllm":
      return find("vllm");
    case "install-windows-ollama":
      // Windows-host Ollama requests may arrive from NEMOCLAW_PROVIDER before
      // the dynamic menu knows whether Windows Ollama needs install,
      // start/restart, or is already reachable. Collapse only to later-state
      // entries that still point at the Windows host.
      return (
        find("start-windows-ollama") ||
        (context.canUseWindowsHostOllama ? find("ollama") : undefined)
      );
    case "start-windows-ollama":
      return context.canUseWindowsHostOllama ? find("ollama") : undefined;
    case "ollama":
      return find("install-ollama");
    default:
      return undefined;
  }
}
