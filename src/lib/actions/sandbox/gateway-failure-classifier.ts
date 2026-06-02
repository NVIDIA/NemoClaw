// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

import { dockerInfo } from "../../adapters/docker/info";
import { dockerCapture } from "../../adapters/docker/run";
import { CLI_NAME } from "../../cli/branding";
import { GATEWAY_PORT } from "../../core/ports";
import * as registry from "../../state/registry";
import { resolveSandboxContainerOwner } from "./sandbox-container-owner";

const DEFAULT_CONTAINER = "openshell-cluster-nemoclaw";
const DOCKER_TIMEOUT_MS = 3000;
const PORT_PROBE_TIMEOUT_MS = 2000;

export type GatewayFailureLayer =
  | "docker_unreachable"
  | "container_missing"
  | "container_exited_port_conflict"
  | "container_exited"
  | "gateway_unreachable"
  | "sandbox_container_stopped"
  | "sandbox_dashboard_port_conflict";

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

export type SandboxContainerFailureLayer =
  | "sandbox_container_stopped"
  | "sandbox_dashboard_port_conflict";

export type SandboxContainerFailureResult = {
  layer: SandboxContainerFailureLayer;
  detail: string;
};

export type SandboxContainerFailureRunners = {
  listAllContainerNames: () => string;
  listRunningContainerNames: () => string;
  listSandboxNames: () => string[];
  portProbe: (port: number) => Promise<boolean>;
};

function defaultDockerInfo(): boolean {
  return dockerInfo({ ignoreError: true, timeout: DOCKER_TIMEOUT_MS }).length > 0;
}

export function isDockerDaemonReachable(): boolean {
  return defaultDockerInfo();
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
  sandbox_container_stopped:
    "Failure layer: sandbox_container_stopped — sandbox container exists but is not running.",
  sandbox_dashboard_port_conflict:
    "Failure layer: sandbox_dashboard_port_conflict — sandbox container is stopped and the dashboard port is held by a foreign listener.",
};

export function getLayerHeader(layer: GatewayFailureLayer): string {
  return LAYER_HEADERS[layer];
}

function defaultListAllContainerNames(): string {
  return dockerCapture(["ps", "-a", "--format", "{{.Names}}"], {
    ignoreError: true,
    timeout: DOCKER_TIMEOUT_MS,
  });
}

function defaultListRunningContainerNames(): string {
  return dockerCapture(["ps", "--format", "{{.Names}}"], {
    ignoreError: true,
    timeout: DOCKER_TIMEOUT_MS,
  });
}

function defaultListSandboxNames(): string[] {
  try {
    return registry.listSandboxes().sandboxes.map((entry) => entry.name);
  } catch {
    return [];
  }
}

const defaultSandboxContainerRunners: SandboxContainerFailureRunners = {
  listAllContainerNames: defaultListAllContainerNames,
  listRunningContainerNames: defaultListRunningContainerNames,
  listSandboxNames: defaultListSandboxNames,
  portProbe: defaultPortProbe,
};

function isValidDashboardPort(port: number | null | undefined): port is number {
  return (
    typeof port === "number" && Number.isInteger(port) && port >= 1 && port <= 65535
  );
}

export async function classifySandboxContainerFailure(
  sandboxName: string,
  opts: {
    dashboardPort?: number | null;
    runners?: SandboxContainerFailureRunners;
  } = {},
): Promise<SandboxContainerFailureResult | null> {
  const runners = opts.runners ?? defaultSandboxContainerRunners;
  const registeredSandboxNames = runners.listSandboxNames();
  const running = resolveSandboxContainerOwner(
    runners.listRunningContainerNames(),
    sandboxName,
    registeredSandboxNames,
  );
  if (running) return null;
  const present = resolveSandboxContainerOwner(
    runners.listAllContainerNames(),
    sandboxName,
    registeredSandboxNames,
  );
  if (!present) return null;
  const dashboardPort = opts.dashboardPort;
  if (isValidDashboardPort(dashboardPort) && (await runners.portProbe(dashboardPort))) {
    return {
      layer: "sandbox_dashboard_port_conflict",
      detail: `Sandbox container '${present}' is stopped and dashboard port ${dashboardPort} is held by another process.`,
    };
  }
  return {
    layer: "sandbox_container_stopped",
    detail: `Sandbox container '${present}' exists but is not running.`,
  };
}

type SandboxDriverLookup = (
  name: string,
) => { openshellDriver?: string | null } | null | undefined;

// Drivers whose sandbox runtime does NOT live in the local Docker daemon. Only
// `vm` qualifies: the NemoClaw gateway always runs as the local Docker
// container `openshell-cluster-nemoclaw` (see classifyGatewayFailure), so the
// `docker` driver and the `kubernetes`/k3s driver (k3s-in-Docker, or Docker
// Desktop's Kubernetes — selected by `isLinuxDockerDriverGatewayEnabled()` for
// non-Linux/non-arm64 hosts) both depend on a reachable local Docker daemon. A
// `vm` sandbox runs in a real VM with no local Docker daemon, so a failing
// `docker info` is normal and must not trigger the outage preflight.
const NON_DOCKER_DRIVERS = new Set(["vm"]);

/**
 * Whether a sandbox's runtime depends on the local Docker daemon. Only the
 * explicit `vm` driver is excluded. The `docker` and `kubernetes` drivers are
 * Docker-backed, and legacy/recovered registry entries that predate
 * `openshellDriver` metadata (field omitted/null) are also treated as
 * Docker-backed so the outage guard still protects the Linux/Docker sandboxes
 * #4428 targets — the historical default driver was Docker. The narrow cost is
 * that a recovered `vm` entry that lost its driver metadata could see Docker
 * guidance on a Docker-less host; that is preferable to silently regressing
 * every legacy Docker sandbox. (#4428)
 */
function isDockerBackedSandbox(
  sandboxName: string,
  getSandbox: SandboxDriverLookup,
): boolean {
  const driver = getSandbox(sandboxName)?.openshellDriver;
  return !(typeof driver === "string" && NON_DOCKER_DRIVERS.has(driver.toLowerCase()));
}

/**
 * Synchronous Docker daemon reachability check for a specific sandbox (the
 * `docker_unreachable` layer of {@link classifyGatewayFailure}). Sandbox
 * commands use this as a fast preflight so a transient Docker daemon outage is
 * classified as a host runtime problem rather than a stuck sandbox phase or a
 * connect timeout (#4428). Returns `false` for VM sandboxes so they are never
 * misclassified. `docker info` is a `spawnSync` call, so this stays synchronous
 * and can run from non-async call sites such as `logs` and `policy-list`.
 */
export function isDockerRuntimeDown(
  sandboxName: string,
  opts?: {
    runners?: Pick<GatewayFailureRunners, "dockerInfo">;
    getSandbox?: SandboxDriverLookup;
  },
): boolean {
  const getSandbox = opts?.getSandbox ?? registry.getSandbox;
  if (!isDockerBackedSandbox(sandboxName, getSandbox)) return false;
  const probe = opts?.runners?.dockerInfo ?? defaultRunners.dockerInfo;
  return !probe();
}

/**
 * Print actionable recovery guidance for a Docker daemon outage. Deliberately
 * never recommends rebuild/destroy/onboard: when Docker is down the sandbox
 * itself is fine and recreating it cannot succeed until the daemon is back
 * (#4428). Shared by status, connect, logs, and policy-list so the outage is
 * named consistently as a host runtime problem.
 */
export function printDockerRuntimeDownGuidance(
  sandboxName: string,
  opts: { writer?: (message: string) => void; retryCommand?: string } = {},
): void {
  const writer = opts.writer ?? console.error;
  const retryCommand = opts.retryCommand ?? "status";
  writer(`  ${getLayerHeader("docker_unreachable")}`);
  writer(
    `  The Docker daemon is not reachable, so sandbox '${sandboxName}' cannot be verified or started.`,
  );
  writer(
    "  This is a Docker runtime outage on the host, not a sandbox failure — do not rebuild, destroy, or re-onboard the sandbox.",
  );
  writer("  Recovery:");
  writer(
    "    1. Start the Docker daemon (e.g. `sudo systemctl start docker`, or start Docker Desktop).",
  );
  writer("    2. Confirm it is back with `docker info`.");
  writer(`    3. Retry: ${CLI_NAME} ${sandboxName} ${retryCommand}`);
}
