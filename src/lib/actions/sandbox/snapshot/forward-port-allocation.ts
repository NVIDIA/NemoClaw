// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  createOpenShellForwardAdapterForAuthority,
  openShellForwardIdentity,
} from "../../../adapters/openshell/forward-runtime";
import {
  createOpenShellForwardPortObserver,
  findAvailableDashboardPortFromObserver,
  getRegistryOccupiedDashboardPorts,
  getRegistryOccupiedHermesApiPorts,
} from "../../../onboard/dashboard-port";
import {
  isValidForwardPort,
  resolveDashboardForwardBind,
} from "../../../onboard/dashboard-runtime";
import { resolveGatewayForwardRuntimeAuthority } from "../../../onboard/gateway-host-runtime";
import { resolveGatewayForwardAuthority } from "../../../onboard/gateway-teardown-authority";
import {
  findAvailableHermesApiPortFromObserver,
  HERMES_API_PORT_ENV,
  readHermesApiPort,
} from "../../../onboard/hermes-api-port";
import { isWsl } from "../../../platform";
import type { SandboxEntry } from "../../../state/registry";

type SnapshotCloneForwardSource = Pick<
  SandboxEntry,
  | "agent"
  | "dashboardPort"
  | "dashboardRemoteBindPrepared"
  | "hermesDashboardEnabled"
  | "hermesDashboardInternalPort"
  | "name"
>;

/** Allocate clone-owned host ports through one exact gateway adapter. */
export async function allocateSnapshotCloneForwardPorts(input: {
  destinationName: string;
  executable: string;
  gatewayName: string;
  gatewayPort: number;
  source: SnapshotCloneForwardSource;
}): Promise<{ dashboardPort: number | null; hermesApiPort: number | null }> {
  const runtime = resolveGatewayForwardRuntimeAuthority(
    resolveGatewayForwardAuthority({
      gatewayName: input.gatewayName,
      gatewayPort: input.gatewayPort,
    }),
  );
  const authority = {
    gatewayEndpoint: runtime.gatewayEndpoint,
    gatewayName: input.gatewayName,
    workspace: "default",
    ...(runtime.localTlsDir ? { localTlsDir: runtime.localTlsDir } : {}),
  };
  const dashboardBind = resolveDashboardForwardBind(input.source, {
    requestedBind: process.env.NEMOCLAW_DASHBOARD_BIND,
    wsl: isWsl(),
  });
  const adapter = createOpenShellForwardAdapterForAuthority(authority, {
    executable: input.executable,
  });
  const observeDashboardForwardPorts = createOpenShellForwardPortObserver({
    adapter,
    forwardForPort: (port) =>
      openShellForwardIdentity(authority, input.destinationName, dashboardBind, port),
  });
  const sourceDashboardPort = input.source.dashboardPort;
  const dashboardOccupied = getRegistryOccupiedDashboardPorts(input.destinationName);
  const hermesInternalPort = input.source.hermesDashboardInternalPort;
  if (input.source.hermesDashboardEnabled === true && isValidForwardPort(hermesInternalPort)) {
    dashboardOccupied.set(
      String(hermesInternalPort),
      `${input.source.name} (Hermes dashboard internal)`,
    );
  }
  const dashboardPort =
    typeof sourceDashboardPort === "number" &&
    Number.isInteger(sourceDashboardPort) &&
    sourceDashboardPort > 0
      ? (
          await findAvailableDashboardPortFromObserver(
            input.destinationName,
            sourceDashboardPort,
            observeDashboardForwardPorts,
            dashboardOccupied,
          )
        ).port
      : null;
  const hermesApiPort =
    input.source.agent === "hermes"
      ? (
          await findAvailableHermesApiPortFromObserver(
            input.destinationName,
            readHermesApiPort({}),
            createOpenShellForwardPortObserver({
              adapter,
              forwardForPort: (port) =>
                openShellForwardIdentity(authority, input.destinationName, "127.0.0.1", port),
            }),
            getRegistryOccupiedHermesApiPorts(input.destinationName),
          )
        ).port
      : null;
  return { dashboardPort, hermesApiPort };
}

export function snapshotCloneHermesApiEnvArgs(port: number | null): string[] {
  return port === null ? [] : [`${HERMES_API_PORT_ENV}=${String(port)}`];
}
