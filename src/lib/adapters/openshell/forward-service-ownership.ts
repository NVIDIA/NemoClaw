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
  readonly listListenerPids?: (port: number) => readonly number[] | null;
  readonly realpath?: (value: string) => string | null;
  readonly sourceEnvironment?: NodeJS.ProcessEnv;
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

function listListenerPids(port: number): readonly number[] | null {
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
        .filter(Boolean)
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

/** Prove that a bound port belongs to the exact direct ForwardTcp command. */
export function isForwardServiceListenerOwned(
  target: ForwardServiceTarget,
  deps: ForwardServiceOwnershipDeps = {},
): boolean {
  validateForwardServiceTarget(target);
  const enumerate = deps.listListenerPids ?? listListenerPids;
  const before = enumerate(target.localPort);
  if (!before || before.length !== 1) return false;
  const pid = before[0];
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;

  const currentUid = deps.currentUid
    ? deps.currentUid()
    : typeof process.getuid === "function"
      ? process.getuid()
      : null;
  const snapshot = (deps.inspectProcess ?? inspectProcess)(pid);
  if (!snapshot || currentUid === null || snapshot.uid !== currentUid) return false;
  const expectedEnvironment = buildOpenShellSubprocessEnv(deps.sourceEnvironment ?? process.env);
  if (
    !expectedEnvironment.HOME ||
    snapshot.environment?.HOME !== expectedEnvironment.HOME ||
    snapshot.environment.XDG_CONFIG_HOME !== expectedEnvironment.XDG_CONFIG_HOME ||
    snapshot.environment.XDG_RUNTIME_DIR !== expectedEnvironment.XDG_RUNTIME_DIR
  ) {
    return false;
  }
  const resolvePath = deps.realpath ?? realpath;
  const expectedExecutable = resolvePath(target.executable);
  const observedExecutable = snapshot.executable ? resolvePath(snapshot.executable) : null;
  if (!expectedExecutable || observedExecutable !== expectedExecutable) return false;

  const expectedArgv = [target.executable, ...buildForwardServiceArgs(target)];
  const invocationMatches = snapshot.argv
    ? sameArgv(snapshot.argv, expectedArgv)
    : snapshot.commandLine === expectedArgv.join(" ");
  if (!invocationMatches) return false;

  const after = enumerate(target.localPort);
  return Boolean(after && after.length === 1 && after[0] === pid);
}
