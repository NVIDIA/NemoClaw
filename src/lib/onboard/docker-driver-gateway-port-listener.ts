// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isLinuxDockerDriverGatewayEnabled } from "./docker-driver-platform";
import type { PortProbeResult } from "./preflight";

export interface DockerDriverGatewayPortListenerOptions {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  gatewayBin?: string | null;
  isPidAliveFn?: (pid: number) => boolean;
  isDockerDriverGatewayProcessFn?: (pid: number, gatewayBin?: string | null) => boolean;
}

export interface GatewayPortListenerRawScan {
  /** Every live listener observed by the complete scan. */
  pids: number[];
  /** False when lsof could not authoritatively enumerate the whole listener set. */
  complete: boolean;
}

export interface DockerDriverGatewayPortListenerScan extends GatewayPortListenerRawScan {
  /** Live listener PIDs that could not be verified as this Docker-driver gateway. */
  unverifiedPids: number[];
}

export interface DockerDriverGatewayServicePortOwnershipOptions
  extends DockerDriverGatewayPortListenerOptions {
  exitOnFailure: boolean;
  logError?: (message: string) => void;
  preparePort: (pids: number[]) => void;
}

export interface DockerDriverGatewayServicePortOwnership {
  portListenerScan: DockerDriverGatewayPortListenerScan;
  preparePort(): void;
  reportUntrustedGatewayPort(message: string): never;
  validatePortOwner(): void;
}

interface ListenerCaptureResult {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface DockerDriverGatewayPortListenerDeps {
  gatewayPort: number | (() => number);
  runCaptureEx(args: readonly string[]): ListenerCaptureResult;
  isPidAlive(pid: number): boolean;
  isDockerDriverGatewayProcess(
    pid: number,
    gatewayBin: string | null | undefined,
    platform: NodeJS.Platform,
  ): boolean;
}

function parseListenerPids(output: string): number[] {
  return output
    .split(/\r?\n/)
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export function createDockerDriverGatewayPortListenerHelpers(
  deps: DockerDriverGatewayPortListenerDeps,
): {
  createGatewayServicePortOwnership(
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayServicePortOwnershipOptions,
  ): DockerDriverGatewayServicePortOwnership;
  getDockerDriverGatewayPortListenerPid(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): number | null;
  getDockerDriverGatewayPortListenerScan(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): DockerDriverGatewayPortListenerScan;
  getGatewayPortListenerRawScan(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): GatewayPortListenerRawScan;
  isDockerDriverGatewayPortListener(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): boolean;
} {
  const currentGatewayPort = () =>
    typeof deps.gatewayPort === "function" ? deps.gatewayPort() : deps.gatewayPort;

  function getDockerDriverGatewayPortListenerPid(
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayPortListenerOptions = {},
  ): number | null {
    if (portCheck.ok) return null;
    const platform = opts.platform ?? process.platform;
    if (!isLinuxDockerDriverGatewayEnabled(platform, opts.arch ?? process.arch)) return null;
    const pid = Number(portCheck.pid);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    if (
      !String(portCheck.process || "")
        .toLowerCase()
        .startsWith("openshell")
    )
      return null;
    const alive = opts.isPidAliveFn ?? deps.isPidAlive;
    if (!alive(pid)) return null;
    const isGateway =
      opts.isDockerDriverGatewayProcessFn ??
      ((candidatePid: number, gatewayBin?: string | null) =>
        deps.isDockerDriverGatewayProcess(candidatePid, gatewayBin, platform));
    return isGateway(pid, opts.gatewayBin) ? pid : null;
  }

  /**
   * Every live process holding the gateway port, with no assumption about what
   * kind of gateway it is.
   *
   * Docker-driver identity is deliberately not applied here: an externally
   * supervised gateway (#6576) is an ordinary systemd-run executable with none
   * of the Docker-driver env markers, so filtering by them would discard the
   * very listener the caller is trying to recognize. Callers that need
   * Docker-driver identity use getDockerDriverGatewayPortListenerScan instead.
   */
  function getGatewayPortListenerRawScan(
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayPortListenerOptions = {},
  ): GatewayPortListenerRawScan {
    const candidates = new Set<number>();

    let result: ListenerCaptureResult;
    try {
      result = deps.runCaptureEx(["lsof", "-ti", `:${currentGatewayPort()}`, "-sTCP:LISTEN"]);
    } catch {
      result = { stdout: "", exitCode: null, timedOut: false };
    }
    // Status 1 means "no listeners" only when the independent port probe also
    // saw a free port. EADDRINUSE plus empty lsof output is a visibility
    // contradiction (commonly a root-owned listener), not a complete scan.
    const complete = result.exitCode === 0 || (result.exitCode === 1 && portCheck.ok);
    if (result.exitCode === 0) {
      for (const pid of parseListenerPids(result.stdout)) candidates.add(pid);
    }

    const alive = opts.isPidAliveFn ?? deps.isPidAlive;
    return { pids: Array.from(candidates).filter((pid) => alive(pid)), complete };
  }

  function getDockerDriverGatewayPortListenerScan(
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayPortListenerOptions = {},
  ): DockerDriverGatewayPortListenerScan {
    const raw = getGatewayPortListenerRawScan(portCheck, opts);
    const candidates = new Set<number>(raw.pids);
    const primaryPid = getDockerDriverGatewayPortListenerPid(portCheck, opts);
    if (primaryPid !== null) candidates.add(primaryPid);

    const platform = opts.platform ?? process.platform;
    const alive = opts.isPidAliveFn ?? deps.isPidAlive;
    const isGateway =
      opts.isDockerDriverGatewayProcessFn ??
      ((pid: number, gatewayBin?: string | null) =>
        deps.isDockerDriverGatewayProcess(pid, gatewayBin, platform));
    const livePids = Array.from(candidates).filter((pid) => alive(pid));
    const verifiedPids = livePids.filter((pid) => isGateway(pid, opts.gatewayBin));
    return {
      pids: verifiedPids,
      unverifiedPids: livePids.filter((pid) => !verifiedPids.includes(pid)),
      complete: raw.complete,
    };
  }

  function createGatewayServicePortOwnership(
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayServicePortOwnershipOptions,
  ): DockerDriverGatewayServicePortOwnership {
    const portListenerScan = getDockerDriverGatewayPortListenerScan(portCheck, opts);
    const reportUntrustedGatewayPort = (message: string): never => {
      const detail =
        `Refusing to start a second OpenShell gateway: ${message}. ` +
        `Inspect port ${currentGatewayPort()} and stop only its owning process before retrying.`;
      (opts.logError ?? console.error)(`  ${detail}`);
      if (opts.exitOnFailure) process.exit(1);
      throw new Error(detail);
    };
    const validatePortOwner = () => {
      if (!portListenerScan.complete || portListenerScan.unverifiedPids.length > 0) {
        reportUntrustedGatewayPort(
          "the gateway port has an unknown or incompletely observed listener",
        );
      }
      if (portCheck.ok) {
        if (portListenerScan.pids.length > 0) {
          reportUntrustedGatewayPort(
            "the gateway port listener changed during ownership validation",
          );
        }
        return;
      }
      const primaryPid = Number(portCheck.pid);
      if (
        portListenerScan.pids.length === 0 ||
        (Number.isInteger(primaryPid) &&
          primaryPid > 0 &&
          !portListenerScan.pids.includes(primaryPid))
      ) {
        reportUntrustedGatewayPort(
          "the gateway port has an unknown or incompletely observed listener",
        );
      }
    };
    return {
      portListenerScan,
      preparePort: () => opts.preparePort(portListenerScan.pids),
      reportUntrustedGatewayPort,
      validatePortOwner,
    };
  }

  return {
    createGatewayServicePortOwnership,
    getDockerDriverGatewayPortListenerPid,
    getDockerDriverGatewayPortListenerScan,
    getGatewayPortListenerRawScan,
    isDockerDriverGatewayPortListener: (portCheck, opts) =>
      getDockerDriverGatewayPortListenerPid(portCheck, opts) !== null,
  };
}
