// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { buildValidatedCurlCommandArgs } from "../../adapters/http/curl-args";
import { stripAnsi } from "../../adapters/openshell/client";
import { CLI_NAME } from "../../cli/branding";
import { GATEWAY_PORT, OLLAMA_PORT } from "../../core/ports";
import { isLinuxDockerDriverGatewayEnabled } from "../../onboard/docker-driver-platform";
import type { SandboxEntry } from "../../state/registry";
import { readCloudflaredState } from "../../tunnel/services";
import {
  buildGatewayInspectFailureChecks,
  type GatewayInspectOptions,
} from "./doctor-gateway-fallback";
import { captureHostCommand } from "./doctor-host-command";
import type { DoctorCheck } from "./doctor-report";

export function oneLine(value = ""): string {
  return String(value).replace(/\s+/g, " ").trim();
}

function gatewayContainerCheck(
  containerName: string,
  output: string,
  options: GatewayInspectOptions,
): DoctorCheck {
  const [runningRaw, healthRaw, imageRaw] = output.trim().split("\t");
  const running = runningRaw === "true";
  const health = healthRaw || "none";
  const image = imageRaw || "unknown";
  const healthy = health === "healthy" || health === "none";
  return {
    group: "Gateway",
    label: "Docker container",
    status: running && healthy ? "ok" : "fail",
    detail: `${containerName} ${running ? "running" : "stopped"} (${health}; ${image})`,
    hint: running
      ? undefined
      : `restart the gateway with \`openshell gateway start --name ${options.gatewayName ?? "nemoclaw"}\``,
  };
}

function gatewayPortCheck(containerName: string, expectedHostPort: number): DoctorCheck {
  const port = captureHostCommand("docker", ["port", containerName, "30051/tcp"], 5000);
  if (port.status !== 0 || !port.stdout.trim()) {
    return {
      group: "Gateway",
      label: "Port mapping",
      status: "fail",
      detail: "30051/tcp is not published on the host",
      hint: "gateway traffic will not reach OpenShell until the container is recreated with a host port",
    };
  }
  const mapping = oneLine(port.stdout);
  const expected = new RegExp(`:${expectedHostPort}(?:\\s|$)`).test(mapping);
  return {
    group: "Gateway",
    label: "Port mapping",
    status: expected ? "ok" : "warn",
    detail: mapping,
    hint: expected ? undefined : `expected host port ${expectedHostPort} for this sandbox gateway`,
  };
}

export function dockerInspectGateway(
  containerName: string,
  options: GatewayInspectOptions = {},
  expectedHostPort = GATEWAY_PORT,
): DoctorCheck[] {
  const inspect = captureHostCommand(
    "docker",
    [
      "inspect",
      "--format",
      "{{.State.Running}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.Config.Image}}",
      containerName,
    ],
    5000,
  );
  if (inspect.status !== 0) {
    return buildGatewayInspectFailureChecks(containerName, options);
  }
  return [
    gatewayContainerCheck(containerName, inspect.stdout, options),
    gatewayPortCheck(containerName, expectedHostPort),
  ];
}

export function findSandboxListLine(output: string, sandboxName: string): string | null {
  const lines = stripAnsi(output).split(/\r?\n/);
  return (
    lines.find((line: string) => {
      const columns = line.trim().split(/\s+/);
      return columns.includes(sandboxName);
    }) || null
  );
}

export function inferSandboxReadyFromLine(line: string | null): boolean | null {
  if (!line) return null;
  if (/\bReady\b/i.test(line)) return true;
  if (/\b(Failed|Error|CrashLoopBackOff|ImagePullBackOff|Unknown|Evicted)\b/i.test(line)) {
    return false;
  }
  return null;
}

function stoppedCloudflaredCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "info",
    detail: "stopped",
    hint: `no cloudflared process; run \`${CLI_NAME} tunnel start\` to start it`,
  };
}

function staleCloudflaredPidFileCheck(): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: "stale PID file",
    hint: `no cloudflared process (stored PID is invalid); run \`${CLI_NAME} tunnel start\` to restart it`,
  };
}

function staleCloudflaredPidCheck(pid: number): DoctorCheck {
  return {
    group: "Local services",
    label: "cloudflared",
    status: "warn",
    detail: `stale PID ${pid}`,
    hint: `no cloudflared process (PID ${pid} is dead or not cloudflared); run \`${CLI_NAME} tunnel start\` to restart it`,
  };
}

export function cloudflaredDoctorCheck(sandboxName: string): DoctorCheck {
  const state = readCloudflaredState(path.join("/tmp", `nemoclaw-services-${sandboxName}`));
  switch (state.kind) {
    case "stopped":
      return stoppedCloudflaredCheck();
    case "stale-pid-file":
      return staleCloudflaredPidFileCheck();
    case "stale-pid-process":
      return staleCloudflaredPidCheck(state.pid);
    case "running":
      return {
        group: "Local services",
        label: "cloudflared",
        status: "ok",
        detail: `running (PID ${state.pid})`,
      };
  }
}

export function ollamaDoctorCheck(currentProvider: string): DoctorCheck {
  const endpoint = `http://127.0.0.1:${OLLAMA_PORT}/api/tags`;
  const result = captureHostCommand(
    "curl",
    buildValidatedCurlCommandArgs(["-sS", "--connect-timeout", "2", "--max-time", "4", endpoint]),
    6000,
  );
  const required = currentProvider === "ollama-local";
  if (result.status !== 0) {
    return {
      group: "Local services",
      label: "Ollama",
      status: required ? "fail" : "info",
      detail: `not reachable at ${endpoint}`,
      hint: required ? "start Ollama or change the sandbox inference provider" : undefined,
    };
  }

  let modelCount = "unknown model count";
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed.models)) modelCount = `${parsed.models.length} model(s)`;
  } catch {
    /* keep generic detail */
  }
  return {
    group: "Local services",
    label: "Ollama",
    status: "ok",
    detail: `reachable at ${endpoint} (${modelCount})`,
  };
}

/**
 * The legacy k3s gateway container only exists for the Kubernetes driver.
 * Prefer the recorded driver and use platform detection for older entries.
 */
export function shouldInspectLegacyGatewayContainer(sb: SandboxEntry | null | undefined): boolean {
  const driver = sb?.openshellDriver;
  if (driver === "docker" || driver === "vm") return false;
  if (driver === "kubernetes") return true;
  return !isLinuxDockerDriverGatewayEnabled();
}
