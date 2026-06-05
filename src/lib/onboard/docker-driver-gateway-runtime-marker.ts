// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const DOCKER_DRIVER_GATEWAY_RUNTIME_MARKER_VERSION = 1;

export type DockerDriverGatewayRuntimeMarker = {
  version: typeof DOCKER_DRIVER_GATEWAY_RUNTIME_MARKER_VERSION;
  pid: number;
  driver: "docker";
  platform: NodeJS.Platform;
  arch: NodeJS.Architecture;
  endpoint: string;
  desiredEnvHash: string;
  gatewayBin: string | null;
  openshellVersion: string | null;
  dockerHost: string | null;
  createdAt: string;
};

export type DockerDriverGatewayRuntimeMarkerInput = {
  pid: number;
  desiredEnv: Record<string, string>;
  endpoint: string;
  gatewayBin?: string | null;
  openshellVersion?: string | null;
  dockerHost?: string | null;
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  createdAt?: string;
};

export type DockerDriverGatewayRuntimeMarkerDrift = { reason: string };

export function hashDockerDriverGatewayEnv(env: Record<string, string>): string {
  const stablePairs = Object.keys(env)
    .sort()
    .map((key) => [key, env[key]] as const);
  return crypto.createHash("sha256").update(JSON.stringify(stablePairs)).digest("hex");
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = String(value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeGatewayBin(value: string | null | undefined): string | null {
  const normalized = normalizeOptionalString(value);
  if (!normalized) return null;
  try {
    return fs.realpathSync.native(normalized);
  } catch {
    return path.resolve(normalized);
  }
}

export function buildDockerDriverGatewayRuntimeMarker({
  pid,
  desiredEnv,
  endpoint,
  gatewayBin = null,
  openshellVersion = null,
  dockerHost = null,
  platform = process.platform,
  arch = process.arch,
  createdAt = new Date().toISOString(),
}: DockerDriverGatewayRuntimeMarkerInput): DockerDriverGatewayRuntimeMarker {
  return {
    version: DOCKER_DRIVER_GATEWAY_RUNTIME_MARKER_VERSION,
    pid,
    driver: "docker",
    platform,
    arch,
    endpoint,
    desiredEnvHash: hashDockerDriverGatewayEnv(desiredEnv),
    gatewayBin: normalizeGatewayBin(gatewayBin),
    openshellVersion: normalizeOptionalString(openshellVersion),
    dockerHost: normalizeOptionalString(dockerHost),
    createdAt,
  };
}

function isRuntimeMarker(value: unknown): value is DockerDriverGatewayRuntimeMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<DockerDriverGatewayRuntimeMarker>;
  return (
    marker.version === DOCKER_DRIVER_GATEWAY_RUNTIME_MARKER_VERSION &&
    marker.driver === "docker" &&
    Number.isInteger(marker.pid) &&
    typeof marker.platform === "string" &&
    typeof marker.arch === "string" &&
    typeof marker.endpoint === "string" &&
    typeof marker.desiredEnvHash === "string" &&
    (typeof marker.gatewayBin === "string" || marker.gatewayBin === null) &&
    (typeof marker.openshellVersion === "string" || marker.openshellVersion === null) &&
    (typeof marker.dockerHost === "string" || marker.dockerHost === null) &&
    typeof marker.createdAt === "string"
  );
}

export function parseDockerDriverGatewayRuntimeMarker(
  raw: string,
): DockerDriverGatewayRuntimeMarker | null {
  try {
    const parsed = JSON.parse(raw);
    return isRuntimeMarker(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readDockerDriverGatewayRuntimeMarker(
  markerPath: string,
): DockerDriverGatewayRuntimeMarker | null {
  try {
    return parseDockerDriverGatewayRuntimeMarker(fs.readFileSync(markerPath, "utf-8"));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return null;
    }
    return null;
  }
}

export function writeDockerDriverGatewayRuntimeMarker(
  markerPath: string,
  marker: DockerDriverGatewayRuntimeMarker,
): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  fs.chmodSync(markerPath, 0o600);
}

export function getDockerDriverGatewayRuntimeMarkerPath(stateDir: string): string {
  return path.join(stateDir, "runtime.json");
}

export function clearDockerDriverGatewayRuntimeMarker(stateDir: string): void {
  fs.rmSync(getDockerDriverGatewayRuntimeMarkerPath(stateDir), { force: true });
}

export function writeDockerDriverGatewayPidFile(pidFile: string, pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(pidFile, `${pid}\n`, { encoding: "utf-8", mode: 0o600 });
}

export function writeDockerDriverGatewayRuntimeMarkerForStateDir(
  stateDir: string,
  input: DockerDriverGatewayRuntimeMarkerInput,
): void {
  writeDockerDriverGatewayRuntimeMarker(
    getDockerDriverGatewayRuntimeMarkerPath(stateDir),
    buildDockerDriverGatewayRuntimeMarker(input),
  );
}

export function getDockerDriverGatewayRuntimeMarkerDrift(
  marker: DockerDriverGatewayRuntimeMarker | null,
  expected: DockerDriverGatewayRuntimeMarkerInput,
): DockerDriverGatewayRuntimeMarkerDrift | null {
  if (!marker) return { reason: "missing Docker-driver runtime marker" };
  const desired = buildDockerDriverGatewayRuntimeMarker(expected);
  if (marker.pid !== desired.pid) return { reason: `runtime marker pid=${marker.pid} (expected ${desired.pid})` };
  if (marker.driver !== "docker") return { reason: `runtime marker driver=${marker.driver}` };
  if (marker.platform !== desired.platform) {
    return { reason: `runtime marker platform=${marker.platform} (expected ${desired.platform})` };
  }
  if (marker.arch !== desired.arch) {
    return { reason: `runtime marker arch=${marker.arch} (expected ${desired.arch})` };
  }
  if (marker.endpoint !== desired.endpoint) {
    return { reason: `runtime marker endpoint=${marker.endpoint} (expected ${desired.endpoint})` };
  }
  if (marker.desiredEnvHash !== desired.desiredEnvHash) {
    return { reason: "runtime marker env hash does not match desired Docker-driver env" };
  }
  if (marker.gatewayBin !== desired.gatewayBin) {
    return { reason: `runtime marker gateway=${marker.gatewayBin || "<unset>"} (expected ${desired.gatewayBin || "<unset>"})` };
  }
  if (expected.openshellVersion !== undefined && marker.openshellVersion !== desired.openshellVersion) {
    return {
      reason: `runtime marker openshell=${marker.openshellVersion || "<unknown>"} (expected ${desired.openshellVersion || "<unknown>"})`,
    };
  }
  if (marker.dockerHost !== desired.dockerHost) {
    return {
      reason: `runtime marker DOCKER_HOST=${marker.dockerHost || "<unset>"} (expected ${desired.dockerHost || "<unset>"})`,
    };
  }
  return null;
}

export function getDockerDriverGatewayRuntimeMarkerDriftForStateDir(
  stateDir: string,
  expected: DockerDriverGatewayRuntimeMarkerInput,
): DockerDriverGatewayRuntimeMarkerDrift | null {
  return getDockerDriverGatewayRuntimeMarkerDrift(
    readDockerDriverGatewayRuntimeMarker(getDockerDriverGatewayRuntimeMarkerPath(stateDir)),
    expected,
  );
}
