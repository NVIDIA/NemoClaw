// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

import { dockerCapture as defaultDockerCapture } from "../adapters/docker";
import {
  findReachableOllamaHost,
  getLocalProviderAvailabilityEndpoint,
  getWindowsHostOllamaDockerReachabilityArgs,
  isLocalProviderProbeOutputHealthy,
  isValidOllamaTagsResponseBody,
  OLLAMA_HOST_DOCKER_INTERNAL,
  OLLAMA_PORT,
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

type RunCapture = (args: string[], options?: { ignoreError?: boolean }) => string;
type DockerCapture = (
  args: string[],
  options?: { env?: NodeJS.ProcessEnv; ignoreError?: boolean; timeout?: number },
) => string;
type ReadTextFile = (filePath: string) => string | null;

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
  detectLocalTcpListener: (port: number) => boolean | null;
}

const LOCAL_PROVIDER_PROBE_CURL_ARGS = ["--connect-timeout", "2", "--max-time", "5"] as const;

function readTextFileOrNull(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }
}

/**
 * Return whether Linux owns a listening TCP socket for `port`, or `null` when
 * procfs cannot establish that fact. Windows sockets forwarded into WSL by
 * mirrored networking do not belong to a Linux process and are not listed in
 * these tables.
 */
export function detectLocalTcpListener(
  port: number,
  readTextFile: ReadTextFile = readTextFileOrNull,
): boolean | null {
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const expectedPort = port.toString(16).toUpperCase().padStart(4, "0");
  for (const filePath of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    const table = readTextFile(filePath);
    if (table === null) return null;
    const lines = table.trimEnd().split(/\r?\n/);
    const header = lines.shift();
    if (!header?.includes("local_address") || !header.includes("st")) return null;
    for (const line of lines) {
      if (!line.trim()) continue;
      const columns = line.trim().split(/\s+/);
      const localAddress = columns[1];
      const state = columns[3];
      const portMatch = /:([0-9A-Fa-f]{4})$/.exec(localAddress ?? "");
      if (!portMatch || typeof state !== "string") return null;
      if (state.toUpperCase() === "0A" && portMatch[1].toUpperCase() === expectedPort) {
        return true;
      }
    }
  }
  return false;
}

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
    detectLocalTcpListener: overrides.detectLocalTcpListener ?? detectLocalTcpListener,
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
  dockerRequirementSupported: boolean;
  dockerCapture: DockerCapture;
}): boolean {
  if (!input.isWsl || !input.dockerRequirementSupported) return false;
  // A successful Docker run is not enough: a captive proxy, a stale listener, or
  // a stub on host.docker.internal can all answer with arbitrary 2xx bodies. Only
  // a body in the Ollama `/api/tags` wire format proves the Windows daemon is live.
  const body = input.dockerCapture(getWindowsHostOllamaDockerReachabilityArgs(), {
    ignoreError: true,
  });
  return isValidOllamaTagsResponseBody(body);
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
  const ollamaHost = input.probeOllama === false ? null : deps.findReachableOllamaHost();
  const ollamaRunning = ollamaHost !== null;
  const directlyResolvedWindowsHostOllama = ollamaHost === OLLAMA_HOST_DOCKER_INTERNAL;
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
  const winOllamaState =
    input.probeOllama === false
      ? { installed: false, installedPath: "", loopbackOnly: false }
      : deps.detectWindowsHostOllama();
  const hasWindowsOllama = winOllamaState.installed;
  const windowsOllamaReachable =
    input.probeOllama === false
      ? false
      : probeWindowsOllamaReachable({
          isWsl,
          dockerRequirementSupported: windowsHostOllamaDockerRequirement.supported,
          dockerCapture: deps.dockerCapture,
        });

  const wslNetworkingMode =
    isWsl && ollamaHost === "127.0.0.1" && windowsOllamaReachable
      ? deps
          .runCapture(["wslinfo", "--networking-mode"], { ignoreError: true })
          .trim()
          .toLowerCase()
      : null;
  const hasWslLocalOllamaListener =
    wslNetworkingMode === "mirrored" ? deps.detectLocalTcpListener(OLLAMA_PORT) : null;
  // Under WSL mirrored networking, a live Windows daemon answers through the
  // distro's 127.0.0.1 before host.docker.internal is considered. Require
  // positive evidence that Windows Ollama is installed and Docker-reachable,
  // plus procfs evidence that Linux does not own a listener on the same port.
  // Ambiguous evidence and dual-daemon topologies stay on the WSL-local
  // version-upgrade/systemd path (#9300).
  const isWindowsHostOllama =
    directlyResolvedWindowsHostOllama ||
    (ollamaHost === "127.0.0.1" &&
      wslNetworkingMode === "mirrored" &&
      hasWindowsOllama &&
      windowsOllamaReachable &&
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
      windowsHostOllamaDockerRequirement.supported && windowsOllamaReachable,
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
      env: input.env,
      log: (message) => log(message),
    }),
    ollamaInstallMenu,
    gpuNimCapable,
  };
}
