// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { dockerInfo } from "../../adapters/docker/info";
import { dockerCapture } from "../../adapters/docker/run";
import { GATEWAY_PORT } from "../../core/ports";

const DEFAULT_CONTAINER = "openshell-cluster-nemoclaw";
const DOCKER_TIMEOUT_MS = 3000;
const PORT_PROBE_TIMEOUT_MS = 2000;

export type GatewayFailureLayer =
  | "docker_unreachable"
  | "container_missing"
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
  dockerExists: (container: string) => boolean;
  portProbe: (port: number) => Promise<boolean>;
};

function defaultDockerInfo(): boolean {
  return dockerInfo({ ignoreError: true, timeout: DOCKER_TIMEOUT_MS }).length > 0;
}

function dockerContainerListed(container: string, allFlag: boolean): boolean {
  const args = ["ps"];
  if (allFlag) args.push("-a");
  args.push("--filter", `name=${container}`, "--format", "{{.Names}}");
  const out = dockerCapture(args, { ignoreError: true, timeout: DOCKER_TIMEOUT_MS });
  return out.split("\n").some((line) => line.trim() === container);
}

function defaultDockerIsRunning(container: string): boolean {
  return dockerContainerListed(container, false);
}

function defaultDockerExists(container: string): boolean {
  return dockerContainerListed(container, true);
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
  dockerExists: defaultDockerExists,
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

  if (runners.dockerIsRunning(DEFAULT_CONTAINER)) {
    return {
      layer: "gateway_unreachable",
      detail: `Container '${DEFAULT_CONTAINER}' is running but the gateway API is not responding.`,
    };
  }

  // Container is not running. Distinguish "exited and still present" from
  // "removed/never created" — only the former can hit container_exited*. Per
  // issue #3271 AC: container_exited_port_conflict requires `docker ps -a` to
  // confirm the container exited rather than being absent.
  if (!runners.dockerExists(DEFAULT_CONTAINER)) {
    return {
      layer: "container_missing",
      detail: `Container '${DEFAULT_CONTAINER}' is not present (never created or removed).`,
    };
  }

  const portInUse = await runners.portProbe(GATEWAY_PORT);
  if (portInUse) {
    return {
      layer: "container_exited_port_conflict",
      detail: `Container '${DEFAULT_CONTAINER}' exited, and port ${GATEWAY_PORT} is held by another process.`,
    };
  }
  return {
    layer: "container_exited",
    detail: `Container '${DEFAULT_CONTAINER}' exited.`,
  };
}

const LAYER_HEADERS: Record<GatewayFailureLayer, string> = {
  docker_unreachable: "Failure layer: docker_unreachable — Docker daemon is not reachable.",
  container_missing:
    "Failure layer: container_missing — gateway container is not present; recreate the sandbox.",
  container_exited_port_conflict:
    "Failure layer: container_exited_port_conflict — container exited, gateway port held by foreign process.",
  container_exited: "Failure layer: container_exited — container exited.",
  gateway_unreachable:
    "Failure layer: gateway_unreachable — container running but gateway API unresponsive.",
};

export function getLayerHeader(layer: GatewayFailureLayer): string {
  return LAYER_HEADERS[layer];
}
