// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { HERMES_OPENAI_API_PORT } from "../core/ports";

/** Agent-neutral rejection message when {@link HERMES_OPENAI_API_PORT} is requested as a dashboard port; shared by both #4984 guards. */
export const RESERVED_HERMES_DASHBOARD_PORT_MESSAGE = `[SECURITY] Invalid dashboard port ${HERMES_OPENAI_API_PORT} - reserved for the Hermes OpenAI-compatible API`;

export interface PreflightPort {
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
    { port: opts.gatewayPort, label: "OpenShell gateway", envVar: "NEMOCLAW_GATEWAY_PORT" },
    ...(opts.dashboardPort !== null
      ? [
          {
            port: opts.dashboardPort,
            label: opts.dashboardLabel,
            envVar: "NEMOCLAW_DASHBOARD_PORT",
          },
        ]
      : []),
  ];
}

/**
 * Reject the reserved {@link HERMES_OPENAI_API_PORT} as a dashboard port at
 * preflight (any agent) so onboarding fails fast at [1/8], before any sandbox.
 * Mirrors the createSandbox guard in resolveHermesDashboardOnboardState. (#4984)
 */
export function assertDashboardPortNotReserved(
  dashboardPort: number | null,
  fail: (message: string) => never = (message) => {
    console.error(`  ${message}`);
    process.exit(1);
  },
): void {
  if (dashboardPort === HERMES_OPENAI_API_PORT) {
    fail(RESERVED_HERMES_DASHBOARD_PORT_MESSAGE);
  }
}
