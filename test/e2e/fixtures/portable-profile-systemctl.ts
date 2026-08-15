// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SYSTEMCTL_SHIM_SOURCE = fileURLToPath(
  new URL("./portable-profile-systemctl-shim.sh", import.meta.url),
);

const FIXTURE_PID_FILES = [
  "nemoclaw-podman-socket-activator.pid",
  "nemoclaw-podman-service.pid",
] as const;
const FIXTURE_SOCKET_FILES = ["podman.sock", "nemoclaw-podman-service.sock"] as const;

function readFixturePid(pidFile: string): number | undefined {
  try {
    const value = fs.readFileSync(pidFile, "utf8").trim();
    const pid = Number(value);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(pid)) {
      throw new Error(`Portable profile fixture PID file ${pidFile} is invalid.`);
    }
    return pid;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function fixtureProcessIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function waitForFixtureProcessExit(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!fixtureProcessIsActive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

async function terminateFixtureProcess(pid: number): Promise<void> {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (await waitForFixtureProcessExit(pid)) return;

  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    throw error;
  }
  if (!(await waitForFixtureProcessExit(pid))) {
    throw new Error(`Portable profile fixture process ${String(pid)} did not exit.`);
  }
}

export function installPortableProfileSystemctlShim(binDir: string): string {
  const systemctl = path.join(binDir, "systemctl");
  fs.copyFileSync(SYSTEMCTL_SHIM_SOURCE, systemctl);
  fs.chmodSync(systemctl, 0o700);
  return systemctl;
}

export async function cleanupPortableProfileSystemctlFixture(runtimeDir: string): Promise<void> {
  const pidFiles = FIXTURE_PID_FILES.map((name) => path.join(runtimeDir, name));
  const pids = pidFiles.map(readFixturePid).filter((pid): pid is number => pid !== undefined);
  await Promise.all(pids.map(terminateFixtureProcess));

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
