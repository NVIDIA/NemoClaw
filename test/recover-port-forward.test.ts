// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { execTimeout, testTimeoutOptions } from "./helpers/timeouts";

const tmpFixtures: string[] = [];

// Each fixture grabs a unique high port. Sharing port 18789 across tests
// collides with real nemoclaw installs on the developer's machine: the
// post-#3334 reachability probe sees the real forward answering and
// (correctly) classifies the dead-list entry as healthy, skipping recovery.
// Seed the base with the worker PID so parallel vitest workers (if ever
// enabled for this file) can't reuse the same ports across processes.
let nextFixturePort = 47000 + (process.pid % 10000);

afterEach(() => {
  for (const dir of tmpFixtures.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

interface Fixture {
  tmpDir: string;
  sandboxName: string;
  invocationLog: string;
}

function setupFixture(opts: {
  sandboxName: string;
  gatewayProbe: "RUNNING" | "STOPPED";
  forwardListStatus: "running" | "dead" | "missing";
  /** When false, `forward start` exits 0 but the post-restart probe keeps
   *  reporting the original dead/missing state — models a failed restart. */
  forwardStartHeals?: boolean;
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
  fs.writeFileSync(forwardStateFile, "initial");

  // Fake openshell: emits the requested gateway-probe and forward-list
  // shapes, swallows mutating subcommands (forward stop / forward start)
  // while logging every invocation so the test can assert the order. The
  // forward state flips to "running" after `forward start` to model the
  // post-recovery probe.
  fs.writeFileSync(
    openshellPath,
    `#!${process.execPath}
const fs = require("node:fs");
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
  const state = fs.readFileSync(${JSON.stringify(forwardStateFile)}, "utf-8");
  process.stdout.write(state === "running"
    ? ${JSON.stringify(recoveredForwardListBody)}
    : ${JSON.stringify(initialForwardListBody)});
  process.exit(0);
}

if (args[0] === "forward" && args[1] === "start") {
  if (${opts.forwardStartHeals === false ? "false" : "true"}) {
    fs.writeFileSync(${JSON.stringify(forwardStateFile)}, "running");
  }
  process.exit(0);
}

if (args[0] === "forward") {
  // forward stop swallowed; forward state untouched.
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

  return { tmpDir, sandboxName, invocationLog };
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
    "reports a failure when forward start succeeds but the post-restart probe still shows dead",
    testTimeoutOptions(20_000),
    () => {
      const fixture = setupFixture({
        sandboxName: "stuck-sandbox",
        gatewayProbe: "RUNNING",
        forwardListStatus: "dead",
        forwardStartHeals: false,
      });
      const result = runRecover(fixture);
      expect(result.status).toBe(0);

      const combined = (result.stdout || "") + (result.stderr || "");
      // Probe wrapper falls back to the plain "is running" line; the success
      // suffix must not appear because the forward never came back.
      expect(combined).toContain("gateway is running in 'stuck-sandbox'");
      expect(combined).not.toContain("restored dashboard port forward");
    },
  );

  it(
    "no-ops when both the gateway and the forward are healthy",
    testTimeoutOptions(20_000),
    () => {
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
    },
  );
});
