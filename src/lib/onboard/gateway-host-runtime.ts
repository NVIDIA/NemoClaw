// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Host-side gateway runtime wiring for onboarding: the environment a gateway is
 * started with, and the lifecycle authority that decides whether NemoClaw may
 * start one at all (#6576).
 *
 * The ownership decision lives here rather than in the onboard entrypoint so it
 * can be constructed with explicit dependencies and tested directly. The pure
 * contract and decision logic live in `gateway-management` and
 * `gateway-ownership`; this module only binds them to real host probes.
 */

import fs from "node:fs";

import { GATEWAY_PORT } from "../core/ports";
import { getGatewayStartNetworkEnv } from "./docker-driver-gateway-env";
import type { DockerDriverGatewayPortListenerScan } from "./docker-driver-gateway-port-listener";
import { hasOpenShellGatewayUserService } from "./docker-driver-gateway-service";
import { isGatewayHttpReady, waitForGatewayHttpReady } from "./gateway-http-readiness";
import { loadGatewayManagementDeclaration } from "./gateway-management";
import {
  assertGatewayEffectAllowed,
  type GatewayAttachmentProbe,
  type GatewayOwner,
  resolveGatewayOwner,
} from "./gateway-ownership";
import type { PortProbeResult } from "./preflight";

export interface GatewayHostRuntimeDeps {
  applyOverlayfsAutoFix(clusterImage: string): string | null;
  checkGatewayPortAvailable(): Promise<PortProbeResult>;
  getDockerDriverGatewayPortListenerScan(
    portCheck: PortProbeResult,
    opts?: { gatewayBin?: string | null },
  ): DockerDriverGatewayPortListenerScan;
  getInstalledOpenshellVersion(): string | null;
  resolveOpenShellGatewayBinary(): string | null;
  spawnSyncImpl?: typeof import("node:child_process").spawnSync;
  waitForGatewayHttpReady(): Promise<boolean>;
}

export interface GatewayHostRuntime {
  /**
   * Fail before the caller can start a gateway that an external supervisor
   * owns. Applies to onboarding, rebuild, and recovery alike.
   */
  assertGatewayStartAllowed(exitOnFailure: boolean): void;
  getGatewayOwner(): GatewayOwner;
  getGatewayStartEnv(): Record<string, string>;
  /** Gateway-ownership dependencies consumed by the onboarding FSM handler. */
  machineGatewayOwnerDeps: {
    probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
    resolveGatewayOwner(): GatewayOwner;
  };
  probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
}

export function createGatewayHostRuntime(deps: GatewayHostRuntimeDeps): GatewayHostRuntime {
  let cachedOwner: GatewayOwner | null = null;

  /**
   * Resolve the one gateway lifecycle authority for this process. A malformed
   * declaration throws instead of degrading to self-management: a host that
   * meant to hand the gateway to an external supervisor must never silently get
   * a second NemoClaw-owned gateway on the same port.
   */
  function getGatewayOwner(): GatewayOwner {
    if (cachedOwner) return cachedOwner;
    const loaded = loadGatewayManagementDeclaration();
    if (!loaded.ok) {
      throw new Error(`Invalid gateway management declaration: ${loaded.reason}`);
    }
    cachedOwner = resolveGatewayOwner({
      declaration: loaded.declaration,
      hasPackagedService: hasOpenShellGatewayUserService(),
    });
    return cachedOwner;
  }

  function isSupervisorUnitActive(owner: GatewayOwner): boolean | null {
    const supervisor = owner.supervisor;
    if (!supervisor || supervisor.kind === "external") return null;
    const spawnSyncImpl =
      deps.spawnSyncImpl ??
      (require("node:child_process") as typeof import("node:child_process")).spawnSync;
    const scope = supervisor.kind === "systemd-user" ? ["--user"] : [];
    const result = spawnSyncImpl("systemctl", [...scope, "is-active", supervisor.serviceName], {
      encoding: "utf-8",
    });
    if (result.error || result.status === null) return null;
    return String(result.stdout ?? "").trim() === "active";
  }

  function readListenerExecPath(pid: number): string | null {
    try {
      return fs.realpathSync.native(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }

  /**
   * Probe the declared endpoint rather than the process default, so a
   * declaration is never assessed against a different local listener. A
   * declared endpoint on a port this process does not operate is rejected by
   * `evaluateGatewayAttachment`, which sees both values.
   */
  function waitForDeclaredGatewayHttpReady(owner: GatewayOwner): Promise<boolean> {
    if (!owner.endpoint) return deps.waitForGatewayHttpReady();
    return waitForGatewayHttpReady({
      probe: () => isGatewayHttpReady(undefined, `${owner.endpoint}/`),
    });
  }

  /**
   * Gather the evidence needed to decide whether NemoClaw may attach to a
   * gateway it does not own. Read-only: this runs before any effect.
   */
  async function probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe> {
    const portCheck = await deps.checkGatewayPortAvailable();
    const scan = deps.getDockerDriverGatewayPortListenerScan(portCheck, {
      gatewayBin: deps.resolveOpenShellGatewayBinary(),
    });
    const [firstPid] = scan.pids;
    return {
      gatewayPort: GATEWAY_PORT,
      httpReady: await waitForDeclaredGatewayHttpReady(owner),
      // `ok` means the port is free; anything else means something holds it.
      portOccupied: !portCheck.ok,
      listenerPids: scan.pids,
      listenerScanComplete: scan.complete,
      supervisorActive: isSupervisorUnitActive(owner),
      listenerExecPath: typeof firstPid === "number" ? readListenerExecPath(firstPid) : null,
    };
  }

  function assertGatewayStartAllowed(exitOnFailure: boolean): void {
    try {
      assertGatewayEffectAllowed(getGatewayOwner(), "start");
    } catch (error) {
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      if (exitOnFailure) process.exit(1);
      throw error;
    }
  }

  function getGatewayStartEnv(): Record<string, string> {
    const gatewayEnv = getGatewayStartNetworkEnv(GATEWAY_PORT);
    const openshellVersion = deps.getInstalledOpenshellVersion();
    const stableGatewayImage = openshellVersion
      ? `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`
      : null;
    if (stableGatewayImage && openshellVersion) {
      gatewayEnv.OPENSHELL_CLUSTER_IMAGE = stableGatewayImage;
      gatewayEnv.IMAGE_TAG = openshellVersion;
      const overlayOverride = deps.applyOverlayfsAutoFix(stableGatewayImage);
      if (overlayOverride) {
        gatewayEnv.OPENSHELL_CLUSTER_IMAGE = overlayOverride;
      }
    }
    return gatewayEnv;
  }

  return {
    assertGatewayStartAllowed,
    getGatewayOwner,
    getGatewayStartEnv,
    machineGatewayOwnerDeps: { probeGatewayAttachment, resolveGatewayOwner: getGatewayOwner },
    probeGatewayAttachment,
  };
}
