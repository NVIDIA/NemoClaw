// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { GATEWAY_PORT } from "../../core/ports";
import { HOST_GATEWAY_PGREP_PATTERN } from "../../onboard/host-gateway-process";
import type { DoctorCheck } from "./doctor";
import { captureHostCommand, type CommandCapture } from "./doctor-host-command";

export type GatewayInspectOptions = {
  namedGatewayConnected?: boolean;
};

type LocalGatewayProbe = {
  portListening: boolean;
  processRunning: boolean;
  unavailableTools: string[];
};

function commandUnavailable(capture: CommandCapture): boolean {
  const errorCode = (capture.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT" || errorCode === "EACCES") return true;
  const detail = `${capture.stderr}\n${capture.error?.message ?? ""}`.toLowerCase();
  return detail.includes("command not found") || detail.includes("permission denied");
}

function probeLocalGatewayProcess(): LocalGatewayProbe {
  const processCheck = captureHostCommand("pgrep", ["-f", HOST_GATEWAY_PGREP_PATTERN], 5000);
  const portCheck = captureHostCommand("ss", ["-ltn", `( sport = :${GATEWAY_PORT} )`], 5000);
  const pgrepUnavailable = commandUnavailable(processCheck);
  const ssUnavailable = commandUnavailable(portCheck);
  return {
    processRunning:
      !pgrepUnavailable && processCheck.status === 0 && processCheck.stdout.trim().length > 0,
    portListening:
      !ssUnavailable && portCheck.status === 0 && portCheck.stdout.includes(`:${GATEWAY_PORT}`),
    unavailableTools: [pgrepUnavailable ? "pgrep" : null, ssUnavailable ? "ss" : null].filter(
      (tool): tool is string => tool !== null,
    ),
  };
}

export function buildGatewayInspectFailureChecks(
  containerName: string,
  options: GatewayInspectOptions,
): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const probe = probeLocalGatewayProcess();

  // Compatibility boundary: Docker-driver gateways are verified by OpenShell's
  // named-gateway status and a host openshell-gateway process, while older
  // installs still use the legacy openshell-cluster-* container inspection.
  // Keep both sources until the legacy container path is retired, then remove
  // this fallback with the stale inspect check.
  if (probe.processRunning && probe.portListening) {
    checks.push({
      group: "Gateway",
      label: "Local gateway process",
      status: options.namedGatewayConnected ? "ok" : "info",
      detail: options.namedGatewayConnected
        ? `openshell-gateway is running, listening on port ${GATEWAY_PORT}, and verified by OpenShell`
        : `openshell-gateway process and port ${GATEWAY_PORT} are present, but the named gateway is not verified`,
      hint: options.namedGatewayConnected
        ? undefined
        : "check the OpenShell status result below before trusting the local gateway probe",
    });
    return checks;
  }

  if (options.namedGatewayConnected) {
    if (probe.unavailableTools.length > 0) {
      checks.push({
        group: "Gateway",
        label: "Local gateway probe",
        status: "info",
        detail: `local probe skipped (${probe.unavailableTools.join(", ")} unavailable); OpenShell reports the named gateway connected`,
      });
      return checks;
    }

    checks.push({
      group: "Gateway",
      label: "Legacy Docker container",
      status: "info",
      detail: `${containerName} not inspectable; OpenShell reports the named gateway connected`,
    });
    return checks;
  }

  if (probe.unavailableTools.length > 0) {
    checks.push({
      group: "Gateway",
      label: "Local gateway probe",
      status: "info",
      detail: `skipped because ${probe.unavailableTools.join(", ")} unavailable`,
      hint: "install procps/iproute2 or use the OpenShell status check below for gateway confirmation",
    });
  }

  checks.push({
    group: "Gateway",
    label: "Docker container",
    status: "fail",
    detail: `${containerName} not found or not inspectable`,
    hint: `run \`docker ps --filter name=${containerName}\``,
  });
  return checks;
}
