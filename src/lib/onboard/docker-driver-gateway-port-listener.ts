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

export interface DockerDriverGatewayPortListenerScan {
  /** Every cmdline-verified listener observed by the primary and complete scans. */
  pids: number[];
  /** False when lsof could not authoritatively enumerate the whole listener set. */
  complete: boolean;
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
  getDockerDriverGatewayPortListenerPid(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): number | null;
  getDockerDriverGatewayPortListenerScan(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): DockerDriverGatewayPortListenerScan;
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

  function getDockerDriverGatewayPortListenerScan(
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayPortListenerOptions = {},
  ): DockerDriverGatewayPortListenerScan {
    const candidates = new Set<number>();
    const primaryPid = getDockerDriverGatewayPortListenerPid(portCheck, opts);
    if (primaryPid !== null) candidates.add(primaryPid);

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

    const platform = opts.platform ?? process.platform;
    const alive = opts.isPidAliveFn ?? deps.isPidAlive;
    const isGateway =
      opts.isDockerDriverGatewayProcessFn ??
      ((pid: number, gatewayBin?: string | null) =>
        deps.isDockerDriverGatewayProcess(pid, gatewayBin, platform));
    return {
      pids: Array.from(candidates).filter((pid) => alive(pid) && isGateway(pid, opts.gatewayBin)),
      complete,
    };
  }

  return {
    getDockerDriverGatewayPortListenerPid,
    getDockerDriverGatewayPortListenerScan,
    isDockerDriverGatewayPortListener: (portCheck, opts) =>
      getDockerDriverGatewayPortListenerPid(portCheck, opts) !== null,
  };
}
