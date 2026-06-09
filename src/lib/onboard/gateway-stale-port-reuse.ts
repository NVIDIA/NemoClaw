// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { GatewayReuseState } from "../state/gateway";
import { destroyGatewayForReuse } from "./gateway-cleanup";
import type { GatewayContainerState } from "./gateway-container-running";
import type { CheckPortOpts, PortProbeResult } from "./preflight";

export type GatewayPortReuseDecision = "stale" | "reuse" | "skip";

export interface GatewayPortReuseInput {
  gatewayReuseState: GatewayReuseState;
  supportsLifecycleCommands: boolean;
  containerState: GatewayContainerState;
}

// When the preflight port-required check finds the gateway port occupied, the
// short-circuit in onboard.ts trusts `gatewayReuseState === "healthy"` and
// reuses the recorded runtime. That short-circuit can fire even after the
// openshell-cluster-* container has been removed out-of-band (Colima/Docker
// restart on macOS; manual `docker rm`), because the upstream stale-metadata
// check that would have cleared the recorded state is gated by
// `gatewayCliSupportsLifecycleCommands` and can be skipped. (#4268)
//
// This decision wraps the second-line defense: when the port is the gateway
// port and recorded state is "healthy", consult the live container state
// before reusing. Returns:
//   - "stale"  — recorded state is "healthy" but the legacy container is
//                missing; caller should clear registry and re-check the port.
//   - "reuse"  — recorded state is "healthy" and the container is live (or the
//                CLI lacks lifecycle commands, so the container model is
//                package-managed and Docker is not the source of truth).
//   - "skip"   — recorded state is not "healthy"; this defensive path does not
//                apply and the caller should fall through to other handling.
export function classifyGatewayPortReuse(input: GatewayPortReuseInput): GatewayPortReuseDecision {
  if (input.gatewayReuseState !== "healthy") return "skip";
  if (!input.supportsLifecycleCommands) return "reuse";
  if (input.containerState === "missing") return "stale";
  return "reuse";
}

export interface HealthyPortReuseInput {
  port: number;
  gatewayPort: number;
  dashboardPort: number;
  label: string;
  runtimeDisplayName: string;
  gatewayName: string;
  gatewayReuseState: GatewayReuseState;
  portCheckOptions: CheckPortOpts | undefined;
  supportsLifecycleCommands: boolean;
  destroyGateway: () => boolean;
  runOpenshell: (args: string[], opts: { ignoreError: true }) => unknown;
  checkPortAvailable: (port?: number, opts?: CheckPortOpts) => Promise<PortProbeResult>;
  verifyGatewayContainerRunning: (gatewayName: string) => GatewayContainerState;
}

export type HealthyPortReuseOutcome =
  | "continue"
  | { gatewayReuseState: GatewayReuseState; portCheck: PortProbeResult };

// Drive the port-required short-circuit when `gatewayReuseState === "healthy"`.
// Owns the stale-container detection, registry cleanup, port re-check, and
// console messaging. Returns `null` when the recorded state isn't reusable
// (caller should fall through to its usual port-conflict handling); returns
// "continue" when the loop iteration should be skipped; otherwise returns the
// updated `gatewayReuseState` plus the re-checked port result so the caller
// can replay the iteration with fresh state.
export async function applyHealthyPortReuse(
  input: HealthyPortReuseInput,
): Promise<HealthyPortReuseOutcome | null> {
  const { port, gatewayPort, dashboardPort, label, runtimeDisplayName, gatewayName } = input;
  if (input.gatewayReuseState !== "healthy") return null;
  if (port !== gatewayPort && port !== dashboardPort) return null;
  // Only probe the container when lifecycle commands are advertised — for
  // package-managed gateways without lifecycle commands the openshell-cluster-*
  // container intentionally doesn't exist and the probe would always report
  // "missing", which is then ignored by classifyGatewayPortReuse anyway.
  if (port === gatewayPort && input.supportsLifecycleCommands) {
    const decision = classifyGatewayPortReuse({
      gatewayReuseState: input.gatewayReuseState,
      supportsLifecycleCommands: true,
      containerState: input.verifyGatewayContainerRunning(gatewayName),
    });
    if (decision === "stale") {
      console.log("  Gateway metadata is stale (container not running). Cleaning up...");
      input.runOpenshell(["forward", "stop", String(dashboardPort)], { ignoreError: true });
      const gatewayReuseState = destroyGatewayForReuse(
        input.destroyGateway,
        "  ✓ Stale gateway metadata cleaned up",
        "  ! Stale gateway metadata cleanup failed; leaving registry state intact.",
      );
      const portCheck = await input.checkPortAvailable(port, input.portCheckOptions);
      if (portCheck.ok) {
        console.log(`  ✓ Port ${port} available (${label})`);
      }
      // Always return the downgraded state so the caller stops treating the
      // runtime as healthy. The caller uses `portCheck.ok` to decide whether
      // to continue the loop or fall through to its port-conflict diagnostic.
      return { gatewayReuseState, portCheck };
    }
  }
  console.log(`  ✓ Port ${port} already owned by healthy ${runtimeDisplayName} runtime (${label})`);
  return "continue";
}
