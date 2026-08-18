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
  readonly gatewayBin: string;
  readonly gatewayCommandLog: string;
  readonly gatewayPidFile: string;
  readonly gatewayTlsDir: string;
  readonly gatewayUnitPath: string;
  readonly homeDir: string;
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

function gatewayServiceUnit(gatewayBin: string): string {
  return `# NEMOCLAW_MANAGED_OPENSHELL_GATEWAY=1
[Service]
StateDirectory=openshell/gateway
Environment=OPENSHELL_LOCAL_TLS_DIR=%S/openshell/tls
EnvironmentFile=-%E/openshell/gateway.env
ExecStartPre=${gatewayBin} generate-certs --output-dir \${OPENSHELL_LOCAL_TLS_DIR} --server-san host.openshell.internal
ExecStart=${gatewayBin}
`;
}

function createFixture(): FixtureScope {
  const directory = fs.mkdtempSync("/tmp/portable-systemctl-shim-");
  const binDir = path.join(directory, "bin");
  const homeDir = path.join(directory, "home");
  const binHome = path.join(homeDir, ".local", "bin");
  const configHome = path.join(homeDir, ".config");
  const stateHome = path.join(homeDir, ".local", "state");
  const runtimeDir = path.join(directory, "runtime");
  const socketPath = path.join(runtimeDir, "podman", "podman.sock");
  const gatewayBin = path.join(binHome, "openshell-gateway");
  const gatewayCommandLog = path.join(directory, "gateway-commands.jsonl");
  const gatewayPidFile = path.join(runtimeDir, "nemoclaw-openshell-gateway.pid");
  const gatewayTlsDir = path.join(stateHome, "nemoclaw", "openshell-docker-gateway", "tls");
  const gatewayUnitPath = path.join(
    configHome,
    "systemd",
    "user",
    "nemoclaw-openshell-gateway.service",
  );
  fs.mkdirSync(binDir);
  fs.mkdirSync(runtimeDir);
  fs.mkdirSync(path.dirname(gatewayBin), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(gatewayUnitPath), { recursive: true, mode: 0o700 });
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
  writeExecutable(
    gatewayBin,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const record = (value) => fs.appendFileSync(
  process.env.FAKE_GATEWAY_COMMAND_LOG,
  JSON.stringify(value) + "\\n",
);
if (
  args.length === 5 &&
  args[0] === "generate-certs" &&
  args[1] === "--output-dir" &&
  args[3] === "--server-san" &&
  args[4] === "host.openshell.internal"
) {
  if (fs.existsSync(process.env.FAKE_GATEWAY_CERT_MARKER + ".fail")) {
    console.error("test-only gateway certificate diagnostic");
    process.exit(70);
  }
  fs.mkdirSync(args[2], { recursive: true, mode: 0o700 });
  fs.writeFileSync(process.env.FAKE_GATEWAY_CERT_MARKER, "generated\\n", { mode: 0o600 });
  record({
    args,
    kind: "generate-certs",
    nvidiaInferenceApiKey: process.env.NVIDIA_INFERENCE_API_KEY ?? null,
    path: process.env.PATH,
    tls: process.env.OPENSHELL_LOCAL_TLS_DIR,
  });
  process.exit(0);
}
if (args.length !== 0) process.exit(64);
record({
  bindAddress: process.env.OPENSHELL_BIND_ADDRESS ?? null,
  bindMounts: process.env.NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS ?? null,
  disableGatewayAuth: process.env.OPENSHELL_DISABLE_GATEWAY_AUTH ?? null,
  disableTls: process.env.OPENSHELL_DISABLE_TLS ?? null,
  dockerHost: process.env.DOCKER_HOST,
  drivers: process.env.OPENSHELL_DRIVERS,
  kind: "serve",
  nvidiaInferenceApiKey: process.env.NVIDIA_INFERENCE_API_KEY ?? null,
  path: process.env.PATH,
  pid: process.pid,
  tls: process.env.OPENSHELL_LOCAL_TLS_DIR,
});
const stop = () => process.exit(0);
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => undefined, 1000);
`,
  );
  fs.writeFileSync(gatewayUnitPath, gatewayServiceUnit(gatewayBin), { mode: 0o600 });
  const gatewayEnvFile = path.join(homeDir, ".config", "openshell", "gateway.env");
  fs.mkdirSync(path.dirname(gatewayEnvFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    gatewayEnvFile,
    `DOCKER_HOST='unix://${socketPath}'\nOPENSHELL_DRIVERS=podman\nOPENSHELL_LOCAL_TLS_DIR=${gatewayTlsDir}\n`,
    { mode: 0o600 },
  );
  return {
    binDir,
    directory,
    env: {
      ...process.env,
      FAKE_GATEWAY_CERT_MARKER: path.join(directory, "gateway-cert.marker"),
      FAKE_GATEWAY_COMMAND_LOG: gatewayCommandLog,
      FAKE_PODMAN_PID_LOG: path.join(directory, "podman-pids.log"),
      FAKE_PODMAN_SOCKET: socketPath,
      HOME: homeDir,
      NEMOCLAW_DOCKER_ENABLE_BIND_MOUNTS: "1",
      NVIDIA_INFERENCE_API_KEY: "test-only-hostile-inherited-key",
      OPENSHELL_BIND_ADDRESS: "127.0.0.1",
      OPENSHELL_DISABLE_GATEWAY_AUTH: "1",
      OPENSHELL_DISABLE_TLS: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      XDG_BIN_HOME: binHome,
      XDG_CONFIG_HOME: configHome,
      XDG_RUNTIME_DIR: runtimeDir,
      XDG_STATE_HOME: stateHome,
    },
    gatewayBin,
    gatewayCommandLog,
    gatewayPidFile,
    gatewayTlsDir,
    gatewayUnitPath,
    homeDir,
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

function readManagedGatewayBinaryPath(scope: FixtureScope): ReturnType<typeof spawnSync> {
  return spawnSync(
    "bash",
    [
      "-c",
      'source "$1"\nread_managed_gateway_binary_path',
      "portable-profile-gateway-binary",
      scope.shim,
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

function gatewayStatus(scope: FixtureScope): number | null {
  return systemctl(scope, ["--user", "is-active", "--quiet", "nemoclaw-openshell-gateway"]).status;
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
  it.each(["/usr/local/bin/openshell-gateway", "/usr/bin/openshell-gateway"])(
    "reads installer-selected OpenShell gateway binary %s from the managed user service (#9208)",
    (gatewayBinary) => {
      const scope = createFixture();
      try {
        fs.writeFileSync(scope.gatewayUnitPath, gatewayServiceUnit(gatewayBinary), { mode: 0o600 });
        const result = readManagedGatewayBinaryPath(scope);
        expect(result.status, String(result.stderr)).toBe(0);
        expect(result.stdout).toBe(`${gatewayBinary}\n`);
      } finally {
        fs.rmSync(scope.directory, { force: true, recursive: true });
      }
    },
  );

  it("rejects a managed OpenShell gateway user service that names an untrusted binary path (#9208)", () => {
    const scope = createFixture();
    try {
      fs.writeFileSync(
        scope.gatewayUnitPath,
        gatewayServiceUnit("/opt/openshell/bin/openshell-gateway"),
        { mode: 0o600 },
      );
      const result = readManagedGatewayBinaryPath(scope);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    } finally {
      fs.rmSync(scope.directory, { force: true, recursive: true });
    }
  });

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
    "runs the managed gateway user-service sequence and cleanup through the fixture (#9208)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      try {
        expect(gatewayStatus(scope)).toBe(3);
        expect(systemctl(scope, ["--user", "daemon-reload"]).status).toBe(0);

        const identity = systemctl(scope, [
          "--user",
          "show",
          "nemoclaw-openshell-gateway",
          "--property=FragmentPath",
          "--property=ExecStart",
        ]);
        expect(identity.status, String(identity.stderr)).toBe(0);
        expect(identity.stdout).toBe(
          `FragmentPath=${scope.gatewayUnitPath}\nExecStart={ path=${scope.gatewayBin} ; argv[]=${scope.gatewayBin} ; }\n`,
        );
        expect(systemctl(scope, ["--user", "stop", "nemoclaw-openshell-gateway"]).status).toBe(0);
        expect(systemctl(scope, ["--user", "enable", "nemoclaw-openshell-gateway"]).status).toBe(0);

        const restart = systemctl(scope, ["--user", "restart", "nemoclaw-openshell-gateway"]);
        expect(restart.status, String(restart.stderr)).toBe(0);
        expect(gatewayStatus(scope)).toBe(0);
        const gatewayProcess = readFixtureProcessRecord(scope.gatewayPidFile);
        expectProcessActive(gatewayProcess.pid);

        const activeIdentity = systemctl(scope, [
          "--user",
          "show",
          "nemoclaw-openshell-gateway",
          "--property=FragmentPath",
          "--property=ExecStart",
          "--property=ActiveState",
          "--property=MainPID",
        ]);
        expect(activeIdentity.status, String(activeIdentity.stderr)).toBe(0);
        expect(activeIdentity.stdout).toContain("ActiveState=active\n");
        expect(activeIdentity.stdout).toContain(`MainPID=${String(gatewayProcess.pid)}\n`);

        const commands = fs
          .readFileSync(scope.gatewayCommandLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(commands.map((command) => command.kind)).toEqual(["generate-certs", "serve"]);
        expect(commands[0]).toMatchObject({
          args: [
            "generate-certs",
            "--output-dir",
            scope.gatewayTlsDir,
            "--server-san",
            "host.openshell.internal",
          ],
          nvidiaInferenceApiKey: null,
          path: "/usr/local/bin:/usr/bin:/bin",
          tls: scope.gatewayTlsDir,
        });
        expect(commands[1]).toMatchObject({
          bindAddress: null,
          bindMounts: null,
          disableGatewayAuth: null,
          disableTls: null,
          dockerHost: `unix://${scope.socketPath}`,
          drivers: "podman",
          nvidiaInferenceApiKey: null,
          path: "/usr/local/bin:/usr/bin:/bin",
          tls: scope.gatewayTlsDir,
        });
        expect(fs.readFileSync(scope.env.FAKE_GATEWAY_CERT_MARKER!, "utf8")).toBe("generated\n");

        await cleanupPortableProfileSystemctlFixture(scope.runtimeDir);
        expect(pidIsActive(gatewayProcess.pid)).toBe(false);
        expect(fs.existsSync(scope.gatewayPidFile)).toBe(false);
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it("does not emit gateway child output when certificate generation fails (#9208)", async () => {
    const scope = createFixture();
    try {
      fs.writeFileSync(`${scope.env.FAKE_GATEWAY_CERT_MARKER!}.fail`, "fail\n", {
        mode: 0o600,
      });
      const restart = systemctl(scope, ["--user", "restart", "nemoclaw-openshell-gateway"]);
      expect(restart.status).toBe(1);
      expect(String(restart.stderr)).toContain(
        "Portable profile fixture could not generate gateway certificates.",
      );
      expect(String(restart.stderr)).not.toContain("test-only gateway certificate diagnostic");
      expect(fs.existsSync(scope.gatewayPidFile)).toBe(false);
      expect(
        fs.statSync(path.join(scope.runtimeDir, "nemoclaw-openshell-gateway.log")).mode & 0o777,
      ).toBe(0o600);
    } finally {
      fs.rmSync(`${scope.env.FAKE_GATEWAY_CERT_MARKER!}.fail`, { force: true });
      await cleanFixture(scope);
    }
  });

  it(
    "preserves a launch record when initial gateway cleanup fails (#9208)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      try {
        const restart = systemctl(
          {
            ...scope,
            env: {
              ...scope.env,
              NEMOCLAW_PORTABLE_PROFILE_TEST_GATEWAY_CLEANUP_FAILURE: "1",
              NEMOCLAW_PORTABLE_PROFILE_TEST_GATEWAY_RECORD_FAILURE: "1",
            },
          },
          ["--user", "restart", "nemoclaw-openshell-gateway"],
        );
        expect(restart.status).toBe(2);
        expect(String(restart.stderr)).toContain(
          "Portable profile fixture could not create the gateway process identity record.",
        );
        expect(String(restart.stderr)).toContain(
          "Portable profile fixture could not stop the gateway launch process.",
        );
        const gatewayLaunchPidFile = path.join(
          scope.runtimeDir,
          "nemoclaw-openshell-gateway-launch.pid",
        );
        expect(fs.existsSync(scope.gatewayPidFile)).toBe(false);
        expect(fs.existsSync(gatewayLaunchPidFile)).toBe(true);
        const commands = fs
          .readFileSync(scope.gatewayCommandLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(commands.map((command) => command.kind)).toEqual(["generate-certs", "serve"]);
        const gatewayPid = commands[1]!.pid as number;
        expect(readFixtureProcessRecord(gatewayLaunchPidFile).pid).toBe(gatewayPid);
        expect(pidIsActive(gatewayPid)).toBe(true);
        await cleanupPortableProfileSystemctlFixture(scope.runtimeDir);
        expect(pidIsActive(gatewayPid)).toBe(false);
        expect(fs.existsSync(gatewayLaunchPidFile)).toBe(false);
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "does not leave a gateway launch process when launch-record publication and cleanup fail (#9208)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      try {
        const restart = systemctl(
          {
            ...scope,
            env: {
              ...scope.env,
              NEMOCLAW_PORTABLE_PROFILE_TEST_GATEWAY_LAUNCH_RECORD_FAILURE: "1",
              NEMOCLAW_PORTABLE_PROFILE_TEST_GATEWAY_UNRECORDED_CLEANUP_FAILURE: "1",
            },
          },
          ["--user", "restart", "nemoclaw-openshell-gateway"],
        );
        expect(restart.status).toBe(2);
        expect(String(restart.stderr)).toContain(
          "Portable profile fixture could not create the gateway launch identity record.",
        );
        expect(String(restart.stderr)).toContain(
          "Portable profile fixture could not complete gateway launch cleanup.",
        );
        const gatewayLaunchPidFile = path.join(
          scope.runtimeDir,
          "nemoclaw-openshell-gateway-launch.pid",
        );
        expect(fs.existsSync(scope.gatewayPidFile)).toBe(false);
        expect(fs.existsSync(gatewayLaunchPidFile)).toBe(false);
        const gatewayLog = fs.readFileSync(
          path.join(scope.runtimeDir, "nemoclaw-openshell-gateway.log"),
          "utf8",
        );
        const launchedPid = /injected gateway launch-record failure for process ([0-9]+)/.exec(
          gatewayLog,
        );
        expect(launchedPid).not.toBeNull();
        const gatewayPid = Number(launchedPid![1]);
        await vi.waitFor(() => expect(pidIsActive(gatewayPid)).toBe(false));
        const commands = fs
          .readFileSync(scope.gatewayCommandLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as Record<string, unknown>);
        expect(commands.map((command) => command.kind)).toEqual(["generate-certs"]);
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it(
    "isolates the managed gateway user service from ambient XDG homes (#9208)",
    { timeout: 30_000 },
    async () => {
      const ambientRoot = fs.mkdtempSync("/tmp/portable-systemctl-ambient-");
      vi.stubEnv("XDG_BIN_HOME", path.join(ambientRoot, "bin"));
      vi.stubEnv("XDG_CONFIG_HOME", path.join(ambientRoot, "config"));
      vi.stubEnv("XDG_RUNTIME_DIR", path.join(ambientRoot, "runtime"));
      vi.stubEnv("XDG_STATE_HOME", path.join(ambientRoot, "state"));
      const scope = createFixture();
      try {
        expect(scope.env.XDG_BIN_HOME).not.toBe(path.join(ambientRoot, "bin"));
        expect(scope.env.XDG_CONFIG_HOME).not.toBe(path.join(ambientRoot, "config"));
        expect(scope.env.XDG_RUNTIME_DIR).not.toBe(path.join(ambientRoot, "runtime"));
        expect(scope.env.XDG_STATE_HOME).not.toBe(path.join(ambientRoot, "state"));
        const reload = systemctl(scope, ["--user", "daemon-reload"]);
        expect(reload.status, String(reload.stderr)).toBe(0);
        const restart = systemctl(scope, ["--user", "restart", "nemoclaw-openshell-gateway"]);
        expect(restart.status, String(restart.stderr)).toBe(0);
        expect(fs.existsSync(scope.gatewayPidFile)).toBe(true);
        expect(fs.readdirSync(ambientRoot)).toEqual([]);
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(ambientRoot, { force: true, recursive: true });
        await cleanFixture(scope);
      }
    },
  );

  it(
    "preserves the gateway PID record when startup identity validation fails (#9208)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      const originalRecordPath = `${scope.gatewayPidFile}.before-validation`;
      try {
        const result = systemctl(
          {
            ...scope,
            env: {
              ...scope.env,
              NEMOCLAW_PORTABLE_PROFILE_TEST_GATEWAY_RECORD_DRIFT: "1",
            },
          },
          ["--user", "restart", "nemoclaw-openshell-gateway"],
        );
        fs.accessSync(originalRecordPath, fs.constants.R_OK);
        expect(result.status).toBe(1);
        expect(String(result.stderr)).toContain("does not match process");
        expect(fs.existsSync(scope.gatewayPidFile)).toBe(true);
        expect(fs.existsSync(originalRecordPath)).toBe(true);
        const driftedRecord = readFixtureProcessRecord(scope.gatewayPidFile);
        expect(pidIsActive(driftedRecord.pid)).toBe(true);
      } finally {
        try {
          fs.copyFileSync(originalRecordPath, scope.gatewayPidFile);
          fs.chmodSync(scope.gatewayPidFile, 0o600);
        } finally {
          fs.rmSync(originalRecordPath, { force: true });
          await cleanFixture(scope);
        }
      }
    },
  );

  it(
    "rejects a reused gateway PID during shared cleanup without signaling the unrelated process (#9208)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      let originalRecord: FixtureProcessRecord | undefined;
      let unrelated: ReturnType<typeof spawn> | undefined;
      try {
        expect(systemctl(scope, ["--user", "restart", "nemoclaw-openshell-gateway"]).status).toBe(
          0,
        );
        originalRecord = readFixtureProcessRecord(scope.gatewayPidFile);
        unrelated = spawnUnrelatedProcess();
        await vi.waitFor(() => expect(pidIsActive(unrelated!.pid!)).toBe(true));
        fs.writeFileSync(scope.gatewayPidFile, replaceRecordedPid(originalRecord, unrelated.pid!), {
          mode: 0o600,
        });

        await expect(cleanupPortableProfileSystemctlFixture(scope.runtimeDir)).rejects.toThrow(
          `Portable profile fixture PID file ${scope.gatewayPidFile} does not match process ${String(unrelated.pid)}.`,
        );
        expect(pidIsActive(unrelated.pid!)).toBe(true);
        expect(fs.existsSync(scope.gatewayPidFile)).toBe(true);
        expect(fs.existsSync(scope.directory)).toBe(true);
      } finally {
        restoreFixtureProcessRecord(scope.gatewayPidFile, originalRecord);
        await stopUnrelatedProcess(unrelated);
        await cleanFixture(scope);
      }
    },
  );

  it(
    "rejects gateway unit drift before restarting the managed process (#9208)",
    { timeout: 30_000 },
    async () => {
      const scope = createFixture();
      try {
        const start = systemctl(scope, ["--user", "restart", "nemoclaw-openshell-gateway"]);
        expect(start.status, String(start.stderr)).toBe(0);
        const gatewayProcess = readFixtureProcessRecord(scope.gatewayPidFile);
        expectProcessActive(gatewayProcess.pid);
        fs.writeFileSync(scope.gatewayUnitPath, "[Service]\nExecStart=/tmp/foreign\n", {
          mode: 0o600,
        });

        const restart = systemctl(scope, ["--user", "restart", "nemoclaw-openshell-gateway"]);
        expect(restart.status).not.toBe(0);
        expect(restart.stderr).toContain("rejected the foreign gateway user service");
        expectProcessActive(gatewayProcess.pid);
        expect(readFixtureProcessRecord(scope.gatewayPidFile).pid).toBe(gatewayProcess.pid);
      } finally {
        await cleanFixture(scope);
      }
    },
  );

  it.each([
    { scenario: "activator PID" },
    { scenario: "service PID" },
    { scenario: "public socket" },
    { scenario: "backend socket" },
  ])(
    "serializes try-restart with a public-socket request and leaves only the recorded backend process active [$scenario] (#9006)",
    { timeout: 30_000 },
    async ({ scenario }) => {
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
        const artifact = (
          {
            "activator PID": activatorPidFile,
            "service PID": servicePidFile,
            "public socket": scope.socketPath,
            "backend socket": backendSocketPath,
          } as const
        )[scenario]!;
        expect(fs.existsSync(artifact), artifact).toBe(false);
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

  it.each([
    { scenario: "activator PID" },
    { scenario: "service PID" },
    { scenario: "public socket" },
    { scenario: "backend socket" },
  ])(
    "stops both fixture processes and removes both sockets during cleanup [$scenario] (#9006)",
    { timeout: 30_000 },
    async ({ scenario }) => {
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
        const artifact = (
          {
            "activator PID": activatorPidFile,
            "service PID": servicePidFile,
            "public socket": scope.socketPath,
            "backend socket": backendSocketPath,
          } as const
        )[scenario]!;
        expect(fs.existsSync(artifact), artifact).toBe(false);
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

  it("rejects malformed or extended gateway user-service commands (#9208)", () => {
    const scope = createFixture();
    try {
      const driftedCommands = [
        ["--user", "daemon-reload", "trailing"],
        ["--user", "show", "nemoclaw-openshell-gateway", "--property=ExecStart"],
        ["--user", "restart", "nemoclaw-openshell-gateway", "trailing"],
        ["--user", "enable", "--now", "nemoclaw-openshell-gateway"],
        ["--user", "is-active", "nemoclaw-openshell-gateway", "--quiet"],
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
