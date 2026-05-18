// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { dockerForceRm } from "../adapters/docker";

const DEFAULT_COMPAT_IMAGE = "ubuntu:24.04";
const DEFAULT_COMPAT_CONTAINER_NAME = "nemoclaw-openshell-gateway";
const GATEWAY_MOUNT_PATH = "/opt/nemoclaw/openshell-gateway";
const DEFAULT_COMPAT_BIND_ADDRESS = "0.0.0.0";
const LOOPBACK_BIND_ADDRESS = "127.0.0.1";

export type DockerDriverGatewayLaunch = {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "host" | "container";
  processGatewayBin: string | null;
  reason?: string;
  containerName?: string;
};

export type DockerDriverGatewayRuntimeIdentity = {
  launch: DockerDriverGatewayLaunch | null;
  desiredEnv: Record<string, string>;
  driftGatewayBin: string | null;
  identityGatewayBin: string | null;
};

type BuildGatewayLaunchOptions = {
  gatewayBin: string;
  gatewayEnv: Record<string, string>;
  stateDir: string;
  sandboxBin?: string | null;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  hostGlibcVersion?: string | null;
  requiredGlibcVersions?: string[];
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
      [...text.matchAll(/GLIBC_([0-9]+(?:\.[0-9]+)+)/g)]
        .map((match) => match[1])
        .filter(Boolean),
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
  const report = (process as unknown as {
    report?: { getReport?: () => { header?: { glibcVersionRuntime?: string } } };
  }).report?.getReport?.();
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

export function shouldUseContainerizedGateway(
  options: Pick<
    BuildGatewayLaunchOptions,
    "gatewayBin" | "platform" | "env" | "hostGlibcVersion" | "requiredGlibcVersions"
  >,
): { useContainer: boolean; reason?: string } {
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
  return {
    useContainer: true,
    reason: `host glibc ${host} is older than openshell-gateway requirement ${required}`,
  };
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
  if (/^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(candidate)) return candidate;
  throw new Error("Invalid Docker image override.");
}

function safeDockerHost(value: string | undefined): string | undefined {
  const candidate = String(value || "").trim();
  if (!candidate) return undefined;
  if (candidate.startsWith("unix://")) {
    const socketPath = candidate.slice("unix://".length);
    if (path.isAbsolute(socketPath) && !socketPath.includes("\0")) return candidate;
  }
  if (/^tcp:\/\/[A-Za-z0-9_.-]+:[0-9]{1,5}$/.test(candidate)) return candidate;
  return undefined;
}

function compatGatewayBindAddress(env: NodeJS.ProcessEnv): string {
  const raw = String(env.NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_BIND_ADDRESS || "").trim();
  if (!raw) return DEFAULT_COMPAT_BIND_ADDRESS;
  if (raw === DEFAULT_COMPAT_BIND_ADDRESS || raw === LOOPBACK_BIND_ADDRESS) return raw;
  throw new Error(
    "Invalid NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_BIND_ADDRESS; expected 0.0.0.0 or 127.0.0.1.",
  );
}

export function buildDockerDriverGatewayLaunch(
  options: BuildGatewayLaunchOptions,
): DockerDriverGatewayLaunch {
  const gatewayEnv = { ...options.gatewayEnv };
  if (options.sandboxBin && !gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN) {
    gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN = options.sandboxBin;
  }
  const baseEnv = options.env ?? process.env;
  const compat = shouldUseContainerizedGateway(options);
  if (!compat.useContainer) {
    const env = { ...baseEnv, ...gatewayEnv };
    return {
      command: options.gatewayBin,
      args: [],
      env,
      mode: "host",
      processGatewayBin: options.gatewayBin,
    };
  }

  gatewayEnv.OPENSHELL_BIND_ADDRESS = compatGatewayBindAddress(baseEnv);
  const env = { ...baseEnv, ...gatewayEnv };
  const sandboxBin = options.sandboxBin || gatewayEnv.OPENSHELL_DOCKER_SUPERVISOR_BIN;
  if (!sandboxBin) {
    throw new Error(
      "OpenShell gateway container compatibility mode requires openshell-sandbox. " +
        "Re-run the NemoClaw installer or set NEMOCLAW_OPENSHELL_SANDBOX_BIN.",
    );
  }

  const image = safeDockerImage(env.NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_IMAGE, DEFAULT_COMPAT_IMAGE);
  const containerName = safeDockerName(
    env.NEMOCLAW_OPENSHELL_GATEWAY_COMPAT_CONTAINER_NAME,
    DEFAULT_COMPAT_CONTAINER_NAME,
  );
  const dockerHost = safeDockerHost(env.DOCKER_HOST);
  if (dockerHost) {
    env.DOCKER_HOST = dockerHost;
  } else {
    delete env.DOCKER_HOST;
  }
  const dockerSocket = getDockerSocketPath(env);
  const args = [
    "run",
    "--rm",
    "--name",
    containerName,
    "--network",
    "host",
  ];
  addVolume(args, path.resolve(options.gatewayBin), GATEWAY_MOUNT_PATH, "ro");
  addVolume(args, path.resolve(options.stateDir), path.resolve(options.stateDir), "rw");
  addVolume(args, path.resolve(path.dirname(sandboxBin)), path.resolve(path.dirname(sandboxBin)), "ro");
  if (fs.existsSync(dockerSocket)) addVolume(args, dockerSocket, dockerSocket, "rw");
  for (const key of Object.keys(gatewayEnv).sort()) {
    addEnv(args, key, gatewayEnv[key]);
  }
  addEnv(args, "DOCKER_HOST", dockerHost);
  addEnv(args, "RUST_LOG", env.RUST_LOG);
  args.push(image, GATEWAY_MOUNT_PATH);

  return {
    command: "docker",
    args,
    env,
    mode: "container",
    processGatewayBin: null,
    reason: compat.reason,
    containerName,
  };
}

export function prepareDockerDriverGatewayLaunch(launch: DockerDriverGatewayLaunch): void {
  if (launch.mode !== "container" || !launch.containerName) return;
  dockerForceRm(launch.containerName, {
    ignoreError: true,
    suppressOutput: true,
    timeout: 30_000,
  });
}

export function buildDockerDriverGatewayRuntimeIdentity(
  options: BuildGatewayLaunchOptions,
): DockerDriverGatewayRuntimeIdentity {
  const launch = buildDockerDriverGatewayLaunch(options);
  const desiredEnv =
    launch.mode === "container"
      ? {
          ...options.gatewayEnv,
          ...Object.fromEntries(
            Object.entries(launch.env).filter(
              ([key, val]) => key in options.gatewayEnv && typeof val === "string",
            ) as [string, string][],
          ),
        }
      : options.gatewayEnv;
  return {
    launch,
    desiredEnv,
    driftGatewayBin: launch.processGatewayBin,
    identityGatewayBin: launch.processGatewayBin || options.gatewayBin,
  };
}

export function prepareAndLogDockerDriverGatewayLaunch(
  launch: DockerDriverGatewayLaunch,
  log: (message: string) => void = console.log,
): void {
  if (launch.mode !== "container") return;
  log(`  OpenShell gateway compatibility patch active (${launch.reason}).`);
  log("  Running openshell-gateway inside a Docker compatibility container.");
  if (launch.env.OPENSHELL_BIND_ADDRESS === "0.0.0.0") {
    log("  Compatibility gateway bind: 0.0.0.0 (required for Docker sandbox callbacks).");
  }
  prepareDockerDriverGatewayLaunch(launch);
}
