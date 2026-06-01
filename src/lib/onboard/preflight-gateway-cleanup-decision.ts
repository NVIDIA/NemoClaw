// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DASHBOARD_PORT } from "../core/ports";
import { listLiveSandboxNames, type GatewayReuseState } from "../state/gateway";

export type PreflightGatewayCleanupAction =
  | "defer"
  | "destroy-legacy"
  | "refuse"
  | "noop";

export const PREFLIGHT_DEFERRED_RECREATE_MESSAGE =
  "  ⚠ Gateway will be recreated when sandbox creation starts — this will affect running sandboxes.";

export const PREFLIGHT_LIVE_SANDBOX_REFUSAL_HEADER =
  "  ✗ Refusing to recreate gateway: live sandbox(es) would be destroyed.";

// Decision for the preflight gateway cleanup step. Returns:
//   - "refuse"         — drift would trigger a destructive gateway recreate
//                        while one or more sandboxes are live (Ready/Running).
//                        The singleton-gateway design (`GATEWAY_NAME = "nemoclaw"`)
//                        means the shared cluster container holds every sandbox,
//                        so recreating the gateway SIGKILLs them.
//   - "defer"          — Docker-driver path: postpone the recreate to step [2/8]
//                        when no live sandboxes are at risk.
//   - "destroy-legacy" — pre-Docker-driver path: destroy immediately so the
//                        port frees up for the upcoming port-availability checks.
//   - "noop"           — recorded state needs no preflight cleanup.
export function preflightGatewayCleanupDecision(opts: {
  gatewayReuseState: GatewayReuseState;
  isDockerDriverGatewayEnabled: boolean;
  liveSandboxNames: readonly string[];
}): PreflightGatewayCleanupAction {
  if (opts.gatewayReuseState !== "stale" && opts.gatewayReuseState !== "active-unnamed") {
    return "noop";
  }
  if (opts.isDockerDriverGatewayEnabled && opts.liveSandboxNames.length > 0) {
    return "refuse";
  }
  return opts.isDockerDriverGatewayEnabled ? "defer" : "destroy-legacy";
}

export interface PreflightGatewayCleanupDeps {
  gatewayReuseState: GatewayReuseState;
  isDockerDriverGatewayEnabled: boolean;
  cliDisplayName: string;
  cliCommandName: string;
  dashboardPort: number;
  liveSandboxNames: readonly string[];
  log: (line: string) => void;
  runOpenshell: (args: string[], options: { ignoreError: true }) => unknown;
  destroyGateway: () => boolean;
  destroyGatewayForReuse: (
    destroy: () => boolean,
    successMessage: string,
    failureMessage: string,
  ) => GatewayReuseState;
  exitProcess: (code: number) => never;
}

export interface RunPreflightGatewayCleanupDeps {
  gatewayReuseState: GatewayReuseState;
  isLinuxDockerDriverGatewayEnabled: () => boolean;
  runCaptureOpenshell: (args: string[], options: { ignoreError: true }) => string;
  runOpenshell: (args: string[], options: { ignoreError: true }) => unknown;
  cliName: () => string;
  cliDisplayName: () => string;
  destroyGateway: () => boolean;
  destroyGatewayForReuse: (
    destroy: () => boolean,
    successMessage: string,
    failureMessage: string,
  ) => GatewayReuseState;
}

// Convenience wrapper for the onboard call site: fetches the live-sandbox set
// from `openshell sandbox list`, resolves CLI display/command names, and wires
// `process.exit` for the refuse path. Tests target `applyPreflightGatewayCleanup`
// directly for fine-grained dependency injection.
export function runPreflightGatewayCleanup(
  deps: RunPreflightGatewayCleanupDeps,
): GatewayReuseState {
  return applyPreflightGatewayCleanup({
    gatewayReuseState: deps.gatewayReuseState,
    isDockerDriverGatewayEnabled: deps.isLinuxDockerDriverGatewayEnabled(),
    cliDisplayName: deps.cliDisplayName(),
    cliCommandName: deps.cliName(),
    dashboardPort: DASHBOARD_PORT,
    liveSandboxNames: listLiveSandboxNames(
      deps.runCaptureOpenshell(["sandbox", "list"], { ignoreError: true }),
    ),
    log: console.log,
    runOpenshell: deps.runOpenshell,
    destroyGateway: deps.destroyGateway,
    destroyGatewayForReuse: deps.destroyGatewayForReuse,
    exitProcess: (code) => process.exit(code),
  });
}

export function applyPreflightGatewayCleanup(
  deps: PreflightGatewayCleanupDeps,
): GatewayReuseState {
  const action = preflightGatewayCleanupDecision({
    gatewayReuseState: deps.gatewayReuseState,
    isDockerDriverGatewayEnabled: deps.isDockerDriverGatewayEnabled,
    liveSandboxNames: deps.liveSandboxNames,
  });
  if (action === "refuse") {
    const names = deps.liveSandboxNames.join(", ");
    deps.log(PREFLIGHT_LIVE_SANDBOX_REFUSAL_HEADER);
    deps.log(`    Live sandbox(es): ${names}`);
    deps.log(
      "    Recreating the gateway here would SIGKILL the running sandbox container(s)",
    );
    deps.log("    and leave them in Phase=Error.");
    deps.log("");
    deps.log("  Resolve with one of:");
    for (const name of deps.liveSandboxNames) {
      deps.log(`    - ${deps.cliCommandName} ${name} stop`);
    }
    deps.log(
      "    - Onboard with the existing NEMOCLAW_GATEWAY_PORT (do not change it).",
    );
    deps.log("");
    deps.log(
      "  Concurrent NemoClaw instances on a single host are tracked in #3053;",
    );
    deps.log(
      "  this refusal protects existing sandboxes until that support lands.",
    );
    deps.exitProcess(1);
  }
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
