// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveOpenshell } from "../adapters/openshell/resolve";
import { isErrnoException } from "../core/errno";
import {
  createDockerDriverGatewayPortListenerHelpers,
  type DockerDriverGatewayPortListenerOptions,
  type DockerDriverGatewayPortListenerScan,
} from "./docker-driver-gateway-port-listener";
import * as dockerDriverGatewayRuntimeMarker from "./docker-driver-gateway-runtime-marker";
import * as gatewayBinding from "./gateway-binding";
import {
  gatewayProcessCmdlineMatches,
  OPENSHELL_GATEWAY_PROCESS_NAMES,
} from "./gateway-process-identity";
import type { PortProbeResult } from "./preflight";

// Keep the listener option type on the established runtime facade while the
// implementation remains isolated in docker-driver-gateway-port-listener.ts.
export type { DockerDriverGatewayPortListenerOptions } from "./docker-driver-gateway-port-listener";

import * as vmDriverProcess from "./vm-driver-process";

const OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS: Readonly<Record<string, string>> = {
  "0.0.72": "sha256:80ed9cda5bf672fefdb9dcd4604b40a8b09c0891b6eb9d03e10227c7e3dfb49d",
};

export type DockerDriverGatewayRuntimeDrift = { reason: string };

type RunCapture = (args: string[], opts?: { ignoreError?: boolean }) => string;
type RunCaptureEx = (args: readonly string[]) => {
  stdout: string;
  exitCode: number | null;
  timedOut: boolean;
};
type DockerDriverGatewayEnvModule = typeof import("./docker-driver-gateway-env");

// Source boundary: OpenShell does not currently expose an authoritative local
// host-gateway identity/drift endpoint for the Docker-driver runtime NemoClaw
// started for this port/configuration. Until that exists, reuse must fail
// closed here for missing binaries or PID files, dead or foreign PIDs,
// unreadable Linux /proc env/exe state, replaced gateway executables, stale
// runtime markers, non-matching port owners, and macOS VM-driver children still
// attached to a Docker-driver gateway. These heuristics can be retired when
// OpenShell owns and reports the same runtime identity fields directly.
export interface DockerDriverGatewayRuntimeDeps {
  gatewayPort: number | (() => number);
  getCachedOpenshellBinary(): string | null;
  getBlueprintMaxOpenshellVersion(): string | null;
  getInstalledOpenshellVersion(versionOutput?: string | null): string | null;
  isOpenshellDevVersion(versionOutput: string | null | undefined): boolean;
  loadDockerDriverGatewayEnv?(): DockerDriverGatewayEnvModule;
  runCapture: RunCapture;
  runCaptureEx?: RunCaptureEx;
  shouldUseOpenshellDevChannel(): boolean;
  supportedOpenshellFallbackVersion: string;
}

export function createDockerDriverGatewayRuntimeHelpers(deps: DockerDriverGatewayRuntimeDeps): {
  clearDockerDriverGatewayRuntimeFiles(): void;
  getDockerDriverGatewayEnv(
    versionOutput?: string | null,
    platform?: NodeJS.Platform,
  ): Record<string, string>;
  getDockerDriverGatewayPid(): number | null;
  getDockerDriverGatewayPidFile(): string;
  getDockerDriverGatewayPortListenerScan(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): DockerDriverGatewayPortListenerScan;
  /** Compatibility view for callers that only need the verified PID list. */
  getDockerDriverGatewayPortListenerPids(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): number[];
  getDockerDriverGatewayPortListenerPid(
    portCheck: PortProbeResult,
    opts?: DockerDriverGatewayPortListenerOptions,
  ): number | null;
  getDockerDriverGatewayRuntimeDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin?: string | null,
    platform?: NodeJS.Platform,
  ): DockerDriverGatewayRuntimeDrift | null;
  getDockerDriverGatewayRuntimeDriftFromSnapshot(snapshot: {
    processEnv: Record<string, string> | null;
    processExe: string | null;
    desiredEnv: Record<string, string>;
    gatewayBin?: string | null;
  }): DockerDriverGatewayRuntimeDrift | null;
  getDockerDriverGatewayStateDir(): string;
  isDockerDriverGatewayPortListener(
    portCheck: PortProbeResult,
    opts?: Parameters<
      ReturnType<
        typeof createDockerDriverGatewayRuntimeHelpers
      >["getDockerDriverGatewayPortListenerPid"]
    >[1],
  ): boolean;
  isDockerDriverGatewayProcess(
    pid: number,
    gatewayBin?: string | null,
    opts?: { requireDockerDriverEnv?: boolean },
  ): boolean;
  isDockerDriverGatewayProcessAlive(): boolean;
  isPidAlive(pid: number): boolean;
  rememberDockerDriverGatewayPid(pid: number): void;
  resolveOpenShellGatewayBinary(): string | null;
  resolveOpenShellSandboxBinary(): string | null;
  shouldRequireDockerDriverEnv(platform?: NodeJS.Platform): boolean;
} {
  const dockerDriverGatewayEnv: DockerDriverGatewayEnvModule =
    deps.loadDockerDriverGatewayEnv?.() ?? require("./docker-driver-gateway-env");

  const currentGatewayPort = () =>
    typeof deps.gatewayPort === "function" ? deps.gatewayPort() : deps.gatewayPort;

  function getDockerDriverGatewayStateDir(): string {
    const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR;
    if (configured && configured.trim()) return path.resolve(configured.trim());
    const dir = gatewayBinding.resolveGatewayStateDirName(currentGatewayPort());
    return path.join(os.homedir(), ".local", "state", "nemoclaw", dir);
  }

  function getDockerDriverGatewayPidFile(): string {
    return path.join(getDockerDriverGatewayStateDir(), "openshell-gateway.pid");
  }

  function resolveSiblingBinary(binaryName: string): string | null {
    const openshellBin = deps.getCachedOpenshellBinary() || resolveOpenshell();
    if (typeof openshellBin !== "string" || openshellBin.length === 0) return null;
    const sibling = path.join(path.dirname(openshellBin), binaryName);
    if (fs.existsSync(sibling)) return sibling;
    return null;
  }

  function resolveOpenShellGatewayBinary(): string | null {
    const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN;
    if (configured && configured.trim()) return path.resolve(configured.trim());
    const sibling = resolveSiblingBinary("openshell-gateway");
    if (sibling) return sibling;
    // Keep the standalone gateway fallbacks coherent with the CLI resolver
    // (resolveOpenshell): `/opt/homebrew/bin` is the Apple Silicon Homebrew
    // prefix and is often missing from the onboarding shell's PATH (#5334).
    for (const candidate of [
      path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
      "/opt/homebrew/bin/openshell-gateway",
      "/usr/local/bin/openshell-gateway",
      "/usr/bin/openshell-gateway",
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  function resolveOpenShellSandboxBinary(): string | null {
    const configured = process.env.NEMOCLAW_OPENSHELL_SANDBOX_BIN;
    if (configured && configured.trim()) return path.resolve(configured.trim());
    const sibling = resolveSiblingBinary("openshell-sandbox");
    if (sibling) return sibling;
    // Apple Silicon Homebrew prefix kept in sync with the other resolvers (#5334).
    for (const candidate of [
      path.join(os.homedir(), ".local", "bin", "openshell-sandbox"),
      "/opt/homebrew/bin/openshell-sandbox",
      "/usr/local/bin/openshell-sandbox",
      "/usr/bin/openshell-sandbox",
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  function getOpenShellDockerSupervisorImage(versionOutput: string | null = null): string {
    if (process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) {
      return process.env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE;
    }
    const installedVersion = deps.getInstalledOpenshellVersion(versionOutput);
    if (deps.shouldUseOpenshellDevChannel() || deps.isOpenshellDevVersion(versionOutput)) {
      return "ghcr.io/nvidia/openshell/supervisor:dev";
    }
    const supportedVersion =
      installedVersion ??
      deps.getBlueprintMaxOpenshellVersion() ??
      deps.supportedOpenshellFallbackVersion;
    const manifestDigest = OPENSHELL_SUPERVISOR_MANIFEST_DIGESTS[supportedVersion];
    return manifestDigest
      ? `ghcr.io/nvidia/openshell/supervisor@${manifestDigest}`
      : `ghcr.io/nvidia/openshell/supervisor:${supportedVersion}`;
  }

  function getDockerDriverGatewayEnv(
    versionOutput: string | null = null,
    platform: NodeJS.Platform = process.platform,
  ): Record<string, string> {
    const gatewayEnv = dockerDriverGatewayEnv.buildDockerDriverGatewayEnv({
      platform,
      gatewayPort: currentGatewayPort(),
      stateDir: getDockerDriverGatewayStateDir(),
      dockerNetworkName: process.env.OPENSHELL_DOCKER_NETWORK_NAME || "openshell-docker",
      getDockerSupervisorImage: () => getOpenShellDockerSupervisorImage(versionOutput),
      resolveSandboxBin: resolveOpenShellSandboxBinary,
    });
    if (gatewayEnv.OPENSHELL_LOCAL_TLS_DIR) {
      process.env.OPENSHELL_LOCAL_TLS_DIR = gatewayEnv.OPENSHELL_LOCAL_TLS_DIR;
    }
    return gatewayEnv;
  }

  function isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return isErrnoException(error) && error.code === "EPERM";
    }
  }

  function getDockerDriverGatewayPid(): number | null {
    try {
      const raw = fs.readFileSync(getDockerDriverGatewayPidFile(), "utf-8").trim();
      const pid = Number.parseInt(raw, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  function readProcessEnv(pid: number): Record<string, string> | null {
    const procEnvPath = `/proc/${pid}/environ`;
    const env: Record<string, string> = {};
    try {
      if (!fs.existsSync(procEnvPath)) return null;
      for (const entry of fs.readFileSync(procEnvPath, "utf-8").split("\0")) {
        if (!entry) continue;
        const idx = entry.indexOf("=");
        if (idx <= 0) continue;
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    } catch {
      return null;
    }
    return env;
  }

  function hasDockerDriverGatewayEnv(pid: number): boolean {
    const env = readProcessEnv(pid);
    if (!env) return false;
    return (
      env.OPENSHELL_DRIVERS === "docker" ||
      Boolean(env.OPENSHELL_DOCKER_SUPERVISOR_IMAGE) ||
      env.OPENSHELL_GRPC_ENDPOINT ===
        dockerDriverGatewayEnv.getDockerDriverGatewayEndpoint(currentGatewayPort())
    );
  }

  function readProcessExe(pid: number): string | null {
    try {
      const procExePath = `/proc/${pid}/exe`;
      if (!fs.existsSync(procExePath)) return null;
      return fs.readlinkSync(procExePath);
    } catch {
      return null;
    }
  }

  function normalizeGatewayExecutablePath(value: string | null | undefined): string | null {
    if (!value) return null;
    const withoutDeletedSuffix = value.replace(/ \(deleted\)$/, "");
    try {
      return fs.realpathSync.native(withoutDeletedSuffix);
    } catch {
      return path.resolve(withoutDeletedSuffix);
    }
  }

  function processIdentityMatchesGatewayBinary(
    identity: string,
    gatewayBin?: string | null,
  ): boolean {
    return gatewayProcessCmdlineMatches(identity, gatewayBin, {
      processNames: OPENSHELL_GATEWAY_PROCESS_NAMES,
      resolveExecutablePath: normalizeGatewayExecutablePath,
    });
  }

  function shouldRequireDockerDriverEnv(platform: NodeJS.Platform = process.platform): boolean {
    return platform === "linux";
  }

  function getDockerDriverGatewayRuntimeDriftFromSnapshot({
    processEnv,
    processExe,
    desiredEnv,
    gatewayBin,
  }: {
    processEnv: Record<string, string> | null;
    processExe: string | null;
    desiredEnv: Record<string, string>;
    gatewayBin?: string | null;
  }): DockerDriverGatewayRuntimeDrift | null {
    if (!processEnv) {
      return { reason: "could not verify process environment" };
    }
    for (const key of dockerDriverGatewayEnv.DOCKER_DRIVER_GATEWAY_RUNTIME_ENV_KEYS) {
      const desired = desiredEnv[key];
      if (typeof desired !== "string") continue;
      const actual = processEnv[key];
      if (actual !== desired) {
        return { reason: `${key}=${actual || "<unset>"} (expected ${desired})` };
      }
    }

    if (processExe === null) {
      return { reason: "could not verify process executable" };
    }
    if (processExe.endsWith(" (deleted)")) {
      return { reason: "gateway executable was replaced on disk" };
    }
    const expectedExe = normalizeGatewayExecutablePath(gatewayBin);
    const actualExe = normalizeGatewayExecutablePath(processExe);
    if (expectedExe && actualExe && actualExe !== expectedExe) {
      return { reason: `executable=${actualExe} (expected ${expectedExe})` };
    }
    return null;
  }

  function getDockerDriverGatewayRuntimeDrift(
    pid: number,
    desiredEnv: Record<string, string>,
    gatewayBin?: string | null,
    platform: NodeJS.Platform = process.platform,
  ): DockerDriverGatewayRuntimeDrift | null {
    if (platform === "darwin" && desiredEnv.OPENSHELL_DRIVERS === "docker") {
      const markerDrift =
        dockerDriverGatewayRuntimeMarker.getDockerDriverGatewayRuntimeMarkerDriftForStateDir(
          getDockerDriverGatewayStateDir(),
          {
            pid,
            desiredEnv,
            endpoint: dockerDriverGatewayEnv.getDockerDriverGatewayEndpoint(currentGatewayPort()),
            gatewayBin,
            dockerHost: process.env.DOCKER_HOST || null,
            platform,
            arch: process.arch,
          },
        );
      if (markerDrift) return markerDrift;
      if (
        vmDriverProcess.hasOpenShellVmDriverChildProcess(pid, (args) =>
          deps.runCapture([...args], { ignoreError: true }),
        )
      ) {
        return { reason: "VM driver child process is still attached to the gateway" };
      }
    }
    if (!shouldRequireDockerDriverEnv(platform)) return null;
    return getDockerDriverGatewayRuntimeDriftFromSnapshot({
      processEnv: readProcessEnv(pid),
      processExe: readProcessExe(pid),
      desiredEnv,
      gatewayBin,
    });
  }

  function captureProcessArgs(pid: number): string {
    return deps
      .runCapture(["ps", "-p", String(pid), "-o", "args="], {
        ignoreError: true,
      })
      .trim();
  }

  function isDockerDriverGatewayProcess(
    pid: number,
    gatewayBin?: string | null,
    opts: { requireDockerDriverEnv?: boolean } = {},
  ): boolean {
    const procCmdlinePath = `/proc/${pid}/cmdline`;
    let identity = "";
    try {
      if (fs.existsSync(procCmdlinePath)) {
        identity = fs.readFileSync(procCmdlinePath, "utf-8").replace(/\0/g, " ").trim();
      }
    } catch {
      identity = "";
    }
    if (!identity) {
      identity = captureProcessArgs(pid);
    }
    if (!identity) return false;
    const matchesGatewayBinary = processIdentityMatchesGatewayBinary(identity, gatewayBin);
    if (!matchesGatewayBinary) return false;
    if (opts.requireDockerDriverEnv && !hasDockerDriverGatewayEnv(pid)) return false;
    return true;
  }

  function isDockerDriverGatewayProcessAlive(): boolean {
    const pid = getDockerDriverGatewayPid();
    if (pid === null || !isPidAlive(pid)) return false;
    if (
      !isDockerDriverGatewayProcess(pid, resolveOpenShellGatewayBinary(), {
        requireDockerDriverEnv: shouldRequireDockerDriverEnv(),
      })
    ) {
      clearDockerDriverGatewayRuntimeFiles();
      return false;
    }
    return true;
  }

  function clearDockerDriverGatewayRuntimeFiles(): void {
    fs.rmSync(getDockerDriverGatewayPidFile(), { force: true });
    dockerDriverGatewayRuntimeMarker.clearDockerDriverGatewayRuntimeMarker(
      getDockerDriverGatewayStateDir(),
    );
  }

  function rememberDockerDriverGatewayPid(pid: number): void {
    dockerDriverGatewayRuntimeMarker.writeDockerDriverGatewayPidFile(
      getDockerDriverGatewayPidFile(),
      pid,
    );
  }

  // Bind listener discovery to this factory's liveness and process-identity
  // dependencies. Returning the configured methods keeps onboard on one
  // authoritative runtime instance rather than constructing a second factory.
  const {
    getDockerDriverGatewayPortListenerPid,
    getDockerDriverGatewayPortListenerScan,
    isDockerDriverGatewayPortListener,
  } = createDockerDriverGatewayPortListenerHelpers({
    gatewayPort: currentGatewayPort,
    runCaptureEx:
      deps.runCaptureEx ??
      ((args) => {
        try {
          return { stdout: deps.runCapture([...args]), exitCode: 0, timedOut: false };
        } catch {
          return { stdout: "", exitCode: null, timedOut: false };
        }
      }),
    isPidAlive,
    isDockerDriverGatewayProcess: (pid, gatewayBin, platform) =>
      isDockerDriverGatewayProcess(pid, gatewayBin, {
        requireDockerDriverEnv: shouldRequireDockerDriverEnv(platform),
      }),
  });
  const getDockerDriverGatewayPortListenerPids = (
    portCheck: PortProbeResult,
    opts: DockerDriverGatewayPortListenerOptions = {},
  ): number[] => getDockerDriverGatewayPortListenerScan(portCheck, opts).pids;

  return {
    clearDockerDriverGatewayRuntimeFiles,
    getDockerDriverGatewayEnv,
    getDockerDriverGatewayPid,
    getDockerDriverGatewayPidFile,
    getDockerDriverGatewayPortListenerScan,
    getDockerDriverGatewayPortListenerPids,
    getDockerDriverGatewayPortListenerPid,
    getDockerDriverGatewayRuntimeDrift,
    getDockerDriverGatewayRuntimeDriftFromSnapshot,
    getDockerDriverGatewayStateDir,
    isDockerDriverGatewayPortListener,
    isDockerDriverGatewayProcess,
    isDockerDriverGatewayProcessAlive,
    isPidAlive,
    rememberDockerDriverGatewayPid,
    resolveOpenShellGatewayBinary,
    resolveOpenShellSandboxBinary,
    shouldRequireDockerDriverEnv,
  };
}
