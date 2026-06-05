// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  getGatewayReuseState,
  shouldSelectNamedGatewayForReuse,
} from "../state/gateway";

export type GatewayReuseSnapshot = {
  gatewayStatus: string;
  gwInfo: string;
  activeGatewayInfo: string;
  gatewayReuseState: ReturnType<typeof getGatewayReuseState>;
};

export interface GatewayReuseDeps {
  gatewayName: string;
  runCaptureOpenshell(args: string[], opts?: Record<string, unknown>): string;
  runOpenshell(args: string[], opts?: Record<string, unknown>): { status: number | null };
  cliDisplayName(): string;
}

export interface GatewayReuseHelpers {
  getGatewayReuseSnapshot(): GatewayReuseSnapshot;
  selectNamedGatewayForReuseIfNeeded(snapshot: GatewayReuseSnapshot): GatewayReuseSnapshot;
}

export function createGatewayReuseHelpers(deps: GatewayReuseDeps): GatewayReuseHelpers {
  function getGatewayReuseSnapshot(): GatewayReuseSnapshot {
    const gatewayStatus = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    const gwInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", deps.gatewayName], {
      ignoreError: true,
    });
    const activeGatewayInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    return {
      gatewayStatus,
      gwInfo,
      activeGatewayInfo,
      gatewayReuseState: getGatewayReuseState(
        gatewayStatus,
        gwInfo,
        activeGatewayInfo,
        deps.gatewayName,
      ),
    };
  }

  function selectNamedGatewayForReuseIfNeeded(snapshot: GatewayReuseSnapshot): GatewayReuseSnapshot {
    if (
      !shouldSelectNamedGatewayForReuse(
        snapshot.gatewayStatus,
        snapshot.gwInfo,
        snapshot.activeGatewayInfo,
        deps.gatewayName,
      )
    ) {
      return snapshot;
    }

    const selectResult = deps.runOpenshell(["gateway", "select", deps.gatewayName], {
      ignoreError: true,
      suppressOutput: true,
    });
    if (selectResult.status !== 0) {
      return snapshot;
    }

    const refreshed = getGatewayReuseSnapshot();
    if (refreshed.gatewayReuseState === "healthy") {
      process.env.OPENSHELL_GATEWAY = deps.gatewayName;
      console.log(`  ✓ Selected existing ${deps.cliDisplayName()} gateway`);
    }
    return refreshed;
  }

  return { getGatewayReuseSnapshot, selectNamedGatewayForReuseIfNeeded };
}
