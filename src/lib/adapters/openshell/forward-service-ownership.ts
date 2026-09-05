// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { buildOpenShellSubprocessEnv } from "./resolve-shared";
import {
  buildForwardServiceArgs,
  type ForwardServiceTarget,
  validateForwardServiceTarget,
} from "./forward-service";

const PROBE_TIMEOUT_MS = 1_000;
const PROBE_MAX_BUFFER_BYTES = 16 * 1024;
const LINUX_PROC_MAX_PROCESSES = 4_096;
const LINUX_PROC_MAX_DESCRIPTORS_PER_PROCESS = 4_096;
const LINUX_PROC_MAX_TOTAL_DESCRIPTORS = 32_768;

export interface ForwardServiceProcessSnapshot {
  readonly argv: readonly string[] | null;
  readonly commandLine: string | null;
  readonly environment: Readonly<Record<string, string>> | null;
  readonly executable: string | null;
  readonly uid: number | null;
}

export interface ForwardServiceOwnershipDeps {
  readonly currentUid?: () => number | null;
  readonly inspectProcess?: (pid: number) => ForwardServiceProcessSnapshot | null;
  readonly listLinuxProcListenerPids?: (port: number) => readonly number[] | null;
  readonly listLsofListenerPids?: (port: number) => readonly number[] | null;
  readonly listListenerPids?: (port: number) => readonly number[] | null;
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (value: string) => string | null;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
}

export type ForwardServiceOwnershipFailure =
  | "listener-changed"
  | "listener-enumeration-unavailable"
  | "listener-not-unique"
  | "process-identity-mismatch";

export type ForwardServiceOwnershipResult =
  | { readonly owned: true }
  | { readonly owned: false; readonly failure: ForwardServiceOwnershipFailure };

export interface LinuxProcSocketDeps {
  readonly readDirectory?: (directory: string) => readonly string[] | null;
  readonly readFile?: (file: string) => string | null;
  readonly readLink?: (file: string) => string | null;
}

function probeExecutable(candidates: readonly string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runProbe(executable: string, args: readonly string[]) {
  return spawnSync(executable, [...args], {
    encoding: "utf8",
    env: buildOpenShellSubprocessEnv(),
    maxBuffer: PROBE_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: PROBE_TIMEOUT_MS,
  });
}

function listLsofListenerPids(port: number): readonly number[] | null {
  const lsof = probeExecutable(["/usr/sbin/lsof", "/usr/bin/lsof"]);
  if (!lsof) return null;
  const result = runProbe(lsof, ["-nP", `-iTCP:${String(port)}`, "-sTCP:LISTEN", "-Fp"]);
  if (result.error || result.status !== 0) return null;
  const pids = new Set<number>();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /^p([1-9]\d*)$/u.exec(line.trim());
    if (match) pids.add(Number(match[1]));
  }
  return [...pids];
}

function readFile(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readDirectory(directory: string): readonly string[] | null {
  try {
    return fs.readdirSync(directory);
  } catch {
    return null;
  }
}

function readLink(file: string): string | null {
  try {
    return fs.readlinkSync(file);
  } catch {
    return null;
  }
}

function linuxTcpListenerInodes(table: string, port: number): ReadonlySet<string> {
  const portHex = port.toString(16).padStart(4, "0").toUpperCase();
  const inodes = new Set<string>();
  for (const line of table.split(/\r?\n/u).slice(1)) {
    const fields = line.trim().split(/\s+/u);
    if (fields.length < 10) continue;
    const localPort = fields[1]?.split(":").at(-1)?.toUpperCase();
    if (fields[3] === "0A" && localPort === portHex && /^\d+$/u.test(fields[9] ?? "")) {
      inodes.add(fields[9] as string);
    }
  }
  return inodes;
}

/** Resolve an IPv4 listener to its Linux procfs process owners. */
export function listLinuxProcListenerPids(
  port: number,
  deps: LinuxProcSocketDeps = {},
): readonly number[] | null {
  const readProcFile = deps.readFile ?? readFile;
  const table = readProcFile("/proc/net/tcp");
  if (table === null) return null;
  const socketInodes = linuxTcpListenerInodes(table, port);
  if (socketInodes.size === 0) return [];
  const entries = (deps.readDirectory ?? readDirectory)("/proc");
  if (!entries) return null;
  const processEntries = entries.filter((entry) => /^[1-9]\d*$/u.test(entry));
  if (processEntries.length > LINUX_PROC_MAX_PROCESSES) return null;
  const readProcDirectory = deps.readDirectory ?? readDirectory;
  const readProcLink = deps.readLink ?? readLink;
  const pids = new Set<number>();
  let descriptorCount = 0;
  for (const entry of processEntries) {
    const descriptors = readProcDirectory(`/proc/${entry}/fd`);
    if (!descriptors) continue;
    descriptorCount += descriptors.length;
    if (
      descriptors.length > LINUX_PROC_MAX_DESCRIPTORS_PER_PROCESS ||
      descriptorCount > LINUX_PROC_MAX_TOTAL_DESCRIPTORS
    ) {
      return null;
    }
    for (const descriptor of descriptors) {
      const link = readProcLink(`/proc/${entry}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/u.exec(link ?? "");
      if (match && socketInodes.has(match[1] as string)) {
        pids.add(Number(entry));
        break;
      }
    }
  }
  return [...pids];
}

function ownershipListenerPids(
  port: number,
  deps: ForwardServiceOwnershipDeps,
): readonly number[] | null {
  if (deps.listListenerPids) return deps.listListenerPids(port);
  const lsof = (deps.listLsofListenerPids ?? listLsofListenerPids)(port);
  if (lsof && lsof.length > 0) return lsof;
  if ((deps.platform ?? process.platform) === "linux") {
    const proc = (deps.listLinuxProcListenerPids ?? listLinuxProcListenerPids)(port);
    if (proc !== null) return proc;
  }
  return lsof;
}

function processUid(pid: number): number | null {
  try {
    const uid = fs.statSync(`/proc/${String(pid)}`).uid;
    if (Number.isSafeInteger(uid) && uid >= 0) return uid;
  } catch {
    // Fall through to ps on hosts without procfs.
  }
  const ps = probeExecutable(["/bin/ps", "/usr/bin/ps"]);
  if (!ps) return null;
  const result = runProbe(ps, ["-p", String(pid), "-o", "uid="]);
  const uid = Number(result.status === 0 ? result.stdout.trim() : "");
  return Number.isSafeInteger(uid) && uid >= 0 ? uid : null;
}

function processExecutable(pid: number): string | null {
  try {
    return fs.realpathSync.native(`/proc/${String(pid)}/exe`);
  } catch {
    // Fall through to lsof on hosts without procfs.
  }
  const lsof = probeExecutable(["/usr/sbin/lsof", "/usr/bin/lsof"]);
  if (!lsof) return null;
  const result = runProbe(lsof, ["-a", "-p", String(pid), "-d", "txt", "-Fn"]);
  if (result.error || result.status !== 0) return null;
  return (
    result.stdout
      .split(/\r?\n/u)
      .find((line) => line.startsWith("n") && line.length > 1)
      ?.slice(1) ?? null
  );
}

function processArgv(pid: number): readonly string[] | null {
  try {
    const argv = fs.readFileSync(`/proc/${String(pid)}/cmdline`, "utf8").split("\0");
    if (argv.at(-1) === "") argv.pop();
    return argv.length > 0 ? argv : null;
  } catch {
    return null;
  }
}

function processCommandLine(pid: number): string | null {
  const ps = probeExecutable(["/bin/ps", "/usr/bin/ps"]);
  if (!ps) return null;
  const result = runProbe(ps, ["-ww", "-p", String(pid), "-o", "command="]);
  const commandLine = result.status === 0 ? result.stdout.trim() : "";
  return commandLine || null;
}

function processEnvironment(pid: number): Readonly<Record<string, string>> | null {
  try {
    return Object.fromEntries(
      fs
        .readFileSync(`/proc/${String(pid)}/environ`, "utf8")
        .split("\0")
        .filter((entry) => entry.includes("="))
        .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)]),
    );
  } catch {
    // Fall through to ps on hosts without procfs.
  }
  const ps = probeExecutable(["/bin/ps", "/usr/bin/ps"]);
  if (!ps) return null;
  const result = runProbe(ps, ["eww", "-p", String(pid), "-o", "command="]);
  if (result.error || result.status !== 0) return null;
  const environment: Record<string, string> = {};
  for (const token of result.stdout.trim().split(/\s+/u)) {
    const separator = token.indexOf("=");
    if (separator > 0) environment[token.slice(0, separator)] = token.slice(separator + 1);
  }
  return environment;
}

function inspectProcess(pid: number): ForwardServiceProcessSnapshot {
  const argv = processArgv(pid);
  return {
    argv,
    commandLine: argv ? null : processCommandLine(pid),
    environment: processEnvironment(pid),
    executable: processExecutable(pid),
    uid: processUid(pid),
  };
}

function realpath(value: string): string | null {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

function sameArgv(actual: readonly string[], expected: readonly string[]): boolean {
  return (
    actual.length === expected.length && actual.every((value, index) => value === expected[index])
  );
}

function processMatchesForwardTarget(
  pid: number,
  deps: ForwardServiceOwnershipDeps,
  currentUid: number,
  expectedEnvironment: NodeJS.ProcessEnv,
  expectedExecutable: string,
  expectedArgv: readonly string[],
): boolean {
  const snapshot = (deps.inspectProcess ?? inspectProcess)(pid);
  if (!snapshot || snapshot.uid !== currentUid) return false;
  const environment = snapshot.environment;
  if (
    !environment ||
    environment.HOME !== expectedEnvironment.HOME ||
    environment.XDG_CONFIG_HOME !== expectedEnvironment.XDG_CONFIG_HOME ||
    environment.XDG_RUNTIME_DIR !== expectedEnvironment.XDG_RUNTIME_DIR
  ) {
    return false;
  }
  const resolvePath = deps.realpath ?? realpath;
  const observedExecutable = snapshot.executable ? resolvePath(snapshot.executable) : null;
  if (observedExecutable !== expectedExecutable) return false;
  return snapshot.argv
    ? sameArgv(snapshot.argv, expectedArgv)
    : snapshot.commandLine === expectedArgv.join(" ");
}

/** Explain whether a bound port belongs to the exact direct ForwardTcp command. */
export function inspectForwardServiceListenerOwnership(
  target: ForwardServiceTarget,
  deps: ForwardServiceOwnershipDeps = {},
): ForwardServiceOwnershipResult {
  validateForwardServiceTarget(target);
  const enumerate = (port: number) => ownershipListenerPids(port, deps);
  const before = enumerate(target.localPort);
  if (before === null) return { owned: false, failure: "listener-enumeration-unavailable" };
  if (before.length !== 1) return { owned: false, failure: "listener-not-unique" };
  const pid = before[0];
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return { owned: false, failure: "listener-not-unique" };
  }

  const currentUid = deps.currentUid
    ? deps.currentUid()
    : typeof process.getuid === "function"
      ? process.getuid()
      : null;
  const expectedEnvironment = buildOpenShellSubprocessEnv(deps.sourceEnvironment ?? process.env);
  const expectedExecutable = (deps.realpath ?? realpath)(target.executable);
  const expectedArgv = [target.executable, ...buildForwardServiceArgs(target)];
  if (currentUid === null || !expectedEnvironment.HOME || !expectedExecutable) {
    return { owned: false, failure: "process-identity-mismatch" };
  }
  if (
    !processMatchesForwardTarget(
      pid,
      deps,
      currentUid,
      expectedEnvironment,
      expectedExecutable,
      expectedArgv,
    )
  ) {
    return { owned: false, failure: "process-identity-mismatch" };
  }

  const after = enumerate(target.localPort);
  if (after === null) return { owned: false, failure: "listener-enumeration-unavailable" };
  if (after.length !== 1 || after[0] !== pid) {
    return { owned: false, failure: "listener-changed" };
  }
  if (
    !processMatchesForwardTarget(
      pid,
      deps,
      currentUid,
      expectedEnvironment,
      expectedExecutable,
      expectedArgv,
    )
  ) {
    return { owned: false, failure: "process-identity-mismatch" };
  }
  return { owned: true };
}
