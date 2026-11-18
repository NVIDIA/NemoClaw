// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Check host-service TCP reachability from the caller's runtime network.
 * Attached llama.cpp selects native supervisor networking on Linux Docker.
 * Existing bridge callers retain their network and firewall diagnostics.
 */

import {
  DEFAULT_DOCKER_DRIVER_NETWORK_NAME,
  parseDockerNetworkIpamEntries,
  resolveDockerDriverNetworkName,
} from "./experimental/docker-network-authority";
import {
  isPortableExperimentalProfile,
  PORTABLE_HOST_GATEWAY_IP,
} from "./experimental/portable-profile";
import type { RuntimeProviderGatewayHostRuntime } from "./runtime-provider/contract";
import { observeConfiguredGatewayHostRuntime } from "./docker-driver-gateway-env";
export { formatHostServiceUnreachableMessage } from "./reachability/host-service-message";

export const DEFAULT_PROBE_NETWORK = DEFAULT_DOCKER_DRIVER_NETWORK_NAME;
const HOST_INTERNAL_NAME = "host.openshell.internal";
// Pinned busybox digest — same image used by the gateway bridge probe so
// it is likely already pulled and avoids a redundant registry fetch.
const PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const PROBE_TIMEOUT_SEC = 5;
const PROBE_OVERHEAD_MS = 10_000;

export type HostServiceReachabilityReason = "ok" | "tcp_failed" | "probe_unavailable";

export interface HostServiceReachabilityResult {
  ok: boolean;
  reason: HostServiceReachabilityReason;
  // The probe always records the port it tested; it is optional on the type so
  // callers (and the Ollama wrapper, whose formatter takes an explicit port)
  // can construct result literals without it.
  port?: number;
  networkName: string;
  subnet?: string;
  gatewayIp?: string;
  detail?: string;
}

interface ProbeRunResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stderr?: string | Buffer | null;
}

export interface HostServiceReachabilityOptions {
  port: number;
  /** Attached llama.cpp uses the native Docker supervisor's host network. */
  nativeSupervisorNetwork?: boolean;
  networkName?: string;
  timeoutSec?: number;
  probeImage?: string;
  runImpl?: (args: readonly string[], timeoutMs: number) => ProbeRunResult;
  inspectNetworkImpl?: (networkName: string) => { subnet?: string; gatewayIp?: string } | undefined;
  usesHostGatewayRouteImpl?: () => boolean;
  platform?: NodeJS.Platform;
  gatewayRuntime?: RuntimeProviderGatewayHostRuntime;
}

function parseNetworkIpamConfig(raw: string): { subnet?: string; gatewayIp?: string } | undefined {
  for (const entry of parseDockerNetworkIpamEntries(raw) ?? []) {
    const { subnet, gatewayIp } = entry;
    if (gatewayIp && !gatewayIp.includes(":")) return { subnet, gatewayIp };
  }
  return undefined;
}

function outputTail(value: unknown): string | undefined {
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : value == null ? "" : String(value);
  const text = raw.trim();
  return text ? text.slice(-400) : undefined;
}

function isNameResolutionFailure(detail: string): boolean {
  return /bad address|name or service not known|temporary failure in name resolution|could not resolve|getaddrinfo/i.test(
    detail,
  );
}

export async function probeHostServiceSandboxReachability(
  opts: HostServiceReachabilityOptions,
): Promise<HostServiceReachabilityResult> {
  const port = opts.port;
  const timeoutSec = opts.timeoutSec ?? PROBE_TIMEOUT_SEC;
  const probeImage = opts.probeImage ?? PROBE_IMAGE;

  const portableProfile = isPortableExperimentalProfile();
  const platform = opts.platform ?? process.platform;
  const managedGatewayRuntime =
    opts.gatewayRuntime ??
    observeConfiguredGatewayHostRuntime({ environment: process.env, platform });
  const inspectNetwork = opts.inspectNetworkImpl ?? managedGatewayRuntime.network.inspect;
  const usesHostGatewayRoute =
    opts.usesHostGatewayRouteImpl ?? managedGatewayRuntime.network.usesHostGatewayRoute;
  const runImpl = opts.runImpl ?? managedGatewayRuntime.network.run;
  const supervisorNetwork =
    opts.nativeSupervisorNetwork === true &&
    !managedGatewayRuntime.usesHostGatewayRoute &&
    !usesHostGatewayRoute()
      ? managedGatewayRuntime.network.supervisorNetwork
      : undefined;
  const networkName = supervisorNetwork
    ? supervisorNetwork.name
    : (opts.networkName ?? resolveDockerDriverNetworkName());
  const network = supervisorNetwork
    ? { gatewayIp: supervisorNetwork.hostAddress, subnet: undefined }
    : inspectNetwork(networkName);
  if (!network) {
    return {
      ok: false,
      reason: "probe_unavailable",
      port,
      networkName,
      detail: `Runtime network "${networkName}" not found`,
    };
  }
  const providerHostAddress = portableProfile
    ? PORTABLE_HOST_GATEWAY_IP
    : managedGatewayRuntime.sandboxHostAddress;
  const isHostGateway =
    providerHostAddress === null &&
    (managedGatewayRuntime.usesHostGatewayRoute === true || usesHostGatewayRoute());
  const usesNonBridgeRoute = providerHostAddress !== null || isHostGateway;

  if (!usesNonBridgeRoute && !network.gatewayIp) {
    return {
      ok: false,
      reason: "probe_unavailable",
      port,
      networkName,
      subnet: network.subnet,
      detail: `Docker network "${networkName}" has no IPv4 gateway`,
    };
  }

  const hostInternalTarget = providerHostAddress
    ? providerHostAddress
    : isHostGateway
      ? "host-gateway"
      : (network.gatewayIp as string);

  const probeArgs = [
    "run",
    "--rm",
    "--pull=missing",
    "--network",
    networkName,
    ...(supervisorNetwork
      ? ["--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only"]
      : []),
    "--add-host",
    `${HOST_INTERNAL_NAME}:${hostInternalTarget}`,
    probeImage,
    "nc",
    `-zw${timeoutSec}`,
    HOST_INTERNAL_NAME,
    String(port),
  ];

  const result = runImpl(probeArgs, timeoutSec * 1000 + PROBE_OVERHEAD_MS);

  if (result.status === 0) {
    return {
      ok: true,
      reason: "ok",
      port,
      networkName,
      subnet: network.subnet,
      gatewayIp: network.gatewayIp,
    };
  }

  const detail = [
    result.error,
    outputTail(result.stderr),
    result.signal ? `signal ${result.signal}` : undefined,
    result.status !== null ? `exit ${result.status}` : undefined,
  ]
    .filter((s): s is string => Boolean(s))
    .join(" | ");

  // Non-nc failures, DNS failures, and host-gateway routes do not prove that
  // a native Docker bridge UFW rule blocked the connection.
  if (result.status !== 1 || isNameResolutionFailure(detail) || usesNonBridgeRoute) {
    return {
      ok: false,
      reason: "probe_unavailable",
      port,
      networkName,
      subnet: network.subnet,
      gatewayIp: network.gatewayIp,
      detail: portableProfile
        ? "portable host-gateway probe did not connect"
        : detail || "probe did not complete",
    };
  }

  return {
    ok: false,
    reason: "tcp_failed",
    port,
    networkName,
    subnet: network.subnet,
    gatewayIp: network.gatewayIp,
    detail: `sandbox container on "${networkName}" could not reach ${HOST_INTERNAL_NAME}:${port}`,
  };
}

export const __test = {
  parseNetworkIpamConfig,
};
