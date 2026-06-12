// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture as defaultDockerCapture } from "../adapters/docker";
import { OLLAMA_PORT, VLLM_PORT } from "../core/ports";
import { findReachableOllamaHost, OLLAMA_HOST_DOCKER_INTERNAL } from "../inference/local";
import type { NvidiaPlatform } from "../inference/nim";
import { detectVllmProfile, type VllmProfile } from "../inference/vllm";
import {
  type ContainerRuntime,
  isWsl as defaultIsWsl,
  type WslDetectionOptions,
} from "../platform";
import { runCapture as defaultRunCapture } from "../runner";
import {
  getContainerRuntime as defaultGetContainerRuntime,
  getWindowsHostOllamaDockerRequirement,
  type WindowsHostOllamaDockerRequirement,
} from "./local-inference-topology";
import { resolveOllamaInstallMenuEntry, type OllamaInstallMenuResult } from "./ollama-install-menu";
import { buildVllmMenuEntries, type VllmMenuEntry } from "./vllm-menu";
import { detectWindowsHostOllama, type WindowsHostOllamaState } from "./windows-host-ollama";

type RunCapture = (args: string[], options?: { ignoreError?: boolean }) => string;
type DockerCapture = (args: string[], options?: { ignoreError?: boolean }) => string;

export interface InferenceProviderHostGpu {
  nimCapable?: boolean;
  spark?: boolean;
  type?: string;
  platform?: NvidiaPlatform;
}

export interface InferenceProviderHostState {
  hasOllama: boolean;
  ollamaHost: string | null;
  ollamaRunning: boolean;
  isWindowsHostOllama: boolean;
  isWsl: boolean;
  hasWindowsOllama: boolean;
  winOllamaInstalledPath: string;
  winOllamaLoopbackOnly: boolean;
  windowsOllamaReachable: boolean;
  windowsHostOllamaDockerRequirement: WindowsHostOllamaDockerRequirement;
  vllmRunning: boolean;
  vllmProfile: VllmProfile | null;
  hasVllmImage: boolean;
  vllmEntries: VllmMenuEntry[];
  ollamaInstallMenu: OllamaInstallMenuResult;
  gpuNimCapable: boolean;
}

export interface DetectInferenceProviderHostStateInput {
  gpu: InferenceProviderHostGpu | null | undefined;
  experimental: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  log?: (message?: string) => void;
  installedOllamaVersion?: string | null;
  runningOllamaVersion?: string | null;
  deps?: Partial<DetectInferenceProviderHostStateDeps>;
}

export interface DetectInferenceProviderHostStateDeps {
  runCapture: RunCapture;
  dockerCapture: DockerCapture;
  hostCommandExists: (commandName: string) => boolean;
  findReachableOllamaHost: () => string | null;
  isWsl: (opts?: WslDetectionOptions) => boolean;
  getContainerRuntime: () => ContainerRuntime;
  detectWindowsHostOllama: () => WindowsHostOllamaState;
  getWindowsHostOllamaDockerRequirement: (
    runtime: ContainerRuntime | null,
  ) => WindowsHostOllamaDockerRequirement;
  detectVllmProfile: (gpu: InferenceProviderHostGpu | null | undefined) => VllmProfile | null;
}

const LOCAL_PROVIDER_PROBE_CURL_ARGS = ["--connect-timeout", "2", "--max-time", "5"] as const;

function hostCommandExists(commandName: string, runCapture: RunCapture): boolean {
  return !!runCapture(["sh", "-c", 'command -v "$1"', "--", commandName], {
    ignoreError: true,
  });
}

function buildDeps(
  overrides: Partial<DetectInferenceProviderHostStateDeps> = {},
): DetectInferenceProviderHostStateDeps {
  const runCapture = overrides.runCapture ?? defaultRunCapture;
  return {
    runCapture,
    dockerCapture: overrides.dockerCapture ?? defaultDockerCapture,
    hostCommandExists:
      overrides.hostCommandExists ?? ((command) => hostCommandExists(command, runCapture)),
    findReachableOllamaHost: overrides.findReachableOllamaHost ?? findReachableOllamaHost,
    isWsl: overrides.isWsl ?? defaultIsWsl,
    getContainerRuntime: overrides.getContainerRuntime ?? defaultGetContainerRuntime,
    detectWindowsHostOllama: overrides.detectWindowsHostOllama ?? detectWindowsHostOllama,
    getWindowsHostOllamaDockerRequirement:
      overrides.getWindowsHostOllamaDockerRequirement ?? getWindowsHostOllamaDockerRequirement,
    detectVllmProfile:
      overrides.detectVllmProfile ??
      ((gpu) => detectVllmProfile(gpu as Parameters<typeof detectVllmProfile>[0])),
  };
}

function probeVllmRunning(runCapture: RunCapture): boolean {
  return !!runCapture(
    ["curl", "-sf", ...LOCAL_PROVIDER_PROBE_CURL_ARGS, `http://127.0.0.1:${VLLM_PORT}/v1/models`],
    { ignoreError: true },
  );
}

function probeWindowsOllamaReachable(input: {
  isWsl: boolean;
  isWindowsHostOllama: boolean;
  runCapture: RunCapture;
}): boolean {
  if (!input.isWsl || input.isWindowsHostOllama) return false;
  return !!input.runCapture(
    [
      "curl",
      "-sf",
      ...LOCAL_PROVIDER_PROBE_CURL_ARGS,
      `http://host.docker.internal:${OLLAMA_PORT}/api/tags`,
    ],
    { ignoreError: true },
  );
}

function maybeWarnAboutDuplicateOllamaDaemons(input: {
  isWsl: boolean;
  ollamaHost: string | null;
  windowsOllamaReachable: boolean;
  runCapture: RunCapture;
  log: (message?: string) => void;
}): void {
  if (!input.isWsl || input.ollamaHost !== "127.0.0.1" || !input.windowsOllamaReachable) return;
  const networkingMode = input
    .runCapture(["wslinfo", "--networking-mode"], {
      ignoreError: true,
    })
    .trim();
  if (networkingMode === "mirrored") return;
  input.log("");
  input.log("  ⚠ Ollama is running on both WSL and the Windows host.");
  input.log("    Stop one to avoid duplicated GPU memory and model caches.");
  input.log("");
}

export function detectInferenceProviderHostState(
  input: DetectInferenceProviderHostStateInput,
): InferenceProviderHostState {
  const deps = buildDeps(input.deps);
  const log = input.log ?? console.log;
  const platform = input.platform ?? process.platform;
  const isWsl = deps.isWsl({ platform, env: input.env });
  const hasOllama = deps.hostCommandExists("ollama");
  const ollamaHost = deps.findReachableOllamaHost();
  const ollamaRunning = ollamaHost !== null;
  const isWindowsHostOllama = ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL;
  const vllmRunning = probeVllmRunning(deps.runCapture);
  const vllmProfile = deps.detectVllmProfile(input.gpu);
  const hasVllmImage = !!(
    vllmProfile &&
    deps.dockerCapture(["images", "-q", vllmProfile.image], { ignoreError: true }).trim()
  );
  const windowsHostOllamaDockerRequirement = deps.getWindowsHostOllamaDockerRequirement(
    isWsl ? deps.getContainerRuntime() : null,
  );
  const winOllamaState = deps.detectWindowsHostOllama();
  const hasWindowsOllama = winOllamaState.installed;
  const windowsOllamaReachable = probeWindowsOllamaReachable({
    isWsl,
    isWindowsHostOllama,
    runCapture: deps.runCapture,
  });

  maybeWarnAboutDuplicateOllamaDaemons({
    isWsl,
    ollamaHost,
    windowsOllamaReachable,
    runCapture: deps.runCapture,
    log,
  });

  const ollamaInstallMenu = resolveOllamaInstallMenuEntry({
    hasOllama,
    ollamaRunning,
    hasWindowsOllama,
    ollamaHost,
    platform,
    isWsl,
    installedOllamaVersion: input.installedOllamaVersion,
    runningOllamaVersion: input.runningOllamaVersion,
  });

  return {
    hasOllama,
    ollamaHost,
    ollamaRunning,
    isWindowsHostOllama,
    isWsl,
    hasWindowsOllama,
    winOllamaInstalledPath: winOllamaState.installedPath,
    winOllamaLoopbackOnly: winOllamaState.loopbackOnly,
    windowsOllamaReachable,
    windowsHostOllamaDockerRequirement,
    vllmRunning,
    vllmProfile,
    hasVllmImage,
    vllmEntries: buildVllmMenuEntries({
      vllmRunning,
      vllmProfile,
      experimental: input.experimental,
      platform: input.gpu?.platform,
      hasVllmImage,
      env: input.env,
      log: (message) => log(message),
    }),
    ollamaInstallMenu,
    gpuNimCapable: Boolean(input.gpu?.nimCapable),
  };
}
