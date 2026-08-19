// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEMCTL_SHIM_SOURCE = fileURLToPath(
  new URL("./portable-profile-systemctl-shim.sh", import.meta.url),
);

const FIXTURE_PROCESS_ID_ENV = "NEMOCLAW_PORTABLE_PROFILE_PROCESS_ID";
const PROCESS_QUERY_TIMEOUT_MS = 5_000;
const FIXTURE_PID_FILES = [
  ["nemoclaw-podman-socket-activator.pid", "activator"],
  ["nemoclaw-podman-service.pid", "service"],
  ["nemoclaw-openshell-gateway-launch.pid", "gateway"],
  ["nemoclaw-openshell-gateway.pid", "gateway"],
] as const;
const FIXTURE_SOCKET_FILES = ["podman.sock", "nemoclaw-podman-service.sock"] as const;

interface FixtureProcessIdentity {
  readonly identity: string;
  readonly pid: number;
  readonly pidFile: string;
  readonly startTime: string;
}

function readFixtureProcessIdentity(
  pidFile: string,
  role: (typeof FIXTURE_PID_FILES)[number][1],
): FixtureProcessIdentity | undefined {
  try {
    const value = fs.readFileSync(pidFile, "utf8").trim();
    const [pidText, startTime, identity, ...extra] = value.split("\t");
    const pid = Number(pidText);
    if (
      extra.length !== 0 ||
      !/^[1-9][0-9]*$/.test(pidText ?? "") ||
      !Number.isSafeInteger(pid) ||
      !/^(?:proc:[0-9]+|ps:.+)$/.test(startTime ?? "") ||
      !new RegExp(`^${role}:[0-9a-f]{32}$`).test(identity ?? "")
    ) {
      throw new Error(`Portable profile fixture PID file ${pidFile} is invalid.`);
    }
    return { identity, pid, pidFile, startTime };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

function processIsZombie(pid: number): boolean {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    return (
      stat
        .slice(stat.lastIndexOf(") ") + 2)
        .trim()
        .split(/\s+/)[0] === "Z"
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (fs.existsSync("/proc/self/stat")) return false;
  }

  const result = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  return result.status === 0 && result.stdout.trim().startsWith("Z");
}

function readProcessStartTime(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    const fields = stat
      .slice(stat.lastIndexOf(") ") + 2)
      .trim()
      .split(/\s+/);
    const startTime = fields[19];
    if (!startTime || !/^[0-9]+$/.test(startTime)) {
      throw new Error(
        `Portable profile fixture process ${String(pid)} has invalid /proc stat data.`,
      );
    }
    return `proc:${startTime}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (fs.existsSync("/proc/self/stat")) return undefined;
  }

  const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  const startTime = result.status === 0 ? result.stdout.trim().replace(/\s+/g, " ") : "";
  return startTime ? `ps:${startTime}` : undefined;
}

function processHasIdentity(pid: number, identity: string): boolean {
  const expected = `${FIXTURE_PROCESS_ID_ENV}=${identity}`;
  try {
    const environment = fs.readFileSync(`/proc/${String(pid)}/environ`, "utf8").split("\0");
    return environment.includes(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (fs.existsSync("/proc/self/environ")) return false;
  }

  const result = spawnSync("ps", ["eww", "-p", String(pid), "-o", "command="], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: PROCESS_QUERY_TIMEOUT_MS,
  });
  return result.status === 0 && result.stdout.split(/\s+/).includes(expected);
}

function fixtureProcessIsActive(processIdentity: FixtureProcessIdentity): boolean {
  if (!processIsActive(processIdentity.pid)) return false;
  if (processIsZombie(processIdentity.pid)) return false;
  if (
    readProcessStartTime(processIdentity.pid) !== processIdentity.startTime ||
    !processHasIdentity(processIdentity.pid, processIdentity.identity)
  ) {
    if (!processIsActive(processIdentity.pid)) return false;
    throw new Error(
      `Portable profile fixture PID file ${processIdentity.pidFile} does not match process ${String(processIdentity.pid)}.`,
    );
  }
  return true;
}

function fixtureProcessHasRecordedStartTime(processIdentity: FixtureProcessIdentity): boolean {
  if (!processIsActive(processIdentity.pid)) return false;
  if (processIsZombie(processIdentity.pid)) return false;
  const startTime = readProcessStartTime(processIdentity.pid);
  if (!startTime && !processIsActive(processIdentity.pid)) return false;
  if (startTime !== processIdentity.startTime) {
    throw new Error(
      `Portable profile fixture PID file ${processIdentity.pidFile} does not match process ${String(processIdentity.pid)}.`,
    );
  }
  return true;
}

async function waitForFixtureProcessExit(
  processIdentity: FixtureProcessIdentity,
): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!fixtureProcessHasRecordedStartTime(processIdentity)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function terminateFixtureProcess(processIdentity: FixtureProcessIdentity): Promise<void> {
  if (!fixtureProcessIsActive(processIdentity)) return;
  try {
    process.kill(processIdentity.pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (await waitForFixtureProcessExit(processIdentity)) return;

  if (!fixtureProcessIsActive(processIdentity)) return;
  try {
    process.kill(processIdentity.pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (!(await waitForFixtureProcessExit(processIdentity))) {
    throw new Error(
      `Portable profile fixture process ${String(processIdentity.pid)} did not exit.`,
    );
  }
}

export function installPortableProfileSystemctlShim(binDir: string): string {
  const systemctl = path.join(binDir, "systemctl");
  fs.copyFileSync(SYSTEMCTL_SHIM_SOURCE, systemctl);
  fs.chmodSync(systemctl, 0o700);
  return systemctl;
}

export async function cleanupPortableProfileSystemctlFixture(runtimeDir: string): Promise<void> {
  const pidFiles = FIXTURE_PID_FILES.map(([name]) => path.join(runtimeDir, name));
  const processIdentities = FIXTURE_PID_FILES.map(([name, role]) =>
    readFixtureProcessIdentity(path.join(runtimeDir, name), role),
  ).filter((identity): identity is FixtureProcessIdentity => identity !== undefined);
  for (const processIdentity of processIdentities) fixtureProcessIsActive(processIdentity);
  await Promise.all(processIdentities.map(terminateFixtureProcess));

  for (const artifact of [
    ...pidFiles,
    ...FIXTURE_SOCKET_FILES.map((name) => path.join(runtimeDir, "podman", name)),
  ]) {
    fs.rmSync(artifact, { force: true });
  }
}

export async function cleanupPortableProfileRootlessFixture(
  runtimeDir: string,
  root: string,
): Promise<void> {
  await cleanupPortableProfileSystemctlFixture(runtimeDir);
  fs.rmSync(root, { force: true, recursive: true });
}

export function cleanupPortableHostGatewayAlias(
  gatewayIp: string,
  wasPresentBefore: boolean,
  env: NodeJS.ProcessEnv,
): void {
  if (wasPresentBefore) return;
  spawnSync("sudo", ["--", "ip", "address", "delete", `${gatewayIp}/32`, "dev", "lo"], {
    env,
    killSignal: "SIGKILL",
    stdio: "ignore",
    timeout: 15_000,
  });
}
