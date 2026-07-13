// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { printPortConflictReport } from "./port-conflict-report";
import type { CheckPortOpts, PortProbeResult } from "./preflight";
import { getPortConflictServiceHints } from "./remediation";

type CheckPortAvailable = (port: number, opts?: CheckPortOpts) => Promise<PortProbeResult>;
type DockerGatewayPortListenerClassifier = (portCheck: PortProbeResult) => boolean;

export interface GatewayPortConflictDeps {
  gatewayPort: number;
  checkPortAvailable: CheckPortAvailable;
  getGatewayPortCheckOptions: () => CheckPortOpts;
  isDockerDriverGatewayPortListener: DockerGatewayPortListenerClassifier;
  exitProcess?: (code: number) => void;
  serviceHints?: string[];
  writeError?: (line: string) => void;
}

const GATEWAY_PORT_LISTENER_CANDIDATE_PROCESSES = [
  "openshell",
  "openshell-gateway",
  "docker-proxy",
  "com.docker.backend",
  "vpnkit",
  "rootlesskit",
  "slirp4netns",
];

export function couldBeNemoClawGatewayPortListener(
  portCheck: PortProbeResult,
  isDockerDriverGatewayPortListener: DockerGatewayPortListenerClassifier,
): boolean {
  if (portCheck.ok) return false;
  const processName = String(portCheck.process || "").toLowerCase();
  if (!processName || processName === "unknown") return true;
  if (isDockerDriverGatewayPortListener(portCheck)) return true;
  return GATEWAY_PORT_LISTENER_CANDIDATE_PROCESSES.some(
    (candidate) =>
      processName === candidate ||
      processName.startsWith(`${candidate}-`) ||
      processName.startsWith(`${candidate}.`),
  );
}

export async function failFastOnForeignGatewayPortConflict({
  gatewayPort,
  checkPortAvailable,
  getGatewayPortCheckOptions,
  isDockerDriverGatewayPortListener,
  exitProcess = (code) => process.exit(code),
  serviceHints = getPortConflictServiceHints(),
  writeError,
}: GatewayPortConflictDeps): Promise<void> {
  const portCheck = await checkPortAvailable(gatewayPort, getGatewayPortCheckOptions());
  if (
    portCheck.ok ||
    couldBeNemoClawGatewayPortListener(portCheck, isDockerDriverGatewayPortListener)
  ) {
    return;
  }

  printPortConflictReport(
    {
      port: gatewayPort,
      label: "OpenShell gateway",
      envVar: "NEMOCLAW_GATEWAY_PORT",
      portCheck,
      serviceHints,
    },
    writeError,
  );
  exitProcess(1);
}
