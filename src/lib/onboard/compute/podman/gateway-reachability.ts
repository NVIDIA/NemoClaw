// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type SpawnSyncOptions, spawnSync } from "node:child_process";
import path from "node:path";

const DEFAULT_PROBE_IMAGE =
  "docker.io/library/busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const DEFAULT_NETWORK_NAME = "openshell";
const PODMAN_HOST_INTERNAL_NAME = "host.containers.internal";
const DEFAULT_TIMEOUT_SECONDS = 5;
const PROBE_OVERHEAD_MS = 10_000;

interface PodmanProbeResult {
  readonly error?: Error;
  readonly status: number | null;
  readonly stderr?: Buffer | string | null;
  readonly stdout?: Buffer | string | null;
}

type SpawnSyncLike = (
  command: string,
  args: string[],
  options: SpawnSyncOptions,
) => PodmanProbeResult;

export interface PodmanGatewayReachabilityOptions {
  readonly exitProcess?: (code: number) => never;
  readonly networkName?: string;
  readonly podmanBin?: string;
  readonly podmanSocketPath?: string;
  readonly port: number;
  readonly probeImage?: string;
  readonly probeName?: string;
  readonly redact: (value: string) => string;
  readonly skip?: boolean;
  readonly spawnSyncImpl?: SpawnSyncLike;
  readonly timeoutSeconds?: number;
}

function output(value: Buffer | string | null | undefined): string {
  if (typeof value === "string") return value;
  return Buffer.isBuffer(value) ? value.toString("utf-8") : "";
}

function boundedDetail(
  result: PodmanProbeResult,
  redact: PodmanGatewayReachabilityOptions["redact"],
): string {
  return redact(
    [result.error?.message, output(result.stderr), output(result.stdout)]
      .filter((value): value is string => Boolean(value?.trim()))
      .join(" | ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(-500),
  );
}

function podmanSocketUrl(socketPath: string): string {
  const normalized = socketPath.trim();
  if (!path.isAbsolute(normalized) || /[\0\r\n]/.test(normalized)) {
    throw new Error("Podman gateway reachability requires a safe absolute Podman socket path");
  }
  return `unix://${normalized}`;
}

export function buildPodmanGatewayProbeArgs(options: {
  readonly networkName: string;
  readonly podmanSocketPath: string;
  readonly port: number;
  readonly probeImage: string;
  readonly probeName: string;
  readonly timeoutSeconds: number;
}): string[] {
  return [
    "--url",
    podmanSocketUrl(options.podmanSocketPath),
    "run",
    "--rm",
    "--name",
    options.probeName,
    "--pull=missing",
    "--network",
    options.networkName,
    options.probeImage,
    "sh",
    "-c",
    `nc -zw${options.timeoutSeconds} ${PODMAN_HOST_INTERNAL_NAME} ${options.port}`,
  ];
}

function helperUnavailable(
  result: PodmanProbeResult,
  redact: PodmanGatewayReachabilityOptions["redact"],
): boolean {
  const detail = boundedDetail(result, redact);
  return (
    result.status === 125 &&
    /image.*(pull|not known|not found)|manifest unknown|pull access denied|initializing source docker|pinging container registry|registry.*(?:timeout|unavailable)|tls handshake timeout/i.test(
      detail,
    )
  );
}

export async function verifyPodmanSandboxGatewayReachableOrExit(
  exitOnFailure: boolean,
  options: PodmanGatewayReachabilityOptions,
): Promise<void> {
  if (options.skip) {
    console.log("  Skipping Podman sandbox-to-gateway reachability probe.");
    return;
  }
  const podmanSocketPath =
    options.podmanSocketPath ?? process.env.OPENSHELL_PODMAN_SOCKET?.trim() ?? "";
  const port = options.port;
  const timeoutSeconds = Math.max(1, options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS);
  const probeName =
    options.probeName ?? `nemoclaw-gateway-probe-${process.pid}-${Date.now().toString(36)}`;
  const podmanBin = options.podmanBin ?? process.env.NEMOCLAW_PODMAN_BIN?.trim() ?? "podman";
  const spawn = options.spawnSyncImpl ?? spawnSync;
  const socketUrl = podmanSocketUrl(podmanSocketPath);
  const result = spawn(
    podmanBin,
    buildPodmanGatewayProbeArgs({
      networkName: options.networkName ?? DEFAULT_NETWORK_NAME,
      podmanSocketPath,
      port,
      probeImage: options.probeImage ?? DEFAULT_PROBE_IMAGE,
      probeName,
      timeoutSeconds,
    }),
    {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutSeconds * 1000 + PROBE_OVERHEAD_MS,
    },
  );
  if (result.status === 0) return;

  spawn(podmanBin, ["--url", socketUrl, "rm", "--force", probeName], {
    encoding: "utf-8",
    stdio: "ignore",
    timeout: PROBE_OVERHEAD_MS,
  });
  const detail = boundedDetail(result, options.redact);
  if (helperUnavailable(result, options.redact)) {
    console.warn(
      `  Could not verify the Podman sandbox route to ${PODMAN_HOST_INTERNAL_NAME}:${port}; continuing because the probe helper was unavailable${detail ? ` (${detail})` : ""}.`,
    );
    return;
  }

  const message = `Podman sandbox containers cannot reach the OpenShell gateway at ${PODMAN_HOST_INTERNAL_NAME}:${port}${detail ? ` (${detail})` : ""}.`;
  console.error(`  ${message}`);
  if (exitOnFailure) (options.exitProcess ?? process.exit)(1);
  throw new Error(message);
}
