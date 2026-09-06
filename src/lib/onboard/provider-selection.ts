// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isBedrockRuntimeEndpoint } from "../inference/bedrock-runtime";
import { type ProviderOption, resolveProviderKeyFallback } from "./provider-key-fallback";
import { providerNameToOptionKey, type RemoteProviderConfigEntryLike } from "./provider-recovery";

export {
  applyVllmInstallResumeDefaults,
  readVllmInstallResumeModel,
  vllmInstallRecoveryOptions,
} from "./provider-recovery";

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

export function resolveSelectedEndpointSource(input: {
  provider: string;
  endpointUrl: string | null;
  hasPinnedAddresses: boolean;
  hasTrustedPrivateCapability: boolean;
}): "onboard" | null {
  if (input.hasPinnedAddresses || input.hasTrustedPrivateCapability) return "onboard";
  if (input.provider !== "compatible-anthropic-endpoint") return null;
  return isBedrockRuntimeEndpoint(input.endpointUrl) ? "onboard" : null;
}

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
  /** True when the selected container runtime can route to the Windows host. */
  windowsHostOllamaSupported: boolean;
  /** True only when a Docker Desktop container reached the Windows daemon. */
  windowsHostOllamaReachable?: boolean;
  hermesProviderAvailable: boolean;
  /**
   * True when the onboard probe already reached a live Ollama daemon, on
   * whichever candidate host answered first. Absent means the caller has no
   * probe result, which leaves an install request untouched.
   */
  ollamaRunning?: boolean;
  /** Platform-qualified default used only when no provider was requested or recorded. */
  platformDefaultProviderKey?: "install-llama-cpp" | "install-ollama" | "install-vllm";
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

/**
 * A daemon that already answers on the Ollama port makes a Windows-host install
 * request unnecessary only when Docker can reach that daemon. Express emits
 * `install-windows-ollama` from a Docker-topology check that does not probe
 * Ollama, so the key can arrive while a Windows daemon still binds to loopback.
 * Route that state through the existing restart action before model selection.
 *
 * Scoped to the Windows-host key on purpose. This helper does not touch
 * `install-ollama`: `resolveOllamaInstallMenuEntry` keeps that entry for a
 * running-but-stale daemon, and collapsing it would skip the Ollama upgrade
 * path.
 */
function collapseWindowsInstallToRunningDaemon<T extends ProviderOption>(
  input: ResolveRequestedProviderSelectionInput<T>,
  providerKey: string,
): T | undefined {
  if (providerKey !== "install-windows-ollama" || !input.ollamaRunning) return undefined;
  // A daemon reached on the Windows host still needs Docker Desktop WSL
  // integration for the sandbox to reach it. Leave that request to the
  // unsupported-runtime rejection below instead of silently reusing it.
  if (input.isWindowsHostOllama && !input.windowsHostOllamaSupported) return undefined;
  if (input.isWindowsHostOllama && input.windowsHostOllamaReachable !== true) {
    return findOption(input.options, "start-windows-ollama");
  }
  return findOption(input.options, "ollama");
}

export function resolveRequestedProviderSelection<T extends ProviderOption>(
  input: ResolveRequestedProviderSelectionInput<T>,
): ProviderSelectionResolution<T> {
  let providerKey = input.requestedProvider;
  let recoveredFromSandbox = false;
  let recoveredModel: string | null = null;
  const canUseWindowsHostOllama =
    input.isWindowsHostOllama &&
    input.windowsHostOllamaSupported &&
    input.windowsHostOllamaReachable === true;

  if (!providerKey) {
    const recordedProvider = input.readRecordedProvider(input.sandboxName);
    const hasNimContainer = !!input.readRecordedNimContainer(input.sandboxName);
    const recoveredKey = providerNameToOptionKey(input.remoteProviderConfig, recordedProvider, {
      hasNimContainer,
    });

    if (recoveredKey) {
      if (
        input.isWsl &&
        recordedProvider === "ollama-local" &&
        input.isWindowsHostOllama &&
        !canUseWindowsHostOllama
      ) {
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
      const platformDefault = input.platformDefaultProviderKey;
      providerKey =
        platformDefault &&
        (findOption(input.options, platformDefault) ||
          resolveProviderKeyFallback(input.options, platformDefault, {
            canUseWindowsHostOllama,
          }))
          ? platformDefault
          : "build";
    }
  }

  if (providerKey === "ollama" && input.isWindowsHostOllama && !canUseWindowsHostOllama) {
    if (!input.windowsHostOllamaSupported) {
      return {
        kind: "failure",
        reason: {
          kind: "unsupported-windows-host-ollama",
          providerKey,
        },
      };
    }
    const restart = findOption(input.options, "start-windows-ollama");
    if (restart) {
      return { kind: "selected", selected: restart, recoveredFromSandbox, recoveredModel };
    }
    return {
      kind: "failure",
      reason: { kind: "requested-provider-unavailable", providerKey },
    };
  }

  const runningDaemon = collapseWindowsInstallToRunningDaemon(input, providerKey);
  if (runningDaemon) {
    return { kind: "selected", selected: runningDaemon, recoveredFromSandbox, recoveredModel };
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
    canUseWindowsHostOllama,
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
