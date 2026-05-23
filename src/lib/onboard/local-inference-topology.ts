// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerInfo } from "../adapters/docker/info";
import {
  type ContainerRuntime,
  containerCanReachHostLoopback,
  inferContainerRuntime,
} from "../platform";
import { ensureOllamaLoopbackSystemdOverride } from "./ollama-systemd";

const DOCKER_INFO_RUNTIME_PROBE_TIMEOUT_MS = 1500;

export function getContainerRuntime(): ContainerRuntime {
  return inferContainerRuntime(
    dockerInfo({ ignoreError: true, timeout: DOCKER_INFO_RUNTIME_PROBE_TIMEOUT_MS }),
  );
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
    console.error(
      "  Ollama systemd restart did not recover after applying the loopback override.",
    );
    process.exit(1);
  }
}
