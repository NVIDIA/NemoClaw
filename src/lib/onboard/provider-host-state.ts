// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture as defaultDockerCapture } from "../adapters/docker";
import {
  findReachableOllamaHost,
  getLocalProviderAvailabilityEndpoint,
  getWindowsHostOllamaDockerReachabilityArgs,
  isLocalProviderProbeOutputHealthy,
  isValidOllamaTagsResponseBody,
  OLLAMA_HOST_DOCKER_INTERNAL,
} from "../inference/local";
import type { NvidiaPlatform } from "../inference/nim";
import { detectVllmProfile, type VllmProfile } from "../inference/vllm";
import { buildVllmDockerEnv } from "../inference/vllm-docker-env";
import {
  type ContainerRuntime,
  isWsl as defaultIsWsl,
  type WslDetectionOptions,
} from "../platform";
import { runCapture as defaultRunCapture } from "../runner";
import {
  getContainerRuntime as defaultGetContainerRuntime,
  getWindowsHostOllamaDockerRequirement,
  isWindowsDaemonOnWslLoopback,
  type WindowsHostOllamaDockerRequirement,
} from "./local-inference-topology";
import { warnAboutArm64NimImageCompatibility } from "./nim-image-compat-warning";
import { type OllamaInstallMenuResult, resolveOllamaInstallMenuEntry } from "./ollama-install-menu";
import { buildVllmMenuEntries, type VllmMenuEntry } from "./vllm-menu";
import { detectWindowsHostOllama, type WindowsHostOllamaState } from "./windows-host-ollama";

type RunCapture = (args: string[], options?: { ignoreError?: boolean }) => string;
type DockerCapture = (
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; ignoreError?: boolean; timeout?: number },
) => string;

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
  /** Whether the daemon on WSL loopback is the Windows host's own Ollama,
   *  which mirrored networking exposes at `127.0.0.1` rather than
   *  `host.docker.internal`. Neither the Linux installer nor Linux service
   *  management applies to it. Absent means not that topology (#9300). */
  windowsDaemonOnWslLoopback?: boolean;
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
  probeOllama?: boolean;
  probeVllm?: boolean;
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
  getLocalProviderAvailabilityEndpoint: (provider: string) => string | null;
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
    getLocalProviderAvailabilityEndpoint:
      overrides.getLocalProviderAvailabilityEndpoint ?? getLocalProviderAvailabilityEndpoint,
  };
}

function probeVllmRunning(deps: DetectInferenceProviderHostStateDeps): boolean {
  let endpoint: string | null;
  try {
    endpoint = deps.getLocalProviderAvailabilityEndpoint("vllm-local");
  } catch {
    return false;
  }
  if (!endpoint) return false;
  const writeOut = endpoint.endsWith("/health")
    ? ["--noproxy", "*", "--write-out", "%{http_code}"]
    : [];
  const output = deps.runCapture(
    ["curl", "-sf", ...LOCAL_PROVIDER_PROBE_CURL_ARGS, ...writeOut, endpoint],
    {
      ignoreError: true,
    },
  );
  return isLocalProviderProbeOutputHealthy(endpoint, output);
}

function probeWindowsOllamaReachable(input: {
  isWsl: boolean;
  isWindowsHostOllama: boolean;
  dockerRequirementSupported: boolean;
  dockerCapture: DockerCapture;
}): boolean {
  if (!input.isWsl || input.isWindowsHostOllama || !input.dockerRequirementSupported) return false;
  // A 2xx body alone does not prove Ollama answered: the same reasoning the
  // loopback probe already applies (#4275) holds here, and this result now
  // also decides whether a version gate runs (#9300).
  return isValidOllamaTagsResponseBody(
    input.dockerCapture(getWindowsHostOllamaDockerReachabilityArgs(), {
      ignoreError: true,
    }),
  );
}

/**
 * Resolve the same topology from scratch, for callers holding no provider host
 * snapshot. Resume repair is one: it reads a recorded `ollama-local` route,
 * which records no topology (#9300). Each probe short-circuits, so a non-WSL
 * host costs one `isWsl` check.
 */
export function detectWindowsDaemonOnWslLoopback(
  overrides: Partial<DetectInferenceProviderHostStateDeps> = {},
): boolean {
  const deps = buildDeps(overrides);
  if (!deps.isWsl()) return false;
  const ollamaHost = deps.findReachableOllamaHost();
  if (ollamaHost !== "127.0.0.1") return false;
  const windowsOllamaReachable = probeWindowsOllamaReachable({
    isWsl: true,
    isWindowsHostOllama: false,
    dockerRequirementSupported: deps.getWindowsHostOllamaDockerRequirement(
      deps.getContainerRuntime(),
    ).supported,
    dockerCapture: deps.dockerCapture,
  });
  return isWindowsDaemonOnWslLoopback({
    isWsl: true,
    ollamaHost,
    windowsOllamaReachable,
    runCapture: deps.runCapture,
  });
}

function maybeWarnAboutDuplicateOllamaDaemons(input: {
  isWsl: boolean;
  ollamaHost: string | null;
  windowsOllamaReachable: boolean;
  windowsDaemonOnWslLoopback: boolean;
  log: (message?: string) => void;
}): void {
  if (!input.isWsl || input.ollamaHost !== "127.0.0.1" || !input.windowsOllamaReachable) return;
  if (input.windowsDaemonOnWslLoopback) return;
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
  const ollamaHost = input.probeOllama === false ? null : deps.findReachableOllamaHost();
  const ollamaRunning = ollamaHost !== null;
  const isWindowsHostOllama = ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL;
  const vllmRunning = input.probeVllm === false ? false : probeVllmRunning(deps);
  const vllmProfile = deps.detectVllmProfile(input.gpu);
  const hasVllmImage = !!(
    vllmProfile &&
    deps
      .dockerCapture(["image", "inspect", "--format", "{{.Id}}", vllmProfile.image], {
        env: buildVllmDockerEnv({}, input.env),
        ignoreError: true,
        timeout: 10_000,
      })
      .trim()
  );
  const windowsHostOllamaDockerRequirement = deps.getWindowsHostOllamaDockerRequirement(
    isWsl ? deps.getContainerRuntime() : null,
  );
  const winOllamaState = deps.detectWindowsHostOllama();
  const hasWindowsOllama = winOllamaState.installed;
  const windowsOllamaReachable =
    input.probeOllama === false
      ? false
      : probeWindowsOllamaReachable({
          isWsl,
          isWindowsHostOllama,
          dockerRequirementSupported: windowsHostOllamaDockerRequirement.supported,
          dockerCapture: deps.dockerCapture,
        });

  const windowsDaemonOnWslLoopback = isWindowsDaemonOnWslLoopback({
    isWsl,
    ollamaHost,
    windowsOllamaReachable,
    runCapture: deps.runCapture,
  });

  maybeWarnAboutDuplicateOllamaDaemons({
    isWsl,
    ollamaHost,
    windowsOllamaReachable,
    windowsDaemonOnWslLoopback,
    log,
  });
  const gpuNimCapable = Boolean(input.gpu?.nimCapable);
  warnAboutArm64NimImageCompatibility({
    gpu: input.gpu,
    nimLocalAvailable: input.experimental && gpuNimCapable,
    platform,
    log,
  });

  const ollamaInstallMenu = resolveOllamaInstallMenuEntry({
    hasOllama,
    ollamaRunning,
    hasWindowsOllama,
    windowsHostOllamaSupported:
      windowsHostOllamaDockerRequirement.supported && windowsOllamaReachable,
    ollamaHost,
    windowsDaemonOnWslLoopback,
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
    windowsDaemonOnWslLoopback,
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
    gpuNimCapable,
  };
}
