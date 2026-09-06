// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { isValidName } from "../../name-validation";
import { buildOpenShellSubprocessEnv } from "./resolve-shared";
import { probeLocalForwardListener } from "./local-forward-listener";

const START_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 100;
const INSPECTION_TIMEOUT_MS = 1_000;
const INSPECTION_MAX_BUFFER_BYTES = 16 * 1024;
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
  ) => {
    unref(): void;
  };
  readonly timeoutMs?: number;
}

export interface ForwardServiceProcess {
  readonly commandLine: string;
  readonly executable: string;
  readonly home: string;
  readonly uid: number;
}

export interface ForwardServiceListenerOptions {
  readonly inspectListener?: (port: number) => ForwardServiceProcess | null;
}

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

function probeExecutable(candidates: readonly string[]): string | null {
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}

function runInspection(executable: string, args: readonly string[]): string | null {
  const result = spawnSync(executable, [...args], {
    encoding: "utf8",
    env: buildOpenShellSubprocessEnv(),
    maxBuffer: INSPECTION_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
    timeout: INSPECTION_TIMEOUT_MS,
  });
  return result.error || result.status !== 0 ? null : result.stdout;
}

function inspectListener(port: number): ForwardServiceProcess | null {
  const lsof = probeExecutable(["/usr/sbin/lsof", "/usr/bin/lsof"]);
  const ps = probeExecutable(["/bin/ps", "/usr/bin/ps"]);
  if (!lsof || !ps) return null;

  const listenerOutput = runInspection(lsof, [
    "-nP",
    `-iTCP:${String(port)}`,
    "-sTCP:LISTEN",
    "-Fp",
  ]);
  const pids = [
    ...new Set(
      listenerOutput
        ?.split(/\r?\n/u)
        .flatMap((line) => /^p([1-9]\d*)$/u.exec(line.trim())?.[1] ?? [])
        .map(Number) ?? [],
    ),
  ];
  const pid = pids.length === 1 ? pids[0] : undefined;
  if (pid === undefined) return null;

  const uid = Number(runInspection(ps, ["-p", String(pid), "-o", "uid="])?.trim());
  const commandLine = runInspection(ps, ["-ww", "-p", String(pid), "-o", "command="])?.trim();
  const environment = runInspection(ps, ["eww", "-p", String(pid), "-o", "command="]);
  const home = environment
    ?.replace(/\s+/gu, "\0")
    .split("\0")
    .find((entry) => entry.startsWith("HOME="))
    ?.slice("HOME=".length);
  const executable = runInspection(lsof, ["-a", "-p", String(pid), "-d", "txt", "-Fn"])
    ?.split(/\r?\n/u)
    .find((line) => line.startsWith("n") && line.length > 1)
    ?.slice(1);
  return Number.isSafeInteger(uid) && uid >= 0 && commandLine && executable && home
    ? { commandLine, executable, home, uid }
    : null;
}

function realpath(value: string): string | null {
  try {
    return fs.realpathSync.native(value);
  } catch {
    return null;
  }
}

/** Match one bound listener to the direct ForwardTcp command that NemoClaw starts. */
export function matchesRunningForwardService(
  target: ForwardServiceTarget,
  options: ForwardServiceListenerOptions = {},
): boolean {
  validateForwardServiceTarget(target);
  const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
  const observed = (options.inspectListener ?? inspectListener)(target.localPort);
  if (!observed || currentUid === null || observed.uid !== currentUid) return false;

  const expectedEnvironment = buildOpenShellSubprocessEnv();
  if (!expectedEnvironment.HOME || observed.home !== expectedEnvironment.HOME) {
    return false;
  }

  const observedExecutable = observed.executable && realpath(observed.executable);
  const expectedExecutable = realpath(target.executable);
  if (!observedExecutable || !expectedExecutable || observedExecutable !== expectedExecutable) {
    return false;
  }

  return observed.commandLine === [target.executable, ...buildForwardServiceArgs(target)].join(" ");
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
    buildOpenShellSubprocessEnv(options.sourceEnvironment ?? process.env),
  );
  child.unref();

  const sleep =
    options.sleep ?? ((milliseconds: number) => Atomics.wait(sleepBuffer, 0, 0, milliseconds));
  const deadline = Date.now() + (options.timeoutMs ?? START_TIMEOUT_MS);
  while (Date.now() < deadline) {
    if (isReachable(target.localPort)) return;
    sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `OpenShell forward service did not bind ${target.localHost}:${String(target.localPort)}`,
  );
}
