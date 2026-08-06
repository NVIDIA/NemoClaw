// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const RUNNER_SOURCE = path.resolve("scripts/cua-qualification-artifact-runner.sh");
const PROBE_SOURCE = path.resolve(
  "test/e2e/support/fixtures/cua-qualification-artifact-boundary-probe.sh",
);
const RUNNER = "/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner";
const ARTIFACT_USER = "nemoclaw-cua-artifact";
const TARGET_SOCKET_DIRECTORY = "/run/nemoclaw";
const TARGET_SOCKET_SOURCE = `${TARGET_SOCKET_DIRECTORY}/cua-qualification-target.sock`;
const CGROUP_SLICE = "/sys/fs/cgroup/system.slice";
const MAX_OUTPUT_BYTES = 16 * 1024;

interface ProcessResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function sha256File(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function rootInvocation(
  command: string,
  args: readonly string[],
): { file: string; args: string[] } {
  if (process.geteuid?.() === 0) return { file: command, args: [...args] };
  return { file: "/usr/bin/sudo", args: ["-n", "--", command, ...args] };
}

function runRoot(command: string, args: readonly string[]): string {
  const invocation = rootInvocation(command, args);
  const result = spawnSync(invocation.file, invocation.args, {
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `privileged test command failed: ${command}: ${result.stderr || result.stdout || result.error?.message || `exit ${String(result.status)}`}`,
    );
  }
  return result.stdout;
}

function spawnRoot(command: string, args: readonly string[]): ChildProcessWithoutNullStreams {
  const invocation = rootInvocation(command, args);
  return spawn(invocation.file, invocation.args, { env: process.env, stdio: "pipe" });
}

function getDatabaseEntry(database: "passwd" | "group", name: string): string | undefined {
  const result = spawnSync("/usr/bin/getent", [database, name], { encoding: "utf8" });
  if (result.status === 2) return undefined;
  if (result.status !== 0) {
    throw new Error(
      `getent ${database} failed: ${result.stderr || `exit ${String(result.status)}`}`,
    );
  }
  return result.stdout.trim();
}

function spawnArtifact(
  args: readonly string[],
  input: string | Buffer = Buffer.alloc(0),
): ChildProcessWithoutNullStreams {
  const child = spawn(RUNNER, [...args], {
    env: { ...process.env, NEMOCLAW_CONTROLLER_SECRET: "must-not-cross-env-boundary" },
    stdio: "pipe",
  });
  child.stdin.end(input);
  return child;
}

function collect(child: ChildProcessWithoutNullStreams): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function runArtifact(
  args: readonly string[],
  input: string | Buffer = Buffer.alloc(0),
): Promise<ProcessResult> {
  return await collect(spawnArtifact(args, input));
}

async function terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    child.kill("SIGKILL");
    await Promise.race([closed, delay(2_000)]);
  }
  child.stdout.destroy();
  child.stderr.destroy();
}

async function waitForJsonLine(
  child: ChildProcessWithoutNullStreams,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  let buffered = "";
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("process did not publish its bounded readiness record"));
    }, 10_000);
    const cleanup = () => {
      clearTimeout(timeout);
      child.stdout.off("data", onData);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("process exited before publishing its readiness record"));
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      buffered += chunk.toString();
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline === -1) return;
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          if (predicate(value)) {
            cleanup();
            resolve(value);
            return;
          }
        } catch {
          // The final result assertion retains any non-JSON output.
        }
      }
    };
    child.stdout.on("data", onData);
    child.once("close", onClose);
    child.once("error", onError);
  });
}

async function startTcpControl(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.end("ambient-host-network\n"));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("TCP control did not bind");
  return {
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

function artifactArgs(
  mode: "--require-target-channel" | "--no-target-channel",
  artifact: string,
  digest = sha256File(artifact),
  runnerOptions: readonly string[] = [],
  artifactArgs: readonly string[] = [],
): string[] {
  return [mode, "--artifact-sha256", digest, ...runnerOptions, "--", artifact, ...artifactArgs];
}

function systemdCgroups(): Set<string> {
  if (!fs.existsSync(CGROUP_SLICE)) return new Set();
  return new Set(
    fs
      .readdirSync(CGROUP_SLICE)
      .filter((entry) => /^nemoclaw-cua-artifact-[A-Za-z0-9]+\.service$/.test(entry)),
  );
}

function systemdUnits(): Set<string> {
  const result = spawnSync(
    "/usr/bin/systemctl",
    [
      "list-units",
      "--all",
      "--plain",
      "--no-legend",
      "--no-pager",
      "nemoclaw-cua-artifact-*.service",
    ],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`systemd unit inventory failed: ${result.stderr || String(result.error)}`);
  }
  return new Set(
    result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/, 1)[0] ?? "")
      .filter((unit) => /^nemoclaw-cua-artifact-[A-Za-z0-9]+\.service$/.test(unit)),
  );
}

function runnerScratchDirectories(): Set<string> {
  return new Set(
    fs.readdirSync("/run").filter((entry) => /^nemoclaw-cua-artifact\.[A-Za-z0-9]{8}$/.test(entry)),
  );
}

function findRootRunnerProcess(artifact: string): number | undefined {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const args = fs
        .readFileSync(`/proc/${entry}/cmdline`, "utf8")
        .split("\0")
        .filter((argument) => argument !== "");
      if (args[1] !== RUNNER || !args.includes(artifact)) continue;
      const effectiveUid = fs
        .readFileSync(`/proc/${entry}/status`, "utf8")
        .match(/^Uid:\s+\d+\s+(\d+)/m)?.[1];
      if (effectiveUid === "0") return Number(entry);
    } catch {
      // Processes may exit between readdir and read.
    }
  }
  return undefined;
}

async function waitForStagingRunner(
  artifact: string,
  previousScratch: ReadonlySet<string>,
): Promise<number> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const runnerPid = findRootRunnerProcess(artifact);
    const scratchCreated = [...runnerScratchDirectories()].some(
      (entry) => !previousScratch.has(entry),
    );
    if (runnerPid !== undefined && scratchCreated) return runnerPid;
    await delay(20);
  }
  throw new Error("runner did not reach its interruptible pre-launch staging boundary");
}

async function waitForNewCgroup(previous: Set<string>): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const current = [...systemdCgroups()].filter((entry) => !previous.has(entry));
    if (current.length === 1) return path.join(CGROUP_SLICE, current[0]!);
    await delay(20);
  }
  throw new Error("runner did not create one isolated systemd cgroup");
}

function processUsesIdentity(uid: number, gid: number): boolean {
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const status = fs.readFileSync(`/proc/${entry}/status`, "utf8");
      const uidLine =
        status
          .match(/^Uid:\s+(.+)$/m)?.[1]
          ?.trim()
          .split(/\s+/) ?? [];
      const gidLine =
        status
          .match(/^Gid:\s+(.+)$/m)?.[1]
          ?.trim()
          .split(/\s+/) ?? [];
      const groups =
        status
          .match(/^Groups:\s*(.*)$/m)?.[1]
          ?.trim()
          .split(/\s+/) ?? [];
      if (
        uidLine.includes(String(uid)) ||
        gidLine.includes(String(gid)) ||
        groups.includes(String(gid))
      ) {
        return true;
      }
    } catch {
      // Processes may exit between readdir and read.
    }
  }
  return false;
}

const ROOT_SOCKET_SERVER = String.raw`
const fs = require("node:fs");
const net = require("node:net");
const socketPath = process.argv[1];
const socketGid = Number(process.argv[2]);
const cancellationMarker = process.argv[3];
const server = net.createServer((socket) => {
  let input = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    input += chunk;
    if (input === "qualification-probe\n") socket.end("target-service-ok\n");
    else if (input === "cancellation-marker\n") {
      fs.writeFileSync(cancellationMarker, "artifact-ran\n", {mode: 0o600});
      socket.end("marker-recorded\n");
    }
    else if (input.length > 64 || input.includes("\n")) socket.destroy();
  });
});
const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
server.listen(socketPath, () => {
  fs.chownSync(socketPath, 0, socketGid);
  fs.chmodSync(socketPath, 0o660);
  process.stdout.write(JSON.stringify({kind: "ready", pid: process.pid}) + "\n");
});
`;

describe("CUA qualification artifact runner source boundary", () => {
  // source-shape-contract: security -- Exact service and command grammar keeps the privileged artifact runner authority closed
  it("declares the closed Noble-compatible service and command grammar", () => {
    const source = fs.readFileSync(RUNNER_SOURCE, "utf8");
    expect(source.startsWith("#!/bin/bash\n")).toBe(true);
    for (const required of [
      "--artifact-sha256",
      "--expand-environment=no",
      "--remain-after-exit",
      "StandardInput=file:$root_directory/run/nemoclaw-cua-control/stdin",
      "RestrictAddressFamilies=AF_UNIX",
      "RestrictNamespaces=mnt pid cgroup net ipc uts",
      "SystemCallArchitectures=native",
      "SystemCallFilter=@system-service @mount unshare sethostname",
      "SystemCallFilter=~@keyring @aio bpf perf_event_open userfaultfd setns clone3",
      "MemorySwapMax=0",
      "MemoryOOMGroup=yes",
      "KillMode=control-group",
      "nosuid,mode=0755,size=256M",
      "subset=pid",
      "--sethostname=nemoclaw-cua-artifact",
      "for undeclared_path in /sys /usr/local /opt /home /run/host /run/systemd",
      "((cleanup_in_progress == 0)) || return 0",
      "trap handle_signal HUP INT QUIT TERM",
    ]) {
      expect(source).toContain(required);
    }
    for (const unsupported of [
      "BindLogSockets=",
      "ProtectProc=",
      "ProcSubset=",
      "PrivateNetwork=",
      "PrivateIPC=",
      "PrivateHostname=",
      "DeviceAllow=",
    ]) {
      expect(source).not.toContain(unsupported);
    }
    expect(source).not.toContain("PrivatePIDs=");
    expect(source).not.toContain("--seccomp-filter");
    expect(spawnSync("/bin/bash", ["-n", RUNNER_SOURCE]).status).toBe(0);
    expect(spawnSync("/bin/bash", ["-n", PROBE_SOURCE]).status).toBe(0);
  });
});

const rootAvailable =
  process.platform === "linux" &&
  (process.geteuid?.() === 0 ||
    spawnSync("/usr/bin/sudo", ["-n", "--", "/usr/bin/true"]).status === 0);
const systemdAvailable =
  process.platform === "linux" &&
  process.arch === "x64" &&
  fs.existsSync("/run/systemd/system") &&
  fs.existsSync("/sys/fs/cgroup/cgroup.controllers") &&
  spawnSync("/usr/bin/systemd-run", ["--version"]).status === 0;
const describeLinuxSystemd = rootAvailable && systemdAvailable ? describe : describe.skip;

describeLinuxSystemd(
  "CUA qualification artifact runner on systemd cgroup v2 (skipped without Linux x64, systemd, cgroup v2, and non-interactive root)",
  () => {
    let createdAccount = false;
    let createdRunnerDirectory = false;
    let installedRunner = false;
    let createdSocketDirectory = false;
    let targetSocketServer: ChildProcessWithoutNullStreams | undefined;
    let targetSocketServerPid: number | undefined;
    let targetSocketServerResult: Promise<ProcessResult> | undefined;
    let controller: ChildProcessWithoutNullStreams | undefined;
    let tcpControl: Awaited<ReturnType<typeof startTcpControl>> | undefined;
    let inputRoot = "";
    let taskInput = "";
    let taskInputSymlink = "";
    let taskInputBadMode = "";
    let taskInputOversized = "";
    let callerProbe = "";
    let checkoutRoot = "";
    let checkoutProbe = "";
    let artifactRoot = "";
    let installedProbe = "";
    let cancellationMarker = "";
    let accountUid = 0;
    let accountGid = 0;

    beforeAll(async () => {
      for (const dependency of [
        "/usr/bin/dd",
        "/usr/bin/flock",
        "/usr/bin/getent",
        "/usr/bin/mknod",
        "/usr/bin/mount",
        "/usr/bin/python3",
        "/usr/bin/setpriv",
        "/usr/bin/systemctl",
        "/usr/bin/systemd-run",
        "/usr/bin/timeout",
        "/usr/bin/unshare",
        "/usr/bin/uname",
        "/usr/sbin/groupdel",
        "/usr/sbin/useradd",
        "/usr/sbin/userdel",
      ]) {
        expect(fs.existsSync(dependency), `required Linux dependency ${dependency}`).toBe(true);
      }

      const existingAccount = getDatabaseEntry("passwd", ARTIFACT_USER);
      if (existingAccount === undefined) {
        runRoot("/usr/sbin/useradd", [
          "--system",
          "--user-group",
          "--no-create-home",
          "--home-dir",
          "/nonexistent",
          "--shell",
          "/usr/sbin/nologin",
          ARTIFACT_USER,
        ]);
        createdAccount = true;
      }
      const account = getDatabaseEntry("passwd", ARTIFACT_USER);
      expect(account).toBeDefined();
      const accountFields = account!.split(":");
      accountUid = Number(accountFields[2]);
      accountGid = Number(accountFields[3]);
      expect(accountUid).toBeGreaterThan(0);
      expect(accountGid).toBeGreaterThan(0);
      expect(accountFields[5]).toBe("/nonexistent");
      expect(["/usr/sbin/nologin", "/bin/false"]).toContain(accountFields[6]);

      const runnerDirectory = path.dirname(RUNNER);
      if (!fs.existsSync(runnerDirectory)) {
        runRoot("/usr/bin/install", [
          "-d",
          "-o",
          "root",
          "-g",
          "root",
          "-m",
          "0755",
          runnerDirectory,
        ]);
        createdRunnerDirectory = true;
      }
      if (fs.existsSync(RUNNER)) {
        expect(fs.readFileSync(RUNNER)).toEqual(fs.readFileSync(RUNNER_SOURCE));
      } else {
        runRoot("/usr/bin/install", [
          "-o",
          "root",
          "-g",
          "root",
          "-m",
          "0555",
          RUNNER_SOURCE,
          RUNNER,
        ]);
        installedRunner = true;
      }

      artifactRoot = `/run/nemoclaw-cua-runner-test-${String(process.pid)}`;
      runRoot("/usr/bin/install", ["-d", "-o", "root", "-g", "root", "-m", "0755", artifactRoot]);
      installedProbe = path.join(artifactRoot, "probe");
      cancellationMarker = path.join(artifactRoot, "cancellation-marker");
      runRoot("/usr/bin/install", [
        "-o",
        "root",
        "-g",
        "root",
        "-m",
        "0555",
        PROBE_SOURCE,
        installedProbe,
      ]);

      inputRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-runner-input-")),
      );
      taskInput = path.join(inputRoot, "task-input.json");
      taskInputBadMode = path.join(inputRoot, "task-input-bad-mode.json");
      taskInputOversized = path.join(inputRoot, "task-input-oversized.json");
      taskInputSymlink = path.join(inputRoot, "task-input-symlink.json");
      callerProbe = path.join(inputRoot, "probe");
      fs.writeFileSync(taskInput, '{"operation":"fixture","value":"sealed"}\n', { mode: 0o400 });
      fs.writeFileSync(path.join(inputRoot, "task-input-sibling"), "must-stay-hidden\n", {
        mode: 0o400,
      });
      fs.writeFileSync(taskInputBadMode, "bad-mode\n", { mode: 0o600 });
      fs.writeFileSync(taskInputOversized, Buffer.alloc(65_537, 0x78), { mode: 0o400 });
      fs.symlinkSync(taskInput, taskInputSymlink);
      fs.copyFileSync(PROBE_SOURCE, callerProbe);
      fs.chmodSync(callerProbe, 0o500);
      fs.chmodSync(inputRoot, 0o500);

      checkoutRoot = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cua-runner-checkout-")),
      );
      checkoutProbe = path.join(checkoutRoot, "target-channel-probe");
      fs.copyFileSync(PROBE_SOURCE, checkoutProbe);
      fs.chmodSync(checkoutProbe, 0o755);
      fs.chmodSync(checkoutRoot, 0o755);

      const controllerSentinel = path.join(inputRoot, "controller-sentinel");
      fs.chmodSync(inputRoot, 0o700);
      fs.writeFileSync(controllerSentinel, "controller-only\n", { mode: 0o400 });
      fs.chmodSync(inputRoot, 0o500);
      controller = spawn(
        "/bin/bash",
        ["-c", 'exec 9<"$CONTROLLER_SENTINEL"; exec /bin/sleep 120'],
        {
          env: {
            ...process.env,
            CONTROLLER_SENTINEL: controllerSentinel,
            NEMOCLAW_CONTROLLER_SECRET: "controller-initial-secret",
          },
          stdio: "pipe",
        },
      );
      controller.stdin.end();
      expect(controller.pid).toBeDefined();
      for (let attempt = 0; attempt < 250; attempt += 1) {
        if (fs.existsSync(`/proc/${String(controller.pid)}/fd/9`)) break;
        await delay(20);
      }
      expect(fs.existsSync(`/proc/${String(controller.pid)}/fd/9`)).toBe(true);

      if (!fs.existsSync(TARGET_SOCKET_DIRECTORY)) {
        runRoot("/usr/bin/install", [
          "-d",
          "-o",
          "root",
          "-g",
          "root",
          "-m",
          "0755",
          TARGET_SOCKET_DIRECTORY,
        ]);
        createdSocketDirectory = true;
      }
      expect(fs.existsSync(TARGET_SOCKET_SOURCE)).toBe(false);
      targetSocketServer = spawnRoot("/usr/bin/node", [
        "-e",
        ROOT_SOCKET_SERVER,
        TARGET_SOCKET_SOURCE,
        String(accountGid),
        cancellationMarker,
      ]);
      targetSocketServerResult = collect(targetSocketServer);
      const targetReady = await waitForJsonLine(
        targetSocketServer,
        (value) => value.kind === "ready",
      );
      targetSocketServerPid = Number(targetReady.pid);
      expect(Number.isSafeInteger(targetSocketServerPid)).toBe(true);
      const socket = fs.lstatSync(TARGET_SOCKET_SOURCE);
      expect(socket.isSocket()).toBe(true);
      expect(socket.uid).toBe(0);
      expect(socket.gid).toBe(accountGid);
      expect(socket.mode & 0o7777).toBe(0o660);

      tcpControl = await startTcpControl();
    }, 30_000);

    afterAll(async () => {
      if (tcpControl !== undefined) await tcpControl.close();
      if (controller !== undefined) await terminate(controller);
      if (targetSocketServerPid !== undefined) {
        runRoot("/bin/kill", ["-TERM", String(targetSocketServerPid)]);
      }
      if (targetSocketServerResult !== undefined) await targetSocketServerResult;
      if (targetSocketServer !== undefined) await terminate(targetSocketServer);
      if (fs.existsSync(TARGET_SOCKET_SOURCE)) {
        runRoot("/usr/bin/rm", ["-f", "--", TARGET_SOCKET_SOURCE]);
      }
      if (createdSocketDirectory && fs.existsSync(TARGET_SOCKET_DIRECTORY)) {
        runRoot("/usr/bin/rmdir", [TARGET_SOCKET_DIRECTORY]);
      }
      if (inputRoot !== "" && fs.existsSync(inputRoot)) {
        fs.chmodSync(inputRoot, 0o700);
        fs.rmSync(inputRoot, { recursive: true, force: true });
      }
      if (checkoutRoot !== "" && fs.existsSync(checkoutRoot)) {
        fs.rmSync(checkoutRoot, { recursive: true, force: true });
      }
      if (artifactRoot !== "" && fs.existsSync(artifactRoot)) {
        runRoot("/usr/bin/rm", ["-rf", "--", artifactRoot]);
      }
      if (installedRunner) runRoot("/usr/bin/rm", ["-f", "--", RUNNER]);
      if (createdRunnerDirectory) runRoot("/usr/bin/rmdir", [path.dirname(RUNNER)]);
      if (createdAccount) {
        runRoot("/usr/sbin/userdel", [ARTIFACT_USER]);
        if (getDatabaseEntry("group", ARTIFACT_USER) !== undefined) {
          runRoot("/usr/sbin/groupdel", [ARTIFACT_USER]);
        }
      }
    }, 30_000);

    it("preserves bounded stdin and isolates one sealed task input with the fixed target socket", {
      timeout: 60_000,
    }, async () => {
      const taskDigest = sha256File(taskInput);
      const probeDigest = sha256File(callerProbe);
      const boundary = await runArtifact(
        artifactArgs(
          "--require-target-channel",
          callerProbe,
          probeDigest,
          ["--ingress-task-input", taskInput, "--ingress-task-input-sha256", taskDigest],
          ["boundary", String(controller!.pid), "9", String(tcpControl!.port), "require"],
        ),
      );
      expect(boundary, boundary.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      const boundaryRecord = JSON.parse(boundary.stdout) as Record<string, unknown>;
      expect(boundaryRecord).toMatchObject({
        kind: "boundary",
        taskInputSha256: taskDigest,
        uid: accountUid,
        gid: accountGid,
        seccomp: 2,
        target: "require",
      });
      for (const [field, hostNamespace] of [
        ["mountNamespace", fs.readlinkSync("/proc/self/ns/mnt")],
        ["networkNamespace", fs.readlinkSync("/proc/self/ns/net")],
        ["ipcNamespace", fs.readlinkSync("/proc/self/ns/ipc")],
        ["utsNamespace", fs.readlinkSync("/proc/self/ns/uts")],
        ["cgroupNamespace", fs.readlinkSync("/proc/self/ns/cgroup")],
      ]) {
        expect(boundaryRecord[field]).not.toBe(hostNamespace);
      }

      const stdinPayload = '{"schemaVersion":"1.0.0","kind":"adapter-request"}\n';
      const stdinResult = await runArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["stdin"]),
        stdinPayload,
      );
      expect(stdinResult, stdinResult.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(JSON.parse(stdinResult.stdout)).toEqual({
        kind: "stdin",
        bytes: Buffer.byteLength(stdinPayload),
        sha256: crypto.createHash("sha256").update(stdinPayload).digest("hex"),
      });

      const checkoutResult = await runArtifact(
        artifactArgs("--no-target-channel", checkoutProbe, undefined, [], ["stdin"]),
      );
      expect(checkoutResult, checkoutResult.stderr).toMatchObject({
        code: 0,
        signal: null,
        stderr: "",
      });

      const noTarget = await runArtifact(artifactArgs("--no-target-channel", "/usr/bin/env"));
      expect(noTarget, noTarget.stderr).toMatchObject({ code: 0, signal: null, stderr: "" });
      expect(noTarget.stdout).not.toContain("NEMOCLAW_CUA_QUALIFICATION_TARGET_SOCKET");
      expect(noTarget.stdout).not.toContain("NEMOCLAW_CONTROLLER_SECRET");

      const fixedExit = await runArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["exit-code"]),
      );
      expect(fixedExit).toEqual({
        code: 23,
        signal: null,
        stdout: "bounded-stdout\n",
        stderr: "bounded-stderr\n",
      });
    });

    it("rejects missing byte authority, unsafe task ingress, and oversized stdin", {
      timeout: 60_000,
    }, async () => {
      const probeDigest = sha256File(callerProbe);
      const taskDigest = sha256File(taskInput);
      const expectedFailures: Array<[string, string[], string | Buffer]> = [
        ["missing digest", ["--no-target-channel", "--", callerProbe, "stdin"], Buffer.alloc(0)],
        [
          "wrong artifact digest",
          artifactArgs("--no-target-channel", callerProbe, "0".repeat(64), [], ["stdin"]),
          Buffer.alloc(0),
        ],
        [
          "symlink input",
          artifactArgs(
            "--require-target-channel",
            callerProbe,
            probeDigest,
            ["--ingress-task-input", taskInputSymlink, "--ingress-task-input-sha256", taskDigest],
            ["stdin"],
          ),
          Buffer.alloc(0),
        ],
        [
          "writable input",
          artifactArgs(
            "--require-target-channel",
            callerProbe,
            probeDigest,
            [
              "--ingress-task-input",
              taskInputBadMode,
              "--ingress-task-input-sha256",
              sha256File(taskInputBadMode),
            ],
            ["stdin"],
          ),
          Buffer.alloc(0),
        ],
        [
          "oversized task input",
          artifactArgs(
            "--require-target-channel",
            callerProbe,
            probeDigest,
            [
              "--ingress-task-input",
              taskInputOversized,
              "--ingress-task-input-sha256",
              sha256File(taskInputOversized),
            ],
            ["stdin"],
          ),
          Buffer.alloc(0),
        ],
        [
          "wrong task digest",
          artifactArgs(
            "--require-target-channel",
            callerProbe,
            probeDigest,
            ["--ingress-task-input", taskInput, "--ingress-task-input-sha256", "f".repeat(64)],
            ["stdin"],
          ),
          Buffer.alloc(0),
        ],
        [
          "no-target ingress",
          artifactArgs(
            "--no-target-channel",
            callerProbe,
            probeDigest,
            ["--ingress-task-input", taskInput, "--ingress-task-input-sha256", taskDigest],
            ["stdin"],
          ),
          Buffer.alloc(0),
        ],
        [
          "missing separator",
          ["--no-target-channel", "--artifact-sha256", probeDigest, callerProbe, "stdin"],
          Buffer.alloc(0),
        ],
        [
          "oversized stdin",
          artifactArgs("--no-target-channel", callerProbe, probeDigest, [], ["stdin"]),
          Buffer.alloc(1024 * 1024 + 1, 0x78),
        ],
      ];
      for (const [label, args, input] of expectedFailures) {
        const result = await runArtifact(args, input);
        expect(result.code, `${label}: ${result.stderr}`).toBe(126);
      }
    });

    it("enforces one live cgroup, total resources, the global lock, and signal cleanup", {
      timeout: 60_000,
    }, async () => {
      const previousCgroups = systemdCgroups();
      const previousUnits = systemdUnits();
      const previousScratch = runnerScratchDirectories();
      const linger = spawnArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["linger"]),
      );
      const lingerResult = collect(linger);
      const cgroup = await waitForNewCgroup(previousCgroups);
      expect(fs.readFileSync(path.join(cgroup, "pids.max"), "utf8").trim()).toBe("32");
      expect(fs.readFileSync(path.join(cgroup, "memory.max"), "utf8").trim()).toBe("268435456");
      expect(fs.readFileSync(path.join(cgroup, "memory.swap.max"), "utf8").trim()).toBe("0");
      expect(fs.readFileSync(path.join(cgroup, "memory.oom.group"), "utf8").trim()).toBe("1");
      expect(fs.readFileSync(path.join(cgroup, "cpu.max"), "utf8").trim()).toBe("50000 100000");
      expect(fs.readFileSync(path.join(cgroup, "cgroup.events"), "utf8")).toContain("populated 1");

      const concurrent = await runArtifact(artifactArgs("--no-target-channel", "/usr/bin/true"));
      expect(concurrent.code).toBe(126);
      expect(concurrent.stderr).toContain("another qualification artifact invocation is active");

      linger.kill("SIGTERM");
      const interrupted = await lingerResult;
      expect(interrupted.code).toBe(126);
      for (let attempt = 0; attempt < 250; attempt += 1) {
        const newUnits = [...systemdUnits()].filter((unit) => !previousUnits.has(unit));
        const newScratch = [...runnerScratchDirectories()].filter(
          (entry) => !previousScratch.has(entry),
        );
        if (!fs.existsSync(cgroup) && newUnits.length === 0 && newScratch.length === 0) break;
        await delay(20);
      }
      expect(fs.existsSync(cgroup)).toBe(false);
      expect([...systemdUnits()].filter((unit) => !previousUnits.has(unit))).toEqual([]);
      expect(
        [...runnerScratchDirectories()].filter((entry) => !previousScratch.has(entry)),
      ).toEqual([]);
      expect(processUsesIdentity(accountUid, accountGid)).toBe(false);

      const pids = await runArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["pids"]),
      );
      expect(pids, pids.stderr).toMatchObject({ code: 0, signal: null });
      expect(JSON.parse(pids.stdout)).toMatchObject({ kind: "pids" });
      expect(Number((JSON.parse(pids.stdout) as { started: number }).started)).toBeLessThan(64);
    });

    it("cancels during pre-launch staging without running the artifact", {
      timeout: 60_000,
    }, async () => {
      const previousCgroups = systemdCgroups();
      const previousUnits = systemdUnits();
      const previousScratch = runnerScratchDirectories();
      const interrupted = spawn(
        RUNNER,
        [
          ...artifactArgs(
            "--require-target-channel",
            installedProbe,
            undefined,
            [],
            ["cancellation-marker"],
          ),
        ],
        {
          env: process.env,
          stdio: "pipe",
        },
      );
      const interruptedResult = collect(interrupted);
      const runnerPid = await waitForStagingRunner(installedProbe, previousScratch);
      await delay(100);
      runRoot("/bin/kill", ["-STOP", String(runnerPid)]);
      runRoot("/bin/kill", ["-TERM", String(runnerPid)]);
      interrupted.stdin.end();
      runRoot("/bin/kill", ["-CONT", String(runnerPid)]);

      const result = await interruptedResult;
      expect(result.code).toBe(126);
      expect(result.stderr).toContain("artifact execution was interrupted");
      expect(fs.existsSync(cancellationMarker)).toBe(false);
      expect([...systemdCgroups()].filter((entry) => !previousCgroups.has(entry))).toEqual([]);
      expect([...systemdUnits()].filter((unit) => !previousUnits.has(unit))).toEqual([]);
      expect(
        [...runnerScratchDirectories()].filter((entry) => !previousScratch.has(entry)),
      ).toEqual([]);
      expect(processUsesIdentity(accountUid, accountGid)).toBe(false);
    });

    it("rejects combined stdout and stderr beyond the single 16 KiB budget", {
      timeout: 60_000,
    }, async () => {
      const stdoutOverflow = await runArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["overflow-stdout"]),
      );
      expect(stdoutOverflow.code).toBe(126);
      expect(
        Buffer.byteLength(stdoutOverflow.stdout) + Buffer.byteLength(stdoutOverflow.stderr),
      ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);

      const stderrOverflow = await runArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["overflow-stderr"]),
      );
      expect(stderrOverflow.code).toBe(126);
      expect(
        Buffer.byteLength(stderrOverflow.stdout) + Buffer.byteLength(stderrOverflow.stderr),
      ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);

      const splitOverflow = await runArtifact(
        artifactArgs("--no-target-channel", installedProbe, undefined, [], ["overflow-split"]),
      );
      expect(splitOverflow.code).toBe(126);
      expect(
        Buffer.byteLength(splitOverflow.stdout) + Buffer.byteLength(splitOverflow.stderr),
      ).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    });
  },
);
