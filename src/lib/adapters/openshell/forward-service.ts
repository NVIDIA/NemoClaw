// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import path from "node:path";

import { isValidName } from "../../name-validation";
import { buildOpenShellSubprocessEnv } from "./resolve-shared";
import { probeLocalForwardListener } from "./local-forward-listener";

const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const PROCESS_TREE_TERMINATION_TIMEOUT_MS = 5_000;
const PROCESS_TREE_TERMINATION_POLL_MS = 25;
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4));

export interface ForwardServiceTarget {
  readonly executable: string;
  readonly gatewayName: string;
  readonly workspace: string;
  readonly sandboxName: string;
  readonly localHost: "127.0.0.1" | "0.0.0.0";
  readonly localPort: number;
  readonly targetHost: "127.0.0.1";
  readonly targetPort: number;
}

export interface ForwardServiceLaunchOptions {
  readonly isReachable?: (port: number) => boolean;
  readonly sleep?: (milliseconds: number) => void;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
  readonly spawnDetached?: (
    executable: string,
    args: readonly string[],
    environment: NodeJS.ProcessEnv,
  ) => ForwardServiceChild;
  readonly terminateProcessTree?: (child: ForwardServiceChild) => void;
  /** Verify the bound forward before releasing the child from startup cleanup. */
  readonly verifyReady?: () => void;
  readonly timeoutMs?: number;
}

export interface ForwardServiceChild {
  readonly pid?: number;
  unref(): void;
}

export interface ForwardServiceProcessTreeTerminationDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly isTrustedTaskkillExecutable?: (executable: string) => boolean;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  readonly processGroupHasRunnableMember?: (pid: number) => boolean;
  readonly signalProcess?: (pid: number, signal: NodeJS.Signals | number) => void;
  readonly sleep?: (milliseconds: number) => void;
  readonly taskkill?: (
    executable: string,
    args: readonly string[],
  ) => { readonly error?: Error; readonly status: number | null };
}

export class ForwardServiceStartupCleanupError extends AggregateError {
  constructor(startupError: Error, cleanupError: unknown) {
    super(
      [startupError, cleanupError],
      "OpenShell forward service startup cleanup could not be proved",
    );
    this.name = "ForwardServiceStartupCleanupError";
  }
}

type ForwardServiceOwnerProbe = (
  executable: string,
  args: readonly string[],
) => { status: number | null; stdout: string };

export interface ForwardServiceOwnerOptions {
  readonly platform?: NodeJS.Platform;
  readonly probe?: ForwardServiceOwnerProbe;
  readonly procRoot?: string;
  readonly procWorkLimit?: number;
}

const FORWARD_OWNER_PROBE_TIMEOUT_MS = 5_000;
const LINUX_PROC_WORK_LIMIT = 50_000;

function isPort(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 65_535;
}

function isCanonicalNemoClawGatewayName(value: string): boolean {
  if (value === "nemoclaw") return true;
  const match = /^nemoclaw-([1-9]\d{0,4})$/u.exec(value);
  if (!match) return false;
  const port = Number(match[1]);
  return port >= 1 && port <= 65_535 && port !== 8_080;
}

export function validateForwardServiceTarget(target: ForwardServiceTarget): ForwardServiceTarget {
  if (!path.isAbsolute(target.executable) || target.executable.includes("\0")) {
    throw new Error("OpenShell forward service executable must be an absolute path");
  }
  if (!isCanonicalNemoClawGatewayName(target.gatewayName)) {
    throw new Error("OpenShell forward service gateway must be a canonical NemoClaw gateway");
  }
  if (!isValidName(target.workspace)) {
    throw new Error("OpenShell forward service workspace is invalid");
  }
  if (!isValidName(target.sandboxName)) {
    throw new Error("OpenShell forward service sandbox name is invalid");
  }
  if (target.localHost !== "127.0.0.1" && target.localHost !== "0.0.0.0") {
    throw new Error("OpenShell forward service local host must be IPv4 loopback or all interfaces");
  }
  if (!isPort(target.localPort) || !isPort(target.targetPort)) {
    throw new Error("OpenShell forward service ports must be between 1 and 65535");
  }
  if (target.targetHost !== "127.0.0.1") {
    throw new Error("OpenShell forward service target host must be IPv4 loopback");
  }
  return target;
}

export function createForwardServiceTarget(
  target: Pick<
    ForwardServiceTarget,
    "executable" | "gatewayName" | "workspace" | "sandboxName" | "localHost"
  >,
  port: number,
): ForwardServiceTarget {
  return validateForwardServiceTarget({
    ...target,
    localPort: port,
    targetHost: "127.0.0.1",
    targetPort: port,
  });
}

/** Build the direct ForwardTcp command introduced in OpenShell 0.0.106. */
export function buildForwardServiceArgs(target: ForwardServiceTarget): string[] {
  validateForwardServiceTarget(target);
  return [
    "--gateway",
    target.gatewayName,
    "--workspace",
    target.workspace,
    "forward",
    "service",
    target.sandboxName,
    "--target-port",
    String(target.targetPort),
    "--target-host",
    target.targetHost,
    "--local",
    `${target.localHost}:${String(target.localPort)}`,
  ];
}

function captureProcess(executable: string, args: readonly string[]) {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    timeout: FORWARD_OWNER_PROBE_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

function lsofListenerPids(port: number, probe: ForwardServiceOwnerProbe): string[] | null {
  const result = probe("lsof", [`-ti4TCP:${String(port)}`, "-sTCP:LISTEN"]);
  if (result.status === null) return null;
  if (result.status !== 0) return [];
  return [
    ...new Set(
      result.stdout
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

function linuxListenerPids(port: number, procRoot: string, workLimit: number): string[] {
  if (!Number.isSafeInteger(workLimit) || workLimit < 1) return [];
  const portSuffix = `:${port.toString(16).padStart(4, "0").toUpperCase()}`;
  const socketInodes = new Set<string>();
  try {
    for (const line of readFileSync(path.join(procRoot, "net", "tcp"), "utf8").split("\n")) {
      const fields = line.trim().split(/\s+/u);
      if (
        fields[3] === "0A" &&
        fields[1]?.toUpperCase().endsWith(portSuffix) &&
        /^\d+$/u.test(fields[9] ?? "")
      ) {
        socketInodes.add(fields[9]);
      }
    }
  } catch {
    // A missing or unreadable IPv4 table cannot prove ownership.
  }
  if (socketInodes.size === 0) return [];

  const pids = new Set<string>();
  let inspected = 0;
  try {
    for (const entry of readdirSync(procRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^[1-9]\d*$/u.test(entry.name)) continue;
      if (++inspected > workLimit) return [];
      try {
        for (const descriptor of readdirSync(path.join(procRoot, entry.name, "fd"))) {
          if (++inspected > workLimit) return [];
          const link = readlinkSync(path.join(procRoot, entry.name, "fd", descriptor));
          const match = /^socket:\[(\d+)\]$/u.exec(link);
          if (match && socketInodes.has(match[1])) {
            pids.add(entry.name);
            break;
          }
        }
      } catch {
        // Processes can exit or deny access while /proc is being inspected.
      }
    }
  } catch {
    return [];
  }
  return [...pids];
}

function listenerPids(
  port: number,
  platform: NodeJS.Platform,
  procRoot: string,
  procWorkLimit: number,
  probe: ForwardServiceOwnerProbe,
): string[] {
  const lsof = lsofListenerPids(port, probe);
  if (lsof !== null || platform !== "linux") return lsof ?? [];
  return linuxListenerPids(port, procRoot, procWorkLimit);
}

function executableMatches(actualExecutable: string, expectedExecutable: string): boolean {
  try {
    return realpathSync(actualExecutable) === realpathSync(expectedExecutable);
  } catch {
    return false;
  }
}

function processExecutableMatches(
  pid: string,
  target: ForwardServiceTarget,
  platform: NodeJS.Platform,
  procRoot: string,
  probe: ForwardServiceOwnerProbe,
): boolean {
  if (platform === "linux") {
    return executableMatches(path.join(procRoot, pid, "exe"), target.executable);
  }
  if (platform !== "darwin") return false;
  const result = probe("lsof", ["-a", "-p", pid, "-d", "txt", "-Fn"]);
  if (result.status !== 0) return false;
  return result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("n/"))
    .some((line) => executableMatches(line.slice(1), target.executable));
}

/** Prove that the current listener is the exact direct ForwardTcp command. */
export function isForwardServiceListenerOwner(
  target: ForwardServiceTarget,
  options: ForwardServiceOwnerOptions = {},
): boolean {
  validateForwardServiceTarget(target);
  const platform = options.platform ?? process.platform;
  const probe = options.probe ?? captureProcess;
  const procRoot = options.procRoot ?? "/proc";
  const procWorkLimit = options.procWorkLimit ?? LINUX_PROC_WORK_LIMIT;
  const before = listenerPids(target.localPort, platform, procRoot, procWorkLimit, probe);
  if (before.length !== 1 || !/^[1-9]\d*$/u.test(before[0])) return false;
  const pid = before[0];
  if (!processExecutableMatches(pid, target, platform, procRoot, probe)) return false;
  const commandLine = probe("ps", ["-ww", "-p", pid, "-o", "args="]);
  if (commandLine.status !== 0) return false;
  const expected = [target.executable, ...buildForwardServiceArgs(target)].join(" ");
  if (commandLine.stdout.trim() !== expected) return false;
  const after = listenerPids(target.localPort, platform, procRoot, procWorkLimit, probe);
  return after.length === 1 && after[0] === pid;
}

function forwardServiceEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = buildOpenShellSubprocessEnv(source);
  const configHome = source.XDG_CONFIG_HOME?.trim();
  if (configHome && path.isAbsolute(configHome)) environment.XDG_CONFIG_HOME = configHome;
  return environment;
}

function noSuchProcess(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

function normalizedWindowsPath(value: string): string {
  return path.win32.normalize(value.replace(/^\\\\\?\\/u, "")).toLowerCase();
}

export function isTrustedTaskkillExecutable(executable: string): boolean {
  try {
    const metadata = lstatSync(executable);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return false;
    return (
      normalizedWindowsPath(realpathSync.native(executable)) === normalizedWindowsPath(executable)
    );
  } catch {
    return false;
  }
}

function resolveTrustedTaskkillExecutable(
  environment: NodeJS.ProcessEnv,
  verify: (executable: string) => boolean,
): string {
  const systemRoot = environment.SystemRoot?.trim();
  if (
    !systemRoot ||
    systemRoot.includes("\0") ||
    !/^[a-z]:[\\/]/iu.test(systemRoot) ||
    systemRoot.split(/[\\/]/u).includes("..")
  ) {
    throw new Error("Trusted Windows SystemRoot is unavailable");
  }
  const executable = path.win32.join(path.win32.normalize(systemRoot), "System32", "taskkill.exe");
  if (!verify(executable)) {
    throw new Error("Trusted Windows taskkill executable is unavailable");
  }
  return executable;
}

function processGroupHasRunnableMember(pid: number): boolean {
  const result = spawnSync("/bin/ps", ["-axo", "pgid=,stat="], {
    encoding: "utf8",
    timeout: FORWARD_OWNER_PROBE_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error("OpenShell forward service process-group settlement probe failed", {
      cause: result.error,
    });
  }
  return (result.stdout ?? "")
    .split(/\r?\n/u)
    .map((line) => /^\s*(\d+)\s+(\S+)/u.exec(line))
    .some((match) => Number(match?.[1]) === pid && !match?.[2]?.startsWith("Z"));
}

/** Terminate only the detached child process group created for this forward launch. */
export function terminateForwardServiceProcessTree(
  child: ForwardServiceChild,
  dependencies: ForwardServiceProcessTreeTerminationDependencies = {},
): void {
  const pid = child.pid;
  if (!Number.isSafeInteger(pid) || Number(pid) <= 1 || pid === process.pid) {
    throw new Error("OpenShell forward service child PID is unavailable");
  }

  const signalProcess = dependencies.signalProcess ?? process.kill.bind(process);
  if ((dependencies.platform ?? process.platform) !== "win32") {
    try {
      signalProcess(-Number(pid), "SIGKILL");
    } catch (error) {
      if (!noSuchProcess(error)) {
        throw new Error("OpenShell forward service process-group termination failed", {
          cause: error,
        });
      }
    }
    const now = dependencies.now ?? Date.now;
    const sleep =
      dependencies.sleep ??
      ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
    const hasRunnableMember =
      dependencies.processGroupHasRunnableMember ?? processGroupHasRunnableMember;
    const deadline = now() + PROCESS_TREE_TERMINATION_TIMEOUT_MS;
    while (now() < deadline) {
      if (!hasRunnableMember(Number(pid))) return;
      sleep(PROCESS_TREE_TERMINATION_POLL_MS);
    }
    if (!hasRunnableMember(Number(pid))) return;
    throw new Error("OpenShell forward service process group did not terminate");
  }

  const taskkill =
    dependencies.taskkill ??
    ((executable: string, args: readonly string[]) => {
      const result = spawnSync(executable, [...args], {
        stdio: "ignore",
        timeout: FORWARD_OWNER_PROBE_TIMEOUT_MS,
        windowsHide: true,
      });
      return { error: result.error, status: result.status };
    });
  const taskkillExecutable = resolveTrustedTaskkillExecutable(
    dependencies.environment ?? process.env,
    dependencies.isTrustedTaskkillExecutable ?? isTrustedTaskkillExecutable,
  );
  const result = taskkill(taskkillExecutable, ["/PID", String(pid), "/T", "/F"]);
  if (!result.error && result.status === 0) return;
  throw new Error("OpenShell forward service process-tree termination failed", {
    cause: result.error,
  });
}

/** Launch one foreground OpenShell service forward as a detached host child. */
export function launchForwardService(
  target: ForwardServiceTarget,
  options: ForwardServiceLaunchOptions = {},
): void {
  validateForwardServiceTarget(target);
  const isReachable = options.isReachable ?? probeLocalForwardListener;
  if (isReachable(target.localPort)) {
    throw new Error(`Host port ${String(target.localPort)} is already occupied`);
  }
  const spawnDetached =
    options.spawnDetached ??
    ((executable, args, environment) =>
      spawn(executable, [...args], { detached: true, env: environment, stdio: "ignore" }));
  const child = spawnDetached(
    target.executable,
    buildForwardServiceArgs(target),
    forwardServiceEnvironment(options.sourceEnvironment ?? process.env),
  );

  const sleep =
    options.sleep ?? ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
  const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  let startupError = new Error(
    `OpenShell forward service did not bind ${target.localHost}:${String(target.localPort)}`,
  );
  while (Date.now() < deadline) {
    if (isReachable(target.localPort)) {
      try {
        options.verifyReady?.();
      } catch (error) {
        startupError = error instanceof Error ? error : new Error(String(error));
        break;
      }
      child.unref();
      return;
    }
    sleep(POLL_INTERVAL_MS);
  }
  try {
    (options.terminateProcessTree ?? terminateForwardServiceProcessTree)(child);
    if (isReachable(target.localPort)) {
      throw new Error("OpenShell forward service listener remained reachable after termination");
    }
  } catch (cleanupError) {
    throw new ForwardServiceStartupCleanupError(startupError, cleanupError);
  }
  // Keep the failed child referenced so Node reaps it after this synchronous stack unwinds.
  throw startupError;
}
