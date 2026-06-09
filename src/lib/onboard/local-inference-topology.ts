// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { detectContainerRuntimeFromDockerInfo } from "../adapters/docker/runtime";
import { type ContainerRuntime, containerCanReachHostLoopback } from "../platform";
import { ensureOllamaLoopbackSystemdOverride } from "./ollama-systemd";

export function getContainerRuntime(): ContainerRuntime {
  return detectContainerRuntimeFromDockerInfo();
}

function describeContainerRuntime(runtime: ContainerRuntime): string {
  switch (runtime) {
    case "docker-desktop":
      return "Docker Desktop";
    case "docker":
      return "native Docker Engine";
    case "podman":
      return "Podman";
    case "colima":
      return "Colima";
    case "unknown":
      return "unknown container runtime";
    default:
      const _exhaustive: never = runtime;
      return _exhaustive;
  }
}

type WindowsHostOllamaStartLabel = (opts: { reachable: boolean; loopbackOnly: boolean }) => string;

type WindowsHostOllamaReject = (
  providerKey: string,
  isNonInteractive: () => boolean,
  abortNonInteractive: (reason: string, hint?: string) => never,
) => boolean;

export type WindowsHostOllamaDockerRequirement =
  | {
      supported: true;
      detectedRuntime: string;
      installLabel: string;
      startLabel: WindowsHostOllamaStartLabel;
    }
  | {
      supported: false;
      detectedRuntime: string;
      labelSuffix: string;
      installLabel: string;
      startLabel: WindowsHostOllamaStartLabel;
      reason: string;
      hint: string;
      reject: WindowsHostOllamaReject;
    };

export function getWindowsHostOllamaDockerRequirement(
  runtime: ContainerRuntime | null,
): WindowsHostOllamaDockerRequirement {
  if (runtime === null) {
    return {
      supported: true,
      detectedRuntime: "not applicable",
      installLabel: "Install Ollama on Windows host (recommended)",
      startLabel(opts) {
        if (opts.reachable) return "Use Ollama on Windows host - running (suggested)";
        if (opts.loopbackOnly)
          return "Restart Ollama on Windows host with 0.0.0.0 binding (suggested)";
        return "Start Ollama on Windows host (suggested)";
      },
    };
  }
  const detectedRuntime = describeContainerRuntime(runtime);
  if (runtime === "docker-desktop") {
    return {
      supported: true,
      detectedRuntime,
      installLabel: "Install Ollama on Windows host (recommended)",
      startLabel(opts) {
        if (opts.reachable) return "Use Ollama on Windows host - running (suggested)";
        if (opts.loopbackOnly)
          return "Restart Ollama on Windows host with 0.0.0.0 binding (suggested)";
        return "Start Ollama on Windows host (suggested)";
      },
    };
  }

  const labelSuffix = " (requires Docker Desktop WSL integration)";
  const reason =
    `Windows-host Ollama requires Docker Desktop WSL integration; ` +
    `detected ${detectedRuntime} in WSL.`;
  const hint = "Choose WSL-local Ollama, or enable Docker Desktop WSL integration for this distro.";
  return {
    supported: false,
    detectedRuntime,
    labelSuffix,
    installLabel: `Install Ollama on Windows host${labelSuffix}`,
    startLabel(opts) {
      if (opts.reachable) return `Use Ollama on Windows host - running${labelSuffix}`;
      if (opts.loopbackOnly) {
        return `Restart Ollama on Windows host with 0.0.0.0 binding${labelSuffix}`;
      }
      return `Start Ollama on Windows host${labelSuffix}`;
    },
    reason,
    hint,
    reject(providerKey, isNonInteractive, abortNonInteractive) {
      if (isNonInteractive()) {
        abortNonInteractive(
          `${providerKey} requires Docker Desktop WSL integration; detected ${detectedRuntime} in WSL.`,
          hint,
        );
      }
      console.error(`  ${reason}`);
      console.error(
        "  Native Docker-in-WSL cannot reliably route sandbox containers to Windows-host Ollama.",
      );
      console.error(`  ${hint}`);
      console.log("");
      return true;
    },
  };
}

export function rejectUnsupportedWindowsHostOllama(
  requirement: WindowsHostOllamaDockerRequirement,
  providerKey: string,
  isWindowsHostOllama: boolean,
  isNonInteractive: () => boolean,
  abortNonInteractive: (reason: string, hint?: string) => never,
): boolean {
  if (!isWindowsHostOllama || requirement.supported) return false;
  return requirement.reject(providerKey, isNonInteractive, abortNonInteractive);
}

// True when the sandbox container needs the local Ollama auth proxy in front
// of raw Ollama. False only under Docker Desktop on WSL, where the docker-
// desktop VM publishes the host's 127.0.0.1 back into containers through
// host.docker.internal. (#3695)
export function shouldFrontOllamaWithProxy(): boolean {
  return !containerCanReachHostLoopback(getContainerRuntime());
}

// Repair the Ollama systemd loopback override for ollama-local providers.
// No-ops for any other provider. Exits non-zero when the restart fails to
// recover, matching the existing fail-closed posture in setupNim. (#3342)
export function repairLocalInferenceSystemdOverrideOrExit(
  provider: string | null | undefined,
  isNonInteractive: () => boolean,
): void {
  if (provider !== "ollama-local") return;
  const state = ensureOllamaLoopbackSystemdOverride({ isNonInteractive });
  if (state === "failed") {
    console.error("  Ollama systemd restart did not recover after applying the loopback override.");
    process.exit(1);
  }
}
