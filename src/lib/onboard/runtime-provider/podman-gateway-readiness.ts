// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getDockerDriverGatewayRuntimeMarkerPath,
  parseDockerDriverGatewayRuntimeMarker,
  readOwnedDockerDriverGatewayRuntimeFile,
  resolveDockerDriverGatewayStateDir,
} from "../docker-driver-gateway-runtime-marker";
import {
  canonicalGatewayTargetMatches,
  gatewayProcessCmdlineMatches,
} from "../gateway-process-identity";
import type {
  RuntimeProviderOwnedGatewayReadinessInput,
  RuntimeProviderOwnedGatewayReadinessObservation,
} from "./contract";

const PODMAN_GATEWAY_READINESS_COMMAND_TIMEOUT_MS = 10_000;

interface PodmanGatewayHostCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PodmanGatewayReadinessDeps {
  readonly currentUid: () => number;
  readonly readOwnedFile: (filePath: string, uid: number) => string | null;
  readonly readProcessArguments: (pid: number, environment: NodeJS.ProcessEnv) => string | null;
  readonly readProcessExecutable: (pid: number) => string | null;
  readonly runHost: (
    command: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => PodmanGatewayHostCommandResult;
}

function runHost(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): PodmanGatewayHostCommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: environment,
    timeout: PODMAN_GATEWAY_READINESS_COMMAND_TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: String(result.stdout ?? ""),
    stderr: String(result.stderr ?? ""),
  };
}

function readProcessArguments(pid: number, environment: NodeJS.ProcessEnv): string | null {
  try {
    const value = fs.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").replaceAll("\0", " ");
    if (value.trim()) return value.trim();
  } catch {
    // Fall through to the read-only process-table query.
  }
  const result = runHost("ps", ["-p", String(pid), "-o", "args="], environment);
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function readProcessExecutable(pid: number): string | null {
  try {
    return fs.realpathSync.native(`/proc/${String(pid)}/exe`);
  } catch {
    return null;
  }
}

const DEFAULT_DEPS: PodmanGatewayReadinessDeps = {
  currentUid: () => (typeof process.getuid === "function" ? process.getuid() : -1),
  readOwnedFile: readOwnedDockerDriverGatewayRuntimeFile,
  readProcessArguments,
  readProcessExecutable,
  runHost,
};

function normalizedExecutable(value: string): string {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function listenerPids(output: string): number[] {
  return [
    ...new Set(
      output
        .split(/\r?\n/u)
        .map((line) => Number.parseInt(line.trim(), 10))
        .filter((pid) => Number.isInteger(pid) && pid > 0),
    ),
  ];
}

function classifyEndpointBinding(
  outputs: readonly string[],
  expectedEndpoint: string,
): RuntimeProviderOwnedGatewayReadinessObservation["endpointBinding"] {
  const expected = new URL(expectedEndpoint);
  let observed = false;
  for (const output of outputs) {
    for (const match of output.matchAll(/^\s*(?:Gateway endpoint|Server):(.*)$/gimu)) {
      observed = true;
      let endpoint: URL;
      try {
        endpoint = new URL(match[1]?.trim() ?? "");
      } catch {
        return "mismatch";
      }
      if (
        endpoint.protocol !== expected.protocol ||
        endpoint.hostname !== expected.hostname ||
        endpoint.port !== expected.port ||
        endpoint.username !== "" ||
        endpoint.password !== "" ||
        endpoint.pathname !== "/" ||
        endpoint.search !== "" ||
        endpoint.hash !== ""
      ) {
        return "mismatch";
      }
    }
  }
  return observed ? "match" : "unknown";
}

function isRunningProcess(
  pid: number,
  uid: number,
  input: RuntimeProviderOwnedGatewayReadinessInput,
  deps: PodmanGatewayReadinessDeps,
): boolean {
  const owner = deps.runHost("ps", ["-p", String(pid), "-o", "uid="], input.environment);
  if (owner.status !== 0 || Number(owner.stdout.trim()) !== uid) return false;
  const status = deps.runHost("ps", ["-p", String(pid), "-o", "stat="], input.environment);
  return status.status === 0 && /^[DIKPRSUW]/u.test(status.stdout.trim());
}

function observeOwnedListener(
  pid: number,
  input: RuntimeProviderOwnedGatewayReadinessInput,
  deps: PodmanGatewayReadinessDeps,
): { readonly runningVersion: string | null } | null {
  const uid = deps.currentUid();
  if (uid < 0 || !canonicalGatewayTargetMatches(input.gatewayName, input.gatewayPort)) return null;
  const stateDir = resolveDockerDriverGatewayStateDir(
    input.environment,
    input.environment.HOME || os.homedir(),
    input.gatewayPort,
  );
  const pidFile = path.join(stateDir, "openshell-gateway.pid");
  const markerPath = getDockerDriverGatewayRuntimeMarkerPath(stateDir);
  const pidText = deps.readOwnedFile(pidFile, uid);
  const markerText = deps.readOwnedFile(markerPath, uid);
  const marker = markerText ? parseDockerDriverGatewayRuntimeMarker(markerText) : null;
  const trustedGatewayBin = input.trustedGatewayBin
    ? normalizedExecutable(input.trustedGatewayBin)
    : null;
  if (
    Number(pidText?.trim()) !== pid ||
    marker?.pid !== pid ||
    marker.driver !== "podman" ||
    marker.platform !== input.platform ||
    marker.arch !== input.architecture ||
    marker.endpoint !== input.expectedEndpoint ||
    !marker.gatewayBin ||
    !trustedGatewayBin ||
    normalizedExecutable(marker.gatewayBin) !== trustedGatewayBin ||
    !isRunningProcess(pid, uid, input, deps)
  ) {
    return null;
  }
  const executableBefore = deps.readProcessExecutable(pid);
  const processArguments = deps.readProcessArguments(pid, input.environment);
  const executableAfter = deps.readProcessExecutable(pid);
  if (
    !executableBefore ||
    executableBefore !== executableAfter ||
    normalizedExecutable(executableBefore) !== trustedGatewayBin ||
    !processArguments ||
    !gatewayProcessCmdlineMatches(processArguments, trustedGatewayBin, {
      expectedOpenShellGateway: { name: input.gatewayName, port: input.gatewayPort },
      requireExpectedFlags: true,
    }) ||
    deps.readOwnedFile(pidFile, uid) !== pidText ||
    deps.readOwnedFile(markerPath, uid) !== markerText ||
    !isRunningProcess(pid, uid, input, deps)
  ) {
    return null;
  }
  return { runningVersion: marker.openshellVersion };
}

export function observeNativePodmanGatewayReadiness(
  input: RuntimeProviderOwnedGatewayReadinessInput,
  deps: PodmanGatewayReadinessDeps = DEFAULT_DEPS,
): RuntimeProviderOwnedGatewayReadinessObservation {
  const scan = deps.runHost(
    "lsof",
    ["-ti", `:${String(input.gatewayPort)}`, "-sTCP:LISTEN"],
    input.environment,
  );
  const complete = scan.status === 0 || (scan.status === 1 && input.portAvailable);
  const candidates = scan.status === 0 ? listenerPids(scan.stdout) : [];
  const proofs = new Map(
    candidates.map((pid) => [pid, observeOwnedListener(pid, input, deps)] as const),
  );
  const pids = candidates.filter((pid) => proofs.get(pid) !== null);
  const unverifiedPids = candidates.filter((pid) => !pids.includes(pid));
  const runningVersion = pids.length === 1 ? proofs.get(pids[0]!)?.runningVersion : null;
  const versionCompatibility =
    pids.length !== 1 || !runningVersion || !input.installedOpenShellVersion
      ? "unknown"
      : runningVersion === input.installedOpenShellVersion
        ? "compatible"
        : "drift";
  return Object.freeze({
    endpointBinding: classifyEndpointBinding(input.managedGatewayOutputs, input.expectedEndpoint),
    listenerScan: Object.freeze({
      pids: Object.freeze(pids),
      unverifiedPids: Object.freeze(unverifiedPids),
      complete,
    }),
    targetBoundListenerPids: Object.freeze([...pids]),
    versionCompatibility,
  });
}
