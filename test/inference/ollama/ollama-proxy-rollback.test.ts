// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";

describe("ollama auth proxy rollback", () => {
  it("restores committed state after an abandoned or failed replacement (#7424)", () => {
    const repoRoot = path.join(import.meta.dirname, "../../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-rollback-"));
    const scriptPath = path.join(tmpDir, "rollback-check.js");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
const runCommands = [];
childProcess.spawn = (_cmd, _args, options = {}) => {
  const pid = [5000, 6000, 7000, 8000][proxySpawns.length];
  proxySpawns.push({
    pid,
    token: options.env && options.env.OLLAMA_PROXY_TOKEN,
    backendUrl: options.env && options.env.OLLAMA_BACKEND_URL,
  });
  return { pid, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (/ps -p (4000|5000|6000|8000)/.test(text)) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof") && text.includes("11435")) return "";
  return "";
};
runner.run = (command) => {
  runCommands.push(command);
  return { status: 0, stdout: "", stderr: "" };
};

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") return { error: null, status: 0, stdout: "", stderr: "" };
  if (args[0] === "curl") {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    return { status: 0, stdout: argv.includes("--config") ? "200" : "401", stderr: "" };
  }
  return originalSpawnSync(...args);
};
require("node:module").syncBuiltinESMExports();

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "committed-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-backend"), "http://127.0.0.1:7000\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4000\n", { mode: 0o600 });

const proxy = require(${proxyPath});
const prepared = proxy.noAuthProxy("http://127.0.0.1:8000/v1");
prepared.restore();
let startupError = "";
try {
  proxy.noAuthProxy("http://127.0.0.1:9000/v1");
} catch (error) {
  startupError = error.message;
}

console.log(JSON.stringify({
  proxySpawns,
  runCommands,
  startupError,
  runningToken: proxy.getOllamaProxyToken(),
  persistedToken: fs.readFileSync(path.join(stateDir, "ollama-proxy-token"), "utf8").trim(),
  persistedBackend: fs.readFileSync(path.join(stateDir, "ollama-backend"), "utf8").trim(),
}));
`;
    fs.writeFileSync(scriptPath, script);

    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: tmpDir };
    delete childEnv.NEMOCLAW_OLLAMA_PROXY_PORT;
    delete childEnv.NEMOCLAW_OLLAMA_PORT;

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf8",
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop() ?? "{}");
    assert.equal(payload.proxySpawns.length, 4);
    assert.notEqual(payload.proxySpawns[0].token, "committed-token");
    assert.equal(payload.proxySpawns[0].backendUrl, "http://127.0.0.1:8000");
    assert.equal(payload.proxySpawns[1].token, "committed-token");
    assert.equal(payload.proxySpawns[1].backendUrl, "http://127.0.0.1:7000");
    assert.notEqual(payload.proxySpawns[2].token, "committed-token");
    assert.equal(payload.proxySpawns[2].backendUrl, "http://127.0.0.1:9000");
    assert.equal(payload.proxySpawns[3].token, "committed-token");
    assert.equal(payload.proxySpawns[3].backendUrl, "http://127.0.0.1:7000");
    assert.deepEqual(payload.runCommands, [
      ["kill", "4000"],
      ["kill", "5000"],
      ["kill", "6000"],
    ]);
    assert.equal(payload.startupError, "Could not start the protected loopback route.");
    assert.equal(payload.runningToken, "committed-token");
    assert.equal(payload.persistedToken, "committed-token");
    assert.equal(payload.persistedBackend, "http://127.0.0.1:7000");
  });
});
