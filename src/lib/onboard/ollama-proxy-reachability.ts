// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox-side reachability probe for the Ollama auth proxy (port 11435).
 *
 * Issue #3340: On Brev VMs (and any Linux host with UFW default-deny), the
 * Ollama auth proxy on port 11435 is unreachable from the sandbox's Docker
 * bridge network. Host-side validation cannot detect this because
 * host.openshell.internal only resolves inside the sandbox network. This
 * probe runs a short-lived container on the same Docker network OpenShell
 * uses for sandboxes and performs a TCP connect to the proxy port, mirroring
 * the exact route the real sandbox takes. A tcp_failed result means a host
 * firewall is blocking the port; the caller can then surface an actionable
 * ufw remediation before declaring onboard successful.
 */

import { OLLAMA_PROXY_PORT } from "../core/ports";
import { dockerCapture, dockerRun } from "../adapters/docker/run";

export const DEFAULT_OLLAMA_PROBE_NETWORK = "openshell-docker";
const HOST_INTERNAL_NAME = "host.openshell.internal";
// Pinned busybox digest — same image used by the gateway bridge probe so
// it is likely already pulled and avoids a redundant registry fetch.
const PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const PROBE_TIMEOUT_SEC = 5;
const PROBE_OVERHEAD_MS = 10_000;

export type OllamaProxyReachabilityReason = "ok" | "tcp_failed" | "probe_unavailable";

export interface OllamaProxyReachabilityResult {
  ok: boolean;
  reason: OllamaProxyReachabilityReason;
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

export interface OllamaProxyReachabilityOptions {
  port?: number;
  networkName?: string;
  timeoutSec?: number;
  probeImage?: string;
  runImpl?: (args: readonly string[], timeoutMs: number) => ProbeRunResult;
  inspectNetworkImpl?: (networkName: string) => { subnet?: string; gatewayIp?: string } | undefined;
  usesHostGatewayRouteImpl?: () => boolean;
}

function parseNetworkIpamConfig(
  raw: string,
): { subnet?: string; gatewayIp?: string } | undefined {
  const text = raw.trim();
  if (!text || text === "<no value>") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed)) return undefined;
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const subnet = typeof r.Subnet === "string" ? r.Subnet : undefined;
    const gatewayIp = typeof r.Gateway === "string" ? r.Gateway : undefined;
    // Skip IPv6-only entries (contain colons)
    if (gatewayIp && !gatewayIp.includes(":")) return { subnet, gatewayIp };
  }
  return undefined;
}

function defaultInspectNetwork(
  networkName: string,
): { subnet?: string; gatewayIp?: string } | undefined {
  const raw = dockerCapture(
    ["network", "inspect", "--format", "{{json .IPAM.Config}}", networkName],
    { ignoreError: true },
  );
  return parseNetworkIpamConfig(raw);
}

// Docker Desktop and VM-backed Docker use a special host-gateway alias rather
// than a specific bridge IP. UFW is not relevant on those platforms, so we
// classify probes from those environments as probe_unavailable.
function defaultUsesHostGatewayRoute(): boolean {
  if (process.platform !== "linux") return true;
  const info = dockerCapture(
    ["info", "--format", "{{.OperatingSystem}}\n{{range .Labels}}{{.}}\n{{end}}"],
    { ignoreError: true },
  );
  return /Docker Desktop|com\.docker\.desktop\./i.test(info);
}

function defaultRunImpl(args: readonly string[], timeoutMs: number): ProbeRunResult {
  const result = dockerRun(args, {
    timeout: timeoutMs,
    ignoreError: true,
    suppressOutput: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? null,
    signal: result.signal,
    error: result.error?.message,
    stderr: result.stderr,
  };
}

function outputTail(value: unknown): string | undefined {
  const raw =
    Buffer.isBuffer(value)
      ? value.toString("utf8")
      : value == null
        ? ""
        : String(value);
  const text = raw.trim();
  return text ? text.slice(-400) : undefined;
}

function isNameResolutionFailure(detail: string): boolean {
  return /bad address|name or service not known|temporary failure in name resolution|could not resolve|getaddrinfo/i.test(
    detail,
  );
}

export async function probeOllamaProxySandboxReachability(
  opts: OllamaProxyReachabilityOptions = {},
): Promise<OllamaProxyReachabilityResult> {
  const networkName =
    opts.networkName ??
    process.env.OPENSHELL_DOCKER_NETWORK_NAME ??
    DEFAULT_OLLAMA_PROBE_NETWORK;
  const port = opts.port ?? OLLAMA_PROXY_PORT;
  const timeoutSec = opts.timeoutSec ?? PROBE_TIMEOUT_SEC;
  const probeImage = opts.probeImage ?? PROBE_IMAGE;
  const inspectNetwork = opts.inspectNetworkImpl ?? defaultInspectNetwork;
  const usesHostGatewayRoute = opts.usesHostGatewayRouteImpl ?? defaultUsesHostGatewayRoute;
  const runImpl = opts.runImpl ?? defaultRunImpl;

  const network = inspectNetwork(networkName);
  if (!network) {
    return {
      ok: false,
      reason: "probe_unavailable",
      networkName,
      detail: `Docker network "${networkName}" not found`,
    };
  }

  const isHostGateway = usesHostGatewayRoute();

  if (!isHostGateway && !network.gatewayIp) {
    return {
      ok: false,
      reason: "probe_unavailable",
      networkName,
      subnet: network.subnet,
      detail: `Docker network "${networkName}" has no IPv4 gateway`,
    };
  }

  const hostInternalTarget = isHostGateway ? "host-gateway" : (network.gatewayIp as string);

  const probeArgs = [
    "run",
    "--rm",
    "--pull=missing",
    "--network",
    networkName,
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

  // Classify as probe_unavailable for: non-nc exit codes, DNS failures,
  // or host-gateway mode (Docker Desktop / macOS — no UFW concern there).
  if (result.status !== 1 || isNameResolutionFailure(detail) || isHostGateway) {
    return {
      ok: false,
      reason: "probe_unavailable",
      networkName,
      subnet: network.subnet,
      gatewayIp: network.gatewayIp,
      detail: detail || "probe did not complete",
    };
  }

  return {
    ok: false,
    reason: "tcp_failed",
    networkName,
    subnet: network.subnet,
    gatewayIp: network.gatewayIp,
    detail: `sandbox container on "${networkName}" could not reach ${HOST_INTERNAL_NAME}:${port}`,
  };
}

export function formatOllamaProxyUnreachableMessage(
  result: OllamaProxyReachabilityResult,
  port: number = OLLAMA_PROXY_PORT,
): string {
  if (result.ok || result.reason !== "tcp_failed") return "";

  const allowCmd = result.subnet
    ? `      sudo ufw allow from ${result.subnet} to any port ${port} proto tcp`
    : [
        `      SUBNET=$(docker network inspect ${result.networkName ?? DEFAULT_OLLAMA_PROBE_NETWORK} --format '{{(index .IPAM.Config 0).Subnet}}')`,
        `      sudo ufw allow from "$SUBNET" to any port ${port} proto tcp`,
      ].join("\n");

  return [
    `  ✗ Sandbox containers cannot reach the Ollama auth proxy at ${HOST_INTERNAL_NAME}:${port}.`,
    "    A host firewall may be blocking traffic from the OpenShell Docker bridge.",
    "    To allow it:",
    allowCmd,
    "    Then re-run `nemoclaw onboard`.",
  ].join("\n");
}

export const __test = {
  parseNetworkIpamConfig,
};
