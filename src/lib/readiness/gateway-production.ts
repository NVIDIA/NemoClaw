// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  classifyManagedGatewayEndpointBinding,
  type ManagedGatewayEndpointBinding,
  type GatewayReuseState,
  type GatewayVersionCompatibility,
  type GatewayVersionSource,
  getGatewayClusterContainerName,
  getGatewayReuseState,
  isGatewayHealthy,
  OPENSHELL_PROBE_TIMEOUT_MS,
  observeOpenShellGatewayVersionCompatibility,
  parseVersionFromText,
  stripAnsi,
} from "../adapters/openshell/gateway-drift";
export { classifyManagedGatewayEndpointBinding };
import { cliName as resolveCliName } from "../onboard/branding";
import {
  getConfiguredGatewayPort,
  getDockerDriverGatewayEndpoint,
  getGatewayPortCheckOptions,
} from "../onboard/docker-driver-gateway-env";
import { getDockerDriverGatewayLocalTlsDir } from "../onboard/docker-driver-gateway-local-tls";
import { createDockerDriverGatewayPortListenerHelpers } from "../onboard/docker-driver-gateway-port-listener";
import {
  hasDockerDriverGatewayEnvironment,
  isDockerDriverGatewayProcessIdentity,
  readDockerDriverGatewayProcessEnvironment,
} from "../onboard/docker-driver-gateway-process-identity";
import {
  resolveDockerDriverGatewayName,
  resolveDockerDriverGatewayStateDirName,
} from "../onboard/docker-driver-gateway-runtime";
import {
  getTrustedActiveOpenShellGatewayUserServiceIdentity,
  hasOpenShellGatewayUserService,
} from "../onboard/docker-driver-gateway-service";
import { createGatewayHostRuntime } from "../onboard/gateway-host-runtime";
import { loadGatewayManagementDeclaration } from "../onboard/gateway-management";
import {
  cleanGatewayProcessToken,
  gatewayProcessCmdlineMatches,
  OPENSHELL_GATEWAY_PROCESS_NAMES,
} from "../onboard/gateway-process-identity";
import { ownedHostGatewayTarget } from "../onboard/gateway-process-target-identity";
import { resolveOpenshell } from "../onboard/openshell-cli";
import { checkPortAvailable } from "../onboard/preflight";
import type {
  GatewayPortConflictState,
  GatewayReadinessDependencies,
  ManagedGatewayObservations,
} from "./gateway";
import { buildSystemReadinessProbeEnv, type ReadinessProbeEnvironmentControls } from "./probe-env";

export interface ProductionGatewayReadinessOptions {
  gatewayName?: () => string;
  gatewayPort?: () => number;
  resolveOwner?: GatewayReadinessDependencies["resolveOwner"];
  probeAttachment?: GatewayReadinessDependencies["probeAttachment"];
  isLegacyClusterBound?: () => boolean;
  observeVersionCompatibility?: (
    source: GatewayVersionSource,
    hostProcessPid: number | null,
  ) => GatewayVersionCompatibility;
}

interface ReadonlyCaptureResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

/** Environment for read-only readiness children; intentionally excludes every credential family. */
export function buildGatewayReadinessProbeEnv(
  source: NodeJS.ProcessEnv = process.env,
  controls: ReadinessProbeEnvironmentControls = {},
): NodeJS.ProcessEnv {
  return buildSystemReadinessProbeEnv(source, controls);
}

function captureReadonly(
  args: readonly string[],
  env: NodeJS.ProcessEnv = buildGatewayReadinessProbeEnv(),
): ReadonlyCaptureResult {
  const [file, ...argv] = args;
  if (!file) return { stdout: "", stderr: "", exitCode: null, timedOut: false };
  const result = spawnSync(file, argv, {
    encoding: "utf-8",
    env,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: OPENSHELL_PROBE_TIMEOUT_MS,
  });
  return {
    stdout: String(result.stdout ?? "").trim(),
    stderr: String(result.stderr ?? "").trim(),
    exitCode: result.status,
    timedOut:
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      result.status === 28,
  };
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function combinedOutput(result: ReadonlyCaptureResult): string {
  return [result.stdout, result.stderr].filter(Boolean).join("\n");
}

function normalizeExecutablePath(value: string): string | null {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return path.isAbsolute(value) ? path.normalize(value) : null;
  }
}

function resolveManagedGatewayProbeTlsDir(
  gatewayPort: number,
  source: NodeJS.ProcessEnv,
): string | undefined {
  const configuredStateDir = source.NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR?.trim();
  const stateDir = configuredStateDir
    ? path.resolve(configuredStateDir)
    : path.join(
        source.HOME || os.homedir(),
        ".local",
        "state",
        "nemoclaw",
        resolveDockerDriverGatewayStateDirName(gatewayPort),
      );
  const localTlsDir = getDockerDriverGatewayLocalTlsDir(stateDir);
  return ["ca.crt", "client/tls.crt", "client/tls.key"].every((relativePath) =>
    fs.existsSync(path.join(localTlsDir, relativePath)),
  )
    ? localTlsDir
    : undefined;
}

/** Require both executable observations to remain the independently trusted binary. */
export function gatewayExecutableSamplesMatchTrustedBinary(
  before: string | null,
  after: string | null,
  trustedBinary: string | null,
): boolean {
  if (!before || !after || !trustedBinary) return false;
  const expected = normalizeExecutablePath(trustedBinary);
  return (
    expected !== null &&
    normalizeExecutablePath(before) === expected &&
    normalizeExecutablePath(after) === expected
  );
}

/** Require one Linux process generation and the trusted executable across both samples. */
export function gatewayProcessSamplesMatchTrustedBinary(
  generationBefore: string | null,
  generationAfter: string | null,
  executableBefore: string | null,
  executableAfter: string | null,
  trustedBinary: string | null,
): boolean {
  return (
    generationBefore !== null &&
    generationAfter === generationBefore &&
    gatewayExecutableSamplesMatchTrustedBinary(executableBefore, executableAfter, trustedBinary)
  );
}

function resolveTrustedOpenshellBinary(env: NodeJS.ProcessEnv): string | null {
  const commandV = captureReadonly(["sh", "-c", 'command -v "$1"', "--", "openshell"], env);
  return resolveOpenshell({
    commandVResult: commandV.exitCode === 0 ? commandV.stdout || null : null,
    home: env.HOME,
  });
}

function resolveTrustedGatewayBinary(openshell: string | null): string | null {
  const configured = process.env.NEMOCLAW_OPENSHELL_GATEWAY_BIN?.trim();
  const candidates = [
    ...(configured ? [path.resolve(configured)] : []),
    ...(openshell ? [path.join(path.dirname(openshell), "openshell-gateway")] : []),
    path.join(os.homedir(), ".local", "bin", "openshell-gateway"),
    "/opt/homebrew/bin/openshell-gateway",
    "/usr/local/bin/openshell-gateway",
    "/usr/bin/openshell-gateway",
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    return normalizeExecutablePath(candidate);
  }
  return null;
}

/** Require the trusted Linux executable plus a trusted path or owned target tag. */
export function gatewayProcessIdentityMatchesTrustedBinary(
  identity: string,
  trustedGatewayBin: string | null,
  gatewayName: string,
  gatewayPort: number,
  actualExecutablePath: string | null = null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  // Linux procfs supplies a kernel-backed executable identity for direct
  // processes. On macOS, argv0 is user-controlled, so direct listeners remain
  // untrusted and only the positively identified Homebrew service is eligible.
  if (!trustedGatewayBin || platform !== "linux") return false;
  const argv0 = cleanGatewayProcessToken(identity.trim().split(/\s+/, 1)[0] ?? "");
  const expected = normalizeExecutablePath(trustedGatewayBin);
  if (
    !expected ||
    !actualExecutablePath ||
    normalizeExecutablePath(actualExecutablePath) !== expected
  ) {
    return false;
  }
  const taggedTarget = ownedHostGatewayTarget(path.basename(argv0));
  if (!taggedTarget) {
    const actual = argv0 ? normalizeExecutablePath(argv0) : null;
    if (!actual || !expected || actual !== expected) return false;
  }
  return gatewayProcessCmdlineMatches(identity, trustedGatewayBin, {
    expectedOpenShellGateway: { name: gatewayName, port: gatewayPort },
    processNames: OPENSHELL_GATEWAY_PROCESS_NAMES,
    resolveExecutablePath: normalizeExecutablePath,
  });
}

function readLinuxProcessStartTime(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf-8");
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) return null;
    return (
      stat
        .slice(commandEnd + 1)
        .trim()
        .split(/\s+/)[19] ?? null
    );
  } catch {
    return null;
  }
}

function readLinuxProcessExecutable(pid: number): string | null {
  try {
    return fs.realpathSync.native(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

function readProcessName(pid: number, env: NodeJS.ProcessEnv): string | null {
  const result = captureReadonly(["ps", "-p", String(pid), "-o", "comm="], env);
  if (result.exitCode !== 0) return null;
  const name = result.stdout.split(/\r?\n/)[0]?.trim();
  return name ? path.basename(name) : null;
}

export function parseDarwinLsofExecutable(output: string): string | null {
  // macOS reports the process executable first, followed by other text vnodes
  // such as /usr/lib/dyld. Selecting the first record prevents a process from
  // satisfying identity by mapping the trusted binary as a later text vnode.
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("n/")) continue;
    const candidate = line.slice(1).trim();
    return path.isAbsolute(candidate) ? candidate : null;
  }
  return null;
}

function readDarwinProcessExecutable(pid: number, env: NodeJS.ProcessEnv): string | null {
  const result = captureReadonly(
    ["/usr/sbin/lsof", "-a", "-p", String(pid), "-d", "txt", "-Fn"],
    env,
  );
  if (result.exitCode !== 0 || result.timedOut) return null;
  return parseDarwinLsofExecutable(result.stdout);
}

function getTrustedHostProcessGatewayRuntime(
  trustedGatewayBin: string | null,
  env: NodeJS.ProcessEnv,
): { gatewayBin: string | null; runningVersion: string | null } | null {
  if (!trustedGatewayBin) return null;
  const version = captureReadonly([trustedGatewayBin, "--version"], env);
  if (version.exitCode !== 0 || version.timedOut) {
    return { gatewayBin: trustedGatewayBin, runningVersion: null };
  }
  return {
    gatewayBin: trustedGatewayBin,
    runningVersion: parseVersionFromText(combinedOutput(version), `${trustedGatewayBin} --version`),
  };
}

function observeReuseState(
  gatewayName: string,
  gatewayPort: number,
  openshell: string | null,
  env: NodeJS.ProcessEnv,
): { endpointBinding: ManagedGatewayEndpointBinding; reuseState: GatewayReuseState | "unknown" } {
  if (!openshell) return { endpointBinding: "not-applicable", reuseState: "missing" };

  const status = captureReadonly([openshell, "status", "-g", gatewayName], env);
  const named = captureReadonly([openshell, "gateway", "info", "-g", gatewayName], env);
  const active = captureReadonly([openshell, "gateway", "info"], env);
  if ([status, named, active].some(({ exitCode, timedOut }) => timedOut || exitCode === null)) {
    return { endpointBinding: "unknown", reuseState: "unknown" };
  }

  const statusOutput = combinedOutput(status);
  let reuseState: GatewayReuseState | "unknown" = getGatewayReuseState(
    statusOutput,
    combinedOutput(named),
    combinedOutput(active),
    gatewayName,
    gatewayName,
  );
  if (status.exitCode !== 0 && reuseState === "missing") {
    reuseState = /\bNo active gateway\b|\bNo gateway metadata found\b/i.test(statusOutput)
      ? "missing"
      : "unknown";
  }
  const liveManagedState = reuseState === "healthy" || reuseState === "active-unnamed";
  return {
    reuseState,
    endpointBinding: liveManagedState
      ? classifyManagedGatewayEndpointBinding(
          [combinedOutput(active), statusOutput, combinedOutput(named)],
          gatewayPort,
        )
      : "not-applicable",
  };
}

function inspectLegacyCluster(
  gatewayName: string,
  gatewayPort: number,
  openshell: string | null,
  env: NodeJS.ProcessEnv,
): { active: boolean; imageRef: string | null } {
  if (!openshell) return { active: false, imageRef: null };
  const status = captureReadonly([openshell, "status", "-g", gatewayName], env);
  const named = captureReadonly([openshell, "gateway", "info", "-g", gatewayName], env);
  const active = captureReadonly([openshell, "gateway", "info"], env);
  if (
    [status, named, active].some(({ exitCode, timedOut }) => timedOut || exitCode === null) ||
    !isGatewayHealthy(
      combinedOutput(status),
      combinedOutput(named),
      combinedOutput(active),
      gatewayName,
    ) ||
    classifyManagedGatewayEndpointBinding(
      [combinedOutput(active), combinedOutput(named)],
      gatewayPort,
    ) !== "match"
  ) {
    return { active: false, imageRef: null };
  }

  const containerName = getGatewayClusterContainerName(gatewayName);
  const running = captureReadonly(
    ["docker", "inspect", "--format", "{{.State.Running}}", containerName],
    env,
  );
  const ports = captureReadonly(
    ["docker", "inspect", "--format", "{{json .NetworkSettings.Ports}}", containerName],
    env,
  );
  if (
    running.exitCode !== 0 ||
    running.timedOut ||
    running.stdout !== "true" ||
    ports.exitCode !== 0 ||
    ports.timedOut
  ) {
    return { active: false, imageRef: null };
  }
  try {
    const bindings = JSON.parse(ports.stdout) as Record<
      string,
      Array<{ HostPort?: string | number | null }> | null
    >;
    const expectedPort = String(gatewayPort);
    const portBound = Object.values(bindings).some((values) =>
      values?.some(({ HostPort }) => String(HostPort ?? "").trim() === expectedPort),
    );
    if (!portBound) return { active: false, imageRef: null };
  } catch {
    return { active: false, imageRef: null };
  }

  const image = captureReadonly(
    ["docker", "inspect", "--format", "{{.Config.Image}}", containerName],
    env,
  );
  return {
    active: true,
    imageRef: image.exitCode === 0 && !image.timedOut ? image.stdout || null : null,
  };
}

function observeInstalledOpenshellVersion(
  openshell: string | null,
  env: NodeJS.ProcessEnv,
): string | null {
  if (!openshell) return null;
  const result = captureReadonly([openshell, "--version"], env);
  if (result.exitCode !== 0 || result.timedOut) return null;
  return parseVersionFromText(combinedOutput(result), `${openshell} --version`);
}

export function classifyManagedGatewayPortConflict(
  portAvailable: boolean,
  listenerScan: {
    pids: readonly number[];
    unverifiedPids: readonly number[];
    complete: boolean;
  },
  reuseState: GatewayReuseState | "unknown",
  legacyClusterBound = false,
  endpointBinding: ManagedGatewayEndpointBinding = "not-applicable",
  hasTargetBoundListenerEvidence = false,
): GatewayPortConflictState {
  const listenerCount = listenerScan.pids.length + listenerScan.unverifiedPids.length;
  if (listenerCount > 1) return "multiple-owners";
  const liveManagedState = reuseState === "healthy" || reuseState === "active-unnamed";
  if (liveManagedState && endpointBinding === "mismatch") return "owner-mismatch";
  if (liveManagedState && endpointBinding === "unknown" && !hasTargetBoundListenerEvidence) {
    return "unknown";
  }
  if (portAvailable) {
    if (listenerCount > 0 || liveManagedState) return "unknown";
    return "none";
  }
  if (reuseState === "foreign-active") return "owner-mismatch";
  if (legacyClusterBound) {
    // Docker's running container plus the exact OpenShell endpoint and
    // published host-port binding positively own this listener. A separately
    // verified host gateway at the same time is an authority contradiction.
    return listenerScan.pids.length > 0 ? "owner-mismatch" : "none";
  }
  if (!listenerScan.complete) return "unknown";
  if (listenerScan.unverifiedPids.length > 0) return "owner-mismatch";
  const recognizedManagedState =
    reuseState === "healthy" ||
    reuseState === "stale" ||
    reuseState === "active-unnamed" ||
    reuseState === "missing";
  return recognizedManagedState && listenerScan.pids.length === 1 ? "none" : "occupied";
}

export function classifyManagedGatewayVersionDrift(
  portAvailable: boolean,
  reuseState: GatewayReuseState | "unknown",
  compatibility: GatewayVersionCompatibility | null,
): ManagedGatewayObservations["driftState"] {
  const managedGatewayCanBeRunning =
    reuseState === "healthy" || reuseState === "stale" || reuseState === "active-unnamed";
  if (portAvailable) {
    return managedGatewayCanBeRunning && reuseState !== "stale" ? "unknown" : "not-detected";
  }
  if (compatibility === "compatible") return "not-detected";
  if (compatibility === "drift") return "detected";
  if (reuseState === "foreign-active") return "not-detected";
  return "unknown";
}

export function classifyManagedGatewayVersionSource(
  legacyClusterBound: boolean,
  listenerScan: { pids: readonly number[]; unverifiedPids: readonly number[] },
  trustedBinaryPids: { has(pid: number): boolean },
): GatewayVersionSource | null {
  if (legacyClusterBound) return "legacy-cluster";
  if (
    listenerScan.pids.length === 1 &&
    listenerScan.unverifiedPids.length === 0 &&
    trustedBinaryPids.has(listenerScan.pids[0])
  ) {
    return "host-process";
  }
  return null;
}

export interface GatewayPortOwners {
  stopPids: number[];
  text: string | null;
}

export function describeGatewayPortOwners(
  listenerScan: { pids: readonly number[]; unverifiedPids: readonly number[] },
  describeProcess: (pid: number) => string | null,
): GatewayPortOwners {
  const allPids = [...new Set([...listenerScan.pids, ...listenerScan.unverifiedPids])];
  const stopPids = [...listenerScan.unverifiedPids];
  if (allPids.length === 0) return { stopPids, text: null };
  const text = allPids
    .map((pid) => {
      const name = describeProcess(pid);
      return name ? `${name} (PID ${pid})` : `PID ${pid}`;
    })
    .join(", ");
  return { stopPids, text };
}

function gatewayPortConflictRemediation(
  gatewayPort: number,
  stopPids: readonly number[],
  hasResolvedOwner: boolean,
  state: GatewayPortConflictState,
): string {
  if (state === "unknown" || !hasResolvedOwner) {
    return `Identify its listener before retrying: sudo lsof -i :${gatewayPort} -sTCP:LISTEN -P -n`;
  }
  if (stopPids.length === 0) {
    const cliName = resolveCliName();
    return (
      "Confirm which managed gateway environment owns the verified listener, then release that " +
      `environment with \`NEMOCLAW_GATEWAY_PORT=${gatewayPort} ${cliName} uninstall\` before retrying.`
    );
  }
  const subject =
    stopPids.length === 1 ? `PID ${stopPids[0]} is` : `PIDs ${stopPids.join(", ")} are`;
  const stopInstruction =
    stopPids.length === 1
      ? "Stop that process through its service manager, or signal only the matching PID from that fresh result before retrying."
      : "Stop each matching process through its service manager, or signal only the matching PIDs from that fresh result before retrying.";
  return (
    `Confirm ${subject} not another NemoClaw gateway. ` +
    `Recheck the listener set immediately before stopping a process: sudo lsof -i :${gatewayPort} -sTCP:LISTEN -P -n. ` +
    stopInstruction
  );
}

export function gatewayPortConflictDetail(
  gatewayPort: number,
  portCheck: Awaited<ReturnType<typeof checkPortAvailable>>,
  state: GatewayPortConflictState,
  owners: GatewayPortOwners = { stopPids: [], text: null },
): string | undefined {
  if (state === "none") return undefined;
  const probedOwner =
    portCheck.process && portCheck.process !== "unknown"
      ? `${portCheck.process}${portCheck.pid ? ` (PID ${portCheck.pid})` : ""}`
      : null;
  const owner = owners.text ?? probedOwner ?? "an unknown listener";
  const condition =
    state === "multiple-owners"
      ? `has multiple listeners: ${owner}`
      : state === "unknown"
        ? "could not be observed completely"
        : `is occupied by ${owner}`;
  const remediation = gatewayPortConflictRemediation(
    gatewayPort,
    owners.stopPids,
    owners.text !== null,
    state,
  );
  return `Gateway port ${gatewayPort} ${condition}. ${remediation}`;
}

function rejectUnexpectedGatewayEffect(): never {
  throw new Error("The public readiness probe cannot perform gateway lifecycle effects.");
}

/** Bind the public collector to local, read-only production probes. */
export function createProductionGatewayReadinessDependencies(
  options: ProductionGatewayReadinessOptions = {},
): GatewayReadinessDependencies {
  const gatewayPort = options.gatewayPort?.() ?? getConfiguredGatewayPort();
  const gatewayName = options.gatewayName?.() ?? resolveDockerDriverGatewayName(gatewayPort);
  const probeEnv = buildGatewayReadinessProbeEnv(process.env, {
    gatewayName,
    localTlsDir: resolveManagedGatewayProbeTlsDir(gatewayPort, process.env),
  });
  const openshellBin = resolveTrustedOpenshellBinary(probeEnv);
  const trustedGatewayBin = resolveTrustedGatewayBinary(openshellBin);
  const trustedVersionBinaryByPid = new Map<number, string>();
  const trustedTargetBoundPids = new Set<number>();

  function observeDirectGatewayBinary(pid: number): string | null {
    if (process.platform !== "linux" || !trustedGatewayBin) return null;
    const generationBefore = readLinuxProcessStartTime(pid);
    const executableBefore = readLinuxProcessExecutable(pid);
    let targetBoundIdentity = false;
    const exactTrustedBinary = isDockerDriverGatewayProcessIdentity({
      pid,
      gatewayBin: trustedGatewayBin,
      captureProcessArgs: (candidatePid) => {
        const result = captureReadonly(["ps", "-p", String(candidatePid), "-o", "args="], probeEnv);
        return result.exitCode === 0 ? result.stdout : "";
      },
      processIdentityMatchesGatewayBinary: (identity) => {
        const matches = gatewayProcessIdentityMatchesTrustedBinary(
          identity,
          trustedGatewayBin,
          gatewayName,
          gatewayPort,
          executableBefore,
          process.platform,
        );
        if (matches) {
          const argv0 = cleanGatewayProcessToken(identity.trim().split(/\s+/, 1)[0] ?? "");
          const target = ownedHostGatewayTarget(path.basename(argv0));
          targetBoundIdentity = target?.name === gatewayName && target.port === gatewayPort;
        }
        return matches;
      },
      requireDockerDriverEnv: true,
      hasDockerDriverGatewayEnv: (candidatePid) =>
        hasDockerDriverGatewayEnvironment(
          readDockerDriverGatewayProcessEnvironment(candidatePid),
          getDockerDriverGatewayEndpoint(gatewayPort),
        ),
    });
    const executableAfter = readLinuxProcessExecutable(pid);
    const generationAfter = readLinuxProcessStartTime(pid);
    const stableTrustedBinary =
      exactTrustedBinary &&
      gatewayProcessSamplesMatchTrustedBinary(
        generationBefore,
        generationAfter,
        executableBefore,
        executableAfter,
        trustedGatewayBin,
      );
    if (!stableTrustedBinary) return null;
    if (targetBoundIdentity) trustedTargetBoundPids.add(pid);
    return trustedGatewayBin;
  }

  function observePackagedServiceGatewayBinary(pid: number): string | null {
    if (process.platform !== "linux" && process.platform !== "darwin") return null;
    const serviceBefore = getTrustedActiveOpenShellGatewayUserServiceIdentity({
      env: probeEnv,
      suppressUnsupportedVersionWarning: true,
    });
    if (serviceBefore?.pid !== pid || !serviceBefore.executablePath) return null;
    const generationBefore = process.platform === "linux" ? readLinuxProcessStartTime(pid) : null;
    const executableBefore =
      process.platform === "linux"
        ? readLinuxProcessExecutable(pid)
        : readDarwinProcessExecutable(pid, probeEnv);
    const serviceAfter = getTrustedActiveOpenShellGatewayUserServiceIdentity({
      env: probeEnv,
      suppressUnsupportedVersionWarning: true,
    });
    // Bracket the complete service-identity probe so PID reuse or re-exec
    // cannot preserve a stale trusted executable sample.
    const executableAfter =
      process.platform === "linux"
        ? readLinuxProcessExecutable(pid)
        : readDarwinProcessExecutable(pid, probeEnv);
    const generationAfter = process.platform === "linux" ? readLinuxProcessStartTime(pid) : null;
    const expected = normalizeExecutablePath(serviceBefore.executablePath);
    const confirmed = serviceAfter?.executablePath
      ? normalizeExecutablePath(serviceAfter.executablePath)
      : null;
    const stableGeneration =
      process.platform !== "linux" ||
      (generationBefore !== null && generationAfter === generationBefore);
    if (
      serviceAfter?.pid !== pid ||
      !expected ||
      confirmed !== expected ||
      !stableGeneration ||
      !gatewayExecutableSamplesMatchTrustedBinary(executableBefore, executableAfter, expected)
    ) {
      return null;
    }
    return expected;
  }

  const listenerHelpers = createDockerDriverGatewayPortListenerHelpers({
    gatewayPort,
    runCaptureEx: (args) => captureReadonly(args, probeEnv),
    isPidAlive,
    isDockerDriverGatewayProcess: (pid) => {
      const trustedBinary =
        observeDirectGatewayBinary(pid) ?? observePackagedServiceGatewayBinary(pid);
      if (!trustedBinary) return false;
      trustedVersionBinaryByPid.set(pid, trustedBinary);
      return true;
    },
  });
  const checkGatewayPortAvailable = () =>
    checkPortAvailable(gatewayPort, {
      ...getGatewayPortCheckOptions(),
      // Public readiness is observation-only. The independent bind probe tells
      // us whether the port is occupied, and the unprivileged listener scan
      // below supplies any ownership evidence available to this user. If that
      // scan cannot see the listener, classification remains unknown and fails
      // closed instead of attempting `sudo -n lsof`.
      skipLsof: true,
    });
  const runtime = createGatewayHostRuntime({
    applyOverlayfsAutoFix: () => null,
    checkGatewayPortAvailable,
    gatewayName: () => gatewayName,
    gatewayPort: () => gatewayPort,
    getGatewayPortListenerRawScan: (portCheck, options) =>
      listenerHelpers.getGatewayPortListenerRawScan(portCheck, options),
    getInstalledOpenshellVersion: () => null,
    hasOpenShellGatewayUserService: () =>
      hasOpenShellGatewayUserService({
        env: probeEnv,
        suppressUnsupportedVersionWarning: true,
      }),
    loadGatewayManagementDeclaration,
    recordHttpReadinessTrace: false,
    clientProbeEnv: probeEnv,
    resolveOpenShellGatewayBinary: () => null,
    runCaptureOpenshell: rejectUnexpectedGatewayEffect,
    runOpenshell: rejectUnexpectedGatewayEffect,
    waitForGatewayHttpReady: async () => false,
    supervisorProbeEnv: probeEnv,
  });

  async function observeManagedGateway(): Promise<ManagedGatewayObservations> {
    const { endpointBinding, reuseState } = observeReuseState(
      gatewayName,
      gatewayPort,
      openshellBin,
      probeEnv,
    );
    const portCheck = await checkGatewayPortAvailable();
    trustedVersionBinaryByPid.clear();
    trustedTargetBoundPids.clear();
    const listenerScan = listenerHelpers.getDockerDriverGatewayPortListenerScan(portCheck, {
      gatewayBin: trustedGatewayBin,
    });
    const managedGatewayCanBeRunning =
      reuseState === "healthy" || reuseState === "stale" || reuseState === "active-unnamed";
    let legacyClusterBound = false;
    let legacyClusterImageRef: string | null = null;
    if (!portCheck.ok && managedGatewayCanBeRunning) {
      try {
        if (options.isLegacyClusterBound) {
          legacyClusterBound = options.isLegacyClusterBound();
        } else {
          const legacyCluster = inspectLegacyCluster(
            gatewayName,
            gatewayPort,
            openshellBin,
            probeEnv,
          );
          legacyClusterBound = legacyCluster.active;
          legacyClusterImageRef = legacyCluster.imageRef;
        }
      } catch {
        legacyClusterBound = false;
      }
    }
    let compatibility: GatewayVersionCompatibility | null = null;
    if (!portCheck.ok) {
      const source = classifyManagedGatewayVersionSource(
        legacyClusterBound,
        listenerScan,
        trustedVersionBinaryByPid,
      );
      try {
        if (source) {
          const hostProcessPid = source === "host-process" ? listenerScan.pids[0] : null;
          const installedVersion = observeInstalledOpenshellVersion(openshellBin, probeEnv);
          compatibility =
            options.observeVersionCompatibility?.(source, hostProcessPid) ??
            observeOpenShellGatewayVersionCompatibility({
              gatewayName,
              source,
              deps:
                source === "legacy-cluster"
                  ? {
                      getInstalledOpenshellVersion: () => installedVersion,
                      getGatewayClusterImageRef: () => legacyClusterImageRef,
                      isGatewayClusterActive: () => true,
                    }
                  : {
                      getInstalledOpenshellVersion: () => installedVersion,
                      getGatewayClusterImageRef: () => null,
                      getHostProcessGatewayRuntime: () =>
                        hostProcessPid === null
                          ? null
                          : getTrustedHostProcessGatewayRuntime(
                              trustedVersionBinaryByPid.get(hostProcessPid) ?? null,
                              probeEnv,
                            ),
                    },
            });
        }
      } catch {
        compatibility = "unknown";
      }
    }
    const driftState = classifyManagedGatewayVersionDrift(portCheck.ok, reuseState, compatibility);
    const portConflictState = classifyManagedGatewayPortConflict(
      portCheck.ok,
      listenerScan,
      reuseState,
      legacyClusterBound,
      endpointBinding,
      listenerScan.pids.length === 1 && trustedTargetBoundPids.has(listenerScan.pids[0] ?? -1),
    );
    const portConflictOwners =
      portConflictState === "none"
        ? { stopPids: [], text: null }
        : describeGatewayPortOwners(listenerScan, (pid) => readProcessName(pid, probeEnv));
    return {
      reuseState,
      driftState,
      portConflictState,
      portConflictDetail: gatewayPortConflictDetail(
        gatewayPort,
        portCheck,
        portConflictState,
        portConflictOwners,
      ),
    };
  }

  return {
    resolveOwner: options.resolveOwner ?? runtime.getGatewayOwner,
    probeAttachment: options.probeAttachment ?? runtime.probeGatewayAttachment,
    observeManagedGateway,
  };
}
