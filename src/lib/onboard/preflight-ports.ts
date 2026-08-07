// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  HERMES_API_PORT_RANGE_END,
  HERMES_API_PORT_RANGE_START,
  isHermesApiPort,
} from "../core/ports";

/** Agent-neutral rejection when a Hermes API port is requested as a dashboard port; shared by both #4984 guards. */
export function reservedHermesDashboardPortMessage(port: number): string {
  return `[SECURITY] Invalid dashboard port ${port} - reserved for the Hermes OpenAI-compatible API (${HERMES_API_PORT_RANGE_START}-${HERMES_API_PORT_RANGE_END})`;
}

export type PreflightPortKind = "gateway" | "dashboard" | "other";

export interface PreflightPort {
  kind: PreflightPortKind;
  port: number;
  label: string;
  envVar: string;
}

/**
 * Build the preflight required-ports list: the OpenShell gateway always, plus
 * the dashboard port when an explicit one is requested (auto-allocation skips
 * it). Extracted from onboard.ts so the reserved-port guard can live in a
 * submodule. (#4984)
 */
export function buildRequiredPreflightPorts(opts: {
  gatewayPort: number;
  dashboardPort: number | null;
  dashboardLabel: string;
}): PreflightPort[] {
  return [
    {
      kind: "gateway",
      port: opts.gatewayPort,
      label: "OpenShell gateway",
      envVar: "NEMOCLAW_GATEWAY_PORT",
    },
    ...(opts.dashboardPort !== null
      ? [
          {
            kind: "dashboard" as const,
            port: opts.dashboardPort,
            label: opts.dashboardLabel,
            envVar: "NEMOCLAW_DASHBOARD_PORT",
          },
        ]
      : []),
  ];
}

/**
 * Reject a Hermes API port as a dashboard port at preflight (any agent) so
 * onboarding fails fast at [1/8], before any sandbox. Every port in the API
 * range is reserved because each Hermes sandbox allocates its own from that
 * range, so a dashboard on any of them would collide with a sibling sandbox.
 * Mirrors the createSandbox guard in resolveHermesDashboardOnboardState. (#4984)
 */
export function assertDashboardPortNotReserved(
  dashboardPort: number | null,
  fail: (message: string) => never = (message) => {
    console.error(`  ${message}`);
    process.exit(1);
  },
): void {
  if (dashboardPort !== null && isHermesApiPort(dashboardPort)) {
    fail(reservedHermesDashboardPortMessage(dashboardPort));
  }
}
