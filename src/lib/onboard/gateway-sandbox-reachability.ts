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

import { dockerInspectFormat } from "../adapters/docker/inspect";
import { dockerRun } from "../adapters/docker/run";
import { GATEWAY_PORT } from "../core/ports";

const DEFAULT_PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const DEFAULT_NETWORK_NAME = "openshell-docker";
const HOST_INTERNAL_NAME = "host.openshell.internal";
const DEFAULT_PROBE_TIMEOUT_SEC = 5;
const PROBE_RUN_OVERHEAD_MS = 10_000;

export type SandboxBridgeReachabilityReason =
  | "ok"
  | "tcp_failed"
  | "network_not_found"
  | "probe_unavailable";

export interface SandboxBridgeReachabilityResult {
  ok: boolean;
  reason: SandboxBridgeReachabilityReason;
  subnet?: string;
  detail?: string;
}

interface SandboxBridgeProbeRunResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: string;
  stderr?: string | Buffer | null;
  stdout?: string | Buffer | null;
}

export interface SandboxBridgeReachabilityOptions {
  networkName?: string;
  port?: number;
  timeoutSec?: number;
  probeImage?: string;
  /** Test seam — override docker run. */
  runImpl?: (args: readonly string[], timeoutMs: number) => SandboxBridgeProbeRunResult;
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

function outputTail(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const raw = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const text = raw.trim();
  return text ? text.slice(-400) : undefined;
}

function summarizeProbeUnavailable(result: SandboxBridgeProbeRunResult): string {
  const details = [
    result.error,
    outputTail(result.stderr),
    outputTail(result.stdout),
    result.signal ? `signal ${result.signal}` : undefined,
    result.status !== null ? `exit ${result.status}` : undefined,
  ].filter((item): item is string => Boolean(item));
  return details[0] ?? "docker run did not complete the probe";
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
      "run", "--rm", "--pull=missing", "--network", networkName, probeImage,
      "sh", "-c", `nc -zw${timeoutSec} ${HOST_INTERNAL_NAME} ${port}`,
    ],
    timeoutSec * 1000 + PROBE_RUN_OVERHEAD_MS,
  );
  if (result.status === 0) {
    return { ok: true, reason: "ok", subnet };
  }
  if (result.status !== 1) {
    return {
      ok: false,
      reason: "probe_unavailable",
      subnet,
      detail: summarizeProbeUnavailable(result),
    };
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
  if (result.reason === "probe_unavailable") {
    return [
      "  ⚠ Could not run the sandbox bridge reachability probe.",
      "    This does not prove the gateway is unreachable; continuing.",
      result.detail ? `    ${result.detail}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
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

export async function verifySandboxBridgeGatewayReachableOrExit(
  exitOnFailure: boolean,
): Promise<void> {
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
