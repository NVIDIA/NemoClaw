// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Docker-driver sandbox -> gateway reachability probe.
 *
 * OpenShell 0.0.39 moved local Docker sandboxes onto a managed bridge network
 * and gives real sandbox containers an explicit host.openshell.internal route.
 * This probe must mirror that route before it can make a useful firewall
 * diagnosis; a plain helper container on the bridge is not equivalent.
 */

import { dockerCapture, dockerRun } from "../adapters/docker/run";
import { GATEWAY_PORT } from "../core/ports";

const DEFAULT_PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const DEFAULT_NETWORK_NAME = "openshell-docker";
const HOST_INTERNAL_NAME = "host.openshell.internal";
const HOST_DOCKER_INTERNAL_NAME = "host.docker.internal";
const DEFAULT_PROBE_TIMEOUT_SEC = 5;
const PROBE_RUN_OVERHEAD_MS = 10_000;

export type SandboxBridgeReachabilityReason = "ok" | "tcp_failed" | "probe_unavailable";
export type SandboxBridgeRouteKind = "bridge_gateway" | "host_gateway";

export interface DockerBridgeNetworkInfo {
  subnet?: string;
  gatewayIp?: string;
}

export interface SandboxBridgeReachabilityResult {
  ok: boolean;
  reason: SandboxBridgeReachabilityReason;
  networkName?: string;
  subnet?: string;
  gatewayIp?: string;
  routeKind?: SandboxBridgeRouteKind;
  detail?: string;
}

interface SandboxBridgeProbeRunResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}

interface OpenShellDockerRoute {
  networkName: string;
  subnet?: string;
  gatewayIp?: string;
  routeKind: SandboxBridgeRouteKind;
  addHosts: string[];
}

export interface SandboxBridgeReachabilityOptions {
  networkName?: string;
  port?: number;
  timeoutSec?: number;
  probeImage?: string;
  runImpl?: (args: readonly string[], timeoutMs: number) => SandboxBridgeProbeRunResult;
  inspectNetworkImpl?: (networkName: string) => DockerBridgeNetworkInfo | undefined;
  usesHostGatewayRouteImpl?: () => boolean;
}

function parseDockerNetworkIpamConfig(raw: string): DockerBridgeNetworkInfo | undefined {
  const text = raw.trim();
  if (!text || text === "<no value>") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  const candidates: DockerBridgeNetworkInfo[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const subnet = typeof record.Subnet === "string" ? record.Subnet : undefined;
    const gatewayIp = typeof record.Gateway === "string" ? record.Gateway : undefined;
    if (subnet || gatewayIp) candidates.push({ subnet, gatewayIp });
  }
  return (
    candidates.find((candidate) => candidate.gatewayIp && !candidate.gatewayIp.includes(":")) ??
    candidates.find((candidate) => candidate.subnet && /^\d+\./.test(candidate.subnet)) ??
    candidates[0]
  );
}

function defaultInspectNetwork(networkName: string): DockerBridgeNetworkInfo | undefined {
  const raw = dockerCapture(
    ["network", "inspect", "--format", "{{json .IPAM.Config}}", networkName],
    { ignoreError: true },
  );
  return parseDockerNetworkIpamConfig(raw);
}

function defaultUsesHostGatewayRoute(): boolean {
  if (process.platform !== "linux") return true;
  const info = dockerCapture(
    ["info", "--format", "{{.OperatingSystem}}\n{{range .Labels}}{{.}}\n{{end}}"],
    { ignoreError: true },
  );
  return /Docker Desktop|com\.docker\.desktop\./i.test(info);
}

function defaultRunImpl(args: readonly string[], timeoutMs: number): SandboxBridgeProbeRunResult {
  const result = dockerRun(args, {
    timeout: timeoutMs,
    ignoreError: true,
    suppressOutput: true,
  });
  return {
    status: result.status ?? null,
    signal: result.signal,
    error: result.error?.message,
    stderr: result.stderr,
    stdout: result.stdout,
  };
}

function buildOpenShellDockerRoute(
  networkName: string,
  network: DockerBridgeNetworkInfo | undefined,
  usesHostGatewayRoute: boolean,
): OpenShellDockerRoute | undefined {
  if (!network) return undefined;
  if (usesHostGatewayRoute) {
    return {
      networkName,
      subnet: network.subnet,
      gatewayIp: network.gatewayIp,
      routeKind: "host_gateway",
      addHosts: [`${HOST_INTERNAL_NAME}:host-gateway`],
    };
  }
  if (!network.gatewayIp) return undefined;
  return {
    networkName,
    subnet: network.subnet,
    gatewayIp: network.gatewayIp,
    routeKind: "bridge_gateway",
    addHosts: [
      `${HOST_DOCKER_INTERNAL_NAME}:${network.gatewayIp}`,
      `${HOST_INTERNAL_NAME}:${network.gatewayIp}`,
    ],
  };
}

function outputTail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const text = raw.trim();
  return text ? text.slice(-400) : undefined;
}

function summarizeProbeResult(result: SandboxBridgeProbeRunResult): string {
  const details = [
    result.error,
    outputTail(result.stderr),
    outputTail(result.stdout),
    result.signal ? `signal ${result.signal}` : undefined,
    result.status !== null ? `exit ${result.status}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return details.length > 0 ? details.join(" | ") : "docker run did not complete the probe";
}

function isNameResolutionFailure(detail: string): boolean {
  return /bad address|name or service not known|temporary failure in name resolution|could not resolve|getaddrinfo/i.test(
    detail,
  );
}

function buildProbeArgs(
  route: OpenShellDockerRoute,
  probeImage: string,
  timeoutSec: number,
  port: number,
): string[] {
  const addHostArgs = route.addHosts.flatMap((host) => ["--add-host", host]);
  return [
    "run",
    "--rm",
    "--pull=missing",
    "--network",
    route.networkName,
    ...addHostArgs,
    probeImage,
    "sh",
    "-c",
    `nc -zw${timeoutSec} ${HOST_INTERNAL_NAME} ${port}`,
  ];
}

export async function isSandboxBridgeGatewayReachable(
  opts: SandboxBridgeReachabilityOptions = {},
): Promise<SandboxBridgeReachabilityResult> {
  const networkName =
    opts.networkName ?? process.env.OPENSHELL_DOCKER_NETWORK_NAME ?? DEFAULT_NETWORK_NAME;
  const port = opts.port ?? GATEWAY_PORT;
  const timeoutSec = opts.timeoutSec ?? DEFAULT_PROBE_TIMEOUT_SEC;
  const probeImage = opts.probeImage ?? DEFAULT_PROBE_IMAGE;
  const inspectNetwork = opts.inspectNetworkImpl ?? defaultInspectNetwork;
  const usesHostGatewayRoute = opts.usesHostGatewayRouteImpl ?? defaultUsesHostGatewayRoute;
  const runImpl = opts.runImpl ?? defaultRunImpl;

  const network = inspectNetwork(networkName);
  const route = buildOpenShellDockerRoute(networkName, network, usesHostGatewayRoute());
  if (!route) {
    return {
      ok: false,
      reason: "probe_unavailable",
      networkName,
      subnet: network?.subnet,
      gatewayIp: network?.gatewayIp,
      detail: network
        ? `Docker network "${networkName}" does not expose an IPv4 gateway for the OpenShell route`
        : `Docker network "${networkName}" not found`,
    };
  }

  const result = runImpl(
    buildProbeArgs(route, probeImage, timeoutSec, port),
    timeoutSec * 1000 + PROBE_RUN_OVERHEAD_MS,
  );
  if (result.status === 0) {
    return {
      ok: true,
      reason: "ok",
      networkName,
      subnet: route.subnet,
      gatewayIp: route.gatewayIp,
      routeKind: route.routeKind,
    };
  }

  const detail = summarizeProbeResult(result);
  if (result.status !== 1 || isNameResolutionFailure(detail)) {
    return {
      ok: false,
      reason: "probe_unavailable",
      networkName,
      subnet: route.subnet,
      gatewayIp: route.gatewayIp,
      routeKind: route.routeKind,
      detail,
    };
  }

  return {
    ok: false,
    reason: "tcp_failed",
    networkName,
    subnet: route.subnet,
    gatewayIp: route.gatewayIp,
    routeKind: route.routeKind,
    detail: `sandbox container on "${networkName}" could not reach ${HOST_INTERNAL_NAME}:${port}`,
  };
}

export function formatSandboxBridgeUnreachableMessage(
  result: SandboxBridgeReachabilityResult,
  port: number = GATEWAY_PORT,
): string {
  if (result.ok) return "";
  if (result.reason === "probe_unavailable") {
    return [
      "  ⚠ Could not verify sandbox bridge reachability.",
      "    This does not prove the gateway is unreachable; continuing.",
      result.detail ? `    ${result.detail}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  if (result.routeKind === "host_gateway") {
    return [
      `  ✗ Sandbox containers cannot reach the gateway at ${HOST_INTERNAL_NAME}:${port}.`,
      "    The probe used Docker's host-gateway route, matching Docker Desktop/VM-backed Docker.",
      "    Restart Docker and the OpenShell gateway, then re-run `nemoclaw onboard`.",
    ].join("\n");
  }

  const allowCmd = result.subnet
    ? `      sudo ufw allow from ${result.subnet} to any port ${port} proto tcp`
    : [
        `      SUBNET=$(docker network inspect ${result.networkName ?? DEFAULT_NETWORK_NAME} --format '{{(index .IPAM.Config 0).Subnet}}')`,
        `      sudo ufw allow from "$SUBNET" to any port ${port} proto tcp`,
      ].join("\n");
  const target = result.gatewayIp
    ? `${HOST_INTERNAL_NAME}:${port} (${result.gatewayIp}:${port})`
    : `${HOST_INTERNAL_NAME}:${port}`;
  return [
    `  ✗ Sandbox containers cannot reach the gateway at ${target}.`,
    "    A host firewall may be blocking traffic from the OpenShell Docker bridge.",
    "    To allow it:",
    allowCmd,
    "    Then re-run `nemoclaw onboard`.",
  ].join("\n");
}

export async function verifySandboxBridgeGatewayReachableOrExit(
  exitOnFailure: boolean,
  options: { skip?: boolean } = {},
): Promise<void> {
  if (options.skip) {
    console.log("  Docker-driver GPU host networking active; skipping sandbox bridge gateway reachability probe.");
    return;
  }
  const reach = await isSandboxBridgeGatewayReachable();
  if (reach.ok) return;

  const message = formatSandboxBridgeUnreachableMessage(reach);
  if (reach.reason === "probe_unavailable") {
    console.warn(message);
    return;
  }

  console.error(message);
  if (exitOnFailure) {
    process.exit(1);
  }
  throw new Error(`Docker-driver sandbox-bridge unreachable (${reach.reason})`);
}

export const __test = {
  buildOpenShellDockerRoute,
  buildProbeArgs,
  parseDockerNetworkIpamConfig,
};
