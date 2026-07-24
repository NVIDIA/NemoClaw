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

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isGatewayHealthy } from "../state/gateway";
import type { DockerDriverGatewayPortListenerScan } from "./docker-driver-gateway-port-listener";
import { hasOpenShellGatewayUserService } from "./docker-driver-gateway-service";
import {
  isDockerDriverGatewayHttpReady,
  isGatewayHttpReady,
  waitForGatewayHttpReady,
} from "./gateway-http-readiness";
import { loadGatewayManagementDeclaration } from "./gateway-management";
import {
  assertGatewayEffectAllowed,
  cgroupBelongsToUnit,
  describeGatewayOwnerForError,
  evaluateGatewayAttachment,
  evaluateGatewayAttachmentConfiguration,
  type GatewayAttachmentProbe,
  type GatewayOwner,
  GatewayOwnershipError,
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
  gatewayName(): string;
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
  isGatewayHealthy?: typeof isGatewayHealthy;
  runCaptureOpenshell(args: string[], opts?: { ignoreError?: boolean }): string;
  runOpenshell(
    args: string[],
    opts?: { ignoreError?: boolean; suppressOutput?: boolean },
  ): { status: number | null };
  resolveOpenShellGatewayBinary(): string | null;
  spawnSyncImpl?: typeof import("node:child_process").spawnSync;
  /** Overrides the readiness request; defaults to a real probe of `endpoint`. */
  probeGatewayHttpReady?(endpoint: string | null): Promise<boolean>;
  /** Overrides `/proc/<pid>/exe` resolution; defaults to the real symlink. */
  readProcExe?(pid: number): string | null;
  /** Overrides `/proc/<pid>/cgroup` reads; defaults to the real file. */
  readProcCgroup?(pid: number): string | null;
  /** Overrides `/proc/<pid>/stat` start-time reads; defaults to the real file. */
  readProcStartTime?(pid: number): string | null;
  waitForGatewayHttpReady(): Promise<boolean>;
}

export interface GatewayHostRuntime {
  /**
   * Fail before the caller can start a gateway that an external supervisor
   * owns. Applies to onboarding, rebuild, and recovery alike.
   */
  assertGatewayStartAllowed(
    exitOnFailure: boolean,
    target?: { gatewayName: string; gatewayPort: number },
  ): void;
  attachGateway(owner: GatewayOwner, expectedProbe: GatewayAttachmentProbe): Promise<void>;
  bindGatewayOwner(owner: GatewayOwner): void;
  /** Local endpoint of the gateway this process operates. */
  getGatewayLocalEndpoint(): string;
  getGatewayOwner(): GatewayOwner;
  resetGatewayOwnerBinding(): void;
  /** Whether an external supervisor owns the gateway lifecycle this run (#6576). */
  isGatewayExternallySupervised(): boolean;
  getGatewayStartEnv(): Record<string, string>;
  /** Gateway-ownership dependencies consumed by the onboarding FSM handler. */
  machineGatewayOwnerDeps: {
    probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
    resolveGatewayOwner(): GatewayOwner;
    attachGateway(owner: GatewayOwner, expectedProbe: GatewayAttachmentProbe): Promise<void>;
  };
  probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe>;
}

export function createGatewayHostRuntime(deps: GatewayHostRuntimeDeps): GatewayHostRuntime {
  let boundOwner: GatewayOwner | null = null;

  function resolveCurrentGatewayOwner(gatewayName: string, gatewayPort: number): GatewayOwner {
    const loaded = loadGatewayManagementDeclaration();
    if (!loaded.ok) {
      throw new Error(`Invalid gateway management declaration: ${loaded.reason}`);
    }
    return resolveGatewayOwner({
      gatewayName,
      gatewayPort,
      declaration: loaded.declaration,
      hasPackagedService: hasOpenShellGatewayUserService(),
    });
  }

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
  function getGatewayOwnerForTarget(
    target: { gatewayName: string; gatewayPort: number } = {
      gatewayName: deps.gatewayName(),
      gatewayPort: deps.gatewayPort(),
    },
  ): GatewayOwner {
    const resolved = resolveCurrentGatewayOwner(target.gatewayName, target.gatewayPort);
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

  function getGatewayOwner(): GatewayOwner {
    return getGatewayOwnerForTarget();
  }

  function isSupervisorUnitActive(owner: GatewayOwner): boolean | null {
    const supervisor = owner.supervisor;
    if (!supervisor) return null;
    const spawnSyncImpl = deps.spawnSyncImpl ?? spawnSync;
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

  function readProcStartTime(pid: number): string | null {
    if (deps.readProcStartTime) return deps.readProcStartTime(pid);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
      const commandEnd = stat.lastIndexOf(")");
      // Fields after the command begin at field 3; process start time is field 22.
      return commandEnd >= 0
        ? (stat
            .slice(commandEnd + 1)
            .trim()
            .split(/\s+/)[19] ?? null)
        : null;
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
  function readListenerSupervisorMatch(owner: GatewayOwner, pid: number): boolean | null {
    const supervisor = owner.supervisor;
    if (!supervisor) return null;
    const cgroupText = readProcCgroup(pid);
    if (cgroupText === null) return null;
    return cgroupBelongsToUnit(cgroupText, supervisor.serviceName, supervisor.kind);
  }

  /** Read executable and cgroup evidence only while the PID names one process. */
  function readStableListenerIdentity(owner: GatewayOwner, pid: number) {
    const startTime = readProcStartTime(pid);
    const execPath = readListenerExecPath(pid);
    const supervisorMatch = readListenerSupervisorMatch(owner, pid);
    const endTime = readProcStartTime(pid);
    return startTime !== null && endTime === startTime
      ? { startTime, execPath, supervisorMatch }
      : null;
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
    prepareExternalGatewayClient(owner);
    const endpoint = owner.endpoint;
    if (new URL(endpoint).protocol === "https:") {
      return waitForGatewayHttpReady({
        probe: () =>
          isDockerDriverGatewayHttpReady(undefined, `${endpoint}/openshell.v1.OpenShell/Health`),
      });
    }
    return waitForGatewayHttpReady({ probe: () => isGatewayHttpReady(undefined, `${endpoint}/`) });
  }

  /**
   * Gather the evidence needed to decide whether NemoClaw may attach to a
   * gateway it does not own. Read-only: this runs before any effect.
   */
  async function probeGatewayAttachment(owner: GatewayOwner): Promise<GatewayAttachmentProbe> {
    const configuration = evaluateGatewayAttachmentConfiguration(owner, deps.gatewayPort());
    if (!configuration.ok) {
      throw new GatewayOwnershipError(configuration.code, configuration.message, owner);
    }
    const portCheck = await deps.checkGatewayPortAvailable();
    const httpReady = await waitForDeclaredGatewayHttpReady(owner);
    const supervisorActive = isSupervisorUnitActive(owner);
    const gatewayBin = deps.resolveOpenShellGatewayBinary();
    const scan = deps.getGatewayPortListenerRawScan(portCheck, {
      gatewayBin,
    });
    const [firstPid] = scan.pids;
    const initialIdentity =
      scan.complete && scan.pids.length === 1 && typeof firstPid === "number"
        ? readStableListenerIdentity(owner, firstPid)
        : null;
    const verifiedScan =
      typeof firstPid === "number"
        ? deps.getGatewayPortListenerRawScan(portCheck, {
            gatewayBin,
          })
        : scan;
    const confirmedIdentity =
      scan.complete &&
      verifiedScan.complete &&
      scan.pids.length === 1 &&
      verifiedScan.pids.length === 1 &&
      verifiedScan.pids[0] === firstPid &&
      typeof firstPid === "number"
        ? readStableListenerIdentity(owner, firstPid)
        : null;
    const listenerStayedStable =
      scan.complete &&
      verifiedScan.complete &&
      scan.pids.length === 1 &&
      verifiedScan.pids.length === 1 &&
      verifiedScan.pids[0] === firstPid &&
      initialIdentity !== null &&
      confirmedIdentity !== null &&
      initialIdentity.startTime === confirmedIdentity.startTime &&
      initialIdentity.execPath === confirmedIdentity.execPath &&
      initialIdentity.supervisorMatch === confirmedIdentity.supervisorMatch;
    return {
      gatewayPort: deps.gatewayPort(),
      httpReady,
      // `ok` means the port is free; anything else means something holds it.
      portOccupied: !portCheck.ok,
      listenerPids: verifiedScan.pids,
      listenerScanComplete: scan.complete && verifiedScan.complete,
      listenerStartTime: listenerStayedStable ? confirmedIdentity.startTime : null,
      supervisorActive,
      listenerExecPath: listenerStayedStable ? confirmedIdentity.execPath : null,
      listenerSupervisorMatch: listenerStayedStable ? confirmedIdentity.supervisorMatch : null,
    };
  }

  function assertGatewayStartAllowed(
    exitOnFailure: boolean,
    target?: { gatewayName: string; gatewayPort: number },
  ): void {
    try {
      assertGatewayEffectAllowed(getGatewayOwnerForTarget(target), "start");
    } catch (error) {
      console.error(`  ${error instanceof Error ? error.message : String(error)}`);
      if (exitOnFailure) process.exit(1);
      throw error;
    }
  }

  function prepareExternalGatewayClient(owner: GatewayOwner): void {
    if (!isExternallySupervised(owner) || !owner.endpoint) return;
    if (new URL(owner.endpoint).protocol !== "https:") return;
    if (!owner.stateDir) {
      throw new Error("Externally supervised HTTPS gateway requires a declared stateDir.");
    }
    const localTlsDir = path.join(owner.stateDir, "tls");
    for (const relativePath of ["ca.crt", "client/tls.crt", "client/tls.key"]) {
      const filePath = path.join(localTlsDir, relativePath);
      try {
        if (!fs.statSync(filePath).isFile()) throw new Error("not a file");
        fs.accessSync(filePath, fs.constants.R_OK);
      } catch {
        throw new Error(
          `Externally supervised gateway TLS file is missing or unreadable: ${filePath}`,
        );
      }
    }
    process.env.OPENSHELL_LOCAL_TLS_DIR = localTlsDir;
  }

  function sameAttachmentEvidence(
    expected: GatewayAttachmentProbe,
    actual: GatewayAttachmentProbe,
  ): boolean {
    return (
      expected.gatewayPort === actual.gatewayPort &&
      expected.httpReady === actual.httpReady &&
      expected.portOccupied === actual.portOccupied &&
      expected.listenerScanComplete === actual.listenerScanComplete &&
      expected.listenerStartTime === actual.listenerStartTime &&
      expected.supervisorActive === actual.supervisorActive &&
      expected.listenerExecPath === actual.listenerExecPath &&
      expected.listenerSupervisorMatch === actual.listenerSupervisorMatch &&
      expected.listenerPids.length === actual.listenerPids.length &&
      expected.listenerPids.every((pid, index) => pid === actual.listenerPids[index])
    );
  }

  /** Register and select the exact endpoint whose listener identity was validated. */
  async function attachGateway(
    owner: GatewayOwner,
    expectedProbe: GatewayAttachmentProbe,
  ): Promise<void> {
    bindGatewayOwner(owner);
    if (!isExternallySupervised(owner) || !owner.endpoint) return;
    const expectedAttachment = evaluateGatewayAttachment(owner, expectedProbe);
    if (!expectedAttachment.ok) {
      throw new GatewayOwnershipError(expectedAttachment.code, expectedAttachment.message, owner);
    }
    prepareExternalGatewayClient(owner);
    const removeAttemptedRegistration = () => {
      deps.runOpenshell(["gateway", "remove", owner.gatewayName], {
        ignoreError: true,
        suppressOutput: true,
      });
      if (process.env.OPENSHELL_GATEWAY === owner.gatewayName) {
        delete process.env.OPENSHELL_GATEWAY;
      }
    };
    const add = () =>
      deps.runOpenshell(
        ["gateway", "add", owner.endpoint as string, "--local", "--name", owner.gatewayName],
        { ignoreError: true, suppressOutput: true },
      );
    let addResult = add();
    if (addResult.status !== 0) {
      removeAttemptedRegistration();
      addResult = add();
    }
    const selectResult = deps.runOpenshell(["gateway", "select", owner.gatewayName], {
      ignoreError: true,
      suppressOutput: true,
    });
    const status = deps.runCaptureOpenshell(["status"], { ignoreError: true });
    const namedInfo = deps.runCaptureOpenshell(["gateway", "info", "-g", owner.gatewayName], {
      ignoreError: true,
    });
    const activeInfo = deps.runCaptureOpenshell(["gateway", "info"], { ignoreError: true });
    if (
      addResult.status !== 0 ||
      selectResult.status !== 0 ||
      !(deps.isGatewayHealthy ?? isGatewayHealthy)(status, namedInfo, activeInfo, owner.gatewayName)
    ) {
      removeAttemptedRegistration();
      throw new GatewayOwnershipError(
        "gateway_registration_failed",
        `Failed to register and select externally supervised gateway '${owner.gatewayName}' at ${owner.endpoint}.`,
        owner,
      );
    }

    let currentProbe: GatewayAttachmentProbe;
    try {
      currentProbe = await probeGatewayAttachment(owner);
    } catch (error) {
      removeAttemptedRegistration();
      throw error;
    }
    const currentAttachment = evaluateGatewayAttachment(owner, currentProbe);
    if (!currentAttachment.ok || !sameAttachmentEvidence(expectedProbe, currentProbe)) {
      removeAttemptedRegistration();
      if (!currentAttachment.ok) {
        throw new GatewayOwnershipError(currentAttachment.code, currentAttachment.message, owner);
      }
      throw new GatewayOwnershipError(
        "identity_mismatch",
        `The externally supervised gateway listener changed while '${owner.gatewayName}' was registered. ` +
          "The registration was removed; stabilize the supervisor and re-run onboarding.",
        owner,
      );
    }
    process.env.OPENSHELL_GATEWAY = owner.gatewayName;
  }

  function bindGatewayOwner(owner: GatewayOwner): void {
    const current = getGatewayOwner();
    if (!sameGatewayOwner(owner, current)) {
      throw new Error(
        "Gateway lifecycle authority changed before it could be bound to this run " +
          `(${describeGatewayOwnerForError(owner)} -> ${describeGatewayOwnerForError(current)}).`,
      );
    }
    boundOwner = owner;
  }

  function getGatewayLocalEndpoint(): string {
    const owner = getGatewayOwner();
    if (isExternallySupervised(owner) && owner.endpoint) return owner.endpoint;
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
    if (openshellVersion) {
      const stableGatewayImage = `ghcr.io/nvidia/openshell/cluster:${openshellVersion}`;
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
    attachGateway,
    bindGatewayOwner,
    getGatewayLocalEndpoint,
    getGatewayOwner,
    getGatewayStartEnv,
    isGatewayExternallySupervised: () => isExternallySupervised(getGatewayOwner()),
    machineGatewayOwnerDeps: {
      attachGateway,
      probeGatewayAttachment,
      resolveGatewayOwner: getGatewayOwner,
    },
    probeGatewayAttachment,
    resetGatewayOwnerBinding: () => {
      boundOwner = null;
    },
  };
}
