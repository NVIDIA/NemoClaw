// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";

type CommandEntry = {
  command: string;
  env?: Record<string, string | undefined> | null;
};

function writeExecutable(target: string, contents: string) {
  fs.writeFileSync(target, contents, { mode: 0o755 });
}

function parseStdoutJson<T>(stdout: string): T {
  const line = stdout
    .trim()
    .split("\n")
    .reverse()
    .find((candidate) => candidate.startsWith("{") && candidate.endsWith("}"));
  assert.ok(line, `expected JSON payload in stdout:\n${stdout}`);
  return JSON.parse(line);
}

const repoRoot = path.join(import.meta.dirname, "..");

function runTerminalDashboardScenario(scenario: "create" | "reuse") {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `nemoclaw-terminal-${scenario}-`));
  const fakeBin = path.join(tmpDir, "bin");
  const scriptPath = path.join(tmpDir, `${scenario}.js`);
  const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
  const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));
  const registryPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "state", "registry.js"));
  const agentDefsPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "agent", "defs.js"));
  const agentOnboardPath = JSON.stringify(
    path.join(repoRoot, "dist", "lib", "agent", "onboard.js"),
  );

  fs.mkdirSync(fakeBin, { recursive: true });
  writeExecutable(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n");

  const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require(${runnerPath});
const registry = require(${registryPath});
const agentDefs = require(${agentDefsPath});
const agentOnboard = require(${agentOnboardPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
const scenario = ${JSON.stringify(scenario)};
const sandboxName = "deepagents-box";
const commands = [];
const registerCalls = [];
const updateCalls = [];
const keepAlive = setInterval(() => {}, 1000);
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");

agentOnboard.createAgentSandbox = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-terminal-agent-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(stagedDockerfile, "FROM scratch\nCMD [\"/bin/sh\"]\n");
  return { buildCtx, stagedDockerfile };
};

runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  const normalized = _n(command);
  commands.push({ command: normalized, env: null });
  if (normalized.includes("sandbox get " + sandboxName)) {
    return scenario === "reuse" ? sandboxName : "";
  }
  if (normalized.includes("sandbox list")) return sandboxName + " Ready";
  if (normalized.includes("forward list")) return sandboxName + " 127.0.0.1 18789 12345 running";
  return "";
};

registry.getSandbox = () =>
  scenario === "reuse"
    ? { name: sandboxName, gpuEnabled: false, agent: "langchain-deepagents-code", dashboardPort: 18789 }
    : null;
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = (name, updates) => {
  updateCalls.push({ name, updates });
  return true;
};
registry.setDefault = () => true;
registry.removeSandbox = () => true;

childProcess.spawn = (...args) => {
  if (scenario === "reuse") throw new Error("unexpected sandbox create");
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.kill = () => true;
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: " + sandboxName + "\n"));
  });
  return child;
};

const { createSandbox } = require(${onboardPath});
const agent = agentDefs.loadAgent("langchain-deepagents-code");

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.test:19000";
  process.env.NEMOCLAW_DASHBOARD_PORT = "19000";
  const resultName = await createSandbox(null, "gpt-5.4", "nvidia-prod", null, sandboxName, null, null, null, agent);
  console.log(JSON.stringify({ resultName, commands, registerCalls, updateCalls }));
  clearInterval(keepAlive);
})().catch((error) => {
  clearInterval(keepAlive);
  console.error(error);
  process.exit(1);
});
`;
  fs.writeFileSync(scriptPath, script);

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: repoRoot,
    encoding: "utf-8",
    env: {
      ...process.env,
      HOME: tmpDir,
      PATH: `${fakeBin}:${process.env.PATH || ""}`,
      NEMOCLAW_NON_INTERACTIVE: "1",
      OPENSHELL_DRIVERS: scenario === "create" ? "vm" : "docker",
    },
    timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr);
  return parseStdoutJson<{
    resultName: string;
    commands: CommandEntry[];
    registerCalls: Array<{ dashboardPort?: number | null }>;
    updateCalls: Array<{ name: string; updates: { dashboardPort?: number | null } }>;
  }>(result.stdout);
}

describe("terminal-agent onboard dashboard handling", () => {
  it("does not inject dashboard env, probe, or forward during create", () => {
    const payload = runTerminalDashboardScenario("create");
    const createCommand = payload.commands.find((entry) =>
      entry.command.includes("sandbox create"),
    );

    assert.equal(payload.resultName, "deepagents-box");
    assert.ok(createCommand, "expected sandbox create command");
    assert.ok(!createCommand.command.includes("CHAT_UI_URL="), createCommand.command);
    assert.ok(!createCommand.command.includes("NEMOCLAW_DASHBOARD_PORT="), createCommand.command);
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("forward start")),
      "terminal agent without declared ports must not start dashboard forwards",
    );
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("/health")),
      "terminal agent without a dashboard must not run dashboard readiness probes",
    );
    assert.equal(payload.registerCalls[0]?.dashboardPort, 0);
  });

  it("does not restore dashboard forwarding while reusing a ready terminal sandbox", () => {
    const payload = runTerminalDashboardScenario("reuse");

    assert.equal(payload.resultName, "deepagents-box");
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("sandbox create")),
      "reuse should not create a new sandbox",
    );
    assert.ok(
      payload.commands.every((entry) => !entry.command.includes("forward start")),
      "terminal reuse must not restore dashboard forwarding",
    );
    assert.equal(
      payload.updateCalls.find((entry) => entry.name === "deepagents-box")?.updates.dashboardPort,
      0,
    );
  });
});
