// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { describe, it } from "vitest";

/** Parse JSON from a child process stdout, stripping any non-JSON prefix. */
function parseStdoutJson<T>(stdout: string): T {
  const line = stdout.trim().split("\n").pop();
  if (!line) {
    throw new Error("Expected JSON payload on the last stdout line");
  }
  return JSON.parse(line);
}

describe("ollama auth proxy recovery", () => {
  it("restarts the proxy from the persisted token when the recorded pid is stale", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-restart-"));
    const scriptPath = path.join(tmpDir, "restart-proxy-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
childProcess.spawn = (cmd, args, opts = {}) => {
  proxySpawns.push({
    cmd,
    args,
    detached: opts.detached,
    stdio: opts.stdio,
    env: {
      OLLAMA_PROXY_TOKEN: opts.env && opts.env.OLLAMA_PROXY_TOKEN,
      OLLAMA_PROXY_PORT: opts.env && opts.env.OLLAMA_PROXY_PORT,
      OLLAMA_BACKEND_PORT: opts.env && opts.env.OLLAMA_BACKEND_PORT,
    },
  });
  return { pid: 4242, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 99999")) return "";
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof -ti :11435")) return "";
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") return { status: 0, stdout: "200", stderr: "" };
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "99999\n", { mode: 0o600 });

const onboard = require(${onboardPath});
onboard.ensureOllamaAuthProxy();

console.log(JSON.stringify({
  proxySpawns,
  pid: fs.readFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "utf8").trim(),
}));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      proxySpawns: Array<{
        cmd: string;
        args: string[];
        detached: boolean;
        stdio: string;
        env: {
          OLLAMA_PROXY_TOKEN: string;
          OLLAMA_PROXY_PORT: string;
          OLLAMA_BACKEND_PORT: string;
        };
      }>;
      pid: string;
    }>(result.stdout);
    assert.equal(payload.proxySpawns.length, 1);
    assert.equal(payload.pid, "4242");
    assert.equal(payload.proxySpawns[0].cmd, process.execPath);
    assert.ok(payload.proxySpawns[0].args[0].endsWith("scripts/ollama-auth-proxy.js"));
    assert.equal(payload.proxySpawns[0].detached, true);
    assert.equal(payload.proxySpawns[0].stdio, "ignore");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_TOKEN, "persisted-token");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_PORT, "11435");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_BACKEND_PORT, "11434");
  });

  it("keeps the existing proxy when the recorded pid still points to the auth proxy", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-keep-"));
    const scriptPath = path.join(tmpDir, "keep-proxy-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
childProcess.spawn = (...args) => {
  proxySpawns.push(args);
  return { pid: 5000, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof -ti :11435")) return "";
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") return { status: 0, stdout: "200", stderr: "" };
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

const onboard = require(${onboardPath});
onboard.ensureOllamaAuthProxy();
console.log(JSON.stringify({ proxySpawns }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{ proxySpawns: object[] }>(result.stdout);
    assert.equal(payload.proxySpawns.length, 0);
  });

  it("keeps the existing proxy when the token is accepted but the backend is unavailable", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-backend-"));
    const scriptPath = path.join(tmpDir, "backend-down-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
childProcess.spawn = (...args) => {
  proxySpawns.push(args);
  return { pid: 5000, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof -ti :11435")) return "";
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") return { status: 0, stdout: "502", stderr: "" };
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

const onboard = require(${onboardPath});
onboard.ensureOllamaAuthProxy();
console.log(JSON.stringify({ proxySpawns }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{ proxySpawns: object[] }>(result.stdout);
    assert.equal(payload.proxySpawns.length, 0);
  });

  it("restarts the existing proxy when it rejects the persisted token", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-token-"));
    const scriptPath = path.join(tmpDir, "token-mismatch-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "dist", "lib", "runner.js"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
const runCommands = [];
childProcess.spawn = (cmd, args, opts = {}) => {
  proxySpawns.push({
    cmd,
    args,
    env: {
      OLLAMA_PROXY_TOKEN: opts.env && opts.env.OLLAMA_PROXY_TOKEN,
      OLLAMA_PROXY_PORT: opts.env && opts.env.OLLAMA_PROXY_PORT,
      OLLAMA_BACKEND_PORT: opts.env && opts.env.OLLAMA_BACKEND_PORT,
    },
  });
  return { pid: 5000, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("ps -p 5000")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof -ti :11435")) return "";
  return "";
};
runner.run = (command) => {
  runCommands.push(command);
  return { status: 0, stdout: "", stderr: "" };
};

let curlCalls = 0;
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") {
    curlCalls += 1;
    return { status: 0, stdout: curlCalls === 1 ? "401" : "200", stderr: "" };
  }
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

const onboard = require(${onboardPath});
onboard.ensureOllamaAuthProxy();
console.log(JSON.stringify({
  proxySpawns,
  runCommands,
  pid: fs.readFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "utf8").trim(),
}));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      proxySpawns: Array<{
        cmd: string;
        args: string[];
        env: {
          OLLAMA_PROXY_TOKEN: string;
          OLLAMA_PROXY_PORT: string;
          OLLAMA_BACKEND_PORT: string;
        };
      }>;
      runCommands: string[][];
      pid: string;
    }>(result.stdout);
    assert.equal(payload.proxySpawns.length, 1);
    assert.equal(payload.pid, "5000");
    assert.deepEqual(payload.runCommands[0], ["kill", "4242"]);
    assert.equal(payload.proxySpawns[0].cmd, process.execPath);
    assert.ok(payload.proxySpawns[0].args[0].endsWith("scripts/ollama-auth-proxy.js"));
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_TOKEN, "persisted-token");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_PORT, "11435");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_BACKEND_PORT, "11434");
  });
});
