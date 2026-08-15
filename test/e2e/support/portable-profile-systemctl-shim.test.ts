// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { installPortableProfileSystemctlShim } from "../fixtures/portable-profile-systemctl.ts";
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
const socketPath = args[3].slice("unix://".length);
fs.rmSync(socketPath, { force: true });
const server = net.createServer((socket) => {
  socket.once("data", () => socket.end("ready"));
});
server.listen(socketPath);
const stop = () => server.close(() => process.exit(0));
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
    timeout: 15_000,
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

async function waitForServiceStatus(scope: FixtureScope, expected: number): Promise<void> {
  await vi.waitFor(() => expect(serviceStatus(scope)).toBe(expected), {
    interval: 50,
    timeout: 5_000,
  });
}

function readFixturePids(scope: FixtureScope): number[] {
  return ["nemoclaw-podman-socket-activator.pid", "nemoclaw-podman-service.pid"]
    .map((name) => path.join(scope.runtimeDir, name))
    .filter((pidFile) => fs.existsSync(pidFile))
    .map((pidFile) => Number(fs.readFileSync(pidFile, "utf8").trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
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

async function waitForExit(pid: number): Promise<void> {
  await vi.waitFor(() => expect(pidIsActive(pid)).toBe(false), {
    interval: 20,
    timeout: 2_000,
  });
}

async function cleanFixture(scope: FixtureScope): Promise<void> {
  const pids = readFixturePids(scope);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
    }
  }
  await Promise.all(pids.map(waitForExit));
  expect(pids.every((pid) => !pidIsActive(pid))).toBe(true);
  fs.rmSync(scope.directory, { force: true, recursive: true });
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
    timeout: 15_000,
  });
}

function portableLaunchProvisionStep(): WorkflowStep {
  const workflow = readYaml<Workflow>(".github/workflows/portable-profile-e2e.yaml");
  const step = workflow.jobs["portable-launch"]?.steps?.find(
    (candidate) => candidate.name === "Provision restricted rootless Linux runtime",
  );
  expect(step).toBeDefined();
  return step!;
}

describe("portable profile systemctl fixture", () => {
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
        const firstPid = fs.readFileSync(servicePidFile, "utf8").trim();
        const refresh = systemctl(scope, ["--user", "try-restart", "podman.service"]);
        expect(refresh.status, String(refresh.stderr)).toBe(0);
        expect(serviceStatus(scope)).toBe(0);
        expect(fs.readFileSync(servicePidFile, "utf8").trim()).not.toBe(firstPid);
        expect(pidIsActive(Number(firstPid))).toBe(false);
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

  it("binds the portable-launch workflow to the shared systemctl fixture (#9006)", () => {
    const provision = portableLaunchProvisionStep().run ?? "";
    expect(provision).toContain(
      'install -m 700 test/e2e/fixtures/portable-profile-systemctl-shim.sh "$shim_dir/systemctl"',
    );
    expect(provision).toContain("systemctl --user start podman.socket");
  });
});
