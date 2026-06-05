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

import os from "node:os";

import { dockerCapture, dockerRun } from "../adapters/docker/run";
import { GATEWAY_PORT } from "../core/ports";
import { cliDisplayName, cliName } from "./branding";
import {
  DOCKER_DESKTOP_WSL_INTEGRATION_HINT,
  ensureProbeImageCached,
  isDockerDaemonUnreachable,
} from "./preflight";
import type { UfwAutoApplyResult } from "./ufw-auto-apply";
import { isUfwAutoApplyOptedIn, tryAutoApplyUfwRule } from "./ufw-auto-apply";

export type { UfwAutoApplyOptions, UfwAutoApplyResult } from "./ufw-auto-apply";
export { tryAutoApplyUfwRule } from "./ufw-auto-apply";

const DEFAULT_PROBE_IMAGE =
  "busybox@sha256:73aaf090f3d85aa34ee199857f03fa3a95c8ede2ffd4cc2cdb5b94e566b11662";
const DEFAULT_NETWORK_NAME = "openshell-docker";
const HOST_INTERNAL_NAME = "host.openshell.internal";
const HOST_DOCKER_INTERNAL_NAME = "host.docker.internal";
const DEFAULT_PROBE_TIMEOUT_SEC = 5;
const PROBE_RUN_OVERHEAD_MS = 10_000;

export type SandboxBridgeReachabilityReason =
  | "ok"
  | "tcp_failed"
  | "probe_unavailable"
  | "probe_timeout"
  | "veth_unsupported"
  | "docker_daemon_unreachable";
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
  /** Explicit timeout flag from the runner (e.g. spawnSync ETIMEDOUT). */
  timedOut?: boolean;
  /** Explicit error code from the runner (e.g. "ETIMEDOUT", "ENOENT"). */
  errorCode?: string | null;
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
  /** Inject a precomputed image-cache result; bypasses real pre-pull. */
  ensureImageCachedOverride?: import("./preflight").EnsureProbeImageCachedResult;
}

export interface FormatSandboxBridgeUnreachableMessageOptions {
  isWsl?: boolean;
}

function isRunningInWsl(env: NodeJS.ProcessEnv = process.env, release = os.release()): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(release));
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
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    status: result.status ?? null,
    signal: result.signal,
    error: error?.message,
    timedOut: error?.code === "ETIMEDOUT",
    errorCode: error?.code ?? null,
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

function isProbeTimeout(result: SandboxBridgeProbeRunResult): boolean {
  // Only spawn-level timeouts qualify here. BusyBox `nc` exits with
  // status 1 and prints "Operation timed out" on connection-level
  // timeouts (firewalled gateway port) — those must fall through to
  // `tcp_failed` so the user gets the UFW/firewall remediation, not a
  // Docker restart hint. We honor explicit timedOut/errorCode flags
  // from the runner when present, and fall back to scanning the error
  // message for the ETIMEDOUT signature.
  if (result.timedOut === true) return true;
  if (result.errorCode && /^ETIMEDOUT$/i.test(result.errorCode)) return true;
  return /\bETIMEDOUT\b/i.test(result.error ?? "");
}

function isVethUnsupported(detail: string): boolean {
  // Specific Jetson bridge-create signature only. Generic "veth"
  // mentions or unrelated "operation not supported" errors must not be
  // classified as veth_unsupported (which is fatal in onboarding) —
  // require the veth-pair-create wording together with the OS error.
  return /failed to add the host .* sandbox veth pair interfaces: operation not supported|veth pair[^.]*?operation not supported/i.test(
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

  // Pre-pull the pinned probe image so a slow-registry cold-cache pull
  // does not get charged against the (much shorter) probe budget and
  // misclassified as a fatal probe_timeout. Image-cache failures stay
  // inconclusive (probe_unavailable), matching pre-#3630 semantics.
  //
  // Test seams that inject a probe runImpl bypass real Docker entirely;
  // skip the pre-pull there unless the test supplies an explicit
  // ensureImageCachedOverride.
  if (opts.ensureImageCachedOverride !== undefined || opts.runImpl === undefined) {
    const cached = opts.ensureImageCachedOverride ?? ensureProbeImageCached(probeImage);
    if (!cached.ok) {
      // A wedged docker daemon (inspect_unavailable) is a fatal Docker
      // outage, not a probe/pull uncertainty — keep onboarding from
      // proceeding into sandbox work that will hang. Pull failures
      // (rate limit / slow registry) remain probe_unavailable.
      const reason: SandboxBridgeReachabilityReason =
        cached.reason === "inspect_unavailable" ? "docker_daemon_unreachable" : "probe_unavailable";
      // Use an inspect-specific fallback when the image-cache check
      // never reached a pull (daemon down at `docker image inspect`),
      // so the printed detail does not mislead users into chasing a
      // registry/pull issue.
      const fallbackDetail =
        cached.reason === "inspect_unavailable"
          ? "docker image inspect did not complete (daemon unreachable)"
          : `docker pull ${probeImage} did not complete`;
      return {
        ok: false,
        reason,
        networkName,
        subnet: route.subnet,
        gatewayIp: route.gatewayIp,
        routeKind: route.routeKind,
        detail: cached.details ?? fallbackDetail,
      };
    }
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
  if (isVethUnsupported(detail)) {
    return {
      ok: false,
      reason: "veth_unsupported",
      networkName,
      subnet: route.subnet,
      gatewayIp: route.gatewayIp,
      routeKind: route.routeKind,
      detail,
    };
  }
  if (isProbeTimeout(result)) {
    return {
      ok: false,
      reason: "probe_timeout",
      networkName,
      subnet: route.subnet,
      gatewayIp: route.gatewayIp,
      routeKind: route.routeKind,
      detail,
    };
  }
  // Daemon-connect failures from the docker CLI (e.g. "Cannot connect
  // to the Docker daemon" after the image-cache check happened to
  // succeed) must surface as fatal docker_daemon_unreachable, not the
  // warn-only probe_unavailable, so onboarding stops here rather than
  // proceeding into sandbox work that will fail later.
  if (isDockerDaemonUnreachable(detail)) {
    return {
      ok: false,
      reason: "docker_daemon_unreachable",
      networkName,
      subnet: route.subnet,
      gatewayIp: route.gatewayIp,
      routeKind: route.routeKind,
      detail,
    };
  }
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
  opts: FormatSandboxBridgeUnreachableMessageOptions = {},
): string {
  if (result.ok) return "";
  const includeWslIntegrationHint = opts.isWsl ?? isRunningInWsl();
  if (result.reason === "probe_unavailable") {
    return [
      "  ⚠ Could not verify sandbox bridge reachability.",
      "    This does not prove the gateway is unreachable; continuing.",
      result.detail ? `    ${result.detail}` : undefined,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  if (result.reason === "veth_unsupported") {
    return [
      "  ✗ Docker could not create the sandbox bridge veth pair.",
      result.detail ? `    ${result.detail}` : undefined,
      "    This matches Jetson kernel/Docker bridge environments where veth creation returns `operation not supported`.",
      `    Update the host kernel/Docker bridge networking support, or run ${cliDisplayName()} on a host whose Docker bridge networking can create veth interfaces.`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  if (result.reason === "probe_timeout") {
    return [
      "  ✗ Docker-driver sandbox bridge reachability probe timed out.",
      result.detail ? `    ${result.detail}` : undefined,
      `    Restart Docker and check for stuck container/network operations before retrying \`${cliName()} onboard\`.`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  if (result.reason === "docker_daemon_unreachable") {
    return [
      "  ✗ Docker daemon is not reachable for the sandbox bridge probe.",
      result.detail ? `    ${result.detail}` : undefined,
      includeWslIntegrationHint ? `    ${DOCKER_DESKTOP_WSL_INTEGRATION_HINT}` : undefined,
      "    Restart the Docker daemon (e.g. `sudo systemctl restart docker`, or restart Docker Desktop/Colima)",
      `    and re-run \`${cliName()} onboard\`.`,
    ].filter((line): line is string => Boolean(line)).join("\n");
  }

  if (result.routeKind === "host_gateway") {
    return [
      `  ✗ Sandbox containers cannot reach the gateway at ${HOST_INTERNAL_NAME}:${port}.`,
      "    The probe used Docker's host-gateway route, matching Docker Desktop/VM-backed Docker.",
      `    Restart Docker and the OpenShell gateway, then re-run \`${cliName()} onboard\`.`,
    ].join("\n");
  }

  const allowCmd =
    result.subnet && result.gatewayIp
      ? `      sudo ufw allow from ${result.subnet} to ${result.gatewayIp} port ${port} proto tcp`
      : result.subnet
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
    `    Then re-run \`${cliName()} onboard\`.`,
  ].join("\n");
}

interface SandboxBridgeVerifierOptions {
  skip?: boolean;
  port?: number;
  reachabilityImpl?: () => Promise<SandboxBridgeReachabilityResult> | SandboxBridgeReachabilityResult;
  autoApplyImpl?: (
    reach: SandboxBridgeReachabilityResult,
  ) => Promise<UfwAutoApplyResult> | UfwAutoApplyResult;
  autoApplyOptedInImpl?: () => boolean;
}

const SILENT_UFW_AUTO_APPLY_REASONS = new Set<UfwAutoApplyResult["reason"]>([
  "not_opted_in",
  "ufw_missing",
  "ufw_inactive",
]);

export async function verifySandboxBridgeGatewayReachableOrExit(
  exitOnFailure: boolean,
  options: SandboxBridgeVerifierOptions = {},
): Promise<void> {
  if (options.skip) {
    console.log("  Docker-driver GPU host networking active; skipping sandbox bridge gateway reachability probe.");
    return;
  }
  const port = options.port ?? GATEWAY_PORT;
  const reachability = options.reachabilityImpl ?? isSandboxBridgeGatewayReachable;
  const autoApplyOptedIn = options.autoApplyOptedInImpl ?? isUfwAutoApplyOptedIn;
  const autoApply =
    options.autoApplyImpl ??
    ((result: SandboxBridgeReachabilityResult) => tryAutoApplyUfwRule(result, { optedIn: true, port }));

  let reach = await reachability();
  if (reach.ok) return;

  // #4265: when operator opts in and the probe proved a bridge TCP failure,
  // try to auto-apply the firewall rule and re-probe before surfacing the
  // manual-fix message. Do not mutate firewall state for probe helper/DNS
  // failures, even if route metadata is present.
  if (reach.routeKind === "bridge_gateway" && reach.reason === "tcp_failed" && autoApplyOptedIn()) {
    const autoApplyResult = await autoApply(reach);
    if (autoApplyResult.applied) {
      const ruleDescription = reach.subnet && reach.gatewayIp
        ? `allow from ${reach.subnet} to ${reach.gatewayIp}:${port}/tcp`
        : `allow sandbox bridge traffic to port ${port}/tcp`;
      console.log(
        `  ✓ Applied UFW rule (NEMOCLAW_AUTO_FIX_FIREWALL=1): ${ruleDescription}`,
      );
      reach = await reachability();
      if (reach.ok) return;
    } else if (!SILENT_UFW_AUTO_APPLY_REASONS.has(autoApplyResult.reason)) {
      console.warn(
        `  ⚠ NEMOCLAW_AUTO_FIX_FIREWALL=1 set but could not auto-apply UFW rule (${autoApplyResult.reason}${autoApplyResult.detail ? `: ${autoApplyResult.detail}` : ""}); falling back to manual instructions.`,
      );
    }
  }

  const message = formatSandboxBridgeUnreachableMessage(reach, port);
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
  isRunningInWsl,
  parseDockerNetworkIpamConfig,
};
