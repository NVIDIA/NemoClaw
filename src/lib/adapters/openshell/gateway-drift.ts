// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { CLI_DISPLAY_NAME, CLI_NAME } from "../../cli/branding";
import { isOpenShellProtobufSchemaMismatch } from "../../runtime-recovery";
import { isGatewayHealthy } from "../../state/gateway";
import { dockerContainerInspectFormat } from "../docker";
import { stripAnsi } from "./client";
import { captureOpenshell, getInstalledOpenshellVersionOrNull } from "./runtime";
import { OPENSHELL_PROBE_TIMEOUT_MS } from "./timeouts";

const DEFAULT_GATEWAY_NAME = "nemoclaw";

export type GatewayClusterImageDrift = {
  containerName: string;
  currentImage: string;
  currentVersion: string;
  expectedVersion: string;
};

export type OpenShellStateRpcIssue =
  | {
      kind: "image_drift";
      drift: GatewayClusterImageDrift;
      output?: string;
    }
  | {
      kind: "protobuf_mismatch";
      drift?: GatewayClusterImageDrift | null;
      output: string;
    };

type GatewayDriftDeps = {
  getInstalledOpenshellVersion?: () => string | null;
  getGatewayClusterImageRef?: (gatewayName: string) => string | null;
  isGatewayClusterActive?: (gatewayName: string) => boolean;
};

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
    typeof deps.isGatewayClusterActive === "function"
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
  const raw = dockerContainerInspectFormat(
    "{{json .NetworkSettings.Ports}}",
    containerName,
    {
      ignoreError: true,
      timeout: timeoutMs,
    },
  ).trim();
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
  if (!isGatewayHealthy(status.output, gatewayInfo.output, activeGatewayInfo.output)) {
    return false;
  }

  const endpointPort =
    parseGatewayEndpointPort(activeGatewayInfo.output) ??
    parseGatewayEndpointPort(gatewayInfo.output);
  if (!endpointPort) return false;

  const containerName = getGatewayClusterContainerName(gatewayName);
  const running = dockerContainerInspectFormat(
    "{{.State.Running}}",
    containerName,
    {
      ignoreError: true,
      timeout: timeoutMs,
    },
  ).trim();
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
    deps.getGatewayClusterImageRef?.(gatewayName) ??
    getGatewayClusterImageRef(gatewayName, { timeoutMs });
  const currentVersion = parseGatewayClusterImageVersion(currentImage);
  if (
    !expectedVersion ||
    !currentImage ||
    !currentVersion ||
    currentVersion === expectedVersion
  ) {
    return null;
  }
  return {
    containerName: getGatewayClusterContainerName(gatewayName),
    currentImage,
    currentVersion,
    expectedVersion,
  };
}

export function detectOpenShellStateRpcPreflightIssue({
  gatewayName = DEFAULT_GATEWAY_NAME,
  deps = {},
  timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS,
}: GatewayDriftOptions = {}): OpenShellStateRpcIssue | null {
  const drift = getGatewayClusterImageDrift({ gatewayName, deps, timeoutMs });
  return drift ? { kind: "image_drift", drift } : null;
}

export function detectOpenShellStateRpcResultIssue(
  result: StateRpcResult,
  { gatewayName = DEFAULT_GATEWAY_NAME, deps = {}, timeoutMs = OPENSHELL_PROBE_TIMEOUT_MS }: GatewayDriftOptions = {},
): OpenShellStateRpcIssue | null {
  const output = String(result.output || "");
  if (!isOpenShellProtobufSchemaMismatch(output)) {
    return null;
  }
  return {
    kind: "protobuf_mismatch",
    drift: isGatewayDriftPreflightDisabled(deps)
      ? null
      : getGatewayClusterImageDrift({ gatewayName, deps, timeoutMs }),
    output,
  };
}

function compactOutput(output: string): string {
  return stripAnsi(output).replace(/\s+/g, " ").trim().slice(0, 260);
}

export function formatOpenShellStateRpcIssue(
  issue: OpenShellStateRpcIssue,
  {
    action = "querying OpenShell sandbox state",
    command,
    gatewayName = DEFAULT_GATEWAY_NAME,
  }: FormatIssueOptions = {},
): string[] {
  const phaseLine =
    issue.kind === "image_drift"
      ? `  OpenShell gateway schema preflight failed before ${action}.`
      : `  OpenShell gateway/schema mismatch was detected while ${action}.`;
  const lines = [
    "",
    phaseLine,
  ];

  const drift = issue.kind === "image_drift" ? issue.drift : issue.drift || null;
  const gatewayContainerName =
    drift?.containerName ?? getGatewayClusterContainerName(gatewayName);
  if (drift) {
    lines.push(
      `  Installed OpenShell: ${drift.expectedVersion}`,
      `  Running gateway image: ${drift.currentImage} (${drift.currentVersion})`,
    );
  } else {
    lines.push(
      `  ${CLI_DISPLAY_NAME} saw protobuf/schema mismatch output from OpenShell.`,
    );
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
    `    1. Run \`${CLI_NAME} onboard --resume\` to repair or recreate the ${CLI_DISPLAY_NAME} gateway with the installed OpenShell image.`,
    `    2. Rerun${command ? ` \`${command}\`` : " the command"} after \`openshell status\` reports a healthy ${CLI_DISPLAY_NAME} gateway.`,
    "",
    `  If gateway recreation is required, preserve sandbox state first; do not remove \`${gatewayContainerName}\` Docker volumes unless you have a backup and explicitly accept state loss.`,
  );

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
