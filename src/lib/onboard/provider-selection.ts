// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ProviderOption, resolveProviderKeyFallback } from "./provider-key-fallback";
import { providerNameToOptionKey, type RemoteProviderConfigEntryLike } from "./provider-recovery";

export type ProviderSelectionFailureReason =
  | {
      kind: "wsl-recorded-ollama-windows-host";
      recordedProvider: string;
    }
  | {
      kind: "recorded-provider-unavailable";
      recordedProvider: string;
      recoveredKey: string;
      windowsHostKey: string | null;
    }
  | {
      kind: "unsupported-windows-host-ollama";
      providerKey: string;
    }
  | {
      kind: "hermes-provider-unavailable";
    }
  | {
      kind: "requested-provider-unavailable";
      providerKey: string;
    };

export interface ProviderSelectionSuccess<T extends ProviderOption> {
  kind: "selected";
  selected: T;
  recoveredFromSandbox: boolean;
  recoveredModel: string | null;
}

export interface ProviderSelectionFailure {
  kind: "failure";
  reason: ProviderSelectionFailureReason;
}

export type ProviderSelectionResolution<T extends ProviderOption> =
  | ProviderSelectionSuccess<T>
  | ProviderSelectionFailure;

export interface ProviderSelectionRecoveryReaders {
  readRecordedProvider(sandboxName: string | null | undefined): string | null;
  readRecordedNimContainer(sandboxName: string | null | undefined): string | null;
  readRecordedModel(sandboxName: string | null | undefined): string | null;
}

export interface ResolveRequestedProviderSelectionInput<T extends ProviderOption>
  extends ProviderSelectionRecoveryReaders {
  options: T[];
  requestedProvider: string | null;
  sandboxName: string | null;
  remoteProviderConfig: Record<string, RemoteProviderConfigEntryLike>;
  isWsl: boolean;
  isWindowsHostOllama: boolean;
  windowsHostOllamaSupported: boolean;
  hermesProviderAvailable: boolean;
}

function findOption<T extends ProviderOption>(options: T[], key: string): T | undefined {
  return options.find((option) => option.key === key);
}

function findWindowsHostKey(options: ProviderOption[]): string | null {
  return (
    options.find((option) => option.key === "start-windows-ollama")?.key ||
    options.find((option) => option.key === "install-windows-ollama")?.key ||
    null
  );
}

function isWindowsHostOllamaRequest(providerKey: string): boolean {
  return providerKey === "start-windows-ollama" || providerKey === "install-windows-ollama";
}

export function resolveRequestedProviderSelection<T extends ProviderOption>(
  input: ResolveRequestedProviderSelectionInput<T>,
): ProviderSelectionResolution<T> {
  let providerKey = input.requestedProvider;
  let recoveredFromSandbox = false;
  let recoveredModel: string | null = null;

  if (!providerKey) {
    const recordedProvider = input.readRecordedProvider(input.sandboxName);
    const hasNimContainer = !!input.readRecordedNimContainer(input.sandboxName);
    const recoveredKey = providerNameToOptionKey(input.remoteProviderConfig, recordedProvider, {
      hasNimContainer,
    });

    if (recoveredKey) {
      if (input.isWsl && recordedProvider === "ollama-local" && input.isWindowsHostOllama) {
        return {
          kind: "failure",
          reason: {
            kind: "wsl-recorded-ollama-windows-host",
            recordedProvider,
          },
        };
      }

      if (!findOption(input.options, recoveredKey)) {
        return {
          kind: "failure",
          reason: {
            kind: "recorded-provider-unavailable",
            recordedProvider: recordedProvider || "",
            recoveredKey,
            windowsHostKey: recoveredKey === "ollama" ? findWindowsHostKey(input.options) : null,
          },
        };
      }

      providerKey = recoveredKey;
      recoveredFromSandbox = true;
      recoveredModel = input.readRecordedModel(input.sandboxName);
    } else {
      providerKey = "build";
    }
  }

  const selected = findOption(input.options, providerKey);
  if (selected) {
    return { kind: "selected", selected, recoveredFromSandbox, recoveredModel };
  }

  if (
    isWindowsHostOllamaRequest(providerKey) &&
    input.isWindowsHostOllama &&
    !input.windowsHostOllamaSupported
  ) {
    return {
      kind: "failure",
      reason: {
        kind: "unsupported-windows-host-ollama",
        providerKey,
      },
    };
  }

  const fallback = resolveProviderKeyFallback(input.options, providerKey, {
    canUseWindowsHostOllama: input.isWindowsHostOllama && input.windowsHostOllamaSupported,
  });
  if (fallback) {
    return {
      kind: "selected",
      selected: fallback,
      recoveredFromSandbox,
      recoveredModel,
    };
  }

  if (providerKey === "hermesProvider" && !input.hermesProviderAvailable) {
    return {
      kind: "failure",
      reason: { kind: "hermes-provider-unavailable" },
    };
  }

  return {
    kind: "failure",
    reason: {
      kind: "requested-provider-unavailable",
      providerKey,
    },
  };
}
