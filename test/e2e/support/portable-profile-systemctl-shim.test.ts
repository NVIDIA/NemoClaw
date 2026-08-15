// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  cleanupPortableProfileRootlessFixture,
  cleanupPortableProfileSystemctlFixture,
  installPortableProfileSystemctlShim,
} from "../fixtures/portable-profile-systemctl.ts";
import { readYaml, type Workflow, type WorkflowStep } from "../../helpers/e2e-workflow-contract.ts";

const INSTALLER_PAYLOAD = path.join(import.meta.dirname, "..", "..", "..", "scripts", "install.sh");

interface FixtureScope {
  readonly binDir: string;
  readonly directory: string;
  readonly env: NodeJS.ProcessEnv;
  readonly runtimeDir: string;
  readonly shim: string;
  readonly socketPath: string;
}

interface FixtureProcessRecord {
  readonly identity: string;
  readonly pid: number;
  readonly startTime: string;
  readonly value: string;
}

function writeExecutable(filePath: string, source: string): void {
  fs.writeFileSync(filePath, source, { encoding: "utf8", mode: 0o700 });
}

function createFixture(): FixtureScope {
  const directory = fs.mkdtempSync("/tmp/portable-systemctl-shim-");
  const binDir = path.join(directory, "bin");
  const runtimeDir = path.join(directory, "runtime");
  const socketPath = path.join(runtimeDir, "podman", "podman.sock");
  fs.mkdirSync(binDir);
  fs.mkdirSync(runtimeDir);
  const shim = installPortableProfileSystemctlShim(binDir);
  writeExecutable(
    path.join(binDir, "podman"),
    `#!${process.execPath}
const fs = require("node:fs");
const net = require("node:net");
const args = process.argv.slice(2);
if (args[0] === "info") {
  process.stdout.write(process.env.FAKE_PODMAN_SOCKET + "\\n");
  process.exit(0);
}
if (
  args.length !== 4 ||
  args[0] !== "system" ||
  args[1] !== "service" ||
  args[2] !== "--time=0" ||
  !args[3].startsWith("unix://")
) {
  process.exit(64);
}
fs.appendFileSync(process.env.FAKE_PODMAN_PID_LOG, process.pid + "\\n");
const socketPath = args[3].slice("unix://".length);
fs.rmSync(socketPath, { force: true });
const sockets = new Set();
const server = net.createServer((socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
  socket.once("data", (data) => {
    if (data.toString() === "hold") {
      socket.write("held");
      return;
    }
    socket.end("ready");
  });
});
server.listen(socketPath);
const stop = () => {
  for (const socket of sockets) socket.destroy();
  server.close(() => process.exit(0));
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
`,
  );
  writeExecutable(path.join(binDir, "docker"), "#!/usr/bin/env bash\nexit 0\n");
  return {
    binDir,
    directory,
    env: {
      ...process.env,
      FAKE_PODMAN_PID_LOG: path.join(directory, "podman-pids.log"),
      FAKE_PODMAN_SOCKET: socketPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_RUNTIME_DIR: runtimeDir,
    },
    runtimeDir,
    shim,
    socketPath,
  };
}

function systemctl(scope: FixtureScope, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync(scope.shim, args, {
    encoding: "utf8",
    env: scope.env,
    killSignal: "SIGKILL",
    timeout: 15_000,
  });
}

function formatPsStartTime(scope: FixtureScope, startTime: string): ReturnType<typeof spawnSync> {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"\nformat_ps_start_time "$2"',
      "portable-profile-ps-start-time",
      scope.shim,
      startTime,
    ],
    {
      encoding: "utf8",
      env: scope.env,
      killSignal: "SIGKILL",
      timeout: 15_000,
    },
  );
}

function systemctlAsync(
  scope: FixtureScope,
  args: string[],
): Promise<{ readonly status: number | null; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(scope.shim, args, {
      env: scope.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Timed out waiting for systemctl ${args.join(" ")}.`));
    }, 15_000);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (status) => {
      clearTimeout(timeout);
      resolve({ status, stderr });
    });
  });
}

function serviceStatus(scope: FixtureScope): number | null {
  return systemctl(scope, ["--user", "is-active", "--quiet", "podman.service"]).status;
}

function activateThroughSocket(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let output = "";
    const finish = (): void => {
      clearTimeout(timeout);
      resolve(output);
    };
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Timed out waiting for the activated Podman service."));
    }, 15_000);
    client.setEncoding("utf8");
    client.once("connect", () => client.write("activate"));
    client.on("data", (chunk) => {
      output += chunk;
    });
    client.once("close", finish);
    client.once("error", finish);
  });
}

function openHeldSocket(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Timed out waiting for the held Podman client."));
    }, 15_000);
    client.setEncoding("utf8");
    client.once("connect", () => client.write("hold"));
    client.once("data", (chunk) => {
      clearTimeout(timeout);
      expect(chunk).toBe("held");
      resolve(client);
    });
    client.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function waitForServiceStatus(scope: FixtureScope, expected: number): Promise<void> {
  await vi.waitFor(() => expect(serviceStatus(scope)).toBe(expected), {
    interval: 50,
    timeout: 5_000,
  });
}

async function waitForPath(filePath: string): Promise<void> {
  await vi.waitFor(() => expect(fs.existsSync(filePath)).toBe(true), {
    interval: 50,
    timeout: 5_000,
  });
}

async function waitForFileText(filePath: string, text: string): Promise<void> {
  await vi.waitFor(() => expect(fs.readFileSync(filePath, "utf8")).toContain(text), {
    interval: 50,
    timeout: 5_000,
  });
}

function pidIsActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
    return false;
  }
}

function expectProcessActive(pid: number): void {
  expect(pidIsActive(pid)).toBe(true);
}

function readFixtureProcessRecord(pidFile: string): FixtureProcessRecord {
  const value = fs.readFileSync(pidFile, "utf8").trim();
  const [pidText, startTime, identity] = value.split("\t");
  return { identity, pid: Number(pidText), startTime, value };
}

function replaceRecordedPid(record: FixtureProcessRecord, pid: number): string {
  return `${String(pid)}\t${record.startTime}\t${record.identity}\n`;
}

function spawnUnrelatedProcess(): ReturnType<typeof spawn> {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000)"], {
    stdio: "ignore",
  });
  expect(child.pid).toBeDefined();
  return child;
}

async function stopUnrelatedProcess(child: ReturnType<typeof spawn> | undefined): Promise<void> {
  await Promise.all(
    [child]
      .filter(
        (candidate): candidate is ReturnType<typeof spawn> =>
          candidate?.pid !== undefined && candidate.exitCode === null,
      )
      .map(
        (candidate) =>
          new Promise<void>((resolve) => {
            const timeout = setTimeout(resolve, 5_000);
            candidate.once("close", () => {
              clearTimeout(timeout);
              resolve();
            });
            candidate.kill("SIGKILL");
          }),
      ),
  );
}

function restoreFixtureProcessRecord(
  pidFile: string,
  record: FixtureProcessRecord | undefined,
): void {
  [record]
    .filter((candidate): candidate is FixtureProcessRecord => candidate !== undefined)
    .forEach((candidate) => fs.writeFileSync(pidFile, `${candidate.value}\n`));
}

async function cleanFixture(scope: FixtureScope): Promise<void> {
  await cleanupPortableProfileRootlessFixture(scope.runtimeDir, scope.directory);
}

function runInstallerOverride(scope: FixtureScope): ReturnType<typeof spawnSync> {
  const script = [
    `source "${INSTALLER_PAYLOAD}" >/dev/null 2>&1 || true`,
    "uname() { printf 'Linux\\n'; }",
    'export NEMOCLAW_EXPERIMENTAL_PROFILE="portable"',
    "prepare_portable_experimental_runtime_override",
    'printf "DOCKER_HOST=%s\\n" "$DOCKER_HOST"',
  ].join("\n");
  return spawnSync("bash", ["-c", script], {
    encoding: "utf8",
    env: scope.env,
    killSignal: "SIGKILL",
    timeout: 15_000,
  });
}

function portableLaunchStep(name: string): WorkflowStep {
  const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
  const step = workflow.jobs["portable-launch"]?.steps?.find(
    (candidate) => candidate.name === name,
  );
  expect(step).toBeDefined();
  return step!;
}

describe("portable profile systemctl fixture", () => {
  it("normalizes irregular ps fallback spacing to one process-start-time identity (#9006)", () => {
    const scope = createFixture();
    try {
      const result = formatPsStartTime(scope, "  Fri  Aug   8  12:34:56  2026  ");
      expect(result.status, String(result.stderr)).toBe(0);
      expect(result.stdout).toBe("ps:Fri Aug 8 12:34:56 2026\n");
    } finally {
      fs.rmSync(scope.directory, { force: true, recursive: true });
    }
  });

  it("treats a process that exits during shared cleanup identity revalidation as inactive (#9006)", async () => {
    const scope = createFixture();
    const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
    const exitedPid = Number.MAX_SAFE_INTEGER;
    const kill = vi.spyOn(process, "kill");
    kill.mockImplementationOnce((_pid, signal) => {
      expect(signal).toBe(0);
      return true;
    });
    kill.mockImplementation((_pid, signal) => {
      expect(signal).toBe(0);
      throw Object.assign(new Error("process exited"), { code: "ESRCH" });
    });
    fs.writeFileSync(servicePidFile, `${String(exitedPid)}\tproc:1\tservice:${"0".repeat(32)}\n`, {
      mode: 0o600,
    });

    try {
      await expect(
        cleanupPortableProfileSystemctlFixture(scope.runtimeDir),
      ).resolves.toBeUndefined();
      expect(kill).toHaveBeenCalledTimes(3);
      expect(fs.existsSync(servicePidFile)).toBe(false);
    } finally {
      kill.mockRestore();
      fs.rmSync(scope.directory, { force: true, recursive: true });
    }
  });

  it(
    "installs a mode-0700 shim that preserves socket identity from cold activation through try-restart (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      try {
        expect(fs.statSync(scope.shim).mode & 0o777).toBe(0o700);
        expect(serviceStatus(scope)).toBe(3);
        expect(systemctl(scope, ["--user", "try-restart", "podman.service"]).status).toBe(0);
        expect(serviceStatus(scope)).toBe(3);
        expect(
          systemctl(scope, [
            "--user",
            "set-environment",
            "NETAVARK_FW=iptables",
            `CONTAINERS_CONF=${path.join(scope.directory, "containers.conf")}`,
          ]).status,
        ).toBe(0);

        const activation = systemctl(scope, ["--user", "start", "podman.socket"]);
        expect(activation.status, String(activation.stderr)).toBe(0);
        const socketAuthority = fs.statSync(scope.socketPath);
        expect(socketAuthority.isSocket()).toBe(true);
        expect(serviceStatus(scope)).toBe(3);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);
        expect(fs.statSync(scope.socketPath)).toMatchObject({
          dev: socketAuthority.dev,
          ino: socketAuthority.ino,
        });
        expect(serviceStatus(scope)).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");

        const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
        const firstProcess = readFixtureProcessRecord(servicePidFile);
        const refresh = systemctl(scope, ["--user", "try-restart", "podman.service"]);
        expect(refresh.status, String(refresh.stderr)).toBe(0);
        expect(serviceStatus(scope)).toBe(0);
        expect(readFixtureProcessRecord(servicePidFile).value).not.toBe(firstProcess.value);
        expect(pidIsActive(firstProcess.pid)).toBe(false);
        expect(fs.statSync(scope.socketPath)).toMatchObject({
          dev: socketAuthority.dev,
          ino: socketAuthority.ino,
        });
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "runs the installer enable --now and CLI host-preparation commands through cold activation (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      try {
        const installer = runInstallerOverride(scope);
        expect(installer.status, String(installer.stderr)).toBe(0);
        expect(installer.stdout).toContain(`DOCKER_HOST=unix://${scope.socketPath}`);
        const socketAuthority = fs.statSync(scope.socketPath);
        expect(socketAuthority.isSocket()).toBe(true);
        expect(serviceStatus(scope)).toBe(3);

        expect(
          systemctl(scope, [
            "--user",
            "set-environment",
            "NETAVARK_FW=iptables",
            `CONTAINERS_CONF=${path.join(scope.directory, "containers.conf")}`,
          ]).status,
        ).toBe(0);
        expect(systemctl(scope, ["--user", "try-restart", "podman.service"]).status).toBe(0);
        expect(serviceStatus(scope)).toBe(3);
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        expect(serviceStatus(scope)).toBe(3);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);
        expect(fs.statSync(scope.socketPath)).toMatchObject({
          dev: socketAuthority.dev,
          ino: socketAuthority.ino,
        });
        expect(serviceStatus(scope)).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "serializes try-restart with a public-socket request and leaves only the recorded backend process active (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const refreshGate = path.join(scope.directory, "refresh-gate");
      const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      const backendSocketPath = path.join(
        scope.runtimeDir,
        "podman",
        "nemoclaw-podman-service.sock",
      );
      const pidLog = scope.env.FAKE_PODMAN_PID_LOG!;
      scope.env.NEMOCLAW_PODMAN_REFRESH_GATE = refreshGate;
      let backendPids: number[] = [];
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        const socketAuthority = fs.statSync(scope.socketPath);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);
        const previousPid = readFixtureProcessRecord(servicePidFile).pid;

        const refresh = systemctlAsync(scope, ["--user", "try-restart", "podman.service"]);
        await waitForPath(`${refreshGate}.waiting`);
        const response = activateThroughSocket(scope.socketPath);
        await waitForPath(`${refreshGate}.client`);
        fs.writeFileSync(`${refreshGate}.release`, "release\n", { mode: 0o600 });

        const [refreshResult, responseOutput] = await Promise.all([refresh, response]);
        expect(refreshResult.status, refreshResult.stderr).toBe(0);
        expect(responseOutput).toBe("ready");
        await waitForServiceStatus(scope, 0);
        const recordedPid = readFixtureProcessRecord(servicePidFile).pid;
        backendPids = fs.readFileSync(pidLog, "utf8").trim().split("\n").map(Number);
        expect(recordedPid).not.toBe(previousPid);
        expect(pidIsActive(previousPid)).toBe(false);
        expect(backendPids).toEqual([previousPid, recordedPid]);
        expect(backendPids.filter(pidIsActive)).toEqual([recordedPid]);
        expect(fs.statSync(scope.socketPath)).toMatchObject({
          dev: socketAuthority.dev,
          ino: socketAuthority.ino,
        });

        await cleanupPortableProfileSystemctlFixture(scope.runtimeDir);
        expect(backendPids.every((pid) => !pidIsActive(pid))).toBe(true);
        for (const artifact of [
          activatorPidFile,
          servicePidFile,
          scope.socketPath,
          backendSocketPath,
        ]) {
          expect(fs.existsSync(artifact), artifact).toBe(false);
        }
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "refreshes the backend while an established public-socket client remains open (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      let heldClient: net.Socket | undefined;
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);
        const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
        const previousPid = readFixtureProcessRecord(servicePidFile).pid;

        heldClient = await openHeldSocket(scope.socketPath);
        expect(heldClient.destroyed).toBe(false);
        const refresh = await systemctlAsync(scope, ["--user", "try-restart", "podman.service"]);

        expect(refresh.status, refresh.stderr).toBe(0);
        await waitForServiceStatus(scope, 0);
        const recordedPid = readFixtureProcessRecord(servicePidFile).pid;
        expect(recordedPid).not.toBe(previousPid);
        expect(pidIsActive(previousPid)).toBe(false);
        expect(pidIsActive(recordedPid)).toBe(true);
      } finally {
        heldClient?.destroy();
        await cleanFixture(scope);
      }
    },
  );

  it(
    "stops both fixture processes and removes both sockets during cleanup (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
      const backendSocketPath = path.join(
        scope.runtimeDir,
        "podman",
        "nemoclaw-podman-service.sock",
      );
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);

        const pids = [activatorPidFile, servicePidFile].map(
          (pidFile) => readFixtureProcessRecord(pidFile).pid,
        );
        expect(pids.every(pidIsActive)).toBe(true);
        expect(fs.statSync(scope.socketPath).isSocket()).toBe(true);
        expect(fs.statSync(backendSocketPath).isSocket()).toBe(true);

        await cleanupPortableProfileSystemctlFixture(scope.runtimeDir);

        expect(pids.every((pid) => !pidIsActive(pid))).toBe(true);
        for (const artifact of [
          activatorPidFile,
          servicePidFile,
          scope.socketPath,
          backendSocketPath,
        ]) {
          expect(fs.existsSync(artifact), artifact).toBe(false);
        }
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "stops the owned activator when it cannot create the process identity record (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      const failureRecord = path.join(scope.runtimeDir, "activator-identity-failure.record");
      scope.env.NEMOCLAW_PODMAN_IDENTITY_FAILURE_ROLE = "activator";
      scope.env.NEMOCLAW_PODMAN_IDENTITY_FAILURE_RECORD = failureRecord;
      try {
        const start = systemctl(scope, ["--user", "start", "podman.socket"]);
        expect(start.status).not.toBe(0);
        expect(start.stderr).toContain(
          "Portable profile fixture could not create the process identity record for activator",
        );
        const processRecord = readFixtureProcessRecord(failureRecord);
        expect(pidIsActive(processRecord.pid)).toBe(false);
        expect(fs.existsSync(activatorPidFile)).toBe(false);
        expect(fs.existsSync(scope.socketPath)).toBe(false);
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "stops the owned backend when it cannot create the process identity record (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
      const backendSocketPath = path.join(
        scope.runtimeDir,
        "podman",
        "nemoclaw-podman-service.sock",
      );
      const failureRecord = path.join(scope.runtimeDir, "service-identity-failure.record");
      scope.env.NEMOCLAW_PODMAN_IDENTITY_FAILURE_ROLE = "service";
      scope.env.NEMOCLAW_PODMAN_IDENTITY_FAILURE_RECORD = failureRecord;
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("");
        await waitForPath(failureRecord);
        const processRecord = readFixtureProcessRecord(failureRecord);
        expect(pidIsActive(processRecord.pid)).toBe(false);
        expect(fs.existsSync(servicePidFile)).toBe(false);
        expect(fs.existsSync(backendSocketPath)).toBe(false);
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "rejects a reused activator PID during shared fixture cleanup without signaling the unrelated process (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      let originalRecord: FixtureProcessRecord | undefined;
      let unrelated: ReturnType<typeof spawn> | undefined;
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        originalRecord = readFixtureProcessRecord(activatorPidFile);
        unrelated = spawnUnrelatedProcess();
        await vi.waitFor(() => expect(pidIsActive(unrelated!.pid!)).toBe(true));
        fs.writeFileSync(activatorPidFile, replaceRecordedPid(originalRecord, unrelated.pid!), {
          mode: 0o600,
        });

        await expect(cleanupPortableProfileSystemctlFixture(scope.runtimeDir)).rejects.toThrow(
          `Portable profile fixture PID file ${activatorPidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        expect(fs.existsSync(activatorPidFile)).toBe(true);
        expect(fs.existsSync(scope.socketPath)).toBe(true);
        expect(fs.existsSync(scope.directory)).toBe(true);
      } finally {
        restoreFixtureProcessRecord(activatorPidFile, originalRecord);
        await stopUnrelatedProcess(unrelated);
        await cleanFixture(scope);
      }
    },
  );

  it(
    "rejects a reused activator PID during socket start without signaling the unrelated process (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      const unrelated = spawnUnrelatedProcess();
      try {
        await vi.waitFor(() => expect(pidIsActive(unrelated.pid!)).toBe(true));
        const staleRecord = `${String(unrelated.pid)}\tproc:1\tactivator:${"0".repeat(32)}\n`;
        fs.writeFileSync(activatorPidFile, staleRecord, { mode: 0o600 });

        const start = systemctl(scope, ["--user", "start", "podman.socket"]);
        expect(start.status).not.toBe(0);
        expect(start.stderr).toContain(
          `Portable profile fixture PID file ${activatorPidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        expect(fs.readFileSync(activatorPidFile, "utf8")).toBe(staleRecord);
        expect(fs.existsSync(scope.socketPath)).toBe(false);
      } finally {
        fs.rmSync(activatorPidFile, { force: true });
        await stopUnrelatedProcess(unrelated);
        await cleanFixture(scope);
      }
    },
  );

  it(
    "rejects a reused activator PID during try-restart without signaling the unrelated process (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
      let originalRecord: FixtureProcessRecord | undefined;
      let unrelated: ReturnType<typeof spawn> | undefined;
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);
        const servicePid = readFixtureProcessRecord(servicePidFile).pid;
        originalRecord = readFixtureProcessRecord(activatorPidFile);
        unrelated = spawnUnrelatedProcess();
        await vi.waitFor(() => expect(pidIsActive(unrelated!.pid!)).toBe(true));
        fs.writeFileSync(activatorPidFile, replaceRecordedPid(originalRecord, unrelated.pid!), {
          mode: 0o600,
        });

        const refresh = systemctl(scope, ["--user", "try-restart", "podman.service"]);
        expect(refresh.status).not.toBe(0);
        expect(refresh.stderr).toContain(
          `Portable profile fixture PID file ${activatorPidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        expect(pidIsActive(servicePid)).toBe(true);
        expect(readFixtureProcessRecord(servicePidFile).pid).toBe(servicePid);
      } finally {
        restoreFixtureProcessRecord(activatorPidFile, originalRecord);
        await stopUnrelatedProcess(unrelated);
        await cleanFixture(scope);
      }
    },
  );

  it(
    "rejects a reused backend PID during socket reset without signaling the unrelated process (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
      const unrelated = spawnUnrelatedProcess();
      try {
        await vi.waitFor(() => expect(pidIsActive(unrelated.pid!)).toBe(true));
        const staleRecord = `${String(unrelated.pid)}\tproc:1\tservice:${"0".repeat(32)}\n`;
        fs.writeFileSync(servicePidFile, staleRecord, { mode: 0o600 });

        const start = systemctl(scope, ["--user", "start", "podman.socket"]);
        expect(start.status).not.toBe(0);
        expect(start.stderr).toContain(
          `Portable profile fixture PID file ${servicePidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        expect(fs.readFileSync(servicePidFile, "utf8")).toBe(staleRecord);
        expect(fs.existsSync(scope.socketPath)).toBe(false);
      } finally {
        fs.rmSync(servicePidFile, { force: true });
        await stopUnrelatedProcess(unrelated);
        await cleanFixture(scope);
      }
    },
  );

  it(
    "rejects a reused backend PID during status and activator refresh without signaling the unrelated process (#9006)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const activatorPidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
      const servicePidFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.pid");
      const logFile = path.join(scope.runtimeDir, "nemoclaw-podman-service.log");
      let originalRecord: FixtureProcessRecord | undefined;
      let unrelated: ReturnType<typeof spawn> | undefined;
      try {
        expect(systemctl(scope, ["--user", "start", "podman.socket"]).status).toBe(0);
        expect(await activateThroughSocket(scope.socketPath)).toBe("ready");
        await waitForServiceStatus(scope, 0);
        originalRecord = readFixtureProcessRecord(servicePidFile);
        const activatorPid = readFixtureProcessRecord(activatorPidFile).pid;
        unrelated = spawnUnrelatedProcess();
        await vi.waitFor(() => expect(pidIsActive(unrelated!.pid!)).toBe(true));
        fs.writeFileSync(servicePidFile, replaceRecordedPid(originalRecord, unrelated.pid!), {
          mode: 0o600,
        });

        expect(serviceStatus(scope)).not.toBe(0);
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        const refresh = systemctl(scope, ["--user", "try-restart", "podman.service"]);
        expect(refresh.status).not.toBe(0);
        expect(refresh.stderr).toContain(
          `Portable profile fixture PID file ${servicePidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        process.kill(activatorPid, "SIGHUP");
        await waitForFileText(
          logFile,
          `Portable profile fixture PID file ${servicePidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        expectProcessActive(originalRecord.pid);
        expect(fs.existsSync(servicePidFile)).toBe(true);
      } finally {
        restoreFixtureProcessRecord(servicePidFile, originalRecord);
        await stopUnrelatedProcess(unrelated);
        await cleanFixture(scope);
      }
    },
  );

  it.each([
    ["malformed PID text", "not-a-pid"],
    ["a PID beyond Number.MAX_SAFE_INTEGER", `${Number.MAX_SAFE_INTEGER}0`],
  ])("rejects %s without removing the rootless fixture (#9006)", async (_kind, invalidPid) => {
    const scope = createFixture();
    const pidFile = path.join(scope.runtimeDir, "nemoclaw-podman-socket-activator.pid");
    try {
      fs.writeFileSync(pidFile, `${invalidPid}\n`, { mode: 0o600 });

      await expect(
        cleanupPortableProfileRootlessFixture(scope.runtimeDir, scope.directory),
      ).rejects.toThrow(`Portable profile fixture PID file ${pidFile} is invalid.`);
      expect(fs.existsSync(pidFile)).toBe(true);
      expect(fs.existsSync(scope.directory)).toBe(true);
    } finally {
      fs.rmSync(pidFile, { force: true });
      await cleanFixture(scope);
    }
  });

  it("rejects malformed or extended user-service commands (#9006)", () => {
    const scope = createFixture();
    try {
      const driftedCommands = [
        ["--user", "restart", "podman.socket"],
        ["--user", "set-environment", "NETAVARK_FW=iptables", "CONTAINERS_CONF="],
        [
          "--user",
          "set-environment",
          "NETAVARK_FW=iptables",
          `CONTAINERS_CONF=${path.join(scope.directory, "containers.conf")}`,
          "trailing",
        ],
        [
          "--user set-environment",
          "NETAVARK_FW=iptables",
          `CONTAINERS_CONF=${path.join(scope.directory, "containers.conf")}`,
        ],
        ["--user", "start", "podman.socket", "trailing"],
        ["--user", "enable", "podman.socket"],
      ];
      for (const args of driftedCommands) {
        const result = systemctl(scope, args);
        expect(result.status, args.join(" ")).toBe(64);
        expect(result.stderr).toContain("unexpected user-service command:");
      }
    } finally {
      fs.rmSync(scope.directory, { force: true, recursive: true });
    }
  });

  it("binds portable-launch setup and always-run cleanup to the shared systemctl fixture (#9006)", () => {
    const provision = portableLaunchStep("Provision restricted rootless Linux runtime").run ?? "";
    expect(provision).toContain(
      'install -m 700 test/e2e/fixtures/portable-profile-systemctl-shim.sh "$shim_dir/systemctl"',
    );
    expect(provision).toContain("systemctl --user start podman.socket");
    const runtimeExportIndex = provision.indexOf("XDG_RUNTIME_DIR=%s");
    expect(runtimeExportIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeExportIndex).toBeLessThan(
      provision.indexOf("systemctl --user start podman.socket"),
    );

    const cleanup = portableLaunchStep("Clean up portable runtime");
    expect(cleanup.if).toBe("always()");
    expect(cleanup.run).toContain('runtime_dir="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"');
    expect(cleanup.run).toContain(
      'import { cleanupPortableProfileSystemctlFixture } from "./test/e2e/fixtures/portable-profile-systemctl.ts"; await cleanupPortableProfileSystemctlFixture(process.argv[1]);',
    );
    expect(cleanup.run).toContain('"$runtime_dir"');
  });
});
