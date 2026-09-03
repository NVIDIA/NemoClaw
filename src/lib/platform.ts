// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { existsSync as defaultExistsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { dockerSpawnSync } from "./adapters/docker/exec";

export type ContainerRuntime = "podman" | "colima" | "docker-desktop" | "docker" | "unknown";

export interface PlatformLookupOptions {
  platform?: NodeJS.Platform;
  home?: string;
  uid?: number;
}

export interface WslDetectionOptions {
  isWsl?: boolean;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  release?: string;
  procVersion?: string;
}

export interface DockerHostDetectionOptions extends PlatformLookupOptions, WslDetectionOptions {
  env?: NodeJS.ProcessEnv;
  existsSync?: (filePath: string) => boolean;
  probeDockerHost?: DockerHostProbe;
}

export interface DockerHostDetection {
  dockerHost: string;
  source: "env" | "socket";
  socketPath: string | null;
}

export type DockerVersionIdentity = "docker" | "podman" | "unknown";

export interface DockerHostProbeResult {
  reachable: boolean;
  identity: DockerVersionIdentity;
}

export type DockerHostProbe = (dockerHost: string | undefined) => DockerHostProbeResult;

type WindowsInteropCapture = (
  command: readonly string[],
  options?: { ignoreError?: boolean; timeout?: number },
) => string;

export interface WindowsProcessTcpListenerProbe {
  processName: string;
  port: number;
  timeoutMs: number;
}

/** Require every matching Windows process listener on a TCP port to use loopback. */
export function windowsProcessListensOnlyOnLoopback(
  runCaptureImpl: WindowsInteropCapture,
  probe: WindowsProcessTcpListenerProbe,
): boolean {
  const processName = probe.processName.trim();
  if (!processName || !Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65_535) {
    return false;
  }
  const quotedProcessName = `'${processName.replace(/'/g, "''")}'`;
  const script =
    `$processPids = @(Get-Process ${quotedProcessName} -ErrorAction SilentlyContinue | ` +
    "Select-Object -ExpandProperty Id); " +
    "if ($processPids.Count -gt 0) { " +
    `Get-NetTCPConnection -LocalPort ${probe.port} -State Listen -ErrorAction SilentlyContinue | ` +
    "Where-Object { $processPids -contains $_.OwningProcess } | " +
    "Select-Object -ExpandProperty LocalAddress }";
  const addresses = runCaptureImpl(["powershell.exe", "-Command", script], {
    ignoreError: true,
    timeout: probe.timeoutMs,
  })
    .split(/\r?\n/)
    .map((address) => address.trim())
    .filter(Boolean);
  return (
    addresses.length > 0 &&
    addresses.every((address) => address === "127.0.0.1" || address === "::1")
  );
}

const DOCKER_PROBE_TIMEOUT_MS = 3_000;
const DOCKER_PROBE_MAX_BUFFER_BYTES = 1024 * 1024;
const DOCKER_PROBE_ENV_NAMES = ["HOME", "USER", "LOGNAME", "PATH"] as const;

function isWsl(opts: WslDetectionOptions = {}): boolean {
  // Explicit override — lets tests pin behavior regardless of the host kernel.
  // Useful because the WSL detection below consults `os.release()`, which
  // returns a "microsoft"-tagged string on WSL2 hosts even when env vars are
  // unset. Without this override, any test calling functions that consult
  // `isWsl()` becomes non-deterministic on WSL2 dev machines.
  if (typeof opts.isWsl === "boolean") return opts.isWsl;

  const platform = opts.platform ?? process.platform;
  if (platform !== "linux") return false;

  const env = opts.env ?? process.env;
  const release = opts.release ?? os.release();
  const procVersion = opts.procVersion ?? "";

  return (
    Boolean(env.WSL_DISTRO_NAME) ||
    Boolean(env.WSL_INTEROP) ||
    /microsoft/i.test(release) ||
    /microsoft/i.test(procVersion)
  );
}

function inferContainerRuntime(info = ""): ContainerRuntime {
  const normalized = String(info).toLowerCase();
  if (!normalized.trim()) return "unknown";
  if (normalized.includes("podman")) return "podman";
  if (normalized.includes("colima")) return "colima";
  if (normalized.includes("docker desktop")) return "docker-desktop";
  if (normalized.includes("docker")) return "docker";
  return "unknown";
}

/**
 * Classify the engine identity from the explicit
 * `docker version --format '{{json .}}'` banner.
 *
 * Podman's Docker-compatible `/info` endpoint does not always name Podman.
 * The `/version` payload retains a `Podman Engine` component. Docker Engine,
 * Docker Desktop, and Colima retain a Docker platform or engine component.
 */
function classifyDockerVersionIdentity(versionOutput = ""): DockerVersionIdentity {
  const text = String(versionOutput || "").trim();
  if (!text) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (/podman/i.test(text)) return "podman";
    return /docker engine/i.test(text) ? "docker" : "unknown";
  }
  const server = (parsed as Record<string, unknown> | null)?.Server;
  if (!server || typeof server !== "object") return "unknown";
  const serverRecord = server as Record<string, unknown>;
  const platformName = (serverRecord.Platform as Record<string, unknown> | undefined)?.Name;
  if (typeof platformName === "string" && /podman/i.test(platformName)) return "podman";
  const components = serverRecord.Components;
  const componentNames = Array.isArray(components)
    ? components.flatMap((component) => {
        const name =
          component && typeof component === "object"
            ? (component as Record<string, unknown>).Name
            : undefined;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  if (componentNames.some((name) => /podman/i.test(name))) return "podman";
  if (
    (typeof platformName === "string" && /^docker (?:engine|desktop)\b/i.test(platformName)) ||
    componentNames.some((name) => name.trim().toLowerCase() === "engine")
  ) {
    return "docker";
  }
  return "unknown";
}

function buildDockerProbeEnv(
  source: NodeJS.ProcessEnv,
  dockerHost: string | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of DOCKER_PROBE_ENV_NAMES) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  if (dockerHost === undefined) {
    if (source.DOCKER_CONFIG !== undefined) env.DOCKER_CONFIG = source.DOCKER_CONFIG;
    if (source.DOCKER_CONTEXT !== undefined) env.DOCKER_CONTEXT = source.DOCKER_CONTEXT;
  }
  if (dockerHost) {
    env.DOCKER_HOST = dockerHost;
  }
  return env;
}

function probeDockerHost(
  dockerHost: string | undefined,
  source: NodeJS.ProcessEnv,
): DockerHostProbeResult {
  const result = dockerSpawnSync(["version", "--format", "{{json .}}"], {
    encoding: "utf-8",
    env: buildDockerProbeEnv(source, dockerHost),
    timeout: DOCKER_PROBE_TIMEOUT_MS,
    maxBuffer: DOCKER_PROBE_MAX_BUFFER_BYTES,
  });
  if (!result || result.status !== 0) return { reachable: false, identity: "unknown" };
  return {
    reachable: true,
    identity: classifyDockerVersionIdentity(String(result.stdout ?? "")),
  };
}

function containerCanReachHostLoopback(
  runtime: ContainerRuntime,
  opts: WslDetectionOptions = {},
): boolean {
  // Whether a sandbox container can reach the host's 127.0.0.1 directly,
  // without an auth proxy fronting host-side services like Ollama or vLLM.
  //
  // Docker Desktop bridges the WSL host's loopback back into containers
  // (running in the docker-desktop VM) via host.docker.internal — so the
  // local Ollama daemon bound to 127.0.0.1:11434 is reachable as-is.
  //
  // Native dockerd installed inside a WSL distro only sees the Docker
  // bridge gateway (e.g. 172.17.0.1); 127.0.0.1 on the WSL host is
  // invisible from any container on that bridge. NemoClaw fronts Ollama
  // with the auth proxy in this topology (issue #3695).
  //
  // Anywhere off WSL (macOS Docker Desktop, regular Linux native Docker),
  // NemoClaw always runs the auth proxy.
  return isWsl(opts) && runtime === "docker-desktop";
}

function shouldPatchCoredns(runtime: ContainerRuntime, opts: WslDetectionOptions = {}): boolean {
  // CoreDNS patching is needed for Colima and Podman (both use custom network bridges).
  // On WSL2, the host DNS is not routable from k3s pods — skip and let setup-dns-proxy.sh handle it.
  if (isWsl(opts)) return false;
  return runtime === "colima" || runtime === "podman";
}

function getColimaDockerSocketCandidates(opts: PlatformLookupOptions = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  return [
    path.join(home, ".colima/default/docker.sock"),
    path.join(home, ".config/colima/default/docker.sock"),
    // Some Colima profiles (and older layouts) place the socket at the
    // top-level ~/.colima/docker.sock rather than under default/. Reported
    // in #3503 — keep as a candidate so detection succeeds without the
    // user having to symlink to /var/run/docker.sock.
    path.join(home, ".colima/docker.sock"),
  ];
}

function findColimaDockerSocket(
  opts: PlatformLookupOptions & { existsSync?: (filePath: string) => boolean } = {},
): string | null {
  const fileExists = opts.existsSync ?? defaultExistsSync;
  return getColimaDockerSocketCandidates(opts).find((socketPath) => fileExists(socketPath)) ?? null;
}

function getPodmanSocketCandidates(opts: PlatformLookupOptions = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;
  const uid = opts.uid ?? process.getuid?.() ?? 1000;

  if (platform === "darwin") {
    return [
      path.join(home, ".local/share/containers/podman/machine/podman.sock"),
      "/var/run/docker.sock",
    ];
  }

  if (platform === "linux") {
    return [`/run/user/${String(uid)}/podman/podman.sock`, "/run/podman/podman.sock"];
  }

  return [];
}

function getDockerSocketCandidates(opts: PlatformLookupOptions = {}): string[] {
  const home = opts.home ?? process.env.HOME ?? "/tmp";
  const platform = opts.platform ?? process.platform;

  if (platform === "darwin") {
    return [
      ...getColimaDockerSocketCandidates({ home }),
      ...getPodmanSocketCandidates({ home, platform }),
      path.join(home, ".docker/run/docker.sock"),
    ];
  }

  if (platform === "linux") {
    return [
      ...getPodmanSocketCandidates({ home, platform, uid: opts.uid }),
      "/run/docker.sock",
      "/var/run/docker.sock",
    ];
  }

  return [];
}

function detectDockerHost(opts: DockerHostDetectionOptions = {}): DockerHostDetection | null {
  const env = opts.env ?? process.env;
  if (env.DOCKER_HOST) {
    return {
      dockerHost: env.DOCKER_HOST,
      source: "env",
      socketPath: null,
    };
  }

  const probe = opts.probeDockerHost ?? ((dockerHost) => probeDockerHost(dockerHost, env));
  if (probe(undefined).reachable) return null;

  const fileExists = opts.existsSync ?? defaultExistsSync;
  let selection: DockerHostDetection | null = null;
  let selectedIdentity: Exclude<DockerVersionIdentity, "unknown"> | null = null;
  for (const socketPath of getDockerSocketCandidates(opts)) {
    if (!fileExists(socketPath)) continue;
    const dockerHost = `unix://${socketPath}`;
    const observation = probe(dockerHost);
    if (!observation.reachable) continue;
    if (observation.identity === "unknown") continue;
    if (selectedIdentity && observation.identity !== selectedIdentity) return null;
    if (selection) continue;
    selection = { dockerHost, source: "socket", socketPath };
    selectedIdentity = observation.identity;
  }

  return selection;
}

export {
  classifyDockerVersionIdentity,
  containerCanReachHostLoopback,
  detectDockerHost,
  findColimaDockerSocket,
  getColimaDockerSocketCandidates,
  getDockerSocketCandidates,
  getPodmanSocketCandidates,
  inferContainerRuntime,
  isWsl,
  shouldPatchCoredns,
};
