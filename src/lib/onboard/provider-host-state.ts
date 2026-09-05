// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { dockerCapture as defaultDockerCapture } from "../adapters/docker";
import {
  detectLocalTcpListener,
  findReachableOllamaHost,
  getLocalProviderAvailabilityEndpoint,
  isLocalProviderProbeOutputHealthy,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_PORT,
  probeWindowsHostOllamaRouteProtection,
  resetOllamaHostCache as defaultResetOllamaHostCache,
  type RunCaptureFn,
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
  type WindowsHostOllamaDockerRequirement,
} from "./local-inference-topology";
import { warnAboutArm64NimImageCompatibility } from "./nim-image-compat-warning";
import { type OllamaInstallMenuResult, resolveOllamaInstallMenuEntry } from "./ollama-install-menu";
import { buildVllmMenuEntries, type VllmMenuEntry } from "./vllm-menu";
import { detectWindowsHostOllama, type WindowsHostOllamaState } from "./windows-host-ollama";

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
  runCapture: RunCaptureFn;
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
  detectLocalTcpListener: (port: number) => boolean | null;
  probeWindowsHostOllamaRouteProtection: typeof probeWindowsHostOllamaRouteProtection;
  resetOllamaHostCache: () => void;
}

const LOCAL_PROVIDER_PROBE_CURL_ARGS = ["--connect-timeout", "2", "--max-time", "5"] as const;

function hostCommandExists(commandName: string, runCapture: RunCaptureFn): boolean {
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
    detectLocalTcpListener: overrides.detectLocalTcpListener ?? detectLocalTcpListener,
    probeWindowsHostOllamaRouteProtection:
      overrides.probeWindowsHostOllamaRouteProtection ?? probeWindowsHostOllamaRouteProtection,
    resetOllamaHostCache: overrides.resetOllamaHostCache ?? defaultResetOllamaHostCache,
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

function maybeWarnAboutDuplicateOllamaDaemons(input: {
  isWsl: boolean;
  ollamaHost: string | null;
  isWindowsHostOllama: boolean;
  windowsOllamaReachable: boolean;
  wslNetworkingMode: string | null;
  hasWslLocalOllamaListener: boolean | null;
  log: (message?: string) => void;
}): void {
  if (
    !input.isWsl ||
    input.isWindowsHostOllama ||
    input.ollamaHost !== "127.0.0.1" ||
    !input.windowsOllamaReachable
  ) {
    return;
  }
  if (input.wslNetworkingMode === "mirrored" && input.hasWslLocalOllamaListener !== true) return;
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
  const discoveredOllamaHost = input.probeOllama === false ? null : deps.findReachableOllamaHost();
  const vllmRunning = input.probeVllm === false ? false : probeVllmRunning(deps);
  const vllmProfile = deps.detectVllmProfile(input.gpu);
  const dockerAvailable = deps.hostCommandExists("docker");
  const hasVllmImage = !!(
    dockerAvailable &&
    vllmProfile &&
    deps
      .dockerCapture(["image", "inspect", "--format", "{{.Id}}", vllmProfile.image], {
        env: buildVllmDockerEnv({}, input.env),
        ignoreError: true,
        timeout: 10_000,
      })
      .trim()
  );
  const containerRuntime = isWsl ? deps.getContainerRuntime() : null;
  const windowsHostOllamaDockerRequirement =
    deps.getWindowsHostOllamaDockerRequirement(containerRuntime);
  const winOllamaState =
    input.probeOllama === false
      ? { installed: false, installedPath: "", loopbackOnly: false }
      : deps.detectWindowsHostOllama();
  const hasWindowsOllama = winOllamaState.installed;
  const windowsOllamaProtection =
    input.probeOllama === false
      ? { loopbackOnly: false, reachable: false, hostValidationEnabled: false, protected: false }
      : deps.probeWindowsHostOllamaRouteProtection(deps.runCapture, {
          runtime: containerRuntime ?? "unknown",
          wslDetection: { isWsl },
          env: input.env,
          loopbackOnly: hasWindowsOllama ? winOllamaState.loopbackOnly : undefined,
        });
  const windowsOllamaReachable = windowsOllamaProtection.reachable;
  const windowsOllamaRouteProtected = windowsOllamaProtection.protected;
  const directlyResolvedWindowsHostOllama = discoveredOllamaHost === OLLAMA_HOST_DOCKER_INTERNAL;
  const wslNetworkingMode =
    isWsl && discoveredOllamaHost === "127.0.0.1" && windowsOllamaReachable
      ? deps
          .runCapture(["wslinfo", "--networking-mode"], {
            ignoreError: true,
            timeout: 5_000,
          })
          .trim()
          .toLowerCase()
      : null;
  const hasWslLocalOllamaListener =
    wslNetworkingMode === "mirrored" ? deps.detectLocalTcpListener(OLLAMA_PORT) : null;
  const couldBeMirroredWindowsHostOllama =
    discoveredOllamaHost === "127.0.0.1" &&
    wslNetworkingMode === "mirrored" &&
    windowsOllamaReachable &&
    hasWslLocalOllamaListener !== true;
  // Never pass an unprotected Windows daemon into the generic running-Ollama
  // path. That path assumes the selected route is already safe to reuse and
  // would otherwise bypass the loopback repair action. Mirrored WSL can expose
  // the same Windows daemon on 127.0.0.1, so protect that identity as well.
  const rejectDiscoveredWindowsRoute =
    (directlyResolvedWindowsHostOllama || couldBeMirroredWindowsHostOllama) &&
    !windowsOllamaRouteProtected;
  if (rejectDiscoveredWindowsRoute) deps.resetOllamaHostCache();
  const ollamaHost = rejectDiscoveredWindowsRoute ? null : discoveredOllamaHost;
  const ollamaRunning = ollamaHost !== null;

  // Under WSL mirrored networking, a live Windows daemon answers through the
  // distro's 127.0.0.1 before host.docker.internal is considered. Require
  // positive evidence that Windows Ollama is installed and Docker-reachable,
  // plus procfs evidence that Linux does not own a listener on the same port.
  // Ambiguous evidence and dual-daemon topologies stay on the WSL-local
  // version-upgrade/systemd path (#9300).
  const isWindowsHostOllama =
    (directlyResolvedWindowsHostOllama && windowsOllamaRouteProtected) ||
    (ollamaHost === "127.0.0.1" &&
      wslNetworkingMode === "mirrored" &&
      windowsOllamaRouteProtected &&
      hasWslLocalOllamaListener === false);

  maybeWarnAboutDuplicateOllamaDaemons({
    isWsl,
    ollamaHost,
    isWindowsHostOllama,
    windowsOllamaReachable,
    wslNetworkingMode,
    hasWslLocalOllamaListener,
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
      windowsHostOllamaDockerRequirement.supported && windowsOllamaRouteProtected,
    ollamaHost,
    platform,
    isWsl,
    isWindowsHostOllama,
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
      dockerAvailable,
      env: input.env,
      log: (message) => log(message),
    }),
    ollamaInstallMenu,
    gpuNimCapable,
  };
}
