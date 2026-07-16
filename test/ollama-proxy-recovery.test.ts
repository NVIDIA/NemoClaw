// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

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
    assert.ok(payload.proxySpawns[0].args[0].endsWith("scripts/ollama-auth-proxy.mts"));
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
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

const proxySpawns = [];
let curlEnv = null;
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
  if (args[0] === "curl") {
    curlEnv = args[2] && args[2].env;
    return { status: 0, stdout: "200", stderr: "" };
  }
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

const onboard = require(${onboardPath});
onboard.ensureOllamaAuthProxy();
console.log(JSON.stringify({ proxySpawns, curlEnv }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HTTP_PROXY: "http://proxy.invalid:8888",
        HOME: tmpDir,
        NVIDIA_INFERENCE_API_KEY: "must-not-leak",
        NO_PROXY: "",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      curlEnv: Record<string, string>;
      proxySpawns: object[];
    }>(result.stdout);
    assert.equal(payload.proxySpawns.length, 0);
    assert.equal(payload.curlEnv.NVIDIA_INFERENCE_API_KEY, undefined);
    assert.equal(payload.curlEnv.HTTP_PROXY, "http://proxy.invalid:8888");
    assert.match(payload.curlEnv.NO_PROXY, /(^|,)127\.0\.0\.1(,|$)/);
    assert.match(payload.curlEnv.NO_PROXY, /(^|,)localhost(,|$)/);
  });

  it("keeps the existing proxy when the token is accepted but the backend is unavailable", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-backend-"));
    const scriptPath = path.join(tmpDir, "backend-down-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

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

  it("reports reachable non-2xx proxy health responses distinctly", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-404-"));
    const scriptPath = path.join(tmpDir, "proxy-health-404-check.js");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") return { status: 0, stdout: "404", stderr: "" };
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });

const proxy = require(${proxyPath});
console.log(JSON.stringify(proxy.probeOllamaAuthProxyHealth()));
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
    const payload = parseStdoutJson<{ detail: string; ok: boolean }>(result.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.detail, /reachable/);
    assert.match(payload.detail, /HTTP 404/);
    assert.doesNotMatch(payload.detail, /not reachable/);
  });

  it("restarts the existing proxy when it rejects the persisted token", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-token-"));
    const scriptPath = path.join(tmpDir, "token-mismatch-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

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
    assert.ok(payload.proxySpawns[0].args[0].endsWith("scripts/ollama-auth-proxy.mts"));
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_TOKEN, "persisted-token");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_PORT, "11435");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_BACKEND_PORT, "11434");
  });

  it("persists the proxy token at mode 0600 matching the running token (#2553)", () => {
    // startOllamaAuthProxy() mints an in-memory token; persistProxyToken() is
    // the seam that writes it to disk. Assert the on-disk file (a) exists at
    // mode 0600 and (b) matches the token the runner reports as current — the
    // token-file invariant otherwise only exercised by the live E2E (phase 7).
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-persist-"));
    const scriptPath = path.join(tmpDir, "persist-token-check.js");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

childProcess.spawn = () => ({ pid: 7777, unref() {} });
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("lsof") && text.includes("11435")) return "";
  if (text.includes("ps -p 7777")) return "node /repo/scripts/ollama-auth-proxy.js";
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") return { error: null, status: 0, stdout: "", stderr: "" };
  if (args[0] === "curl") {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    // authed probe → 200 (accepted); unauth probe → 401 (rejected).
    return { status: 0, stdout: argv.includes("--config") ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};

const proxy = require(${proxyPath});
const started = proxy.startOllamaAuthProxy();
// startOllamaAuthProxy intentionally holds the token in memory only; the
// onboarding flow persists it once the provider is confirmed. Exercise that seam.
const running = proxy.getOllamaProxyToken();
proxy.persistProxyToken(running);

const tokenPath = path.join(process.env.HOME, ".nemoclaw", "ollama-proxy-token");
const stat = fs.statSync(tokenPath);
console.log(JSON.stringify({
  started,
  mode: (stat.mode & 0o777).toString(8),
  fileToken: fs.readFileSync(tokenPath, "utf8").trim(),
  runningToken: running,
}));
`;
    fs.writeFileSync(scriptPath, script);

    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: tmpDir };
    delete childEnv.NEMOCLAW_OLLAMA_PROXY_PORT;
    delete childEnv.NEMOCLAW_OLLAMA_PORT;

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: childEnv,
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      started: boolean;
      mode: string;
      fileToken: string;
      runningToken: string;
    }>(result.stdout);
    assert.equal(payload.started, true);
    // Token file is 0600 and its contents match the running token.
    assert.equal(payload.mode, "600");
    assert.ok(payload.fileToken.length > 0, "expected a non-empty persisted token");
    assert.equal(payload.fileToken, payload.runningToken);
  });

  it("restart preserves a 0600 token file whose contents match the respawned token (#2553)", () => {
    // A stale recorded pid forces a restart. Beyond spawning with the persisted
    // token (covered above), assert the lifecycle invariant: the token file
    // survives the restart at mode 0600 and the respawned proxy is launched with
    // exactly that file token — the persisted token round-trips into the child.
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-restart-mode-"));
    const scriptPath = path.join(tmpDir, "restart-mode-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

let spawnedToken = null;
childProcess.spawn = (cmd, args, opts = {}) => {
  spawnedToken = opts.env && opts.env.OLLAMA_PROXY_TOKEN;
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
const tokenPath = path.join(stateDir, "ollama-proxy-token");
fs.writeFileSync(tokenPath, "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "99999\n", { mode: 0o600 });

const onboard = require(${onboardPath});
onboard.ensureOllamaAuthProxy();

const stat = fs.statSync(tokenPath);
console.log(JSON.stringify({
  spawnedToken,
  mode: (stat.mode & 0o777).toString(8),
  fileToken: fs.readFileSync(tokenPath, "utf8").trim(),
}));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{ spawnedToken: string; mode: string; fileToken: string }>(
      result.stdout,
    );
    // Restart reuses the persisted token; the file is untouched at 0600.
    assert.equal(payload.mode, "600");
    assert.equal(payload.fileToken, "persisted-token");
    assert.equal(payload.spawnedToken, "persisted-token");
  });

  it("repairs a divergent on-disk token by restarting with the file token (#2553)", () => {
    // Divergence: the running proxy holds a token that no longer matches the
    // authoritative on-disk token (e.g. after a failed re-onboard rewrote the
    // file). The file token probe returns 401, so ensureOllamaAuthProxy detects
    // the divergence, reclaims the stale proxy, and restarts it with the FILE
    // token — the on-disk value is authoritative, not whatever was running.
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-divergent-"));
    const scriptPath = path.join(tmpDir, "divergent-token-check.js");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});

let spawnedToken = null;
const runCommands = [];
childProcess.spawn = (cmd, args, opts = {}) => {
  spawnedToken = opts.env && opts.env.OLLAMA_PROXY_TOKEN;
  return { pid: 5000, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("ps -p 5000")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof -ti :11435")) return "";
  return "";
};
runner.run = (command) => { runCommands.push(command); return { status: 0, stdout: "", stderr: "" }; };

let curlCalls = 0;
const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") {
    curlCalls += 1;
    // The running proxy holds a DIFFERENT token: first probe (file token) → 401
    // (divergence), post-restart probe → 200 (repaired).
    return { status: 0, stdout: curlCalls === 1 ? "401" : "200", stderr: "" };
  }
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
const tokenPath = path.join(stateDir, "ollama-proxy-token");
// The authoritative on-disk token, divergent from whatever ran before.
fs.writeFileSync(tokenPath, "new-file-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

const proxy = require(${proxyPath});
proxy.ensureOllamaAuthProxy();

const stat = fs.statSync(tokenPath);
console.log(JSON.stringify({
  spawnedToken,
  runCommands,
  mode: (stat.mode & 0o777).toString(8),
  fileToken: fs.readFileSync(tokenPath, "utf8").trim(),
}));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      spawnedToken: string;
      runCommands: string[][];
      mode: string;
      fileToken: string;
    }>(result.stdout);
    // The stale proxy is reclaimed and the repair restart uses the FILE token.
    assert.deepEqual(payload.runCommands[0], ["kill", "4242"]);
    assert.equal(payload.spawnedToken, "new-file-token");
    // The authoritative token file is preserved at 0600.
    assert.equal(payload.mode, "600");
    assert.equal(payload.fileToken, "new-file-token");
  });
});
