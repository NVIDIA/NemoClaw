// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

const tmpFixtures: string[] = [];
const listenerProcesses: ChildProcess[] = [];

// Each fixture grabs a unique high port. Sharing port 18789 across tests
// collides with real nemoclaw installs on the developer's machine: the
// post-#3334 reachability probe sees the real forward answering and
// (correctly) classifies the dead-list entry as healthy, skipping recovery.
// Seed the base with the worker PID so parallel vitest workers (if ever
// enabled for this file) can't reuse the same ports across processes.
let nextFixturePort = 47000 + (process.pid % 10000);

afterEach(() => {
  for (const child of listenerProcesses.splice(0)) {
    child.kill("SIGKILL");
  }
  for (const dir of tmpFixtures.splice(0)) {
    const listenerPidFile = path.join(dir, "forward-listener-pids");
    const listenerPids = (
      fs.existsSync(listenerPidFile) ? fs.readFileSync(listenerPidFile, "utf-8") : ""
    )
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    for (const pid of listenerPids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        expect((error as NodeJS.ErrnoException).code).toBe("ESRCH");
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function forwardListenerScript(port: string): string {
  return (
    'const net=require("node:net");' +
    "const server=net.createServer(()=>{});" +
    "let stopping=false;" +
    'process.on("SIGTERM",()=>{' +
    "if(stopping)return;" +
    "stopping=true;" +
    "setTimeout(()=>server.close(()=>process.exit(0)),150);" +
    "});" +
    `server.listen(${JSON.stringify(Number(port))},"127.0.0.1");`
  );
}

function startReachableForward(port: string, listenerPidFile: string): void {
  const child = spawn(process.execPath, ["-e", forwardListenerScript(port)], { stdio: "ignore" });
  listenerProcesses.push(child);
  expect(child.pid, `test forward listener failed to spawn for ${port}`).toBeDefined();
  fs.appendFileSync(listenerPidFile, `${String(child.pid)}\n`);

  const probe =
    "const net=require('node:net');" +
    `const s=net.createConnection({host:'127.0.0.1',port:${Number(port)}});` +
    "s.setTimeout(100);" +
    "s.on('connect',()=>{s.destroy();process.exit(0)});" +
    "s.on('error',()=>process.exit(1));" +
    "s.on('timeout',()=>{s.destroy();process.exit(1)});";
  const deadline = Date.now() + 2000;
  let listenerReady = false;
  while (Date.now() < deadline && !listenerReady) {
    listenerReady = spawnSync(process.execPath, ["-e", probe], { stdio: "ignore" }).status === 0;
  }
  expect(listenerReady, `test forward listener failed to bind port ${port}`).toBe(true);
}

interface Fixture {
  tmpDir: string;
  sandboxName: string;
  invocationLog: string;
  recoveryWaitMs: string;
}

function setupFixture(opts: {
  sandboxName: string;
  gatewayProbe: "RUNNING" | "STOPPED";
  forwardListStatus: "running" | "dead" | "missing";
  /** When false, `forward start` exits 0 but the post-restart probe keeps
   *  reporting the original dead/missing state — models a failed restart. */
  forwardStartHeals?: boolean;
  /** Number of post-start list probes that remain stale before ownership is visible. */
  forwardStartDelayPolls?: number;
  recoveryWaitMs?: string;
  port?: string;
}): Fixture {
  const sandboxName = opts.sandboxName;
  const port = opts.port ?? String(nextFixturePort++);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-recover-"));
  tmpFixtures.push(tmpDir);
  const homeLocalBin = path.join(tmpDir, ".local", "bin");
  const registryDir = path.join(tmpDir, ".nemoclaw");
  const openshellPath = path.join(homeLocalBin, "openshell");
  const invocationLog = path.join(tmpDir, "openshell-calls.log");

  fs.mkdirSync(homeLocalBin, { recursive: true });
  fs.mkdirSync(registryDir, { recursive: true });

  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      defaultSandbox: sandboxName,
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          model: "nvidia/test-model",
          provider: "nvidia-prod",
          gpuEnabled: false,
          policies: [],
          dashboardPort: Number(port),
        },
      },
    }),
    { mode: 0o600 },
  );

  const initialForwardListBody =
    opts.forwardListStatus === "missing"
      ? ""
      : `${sandboxName} 127.0.0.1 ${port} 12345 ${opts.forwardListStatus}\n`;
  const recoveredForwardListBody = `${sandboxName} 127.0.0.1 ${port} 99999 running\n`;
  const forwardStateFile = path.join(tmpDir, "forward-state");
  const forwardPollCountFile = path.join(tmpDir, "forward-poll-count");
  const listenerPidFile = path.join(tmpDir, "forward-listener-pids");
  fs.writeFileSync(forwardStateFile, "initial");
  fs.writeFileSync(forwardPollCountFile, "0");
  fs.writeFileSync(listenerPidFile, "");

  // Fake openshell: emits the requested gateway-probe and forward-list
  // shapes while logging every invocation so the test can assert the order.
  // A stop signals the preexisting listener, which releases asynchronously;
  // a successful start launches a replacement listener before flipping the
  // forward state to "running" for the post-recovery probe.
  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(invocationLog)}, args.join(" ") + "\\n");

if (args[0] === "status") {
  process.stdout.write("Gateway: nemoclaw\\nStatus: Connected\\n");
  process.exit(0);
}

if (args[0] === "gateway" && args[1] === "info") {
  process.stdout.write(
    "Gateway: nemoclaw\\nGateway endpoint: https://127.0.0.1:8080\\n",
  );
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "get" && args[2] === ${JSON.stringify(sandboxName)}) {
  process.stdout.write(
    "Sandbox:\\n\\n  Id: abc\\n  Name: ${sandboxName}\\n  Phase: Ready\\n",
  );
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "list") {
  process.stdout.write("${sandboxName}   Ready   1m ago\\n");
  process.exit(0);
}

if (args[0] === "sandbox" && args[1] === "exec") {
  // The probe parser drops everything up to and including the start marker,
  // so the fake gateway response must follow it on a new line.
  process.stdout.write("__NEMOCLAW_SANDBOX_EXEC_STARTED__\\n${opts.gatewayProbe}\\n");
  process.exit(0);
}

if (args[0] === "forward" && args[1] === "list") {
  let state = fs.readFileSync(${JSON.stringify(forwardStateFile)}, "utf-8");
  if (state === "pending") {
    const polls = Number(fs.readFileSync(${JSON.stringify(forwardPollCountFile)}, "utf-8")) + 1;
    fs.writeFileSync(${JSON.stringify(forwardPollCountFile)}, String(polls));
    if (polls >= ${opts.forwardStartDelayPolls ?? 0}) {
      fs.writeFileSync(${JSON.stringify(forwardStateFile)}, "running");
      state = "running";
    }
  }
  process.stdout.write(state === "running"
    ? ${JSON.stringify(recoveredForwardListBody)}
    : ${JSON.stringify(initialForwardListBody)});
  process.exit(0);
}

if (args[0] === "forward" && args[1] === "stop") {
  const listenerPids = fs.readFileSync(${JSON.stringify(listenerPidFile)}, "utf-8")
    .trim()
    .split(/\\s+/)
    .map(Number)
    .filter((pid) => Number.isInteger(pid) && pid > 0);
  const listenerPid = listenerPids.at(-1);
  if (listenerPid !== undefined) {
    try {
      process.kill(listenerPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  process.exit(0);
}

if (args[0] === "forward" && args[1] === "start") {
  if (${opts.forwardStartHeals === false ? "false" : "true"}) {
    const listener = spawn(process.execPath, ["-e", ${JSON.stringify(forwardListenerScript(port))}], {
      detached: true,
      stdio: "ignore",
    });
    listener.unref();
    if (listener.pid !== undefined) {
      fs.appendFileSync(${JSON.stringify(listenerPidFile)}, String(listener.pid) + "\\n");
    }
    fs.writeFileSync(
      ${JSON.stringify(forwardStateFile)},
      ${opts.forwardStartDelayPolls ? '"pending"' : '"running"'},
    );
  }
  process.exit(0);
}

if (args[0] === "forward") {
  process.exit(0);
}

if (args[0] === "policy" && args[1] === "get") {
  process.exit(1);
}

if (args[0] === "inference" && args[1] === "get") {
  process.stdout.write(
    "Gateway inference:\\n  Provider: nvidia-prod\\n  Model: nvidia/test-model\\n",
  );
  process.exit(0);
}

process.exit(0);
`,
    { mode: 0o755 },
  );

  // A running OpenShell row is only healthy when its local socket also
  // answers. Keep the listener alive in a separate process because runRecover
  // uses spawnSync and blocks this Vitest worker's event loop.
  const reachablePorts = opts.forwardStartHeals !== false ? [port] : [];
  reachablePorts.forEach((reachablePort) => startReachableForward(reachablePort, listenerPidFile));

  return {
    tmpDir,
    sandboxName,
    invocationLog,
    recoveryWaitMs: opts.recoveryWaitMs ?? "2000",
  };
}

function runRecover(fixture: Fixture) {
  const repoRoot = path.join(import.meta.dirname, "..");
  return spawnSync(
    process.execPath,
    [path.join(repoRoot, "bin", "nemoclaw.js"), fixture.sandboxName, "recover"],
    {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: fixture.tmpDir,
        PATH: "/usr/bin:/bin",
        NEMOCLAW_NO_CONNECT_HINT: "1",
        NEMOCLAW_FORWARD_RECOVERY_WAIT_MS: fixture.recoveryWaitMs,
      },
      timeout: execTimeout(15_000),
    },
  );
}

describe("nemoclaw <name> recover", () => {
  it(
    "re-establishes the dashboard port-forward when the gateway is alive but the forward is dead",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "alive-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "dead",
      });
      const result = runRecover(fixture);
      expect(result.status).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain(
        "gateway is running in 'alive-sandbox'; restored dashboard port forward",
      );

      const calls = fs.readFileSync(fixture.invocationLog, "utf-8").split("\n");
      const stopIdx = calls.findIndex((l) => l.startsWith("forward stop "));
      const startIdx = calls.findIndex((l) => l.startsWith("forward start "));
      expect(stopIdx).toBeGreaterThanOrEqual(0);
      expect(startIdx).toBeGreaterThan(stopIdx);
    },
  );

  it(
    "polls until the exact forward owner appears after background start",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "delayed-owner-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "dead",
        forwardStartDelayPolls: 3,
        recoveryWaitMs: "2000",
      });
      const result = runRecover(fixture);
      expect(result.status).toBe(0);

      const calls = fs.readFileSync(fixture.invocationLog, "utf-8").split("\n");
      const startIdx = calls.findIndex((line) => line.startsWith("forward start "));
      const postStartListCalls = calls
        .slice(startIdx + 1)
        .filter((line) => line === "forward list");
      expect(startIdx).toBeGreaterThanOrEqual(0);
      expect(postStartListCalls.length).toBeGreaterThanOrEqual(3);
    },
  );

  it(
    "reports a failure when forward start succeeds but the post-restart probe still shows dead",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "stuck-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "dead",
        forwardStartHeals: false,
        recoveryWaitMs: "0",
      });
      const result = runRecover(fixture);
      expect(result.status).toBe(1);

      const combined = (result.stdout || "") + (result.stderr || "");
      expect(combined).toContain("gateway is running in 'stuck-sandbox'");
      expect(combined).toContain("primary dashboard/API host forward could not be re-established");
      expect(combined).not.toContain("restored dashboard port forward");
    },
  );

  it("no-ops when both the gateway and the forward are healthy", testTimeoutOptions(20_000), () => {
    const fixture = setupFixture({
      sandboxName: "healthy-sandbox",
      gatewayProbe: "RUNNING",
      forwardListStatus: "running",
    });
    const result = runRecover(fixture);
    expect(result.status).toBe(0);

    const combined = (result.stdout || "") + (result.stderr || "");
    expect(combined).toContain("gateway is running in 'healthy-sandbox'");
    expect(combined).not.toContain("Re-establishing");
    expect(combined).not.toContain("restored dashboard port forward");

    const calls = fs.readFileSync(fixture.invocationLog, "utf-8").split("\n");
    expect(calls.some((l) => l.startsWith("forward stop "))).toBe(false);
    expect(calls.some((l) => l.startsWith("forward start "))).toBe(false);
  });
});
