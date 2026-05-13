// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Probe sandbox-bridge → gateway reachability on the Docker-driver path.
 *
 * Companion to ./gateway-tcp-readiness. That probe checks host loopback
 * (127.0.0.1:GATEWAY_PORT); it cannot detect a host firewall dropping
 * traffic from the Docker bridge subnet to the host bridge gateway IP.
 * The packet path that matters for real sandboxes is bridge → host
 * INPUT chain, so this probe spawns a helper container on the same
 * network and TCP-connects to host.openshell.internal:GATEWAY_PORT.
 *
 * Diagnostic-only: never mutates iptables/ufw.
 */

import { dockerRun } from "../adapters/docker/run";
import { dockerInspectFormat } from "../adapters/docker/inspect";
import { GATEWAY_PORT } from "../core/ports";

const DEFAULT_PROBE_IMAGE = "busybox:latest";
const DEFAULT_NETWORK_NAME = "openshell-docker";
const HOST_INTERNAL_NAME = "host.openshell.internal";
const DEFAULT_PROBE_TIMEOUT_SEC = 5;
const PROBE_RUN_OVERHEAD_MS = 10_000;

export type SandboxBridgeReachabilityReason = "ok" | "tcp_failed" | "network_not_found";

export interface SandboxBridgeReachabilityResult {
  ok: boolean;
  reason: SandboxBridgeReachabilityReason;
  subnet?: string;
  detail?: string;
}

export interface SandboxBridgeReachabilityOptions {
  networkName?: string;
  port?: number;
  timeoutSec?: number;
  probeImage?: string;
  /** Test seam — override docker run. */
  runImpl?: (args: readonly string[], timeoutMs: number) => { status: number | null };
  /** Test seam — override the network-subnet inspect. */
  inspectSubnetImpl?: (networkName: string) => string | undefined;
}

function defaultInspectSubnet(networkName: string): string | undefined {
  try {
    const out = dockerInspectFormat(
      "{{(index .IPAM.Config 0).Subnet}}",
      networkName,
      { ignoreError: true },
    ).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

function defaultRunImpl(args: readonly string[], timeoutMs: number): { status: number | null } {
  const result = dockerRun(args, {
    timeout: timeoutMs,
    ignoreError: true,
    suppressOutput: true,
  });
  return { status: result.status ?? null };
}

export async function isSandboxBridgeGatewayReachable(
  opts: SandboxBridgeReachabilityOptions = {},
): Promise<SandboxBridgeReachabilityResult> {
  const networkName =
    opts.networkName ?? process.env.OPENSHELL_DOCKER_NETWORK_NAME ?? DEFAULT_NETWORK_NAME;
  const port = opts.port ?? GATEWAY_PORT;
  const timeoutSec = opts.timeoutSec ?? DEFAULT_PROBE_TIMEOUT_SEC;
  const probeImage = opts.probeImage ?? DEFAULT_PROBE_IMAGE;
  const inspectSubnet = opts.inspectSubnetImpl ?? defaultInspectSubnet;
  const runImpl = opts.runImpl ?? defaultRunImpl;

  const subnet = inspectSubnet(networkName);
  if (!subnet) {
    return {
      ok: false,
      reason: "network_not_found",
      detail: `Docker network "${networkName}" not found`,
    };
  }

  const result = runImpl(
    [
      "run", "--rm", "--network", networkName, probeImage,
      "sh", "-c", `nc -zw${timeoutSec} ${HOST_INTERNAL_NAME} ${port}`,
    ],
    timeoutSec * 1000 + PROBE_RUN_OVERHEAD_MS,
  );
  if (result.status === 0) {
    return { ok: true, reason: "ok", subnet };
  }
  return {
    ok: false,
    reason: "tcp_failed",
    subnet,
    detail: `sandbox container on "${networkName}" could not reach ${HOST_INTERNAL_NAME}:${port}`,
  };
}

/** CLI-ready actionable error message for a failed probe. */
export function formatSandboxBridgeUnreachableMessage(
  result: SandboxBridgeReachabilityResult,
  port: number = GATEWAY_PORT,
): string {
  if (result.ok) return "";
  if (result.reason === "network_not_found") {
    return [
      `  ✗ ${result.detail}`,
      "    The Docker-driver gateway reported healthy but the bridge network is missing.",
      "    Check the gateway log for startup errors before retrying.",
    ].join("\n");
  }
  const allowCmd = result.subnet
    ? `      sudo ufw allow from ${result.subnet} to any port ${port} proto tcp`
    : [
        `      SUBNET=$(docker network inspect openshell-docker --format '{{(index .IPAM.Config 0).Subnet}}')`,
        `      sudo ufw allow from "$SUBNET" to any port ${port} proto tcp`,
      ].join("\n");
  return [
    `  ✗ Sandbox containers cannot reach the gateway at ${HOST_INTERNAL_NAME}:${port}.`,
    "    A host firewall is blocking traffic from the sandbox bridge.",
    "    To allow it:",
    allowCmd,
    "    Then re-run `nemoclaw onboard`.",
  ].join("\n");
}
