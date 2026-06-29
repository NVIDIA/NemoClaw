// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import {
  getDockerDriverGatewayRuntimeMarkerPath,
  readDockerDriverGatewayRuntimeMarker,
} from "../../onboard/docker-driver-gateway-runtime-marker";
import {
  hostGatewayCmdlineMatches,
  resolveDockerDriverGatewayStateDir,
} from "../../onboard/host-gateway-process";
import { isOpenShellProtobufSchemaMismatch } from "../../runtime-recovery";
import { isGatewayHealthy } from "../../state/gateway";
import { dockerContainerInspectFormat } from "../docker";
import { parseVersionFromText, stripAnsi } from "./client";
import { resolveOpenshell } from "./resolve";
import { captureOpenshell, getInstalledOpenshellVersionOrNull } from "./runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const DEFAULT_GATEWAY_NAME = "nemoclaw";

export type GatewayClusterImageDrift = {
  containerName: string;
  currentImage: string;
  currentVersion: string;
  expectedVersion: string;
};

export type GatewayHostProcessDrift = {
  gatewayBin: string | null;
  currentVersion: string;
  expectedVersion: string;
};

export type GatewayDrift = GatewayClusterImageDrift | GatewayHostProcessDrift;

export type HostProcessGatewayRuntime = {
  gatewayBin: string | null;
  runningVersion: string | null;
};

export type OpenShellStateRpcIssue =
  | {
      kind: "image_drift";
      drift: GatewayClusterImageDrift;
      output?: string;
    }
  | {
      kind: "host_process_drift";
      drift: GatewayHostProcessDrift;
      output?: string;
    }
  | {
      kind: "protobuf_mismatch";
      drift?: GatewayDrift | null;
      output: string;
    };

type GatewayDriftDeps = {
  getInstalledOpenshellVersion?: () => string | null;
  getGatewayClusterImageRef?: (gatewayName: string) => string | null;
  isGatewayClusterActive?: (gatewayName: string) => boolean;
  getHostProcessGatewayRuntime?: () => HostProcessGatewayRuntime | null;
};

export function isHostProcessGatewayDrift(
  drift: GatewayDrift | null | undefined,
): drift is GatewayHostProcessDrift {
  return !!drift && "gatewayBin" in drift;
}

type GatewayDriftOptions = {
  gatewayName?: string;
  deps?: GatewayDriftDeps;
  timeoutMs?: number;
};

type StateRpcResult = {
  status?: number | null;
  output?: string | null;
};

type FormatIssueOptions = {
  action?: string;
  command?: string;
  gatewayName?: string;
};

function hasInjectedGatewayDriftDeps(deps: GatewayDriftDeps): boolean {
  return (
    typeof deps.getInstalledOpenshellVersion === "function" ||
    typeof deps.getGatewayClusterImageRef === "function" ||
    typeof deps.isGatewayClusterActive === "function" ||
    typeof deps.getHostProcessGatewayRuntime === "function"
  );
}

function isGatewayDriftPreflightDisabled(deps: GatewayDriftDeps): boolean {
  const isTestRuntime = process.env.VITEST === "true" || process.env.NODE_ENV === "test";
  return (
    process.env.NEMOCLAW_DISABLE_GATEWAY_DRIFT_PREFLIGHT === "1" &&
    isTestRuntime &&
    !hasInjectedGatewayDriftDeps(deps)
  );
}

export function getGatewayClusterContainerName(gatewayName = DEFAULT_GATEWAY_NAME): string {
  return `openshell-cluster-${gatewayName}`;
}

export function parseGatewayClusterImageVersion(
  imageRef: string | null | undefined,
): string | null {
  const ref = String(imageRef || "");
  const upstreamMatch = ref.match(/openshell\/cluster:([0-9]+\.[0-9]+\.[0-9]+)/);
  if (upstreamMatch) return upstreamMatch[1];
  const patchedMatch = ref.match(/(?:^|\/)nemoclaw-cluster:([0-9]+\.[0-9]+\.[0-9]+)(?:[-@]|$)/);
  return patchedMatch ? patchedMatch[1] : null;
}

export function getGatewayClusterImageRef(
  gatewayName = DEFAULT_GATEWAY_NAME,
  { timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): string | null {
  const imageRef = dockerContainerInspectFormat(
    "{{.Config.Image}}",
    getGatewayClusterContainerName(gatewayName),
    {
      ignoreError: true,
      timeout: timeoutMs,
    },
  ).trim();
  return imageRef || null;
}

function parseGatewayEndpointPort(output: string): string | null {
  const match = stripAnsi(output).match(/^\s*Gateway endpoint:\s+(\S+)\s*$/m);
  if (!match) return null;
  try {
    const url = new URL(match[1]);
    if (url.port) return url.port;
    if (url.protocol === "http:") return "80";
    if (url.protocol === "https:") return "443";
  } catch {
    return null;
  }
  return null;
}

function getGatewayClusterPublishedHostPorts(
  containerName: string,
  timeoutMs: number,
): Set<string> {
  const raw = dockerContainerInspectFormat("{{json .NetworkSettings.Ports}}", containerName, {
    ignoreError: true,
    timeout: timeoutMs,
  }).trim();
  if (!raw || raw === "null" || raw === "<no value>") return new Set();
  try {
    const parsed = JSON.parse(raw) as Record<
      string,
      Array<{ HostPort?: string | number | null }> | null
    >;
    const ports = new Set<string>();
    for (const bindings of Object.values(parsed)) {
      if (!Array.isArray(bindings)) continue;
      for (const binding of bindings) {
        const hostPort = binding?.HostPort;
        if (hostPort !== null && hostPort !== undefined && String(hostPort).trim()) {
          ports.add(String(hostPort).trim());
        }
      }
    }
    return ports;
  } catch {
    return new Set();
  }
}

export function isGatewayClusterActiveForGateway(
  gatewayName = DEFAULT_GATEWAY_NAME,
  { timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS }: { timeoutMs?: number } = {},
): boolean {
  const status = captureOpenshell(["status"], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  const gatewayInfo = captureOpenshell(["gateway", "info", "-g", gatewayName], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  const activeGatewayInfo = captureOpenshell(["gateway", "info"], {
    ignoreError: true,
    timeout: timeoutMs,
  });
  if (!isGatewayHealthy(status.output, gatewayInfo.output, activeGatewayInfo.output, gatewayName)) {
    return false;
  }

  const endpointPort =
    parseGatewayEndpointPort(activeGatewayInfo.output) ??
    parseGatewayEndpointPort(gatewayInfo.output);
  if (!endpointPort) return false;

  const containerName = getGatewayClusterContainerName(gatewayName);
  const running = dockerContainerInspectFormat("{{.State.Running}}", containerName, {
    ignoreError: true,
    timeout: timeoutMs,
  }).trim();
  if (running !== "true") return false;

  return getGatewayClusterPublishedHostPorts(containerName, timeoutMs).has(endpointPort);
}

export function getGatewayClusterImageDrift({
  gatewayName = DEFAULT_GATEWAY_NAME,
  deps = {},
  timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS,
}: GatewayDriftOptions = {}): GatewayClusterImageDrift | null {
  if (isGatewayDriftPreflightDisabled(deps)) {
    return null;
  }
  const expectedVersion =
    deps.getInstalledOpenshellVersion?.() ??
    getInstalledOpenshellVersionOrNull({ timeout: timeoutMs });
  const clusterActive =
    deps.isGatewayClusterActive?.(gatewayName) ??
    (typeof deps.getGatewayClusterImageRef === "function"
      ? true
      : isGatewayClusterActiveForGateway(gatewayName, { timeoutMs }));
  if (!clusterActive) {
    return null;
  }
  const currentImage =
    typeof deps.getGatewayClusterImageRef === "function"
      ? deps.getGatewayClusterImageRef(gatewayName)
      : getGatewayClusterImageRef(gatewayName, { timeoutMs });
  const currentVersion = parseGatewayClusterImageVersion(currentImage);
  if (!expectedVersion || !currentImage || !currentVersion || currentVersion === expectedVersion) {
    return null;
  }
  return {
    containerName: getGatewayClusterContainerName(gatewayName),
    currentImage,
    currentVersion,
    expectedVersion,
  };
}

function probeGatewayBinaryVersion(gatewayBin: string, timeoutMs: number): string | null {
  try {
    const result = spawnSync(gatewayBin, ["--version"], {
      encoding: "utf-8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) return null;
    return parseVersionFromText(`${result.stdout || ""}${result.stderr || ""}`);
  } catch {
    return null;
  }
}

/**
 * Whether `pid` is a live host-process gateway. Uses `process.kill(pid, 0)` for
 * liveness, then confirms identity via {@link hostGatewayCmdlineMatches}, which
 * gates on argv0 (the executable) rather than any cmdline token — so a recycled
 * PID belonging to an unrelated process that merely mentions the binary path
 * (e.g. `vim /opt/.../openshell-gateway`) cannot make a stale marker look live.
 */
function isLiveGatewayProcess(pid: number | null | undefined, gatewayBin: string | null): boolean {
  if (!Number.isInteger(pid as number) || (pid as number) <= 0) return false;
  try {
    process.kill(pid as number, 0);
  } catch (err) {
    // ESRCH → no such process (dead). EPERM → exists but not ours (alive).
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  let cmdline = "";
  try {
    cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim();
  } catch {
    try {
      const ps = spawnSync("ps", ["-p", String(pid), "-o", "args="], {
        encoding: "utf-8",
        timeout: 2000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      cmdline = ps.status === 0 ? String(ps.stdout || "").trim() : "";
    } catch {
      cmdline = "";
    }
  }
  return cmdline ? hostGatewayCmdlineMatches(cmdline, gatewayBin) : false;
}

/**
 * Resolve the host-process gateway binary path. Prefers the binary of a *live*
 * marker gateway process (what is actually serving RPCs). A stale marker — dead
 * PID, e.g. after OpenShell was reinstalled elsewhere or
 * `NEMOCLAW_OPENSHELL_GATEWAY_BIN` changed — must not be trusted, or we would
 * flag drift against a binary that is no longer the gateway and wrongly block
 * recovery. When the marker is stale or absent, mirror
 * `onboard.ts:resolveOpenShellGatewayBinary` (env override → sibling of the
 * resolved `openshell` binary → standard install paths): the binary
 * `startDockerDriverGateway()` would actually launch next.
 */
function resolveHostProcessGatewayBin(
  marker: { gatewayBin: string | null; pid?: number } | null,
): string | null {
  if (marker?.gatewayBin && isLiveGatewayProcess(marker.pid, marker.gatewayBin)) {
    return marker.gatewayBin;
  }
  const configuredBin = process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN?.trim();
  if (configuredBin) return path.resolve(configuredBin);
  const openshellBin = resolveOpenshell();
  const candidates = [
    ...(openshellBin ? [path.join(path.dirname(openshellBin), "openshell-gateway")] : []),
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve the host-process (Docker-driver) gateway binary and its on-disk
 * version.
 *
 * We re-probe `<bin> --version` rather than trusting the marker's stored
 * `openshellVersion`. That recorded value is the *CLI* version captured at
 * launch, not the gateway binary's version, so it (a) misses the primary
 * #4430 repro — a gateway binary swapped to a version *older* than the CLI,
 * where the marker still records the newer CLI version — and (b) false-positives
 * on a stale marker whose recorded process is long dead (the marker is only
 * rewritten on the next NemoClaw-managed gateway start). The on-disk binary is
 * the version that the gateway is currently serving or would next be launched
 * from.
 *
 * The narrow remaining gap — an in-place OpenShell upgrade that leaves the old
 * gateway *process* running while the on-disk binary is already new — cannot be
 * resolved from local state (no reliable served-version probe exists), but it is
 * still fail-closed: querying that stale process yields a protobuf/schema
 * mismatch that {@link detectOpenShellStateRpcResultIssue} catches and surfaces
 * with the same structured "no sandbox data was changed" guidance.
 */
export function getHostProcessGatewayRuntimeOrNull({
  timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS,
}: {
  timeoutMs?: number;
} = {}): HostProcessGatewayRuntime | null {
  const marker = readDockerDriverGatewayRuntimeMarker(
    getDockerDriverGatewayRuntimeMarkerPath(resolveDockerDriverGatewayStateDir()),
  );
  const gatewayBin = resolveHostProcessGatewayBin(marker);
  if (!gatewayBin) {
    return null;
  }
  return { gatewayBin, runningVersion: probeGatewayBinaryVersion(gatewayBin, timeoutMs) };
}

/**
 * Detect drift between the installed OpenShell CLI and a host-process /
 * Docker-driver gateway binary. Only applies when there is no legacy
 * `openshell-cluster-*` container to inspect; cluster-image drift is handled
 * by {@link getGatewayClusterImageDrift}.
 */
export function getGatewayHostProcessDrift({
  gatewayName = DEFAULT_GATEWAY_NAME,
  deps = {},
  timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS,
}: GatewayDriftOptions = {}): GatewayHostProcessDrift | null {
  if (isGatewayDriftPreflightDisabled(deps)) {
    return null;
  }
  // Host-process drift only applies when the active gateway is not a legacy
  // cluster container. A cluster image ref alone is not enough: `docker inspect`
  // still returns `.Config.Image` for a *stopped* leftover container, which must
  // not mask a real host-process gateway. Only suppress host-process detection
  // when that container is actually the active gateway (mirrors the cluster
  // detector's own active gate). The active probe runs solely when a cluster
  // container exists, so the common marker-less host-process path stays cheap.
  const clusterImage =
    typeof deps.getGatewayClusterImageRef === "function"
      ? deps.getGatewayClusterImageRef(gatewayName)
      : getGatewayClusterImageRef(gatewayName, { timeoutMs });
  if (clusterImage) {
    const clusterActive =
      deps.isGatewayClusterActive?.(gatewayName) ??
      isGatewayClusterActiveForGateway(gatewayName, { timeoutMs });
    if (clusterActive) {
      return null;
    }
  }
  const expectedVersion =
    deps.getInstalledOpenshellVersion?.() ??
    getInstalledOpenshellVersionOrNull({ timeout: timeoutMs });
  if (!expectedVersion) {
    return null;
  }
  const runtime =
    deps.getHostProcessGatewayRuntime?.() ?? getHostProcessGatewayRuntimeOrNull({ timeoutMs });
  if (!runtime || !runtime.runningVersion || runtime.runningVersion === expectedVersion) {
    return null;
  }
  return {
    gatewayBin: runtime.gatewayBin,
    currentVersion: runtime.runningVersion,
    expectedVersion,
  };
}

export function detectOpenShellStateRpcPreflightIssue({
  gatewayName = DEFAULT_GATEWAY_NAME,
  deps = {},
  timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS,
}: GatewayDriftOptions = {}): OpenShellStateRpcIssue | null {
  const imageDrift = getGatewayClusterImageDrift({ gatewayName, deps, timeoutMs });
  if (imageDrift) {
    return { kind: "image_drift", drift: imageDrift };
  }
  const hostDrift = getGatewayHostProcessDrift({ gatewayName, deps, timeoutMs });
  if (hostDrift) {
    return { kind: "host_process_drift", drift: hostDrift };
  }
  return null;
}

export function detectOpenShellStateRpcResultIssue(
  result: StateRpcResult,
  {
    gatewayName = DEFAULT_GATEWAY_NAME,
    deps = {},
    timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS,
  }: GatewayDriftOptions = {},
): OpenShellStateRpcIssue | null {
  const output = String(result.output || "");
  if (!isOpenShellProtobufSchemaMismatch(output)) {
    return null;
  }
  return {
    kind: "protobuf_mismatch",
    drift: isGatewayDriftPreflightDisabled(deps)
      ? null
      : (getGatewayClusterImageDrift({ gatewayName, deps, timeoutMs }) ??
        getGatewayHostProcessDrift({ gatewayName, deps, timeoutMs })),
    output,
  };
}

function compactOutput(output: string): string {
  return stripAnsi(output).replace(/\s+/g, " ").trim().slice(0, 260);
}

export function formatOpenShellStateRpcIssue(
  issue: OpenShellStateRpcIssue,
  { action = "querying OpenShell sandbox state", command }: FormatIssueOptions = {},
): string[] {
  const phaseLine =
    issue.kind === "protobuf_mismatch"
      ? `  OpenShell gateway/schema mismatch was detected while ${action}.`
      : `  OpenShell gateway schema preflight failed before ${action}.`;
  const lines = ["", phaseLine];

  const drift = issue.kind === "protobuf_mismatch" ? (issue.drift ?? null) : issue.drift;
  if (drift) {
    lines.push(`  Installed OpenShell: ${drift.expectedVersion}`);
    if (isHostProcessGatewayDrift(drift)) {
      lines.push(
        `  Running gateway binary: ${drift.gatewayBin ?? "host-process gateway"} (${drift.currentVersion})`,
      );
    } else {
      lines.push(`  Running gateway image: ${drift.currentImage} (${drift.currentVersion})`);
    }
  } else {
    lines.push(`  ${CLI_DISPLAY_NAME} saw protobuf/schema mismatch output from OpenShell.`);
  }

  if (issue.kind === "protobuf_mismatch") {
    const snippet = compactOutput(issue.output);
    if (snippet) {
      lines.push(`  OpenShell output: ${snippet}`);
    }
  }

  lines.push(
    "",
    "  Refusing to trust OpenShell sandbox state while the host CLI and gateway schema may be out of sync.",
    "  No sandbox data was changed.",
    "",
    "  Recovery:",
    `    1. Run \`${CLI_NAME} onboard --resume\` to repair or recreate the ${CLI_DISPLAY_NAME} gateway with the installed OpenShell version.`,
    `    2. Rerun${command ? ` \`${command}\`` : " the command"} after \`openshell status\` reports a healthy ${CLI_DISPLAY_NAME} gateway.`,
    "",
  );

  if (isHostProcessGatewayDrift(drift)) {
    lines.push(
      `  If gateway recreation is required, preserve sandbox state first; do not delete sandbox volumes or backups until \`openshell status\` reports a healthy ${CLI_DISPLAY_NAME} gateway on the installed OpenShell version.`,
    );
  } else if (drift) {
    lines.push(
      `  If gateway recreation is required, preserve sandbox state first; do not remove \`${drift.containerName}\` Docker volumes unless you have a backup and explicitly accept state loss.`,
    );
  } else {
    // protobuf_mismatch with no resolved drift: the gateway driver is unknown
    // here (could be host-process), so stay gateway-neutral rather than naming a
    // cluster container that may not exist.
    lines.push(
      `  If gateway recreation is required, preserve sandbox state first; do not delete sandbox state, backups, or gateway data until \`openshell status\` reports a healthy ${CLI_DISPLAY_NAME} gateway.`,
    );
  }

  return lines;
}

export function printOpenShellStateRpcIssue(
  issue: OpenShellStateRpcIssue,
  options: FormatIssueOptions = {},
  writer: (message?: string) => void = console.error,
): void {
  for (const line of formatOpenShellStateRpcIssue(issue, options)) {
    writer(line);
  }
}
