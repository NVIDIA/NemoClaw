// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";

export type PreflightGatewayCleanupAction = "defer" | "destroy-legacy" | "noop";

export const PREFLIGHT_DEFERRED_RECREATE_MESSAGE =
  "  ⚠ Gateway will be recreated when sandbox creation starts — this will affect running sandboxes.";

export function preflightGatewayCleanupDecision(opts: {
  gatewayReuseState: GatewayReuseState;
  isDockerDriverGatewayEnabled: boolean;
}): PreflightGatewayCleanupAction {
  if (opts.gatewayReuseState !== "stale" && opts.gatewayReuseState !== "active-unnamed") {
    return "noop";
  }
  return opts.isDockerDriverGatewayEnabled ? "defer" : "destroy-legacy";
}

export interface PreflightGatewayCleanupDeps {
  gatewayReuseState: GatewayReuseState;
  isDockerDriverGatewayEnabled: boolean;
  cliDisplayName: string;
  dashboardPort: number;
  log: (line: string) => void;
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
  });
  if (action === "defer") {
    deps.log(PREFLIGHT_DEFERRED_RECREATE_MESSAGE);
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
