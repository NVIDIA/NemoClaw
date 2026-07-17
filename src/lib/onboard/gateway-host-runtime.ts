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

import type { DockerDriverGatewayPortListenerScan } from "./docker-driver-gateway-port-listener";
import { hasOpenShellGatewayUserService } from "./docker-driver-gateway-service";
import { isGatewayHttpReady, waitForGatewayHttpReady } from "./gateway-http-readiness";
import { loadGatewayManagementDeclaration } from "./gateway-management";
import {
  assertGatewayEffectAllowed,
  cgroupBelongsToUnit,
  describeGatewayOwnerForError,
  type GatewayAttachmentProbe,
  type GatewayOwner,
  isExternallySupervised,
  resolveGatewayOwner,
  sameGatewayOwner,
} from "./gateway-ownership";
import type { PortProbeResult } from "./preflight";

/** `systemctl is-active` is a local query; anything slower than this is wedged. */
const SUPERVISOR_PROBE_TIMEOUT_MS = 5_000;

export interface GatewayHostRuntimeDeps {
  applyOverlayfsAutoFix(clusterImage: string): string | null;
  checkGatewayPortAvailable(): Promise<PortProbeResult>;
  /**
   * Read lazily: the onboarding entrypoint rebinds its gateway port at runtime
   * when an authoritative gateway is selected, so a captured value goes stale.
   */
  gatewayPort(): number;
  /**
   * Unfiltered listener enumeration. An externally supervised gateway is an
   * ordinary systemd-run executable with no Docker-driver env markers, so the
   * Docker-driver-filtered scan would discard it and report an unknown listener.
   */
  getGatewayPortListenerRawScan(
    portCheck: PortProbeResult,
    opts?: { gatewayBin?: string | null },
  ): DockerDriverGatewayPortListenerScan;
  getInstalledOpenshellVersion(): string | null;
  resolveOpenShellGatewayBinary(): string | null;
  spawnSyncImpl?: typeof import("node:child_process").spawnSync;
  /** Overrides the readiness request; defaults to a real probe of `endpoint`. */
  probeGatewayHttpReady?(endpoint: string | null): Promise<boolean>;
  /** Overrides `/proc/<pid>/exe` resolution; defaults to the real symlink. */
  readProcExe?(pid: number): string | null;
  /** Overrides `/proc/<pid>/cgroup` reads; defaults to the real file. */
  readProcCgroup?(pid: number): string | null;
  waitForGatewayHttpReady(): Promise<boolean>;
}

export interface GatewayHostRuntime {
  /**
   * Fail before the caller can start a gateway that an external supervisor
   * owns. Applies to onboarding, rebuild, and recovery alike.
   */
  assertGatewayStartAllowed(exitOnFailure: boolean): void;
  /** HTTPS endpoint of the gateway this process operates. */
  getGatewayLocalEndpoint(): string;
  getGatewayOwner(): GatewayOwner;
  /** Whether an external supervisor owns the gateway lifecycle this run (#6576). */
  isGatewayExternallySupervised(): boolean;
  getGatewayStartEnv(): Record<string, string>;
  /** Gateway-ownership dependencies consumed by the onboarding FSM handler. */
  machineGatewayOwnerDeps: {
    probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
    resolveGatewayOwner(): GatewayOwner;
  };
  probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
}

export function createGatewayHostRuntime(deps: GatewayHostRuntimeDeps): GatewayHostRuntime {
  let boundOwner: GatewayOwner | null = null;

  /**
   * Resolve the one gateway lifecycle authority for this run. A malformed
   * declaration throws instead of degrading to self-management: a host that
   * meant to hand the gateway to an external supervisor must never silently get
   * a second NemoClaw-owned gateway on the same port.
   *
   * The authority is bound on first resolution and stays fixed for the run.
   * Later calls re-read the declaration and packaged-service state and compare:
   * if they now describe a *different* authority, that is a check/use gap
   * between preflight and the FSM handler, so it fails closed rather than
   * silently switching owners mid-run. Changing authority is an explicit
   * migration, not something a mutating file can do underneath a running
   * onboard (#6576).
   */
  function getGatewayOwner(): GatewayOwner {
    const loaded = loadGatewayManagementDeclaration();
    if (!loaded.ok) {
      throw new Error(`Invalid gateway management declaration: ${loaded.reason}`);
    }
    const resolved = resolveGatewayOwner({
      declaration: loaded.declaration,
      hasPackagedService: hasOpenShellGatewayUserService(),
    });
    if (boundOwner) {
      if (!sameGatewayOwner(boundOwner, resolved)) {
        throw new Error(
          "Gateway lifecycle authority changed during this run " +
            `(${describeGatewayOwnerForError(boundOwner)} -> ${describeGatewayOwnerForError(resolved)}). ` +
            "Exactly one component owns the gateway per run; re-run onboarding to adopt the new authority.",
        );
      }
      return boundOwner;
    }
    boundOwner = resolved;
    return boundOwner;
  }

  function isSupervisorUnitActive(owner: GatewayOwner): boolean | null {
    const supervisor = owner.supervisor;
    if (!supervisor) return null;
    const spawnSyncImpl =
      deps.spawnSyncImpl ??
      (require("node:child_process") as typeof import("node:child_process")).spawnSync;
    const scope = supervisor.kind === "systemd-user" ? ["--user"] : [];
    const result = spawnSyncImpl("systemctl", [...scope, "is-active", supervisor.serviceName], {
      encoding: "utf-8",
      // spawnSync blocks the event loop, so a wedged systemd/D-Bus session would
      // otherwise stall onboarding indefinitely. A timeout surfaces as an error,
      // which the unknown-supervisor path below already treats as "cannot tell".
      timeout: SUPERVISOR_PROBE_TIMEOUT_MS,
    });
    if (result.error || result.status === null) return null;
    return String(result.stdout ?? "").trim() === "active";
  }

  function readListenerExecPath(pid: number): string | null {
    if (deps.readProcExe) return deps.readProcExe(pid);
    try {
      return fs.realpathSync.native(`/proc/${pid}/exe`);
    } catch {
      return null;
    }
  }

  function readProcCgroup(pid: number): string | null {
    if (deps.readProcCgroup) return deps.readProcCgroup(pid);
    try {
      return fs.readFileSync(`/proc/${pid}/cgroup`, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Bind a listening PID to the declared supervisor unit via cgroup membership
   * — the authoritative evidence that the process is the unit's, not merely a
   * same-binary impostor holding the port. Returns null when the relationship
   * cannot be established (no PID or an unreadable cgroup), and the caller then
   * fails closed.
   */
  function readListenerSupervisorMatch(
    owner: GatewayOwner,
    pid: number | undefined,
  ): boolean | null {
    const supervisor = owner.supervisor;
    if (!supervisor || typeof pid !== "number") return null;
    const cgroupText = readProcCgroup(pid);
    if (cgroupText === null) return null;
    return cgroupBelongsToUnit(cgroupText, supervisor.serviceName);
  }

  /**
   * Probe the declared endpoint rather than the process default, so a
   * declaration is never assessed against a different local listener. A
   * declared endpoint on a port this process does not operate is rejected by
   * `evaluateGatewayAttachment`, which sees both values.
   */
  function waitForDeclaredGatewayHttpReady(owner: GatewayOwner): Promise<boolean> {
    if (deps.probeGatewayHttpReady) return deps.probeGatewayHttpReady(owner.endpoint);
    if (!owner.endpoint) return deps.waitForGatewayHttpReady();
    // The endpoint is constrained to a supported loopback origin at parse time,
    // so this cannot be pointed at an arbitrary host.
    const endpoint = owner.endpoint;
    return waitForGatewayHttpReady({
      probe: () => isGatewayHttpReady(undefined, `${endpoint}/`),
    });
  }

  /**
   * Gather the evidence needed to decide whether NemoClaw may attach to a
   * gateway it does not own. Read-only: this runs before any effect.
   */
  async function probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe> {
    const portCheck = await deps.checkGatewayPortAvailable();
    const scan = deps.getGatewayPortListenerRawScan(portCheck, {
      gatewayBin: deps.resolveOpenShellGatewayBinary(),
    });
    const [firstPid] = scan.pids;
    return {
      gatewayPort: deps.gatewayPort(),
      httpReady: await waitForDeclaredGatewayHttpReady(owner),
      // `ok` means the port is free; anything else means something holds it.
      portOccupied: !portCheck.ok,
      listenerPids: scan.pids,
      listenerScanComplete: scan.complete,
      supervisorActive: isSupervisorUnitActive(owner),
      listenerExecPath: typeof firstPid === "number" ? readListenerExecPath(firstPid) : null,
      listenerSupervisorMatch: readListenerSupervisorMatch(owner, firstPid),
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

  function getGatewayLocalEndpoint(): string {
    const { getGatewayHttpsEndpoint } =
      require("./docker-driver-gateway-env") as typeof import("./docker-driver-gateway-env");
    return getGatewayHttpsEndpoint(deps.gatewayPort());
  }

  function getGatewayStartEnv(): Record<string, string> {
    // Resolved lazily, not through a module-scope import: the gateway env module
    // reads NEMOCLAW_GATEWAY_BIND_ADDRESS at load, and callers that reload
    // onboarding with a different environment drop it from the require cache.
    // A hoisted binding would pin this module to the stale first instance.
    const { getGatewayStartNetworkEnv } =
      require("./docker-driver-gateway-env") as typeof import("./docker-driver-gateway-env");
    const gatewayEnv = getGatewayStartNetworkEnv(deps.gatewayPort());
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
    getGatewayLocalEndpoint,
    getGatewayOwner,
    getGatewayStartEnv,
    isGatewayExternallySupervised: () => isExternallySupervised(getGatewayOwner()),
    machineGatewayOwnerDeps: { probeGatewayAttachment, resolveGatewayOwner: getGatewayOwner },
    probeGatewayAttachment,
  };
}
