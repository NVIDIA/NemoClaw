// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { warnLine } from "../cli/terminal-style";
import type { GatewayReuseState } from "../state/gateway";

export type PreflightGatewayCleanupAction = "defer" | "destroy-legacy" | "noop";

export const PREFLIGHT_DEFERRED_RECREATE_MESSAGE =
  "Gateway will be recreated when sandbox creation starts — this will affect running sandboxes.";

export function preflightGatewayCleanupDecision(opts: {
  gatewayReuseState: GatewayReuseState;
  isDockerDriverGatewayEnabled: boolean;
  externallySupervised?: boolean;
}): PreflightGatewayCleanupAction {
  // An externally supervised gateway is never cleaned up by NemoClaw, even from
  // preflight: stale metadata or an interrupted prior run must not let this
  // destroy a gateway whose declared supervisor is the sole lifecycle authority
  // (#6576). The FSM attach path is the only thing that touches it.
  if (opts.externallySupervised) return "noop";
  if (opts.gatewayReuseState !== "stale" && opts.gatewayReuseState !== "active-unnamed") {
    return "noop";
  }
  return opts.isDockerDriverGatewayEnabled ? "defer" : "destroy-legacy";
}

export interface PreflightGatewayCleanupDeps {
  gatewayReuseState: GatewayReuseState;
  isDockerDriverGatewayEnabled: boolean;
  externallySupervised?: boolean;
  cliDisplayName: string;
  dashboardPort: number;
  log: (line: string) => void;
  warn: (line: string) => void;
  runOpenshell: (args: string[], options: { ignoreError: true }) => unknown;
  destroyGateway: () => boolean;
  destroyGatewayForReuse: (
    destroy: () => boolean,
    successMessage: string,
    failureMessage: string,
  ) => GatewayReuseState;
}

export function applyPreflightGatewayCleanup(deps: PreflightGatewayCleanupDeps): GatewayReuseState {
  const action = preflightGatewayCleanupDecision({
    gatewayReuseState: deps.gatewayReuseState,
    isDockerDriverGatewayEnabled: deps.isDockerDriverGatewayEnabled,
    externallySupervised: deps.externallySupervised,
  });
  if (action === "defer") {
    deps.warn(warnLine(PREFLIGHT_DEFERRED_RECREATE_MESSAGE));
    return deps.gatewayReuseState;
  }
  if (action === "destroy-legacy") {
    deps.log(`  Cleaning up previous ${deps.cliDisplayName} session...`);
    deps.runOpenshell(["forward", "stop", String(deps.dashboardPort)], { ignoreError: true });
    return deps.destroyGatewayForReuse(
      deps.destroyGateway,
      "  ✓ Previous session cleaned up",
      "  ! Previous session cleanup failed; leaving registry state intact.",
    );
  }
  return deps.gatewayReuseState;
}
