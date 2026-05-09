// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import { execSync } from "node:child_process";

import { GATEWAY_PORT } from "../../core/ports";

const DEFAULT_CONTAINER = "openshell-cluster-nemoclaw";
const DOCKER_TIMEOUT_MS = 3000;
const PORT_PROBE_TIMEOUT_MS = 2000;

export type GatewayFailureLayer =
  | "docker_unreachable"
  | "container_exited_port_conflict"
  | "container_exited"
  | "gateway_unreachable";

export type GatewayFailureResult = {
  layer: GatewayFailureLayer;
  detail: string;
};

export type GatewayFailureRunners = {
  dockerInfo: () => boolean;
  dockerIsRunning: (container: string) => boolean;
  portProbe: (port: number) => Promise<boolean>;
};

function defaultDockerInfo(): boolean {
  try {
    execSync("docker info", { timeout: DOCKER_TIMEOUT_MS, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function defaultDockerIsRunning(container: string): boolean {
  try {
    const out = execSync(`docker ps --filter name=${container} --format "{{.Names}}"`, {
      timeout: DOCKER_TIMEOUT_MS,
      stdio: "pipe",
      encoding: "utf-8",
    });
    return out.trim().split("\n").some((line) => line.trim() === container);
  } catch {
    return false;
  }
}

function defaultPortProbe(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = net.connect({ host: "127.0.0.1", port }, () => {
      sock.destroy();
      resolve(true);
    });
    sock.setTimeout(PORT_PROBE_TIMEOUT_MS);
    sock.on("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.on("error", () => {
      resolve(false);
    });
  });
}

const defaultRunners: GatewayFailureRunners = {
  dockerInfo: defaultDockerInfo,
  dockerIsRunning: defaultDockerIsRunning,
  portProbe: defaultPortProbe,
};

export async function classifyGatewayFailure(
  _sandboxName: string,
  opts?: { runners?: GatewayFailureRunners },
): Promise<GatewayFailureResult> {
  const runners = opts?.runners ?? defaultRunners;

  if (!runners.dockerInfo()) {
    return {
      layer: "docker_unreachable",
      detail: "Docker daemon is not reachable (docker info failed or timed out).",
    };
  }

  const containerRunning = runners.dockerIsRunning(DEFAULT_CONTAINER);

  if (!containerRunning) {
    const portInUse = await runners.portProbe(GATEWAY_PORT);
    if (portInUse) {
      return {
        layer: "container_exited_port_conflict",
        detail: `Container '${DEFAULT_CONTAINER}' is not running, but port ${GATEWAY_PORT} is held by another process.`,
      };
    }
    return {
      layer: "container_exited",
      detail: `Container '${DEFAULT_CONTAINER}' is not running.`,
    };
  }

  return {
    layer: "gateway_unreachable",
    detail: `Container '${DEFAULT_CONTAINER}' is running but the gateway API is not responding.`,
  };
}

const LAYER_HEADERS: Record<GatewayFailureLayer, string> = {
  docker_unreachable: "Failure layer: docker_unreachable — Docker daemon is not reachable.",
  container_exited_port_conflict:
    "Failure layer: container_exited_port_conflict — container stopped, gateway port held by foreign process.",
  container_exited: "Failure layer: container_exited — container is not running.",
  gateway_unreachable:
    "Failure layer: gateway_unreachable — container running but gateway API unresponsive.",
};

export function getLayerHeader(layer: GatewayFailureLayer): string {
  return LAYER_HEADERS[layer];
}
