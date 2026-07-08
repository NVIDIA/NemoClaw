// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { dockerForceRm } from "../adapters/docker";
import type { DockerDriverGatewayLaunch } from "./docker-driver-gateway-launch";

const DEFAULT_COMPAT_IMAGE =
  "ubuntu:24.04@sha256:786a8b558f7be160c6c8c4a54f9a57274f3b4fb1491cf65146521ae77ff1dc54";
const DEFAULT_COMPAT_CONTAINER_NAME = "nemoclaw-openshell-gateway";
const GATEWAY_MOUNT_PATH = "/opt/nemoclaw/openshell-gateway";
const LOOPBACK_BIND_ADDRESS = "127.0.0.1";
const DEFAULT_COMPAT_BIND_ADDRESS = LOOPBACK_BIND_ADDRESS;
const DOCKER_DAEMON_PROBE_TIMEOUT_MS = 5_000;

type ContainerizedGatewayLaunchOptions = {
  gatewayBin: string;
  gatewayEnv: Record<string, string>;
  stateDir: string;
  sandboxBin?: string | null;
  compatContainerName?: string;
  baseEnv: NodeJS.ProcessEnv;
  reason?: string;
};

export function compareDottedVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i += 1) {
    const delta = (left[i] ?? 0) - (right[i] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

export function maxDottedVersion(versions: string[]): string | null {
  return versions.reduce<string | null>(
    (max, version) => (!max || compareDottedVersions(version, max) > 0 ? version : max),
    null,
  );
}

export function parseGlibcVersionsFromBinaryText(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/GLIBC_([0-9]+(?:\.[0-9]+)+)/g)].map((match) => match[1]).filter(Boolean),
    ),
  ];
}

export function requiredGlibcVersionsForBinary(binaryPath: string): string[] {
  try {
    return parseGlibcVersionsFromBinaryText(fs.readFileSync(binaryPath, "latin1"));
  } catch {
    return [];
  }
}

export function getHostGlibcVersion(): string | null {
  const report = (
    process as unknown as {
      report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } };
    }
  ).report?.getReport?.();
  const fromNode = report?.header?.glibcVersionRuntime;
  if (fromNode) return fromNode;
  try {
    const output = execFileSync("getconf", ["GNU_LIBC_VERSION"], {
      encoding: "utf-8",
      timeout: 5_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.match(/glibc\s+([0-9]+(?:\.[0-9]+)+)/i)?.[1] ?? null;
  } catch {
    return null;
  }
}

export function getDockerSocketPath(env: NodeJS.ProcessEnv = process.env): string {
  const dockerHost = String(env.DOCKER_HOST || "").trim();
  if (dockerHost.startsWith("unix://")) return dockerHost.slice("unix://".length);
  return "/var/run/docker.sock";
}

export function assertCompatibleDockerDaemonReachable(
  env: NodeJS.ProcessEnv = process.env,
  probe: typeof execFileSync = execFileSync,
): void {
  const socketPath = getDockerSocketPath(env);
  try {
    if (!fs.statSync(socketPath).isSocket()) {
      throw new Error("path is not a Unix socket");
    }
  } catch (error) {
    throw new Error(
      `OpenShell gateway compatibility mode requires a reachable Docker daemon at unix://${socketPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const version = probe(
      "docker",
      ["--host", `unix://${socketPath}`, "version", "--format", "{{.Server.Version}}"],
      {
        encoding: "utf-8",
        timeout: DOCKER_DAEMON_PROBE_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    if (!String(version).trim()) throw new Error("Docker returned an empty server version");
  } catch (error) {
    throw new Error(
      `OpenShell gateway compatibility mode could not reach the Docker daemon at unix://${socketPath} within ${DOCKER_DAEMON_PROBE_TIMEOUT_MS}ms: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function shouldUseContainerizedGateway(options: {
  gatewayBin: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostGlibcVersion?: string | null;
  requiredGlibcVersions?: string[];
}): { useContainer: boolean; reason?: string } {
  const env = options.env ?? process.env;
  const override = String(env.NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH || "").trim();
  if (override === "0") return { useContainer: false };
  if ((options.platform ?? process.platform) !== "linux") return { useContainer: false };
  if (override === "1") {
    return { useContainer: true, reason: "forced by NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH=1" };
  }

  const host = options.hostGlibcVersion ?? getHostGlibcVersion();
  if (!host) return { useContainer: false };
  const required = maxDottedVersion(
    options.requiredGlibcVersions ?? requiredGlibcVersionsForBinary(options.gatewayBin),
  );
  if (!required) return { useContainer: false };
  if (compareDottedVersions(required, host) <= 0) return { useContainer: false };
  throw new Error(
    `OpenShell gateway compatibility container requires explicit opt-in: host glibc ${host} is older than openshell-gateway requirement ${required}. ` +
      "This mode uses host networking and read-only Docker socket access. " +
      "Set NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH=1 to opt in, or install an OpenShell gateway binary compatible with this host.",
  );
}

function addVolume(args: string[], hostPath: string, containerPath = hostPath, mode = "rw"): void {
  args.push("--volume", `${hostPath}:${containerPath}:${mode}`);
}

function addEnv(args: string[], key: string, value: string | undefined): void {
  if (typeof value === "string") args.push("--env", key);
}

function safeDockerName(value: string | undefined, fallback: string): string {
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(candidate)) return candidate;
  throw new Error("Invalid Docker container name override.");
}

function safeDockerImage(value: string | undefined, fallback: string): string {
  const candidate = String(value || "").trim();
  if (!candidate) return fallback;
  if (
    /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(candidate) &&
    /@sha256:[A-Fa-f0-9]{64}$/.test(candidate)
  ) {
    return candidate;
  }
  throw new Error(
    "Invalid Docker image override; NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_IMAGE must include an immutable @sha256:<64-hex> digest.",
  );
}

function safeDockerHost(value: string | undefined): string | undefined {
  const candidate = String(value || "").trim();
  if (!candidate) return undefined;
  if (candidate.startsWith("unix://")) {
    const socketPath = candidate.slice("unix://".length);
    if (path.isAbsolute(socketPath) && !socketPath.includes("\0")) return candidate;
  }
  throw new Error(
    "Invalid DOCKER_HOST for OpenShell gateway compatibility mode; only absolute unix:// Docker sockets are supported.",
  );
}

function compatGatewayBindAddress(env: NodeJS.ProcessEnv): string {
  const raw = String(env.NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_BIND_ADDRESS || "").trim();
  if (!raw) return DEFAULT_COMPAT_BIND_ADDRESS;
  if (raw === LOOPBACK_BIND_ADDRESS) return raw;
  throw new Error(
    "Invalid NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_BIND_ADDRESS; OpenShell compatibility mode only supports 127.0.0.1.",
  );
}

function buildGatewayProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  gatewayEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv, ...gatewayEnv };
  if (!("OPENSHELL_DISABLE_GATEWAY_AUTH" in gatewayEnv)) {
    delete env.OPENSHELL_DISABLE_GATEWAY_AUTH;
  }
  return env;
}

export function buildContainerizedDockerDriverGatewayLaunch(
  options: ContainerizedGatewayLaunchOptions,
): DockerDriverGatewayLaunch {
  options.gatewayEnv.OPENSHELL_BIND_ADDRESS = compatGatewayBindAddress(options.baseEnv);
  const env = buildGatewayProcessEnv(options.baseEnv, options.gatewayEnv);
  const sandboxBin = options.sandboxBin || options.gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN;
  if (!sandboxBin) {
    throw new Error(
      "OpenShell gateway container compatibility mode requires openshell-sandbox. " +
        "Re-run the NemoClaw installer or set NEMOCLAW_OPENSHELL_SANDBOX_BIN.",
    );
  }
  env.OPENSHELL_GATEWAY_CONFIG = options.gatewayEnv.OPENSHELL_GATEWAY_CONFIG;

  const image = safeDockerImage(env.NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_IMAGE, DEFAULT_COMPAT_IMAGE);
  // The per-port compatContainerName wins so a process-wide
  // NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME cannot collapse two sandboxes
  // back onto one compat container (and its pre-launch `docker rm`) (#4422). The
  // env override still applies when no per-port name is supplied.
  const containerName = safeDockerName(
    options.compatContainerName,
    safeDockerName(
      env.NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME,
      DEFAULT_COMPAT_CONTAINER_NAME,
    ),
  );
  const dockerHost = safeDockerHost(env.DOCKER_HOST);
  if (dockerHost) {
    env.DOCKER_HOST = dockerHost;
  } else {
    delete env.DOCKER_HOST;
  }
  const dockerSocket = getDockerSocketPath(env);
  // The compat container is a host-side OpenShell gateway ABI shim for Linux
  // hosts whose glibc is older than the downloaded gateway binary. Host
  // networking is required so OpenShell can compute and bind Docker bridge
  // callback addresses exactly as a host gateway would; the main listener is
  // still forced to loopback by compatGatewayBindAddress(). Docker socket access
  // is needed only so that gateway process can continue driving the Docker
  // compute driver from inside the shim container; the socket is still a
  // privileged host API even with a read-only bind mount.
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "host",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
  ];
  addVolume(args, path.resolve(options.gatewayBin), GATEWAY_MOUNT_PATH, "ro");
  addVolume(args, path.resolve(options.stateDir), path.resolve(options.stateDir), "rw");
  addVolume(
    args,
    path.resolve(path.dirname(sandboxBin)),
    path.resolve(path.dirname(sandboxBin)),
    "ro",
  );
  if (fs.existsSync(dockerSocket)) addVolume(args, dockerSocket, dockerSocket, "ro");
  for (const key of Object.keys(options.gatewayEnv).sort()) {
    addEnv(args, key, options.gatewayEnv[key]);
  }
  addEnv(args, "OPENSHELL_GATEWAY_CONFIG", env.OPENSHELL_GATEWAY_CONFIG);
  addEnv(args, "DOCKER_HOST", dockerHost);
  addEnv(args, "RUST_LOG", env.RUST_LOG);
  args.push(image, GATEWAY_MOUNT_PATH);

  return {
    command: "docker",
    args,
    env,
    mode: "container",
    processGatewayBin: null,
    reason: options.reason,
    containerName,
  };
}

export function prepareContainerizedDockerDriverGatewayLaunch(
  launch: DockerDriverGatewayLaunch,
  removeContainer: typeof dockerForceRm = dockerForceRm,
  verifyDockerDaemon: (env?: NodeJS.ProcessEnv) => void = assertCompatibleDockerDaemonReachable,
): void {
  if (launch.mode !== "container" || !launch.containerName) return;
  verifyDockerDaemon(launch.env);
  const result = removeContainer(launch.containerName, {
    ignoreError: true,
    suppressOutput: true,
    timeout: 30_000,
  });
  if (result.error) {
    throw new Error(
      `Failed to remove prior OpenShell compatibility gateway container '${launch.containerName}': ${result.error.message}`,
    );
  }
}

export function logContainerizedDockerDriverGatewayLaunch(
  launch: DockerDriverGatewayLaunch,
  log: (message: string) => void = console.log,
  warn: (message: string) => void = console.warn,
): void {
  if (launch.mode !== "container") return;
  log(`  OpenShell gateway compatibility patch active (${launch.reason}).`);
  log("  Running openshell-gateway inside a Docker compatibility container.");
  warn(
    "  SECURITY NOTICE: compatibility container uses host networking plus Docker API access; enabled only by NEMOCLAW_OPENSHELL_GATEWAY_CONTAINER_PATCH=1. Review/removal conditions: docs/security/openshell-0.0.72-compatibility-review.mdx#source-of-truth-boundaries.",
  );
  log(
    "  Compatibility gateway bind: 127.0.0.1 main listener plus OpenShell Docker-driver bridge reachability.",
  );
  log(
    "  Gateway auth boundary: host-side OpenShell CLI uses local mTLS; sandbox callbacks use mTLS plus OpenShell gateway JWT.",
  );
  prepareContainerizedDockerDriverGatewayLaunch(launch);
}
