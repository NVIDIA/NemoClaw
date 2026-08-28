// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
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

function runProxyRecoveryRefusal(options: {
  readonly backendKind: "ollama" | "compatible-endpoint" | null;
  readonly backendUrl: string;
  readonly descriptorSchemaVersion?: number;
  readonly descriptorUrl?: string;
}): { readonly status: number | null; readonly stderr: string } {
  const repoRoot = path.join(import.meta.dirname, "../../..");
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-refusal-"));
  const scriptPath = path.join(tmpDir, "recovery-refusal-check.js");
  const proxyPath = JSON.stringify(
    path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
  );
  const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
  const descriptorSetup = options.backendKind
    ? `fs.writeFileSync(path.join(stateDir, "ollama-backend.json"), ${JSON.stringify(
        JSON.stringify({
          schemaVersion: options.descriptorSchemaVersion ?? 1,
          kind: options.backendKind,
          url: options.descriptorUrl ?? options.backendUrl,
        }),
      )}, { mode: 0o600 });`
    : "";
  const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const runner = require(${runnerPath});

childProcess.spawn = (_cmd, _args, opts = {}) => {
  fs.writeFileSync(
    opts.env.NEMOCLAW_OLLAMA_PROXY_STATUS_FILE,
    JSON.stringify({ reason: "backend-not-loopback", details: "00000000:11434" }),
    { mode: 0o600 },
  );
  return { pid: 4242, unref() {} };
};
runner.runCapture = () => "";
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) =>
  args[0] === "sleep" ? { status: 0, stdout: "", stderr: "" } : originalSpawnSync(...args);

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "persisted-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-backend"), ${JSON.stringify(
    `${options.backendUrl}\n`,
  )}, { mode: 0o600 });
${descriptorSetup}

const proxy = require(${proxyPath});
proxy.ensureOllamaAuthProxy();
`;
  fs.writeFileSync(scriptPath, script);

  try {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, HOME: tmpDir };
    delete childEnv.NEMOCLAW_OLLAMA_PORT;
    delete childEnv.NEMOCLAW_OLLAMA_PROXY_PORT;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: childEnv,
    });
    return { status: result.status, stderr: result.stderr };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("ollama auth proxy recovery", () => {
  it.each([
    {
      name: "compatible endpoint on the Ollama port",
      backendKind: "compatible-endpoint" as const,
      backendUrl: "http://127.0.0.1:11434",
      expected: /The endpoint at 127\.0\.0\.1:11434/,
      unexpected: /OLLAMA_HOST=/,
    },
    {
      name: "managed Ollama daemon",
      backendKind: "ollama" as const,
      backendUrl: "http://127.0.0.1:11434",
      expected: /OLLAMA_HOST=127\.0\.0\.1:11434/,
      unexpected: /The (endpoint|inference backend) at/,
    },
    {
      name: "managed Ollama daemon on a persisted custom port",
      backendKind: "ollama" as const,
      backendUrl: "http://127.0.0.1:12345",
      expected: /OLLAMA_HOST=127\.0\.0\.1:12345/,
      unexpected: /OLLAMA_HOST=127\.0\.0\.1:11434/,
    },
    {
      name: "legacy state without a descriptor",
      backendKind: null,
      backendUrl: "http://127.0.0.1:11434",
      expected: /The inference backend at 127\.0\.0\.1:11434/,
      unexpected: /OLLAMA_HOST=/,
    },
  ])("renders the structured bind refusal for $name", ({ backendKind, backendUrl, expected, unexpected }) => {
    const result = runProxyRecoveryRefusal({
      backendKind,
      backendUrl,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, expected);
    assert.doesNotMatch(result.stderr, unexpected);
    assert.doesNotMatch(result.stderr, /did not become ready after restart/);
  });

  it("ignores a descriptor whose URL does not match the legacy route", () => {
    const result = runProxyRecoveryRefusal({
      backendKind: "compatible-endpoint",
      backendUrl: "http://127.0.0.1:11434",
      descriptorUrl: "http://127.0.0.1:8000",
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /The inference backend at 127\.0\.0\.1:11434/);
    assert.doesNotMatch(result.stderr, /OLLAMA_HOST=/);
  });

  it("ignores an unsupported descriptor schema", () => {
    const result = runProxyRecoveryRefusal({
      backendKind: "ollama",
      backendUrl: "http://127.0.0.1:11434",
      descriptorSchemaVersion: 2,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /The inference backend at 127\.0\.0\.1:11434/);
    assert.doesNotMatch(result.stderr, /OLLAMA_HOST=/);
  });

  it("restarts with the persisted token and compatible backend when the pid is stale (#7424)", () => {
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
      OLLAMA_BACKEND_URL: opts.env && opts.env.OLLAMA_BACKEND_URL,
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
fs.writeFileSync(path.join(stateDir, "ollama-backend"), "http://127.0.0.1:8000\n", { mode: 0o600 });
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
          OLLAMA_BACKEND_URL: string;
        };
      }>;
      pid: string;
    }>(result.stdout);
    assert.equal(payload.proxySpawns.length, 1);
    assert.equal(payload.pid, "4242");
    assert.equal(payload.proxySpawns[0].cmd, process.execPath);
    assert.ok(payload.proxySpawns[0].args.at(-1)?.endsWith("scripts/ollama-auth-proxy.mts"));
    assert.equal(payload.proxySpawns[0].detached, true);
    assert.equal(payload.proxySpawns[0].stdio, "ignore");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_TOKEN, "persisted-token");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_PORT, "11435");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_BACKEND_PORT, "11434");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_BACKEND_URL, "http://127.0.0.1:8000");
  });

  it("keeps the existing proxy when the recorded pid still points to the auth proxy", () => {
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
    assert.ok(payload.proxySpawns[0].args.at(-1)?.endsWith("scripts/ollama-auth-proxy.mts"));
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_TOKEN, "persisted-token");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_PROXY_PORT, "11435");
    assert.equal(payload.proxySpawns[0].env.OLLAMA_BACKEND_PORT, "11434");
  });

  it("keeps the committed token when switching from a compatible backend to Ollama (#7424)", () => {
    const repoRoot = path.join(import.meta.dirname, "../../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-switch-"));
    const scriptPath = path.join(tmpDir, "provider-switch-check.js");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );
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
    token: opts.env && opts.env.OLLAMA_PROXY_TOKEN,
    backendUrl: opts.env && opts.env.OLLAMA_BACKEND_URL,
  });
  return { pid: proxySpawns.length === 1 ? 5000 : 6000, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("ps -p 5000")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("ps -p 6000")) return "node /tmp/ollama-auth-proxy.js";
  if (text.includes("lsof") && text.includes("11435")) return "";
  return "";
};
runner.run = (command) => {
  runCommands.push(command);
  return { status: 0, stdout: "", stderr: "" };
};

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  if (args[0] === "nc") return { error: null, status: 0, stdout: "", stderr: "" };
  if (args[0] === "curl") {
    const argv = Array.isArray(args[1]) ? args[1] : [];
    return { status: 0, stdout: argv.includes("--config") ? "200" : "401", stderr: "" };
  }
  return origSpawnSync(...args);
};

const stateDir = path.join(process.env.HOME, ".nemoclaw");
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "compatible-token\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-backend"), "http://127.0.0.1:8000\n", { mode: 0o600 });
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "4242\n", { mode: 0o600 });

const proxy = require(${proxyPath});
const started = proxy.startOllamaAuthProxy();
proxy.ensureOllamaAuthProxy();
const runningToken = proxy.getOllamaProxyToken();
proxy.persistProxyToken(runningToken);

// Simulate a host restart after provider setup commits the selected route.
fs.writeFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "99999\n", { mode: 0o600 });
delete require.cache[require.resolve(${proxyPath})];
const recoveredProxy = require(${proxyPath});
recoveredProxy.ensureOllamaAuthProxy();

console.log(JSON.stringify({
  started,
  proxySpawns,
  runCommands,
  runningToken,
  persistedBackend: fs.readFileSync(path.join(stateDir, "ollama-backend"), "utf8").trim(),
  persistedDescriptor: JSON.parse(
    fs.readFileSync(path.join(stateDir, "ollama-backend.json"), "utf8"),
  ),
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
      started: boolean;
      proxySpawns: Array<{ token: string; backendUrl: string }>;
      runCommands: string[][];
      runningToken: string;
      persistedBackend: string;
      persistedDescriptor: { schemaVersion: number; kind: string; url: string };
    }>(result.stdout);
    assert.equal(payload.started, true);
    assert.equal(payload.proxySpawns.length, 2);
    assert.equal(payload.proxySpawns[0].backendUrl, "http://127.0.0.1:11434");
    assert.equal(payload.proxySpawns[0].token, payload.runningToken);
    assert.equal(payload.proxySpawns[1].backendUrl, "http://127.0.0.1:11434");
    assert.equal(payload.proxySpawns[1].token, payload.runningToken);
    assert.equal(payload.runningToken, "compatible-token");
    assert.deepEqual(payload.runCommands, [["kill", "4242"]]);
    assert.equal(payload.persistedBackend, "http://127.0.0.1:11434");
    assert.deepEqual(payload.persistedDescriptor, {
      schemaVersion: 1,
      kind: "ollama",
      url: "http://127.0.0.1:11434",
    });
  });

  it("persists compatible backend and token state for restart recovery (#7424)", () => {
    // The compatible no-auth flow persists both restart inputs after startup.
    // Assert that the backend round-trips and that the token file remains 0600
    // with contents matching the running proxy.
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
const prepared = proxy.noAuthProxy("http://127.0.0.1:8000/v1");
prepared.persist();
const running = proxy.getOllamaProxyToken();

const tokenPath = path.join(process.env.HOME, ".nemoclaw", "ollama-proxy-token");
const backendPath = path.join(process.env.HOME, ".nemoclaw", "ollama-backend");
const descriptorPath = path.join(process.env.HOME, ".nemoclaw", "ollama-backend.json");
const stat = fs.statSync(tokenPath);
console.log(JSON.stringify({
  prepared,
  backendDescriptor: JSON.parse(fs.readFileSync(descriptorPath, "utf8")),
  backendUrl: fs.readFileSync(backendPath, "utf8").trim(),
  descriptorMode: (fs.statSync(descriptorPath).mode & 0o777).toString(8),
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
      prepared: { baseUrl: string; credentialValue: string };
      backendDescriptor: { schemaVersion: number; kind: string; url: string };
      backendUrl: string;
      descriptorMode: string;
      mode: string;
      fileToken: string;
      runningToken: string;
    }>(result.stdout);
    assert.equal(payload.prepared.baseUrl, "http://host.openshell.internal:11435/v1");
    assert.equal(payload.prepared.credentialValue, payload.runningToken);
    assert.equal(payload.backendUrl, "http://127.0.0.1:8000");
    assert.deepEqual(payload.backendDescriptor, {
      schemaVersion: 1,
      kind: "compatible-endpoint",
      url: "http://127.0.0.1:8000",
    });
    assert.equal(payload.descriptorMode, "600");
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
    const repoRoot = path.join(import.meta.dirname, "../../..");
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
    const repoRoot = path.join(import.meta.dirname, "../../..");
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

describe("ollama auth proxy state across gateway ports", () => {
  function runSecondGatewayProxyStart(options: {
    readonly callingGatewayPort?: number;
    readonly gatewayScopedBackend?: string;
    readonly gatewayScopedBackendKind?: "ollama" | "compatible-endpoint";
    readonly gatewayScopedPort?: number;
    readonly otherGatewayScopedToken?: string;
    readonly prefix: string;
    readonly proxyPort?: number;
    readonly sharedProxyPort?: number;
    readonly recover?: boolean;
    readonly sharedBackend?: string;
    readonly sharedBackendKind?: "ollama" | "compatible-endpoint";
    readonly sharedPid?: number;
    readonly sharedToken?: string;
    readonly gatewayScopedToken?: string;
  }): {
    readonly spawnedBackends: Array<string | null>;
    readonly spawnedProxyPorts: string[];
    readonly spawnedTokens: string[];
    readonly activeToken: string | null;
    readonly sharedBackend: string | null;
    readonly sharedBackendDescriptor: string | null;
    readonly sharedPid: string | null;
    readonly sharedProxyPort: string | null;
    readonly sharedToken: string | null;
    readonly gatewayScopedBackend: string | null;
    readonly gatewayScopedBackendDescriptor: string | null;
    readonly gatewayScopedToken: string | null;
    readonly operationError: string | null;
    readonly routeUrl: string | null;
  } {
    const repoRoot = path.join(import.meta.dirname, "../../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix));
    const scriptPath = path.join(tmpDir, "second-gateway-check.js");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));
    const localPath = JSON.stringify(path.join(repoRoot, "src", "lib", "inference", "local.ts"));

    const sharedDir = path.join(tmpDir, ".nemoclaw");
    const gatewayScopedPort = options.gatewayScopedPort ?? 8990;
    const gatewayScopedDir = path.join(sharedDir, "gateways", String(gatewayScopedPort));
    const otherGatewayDir = path.join(sharedDir, "gateways", "8991");
    fs.mkdirSync(gatewayScopedDir, { recursive: true });
    fs.mkdirSync(otherGatewayDir, { recursive: true });

    const optionalStateFiles: ReadonlyArray<readonly [string, string | undefined]> = [
      [path.join(sharedDir, "ollama-proxy-token"), options.sharedToken],
      [path.join(sharedDir, "ollama-backend"), options.sharedBackend],
      [
        path.join(sharedDir, "ollama-backend.json"),
        options.sharedBackend && options.sharedBackendKind
          ? JSON.stringify({
              schemaVersion: 1,
              kind: options.sharedBackendKind,
              url: options.sharedBackend,
            })
          : undefined,
      ],
      [
        path.join(sharedDir, "ollama-proxy-port"),
        options.sharedProxyPort === undefined ? undefined : String(options.sharedProxyPort),
      ],
      [
        path.join(sharedDir, "ollama-auth-proxy.pid"),
        options.sharedPid === undefined ? undefined : String(options.sharedPid),
      ],
      [path.join(gatewayScopedDir, "ollama-proxy-token"), options.gatewayScopedToken],
      [path.join(gatewayScopedDir, "ollama-backend"), options.gatewayScopedBackend],
      [
        path.join(gatewayScopedDir, "ollama-backend.json"),
        options.gatewayScopedBackend && options.gatewayScopedBackendKind
          ? JSON.stringify({
              schemaVersion: 1,
              kind: options.gatewayScopedBackendKind,
              url: options.gatewayScopedBackend,
            })
          : undefined,
      ],
      [path.join(otherGatewayDir, "ollama-proxy-token"), options.otherGatewayScopedToken],
    ];
    const presentStateFiles = optionalStateFiles.filter(
      (entry): entry is readonly [string, string] => entry[1] !== undefined,
    );
    for (const [file, value] of presentStateFiles) {
      fs.writeFileSync(file, `${value}\n`, { mode: 0o600 });
    }

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});
const wait = require(${waitPath});

wait.waitForPort = () => true;

const spawnedTokens = [];
const spawnedBackends = [];
const spawnedProxyPorts = [];
childProcess.spawn = (_cmd, _args, opts = {}) => {
  spawnedTokens.push(opts.env && opts.env.OLLAMA_PROXY_TOKEN);
  spawnedBackends.push((opts.env && opts.env.OLLAMA_BACKEND_URL) || null);
  spawnedProxyPorts.push(opts.env && opts.env.OLLAMA_PROXY_PORT);
  return { pid: 4242, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242")) return "node /tmp/ollama-auth-proxy.js";
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const origSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") {
    const curlArgs = Array.isArray(args[1]) ? args[1] : [];
    return { status: 0, stdout: curlArgs.includes("--config") ? "200" : "401", stderr: "" };
  }
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  return origSpawnSync(...args);
};

const proxy = require(${proxyPath});
const local = require(${localPath});
let operationError = null;
try {
  if (${JSON.stringify(options.recover === true)}) proxy.ensureOllamaAuthProxy();
  else proxy.startOllamaAuthProxy();
} catch (error) {
  operationError = error instanceof Error ? error.message : String(error);
}

const readToken = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : null);
const sharedDir = path.join(process.env.HOME, ".nemoclaw");
console.log(JSON.stringify({
  spawnedBackends,
  spawnedProxyPorts,
  spawnedTokens,
  activeToken: operationError ? null : proxy.getOllamaProxyToken(),
  sharedBackend: readToken(path.join(sharedDir, "ollama-backend")),
  sharedBackendDescriptor: readToken(path.join(sharedDir, "ollama-backend.json")),
  sharedPid: readToken(path.join(sharedDir, "ollama-auth-proxy.pid")),
  sharedProxyPort: readToken(path.join(sharedDir, "ollama-proxy-port")),
  sharedToken: readToken(path.join(sharedDir, "ollama-proxy-token")),
  gatewayScopedBackend: readToken(
    path.join(sharedDir, "gateways", ${JSON.stringify(String(options.gatewayScopedPort ?? 8990))}, "ollama-backend"),
  ),
  gatewayScopedBackendDescriptor: readToken(
    path.join(sharedDir, "gateways", ${JSON.stringify(String(options.gatewayScopedPort ?? 8990))}, "ollama-backend.json"),
  ),
  gatewayScopedToken: readToken(
    path.join(sharedDir, "gateways", ${JSON.stringify(String(options.gatewayScopedPort ?? 8990))}, "ollama-proxy-token"),
  ),
  operationError,
  routeUrl: local.getLocalProviderBaseUrl("ollama-local"),
}));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        NEMOCLAW_GATEWAY_PORT: String(options.callingGatewayPort ?? 8990),
        NEMOCLAW_OLLAMA_PROXY_PORT: String(options.proxyPort ?? 11435),
      },
    });

    try {
      assert.equal(result.status, 0, result.stderr);
      return parseStdoutJson(result.stdout);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }

  it("reuses the persisted host token when onboarding a second gateway port (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      prefix: "nemoclaw-ollama-proxy-second-gateway-",
      sharedToken: "first-gateway-token",
    });

    assert.deepEqual(payload.spawnedTokens, ["first-gateway-token"]);
    assert.equal(payload.activeToken, "first-gateway-token");
    assert.equal(payload.sharedToken, "first-gateway-token");
    assert.equal(payload.gatewayScopedToken, null);
  });

  it.each([
    8990, 9000,
  ])("keeps the configured proxy port host-wide for gateway %i (#8704)", (callingGatewayPort) => {
    const payload = runSecondGatewayProxyStart({
      callingGatewayPort,
      prefix: `nemoclaw-ollama-proxy-port-${String(callingGatewayPort)}-`,
      proxyPort: 12000,
      sharedToken: "shared-token",
    });

    assert.deepEqual(payload.spawnedProxyPorts, ["12000"]);
    assert.equal(payload.sharedProxyPort, "12000");
    assert.equal(payload.routeUrl, "http://host.openshell.internal:12000/v1");
  });

  it("rejects a second gateway proxy port before changing shared proxy state (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      callingGatewayPort: 9000,
      prefix: "nemoclaw-ollama-proxy-port-conflict-",
      proxyPort: 12000,
      sharedPid: 4241,
      sharedProxyPort: 11435,
      sharedToken: "first-gateway-token",
    });

    assert.deepEqual(payload.spawnedProxyPorts, []);
    assert.deepEqual(payload.spawnedTokens, []);
    assert.equal(payload.sharedProxyPort, "11435");
    assert.equal(payload.sharedPid, "4241");
    assert.equal(payload.sharedToken, "first-gateway-token");
    assert.match(payload.operationError || "", /already uses port 11435/);
  });

  it("adopts a token an earlier gateway-scoped run left behind (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      callingGatewayPort: 9000,
      gatewayScopedPort: 8990,
      prefix: "nemoclaw-ollama-proxy-adopt-scoped-",
      gatewayScopedToken: "scoped-token",
    });

    assert.deepEqual(payload.spawnedTokens, ["scoped-token"]);
    assert.equal(payload.sharedToken, "scoped-token");
  });

  it("adopts a gateway-scoped backend with its token during recovery (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      callingGatewayPort: 9000,
      gatewayScopedBackend: "http://127.0.0.1:12345",
      gatewayScopedBackendKind: "compatible-endpoint",
      gatewayScopedPort: 8990,
      prefix: "nemoclaw-ollama-proxy-adopt-backend-",
      gatewayScopedToken: "scoped-token",
      recover: true,
    });

    assert.deepEqual(payload.spawnedTokens, ["scoped-token"]);
    assert.deepEqual(payload.spawnedBackends, ["http://127.0.0.1:12345"]);
    assert.equal(payload.sharedToken, "scoped-token");
    assert.equal(payload.sharedBackend, "http://127.0.0.1:12345");
    assert.equal(payload.gatewayScopedBackend, "http://127.0.0.1:12345");
    assert.deepEqual(JSON.parse(payload.sharedBackendDescriptor || "null"), {
      schemaVersion: 1,
      kind: "compatible-endpoint",
      url: "http://127.0.0.1:12345",
    });
  });

  it("keeps the shared backend when adopting a gateway-scoped token without one (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      callingGatewayPort: 9000,
      gatewayScopedPort: 8990,
      gatewayScopedToken: "scoped-token",
      prefix: "nemoclaw-ollama-proxy-adopt-mixed-backend-",
      recover: true,
      sharedBackend: "http://127.0.0.1:12345",
      sharedBackendKind: "ollama",
    });

    assert.deepEqual(payload.spawnedTokens, ["scoped-token"]);
    assert.deepEqual(payload.spawnedBackends, ["http://127.0.0.1:12345"]);
    assert.equal(payload.sharedToken, "scoped-token");
    assert.equal(payload.sharedBackend, "http://127.0.0.1:12345");
    assert.equal(payload.gatewayScopedBackend, null);
    assert.deepEqual(JSON.parse(payload.sharedBackendDescriptor || "null"), {
      schemaVersion: 1,
      kind: "ollama",
      url: "http://127.0.0.1:12345",
    });
  });

  it("mints a token when no gateway on the host has one (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      prefix: "nemoclaw-ollama-proxy-first-run-",
    });

    assert.equal(payload.spawnedTokens.length, 1);
    assert.match(payload.spawnedTokens[0], /^[0-9a-f]{48}$/);
    assert.equal(payload.activeToken, payload.spawnedTokens[0]);
  });

  it("fails safely when dormant gateway roots contain conflicting tokens (#8704)", () => {
    const payload = runSecondGatewayProxyStart({
      callingGatewayPort: 9000,
      gatewayScopedPort: 8990,
      gatewayScopedToken: "first-token",
      otherGatewayScopedToken: "second-token",
      prefix: "nemoclaw-ollama-proxy-conflicting-scoped-",
    });

    assert.deepEqual(payload.spawnedTokens, []);
    assert.equal(payload.sharedToken, null);
    assert.match(payload.operationError || "", /Conflicting legacy Ollama proxy tokens/);
    assert.match(payload.operationError || "", /gateways\/8990\/ollama-proxy-token/);
    assert.match(payload.operationError || "", /gateways\/8991\/ollama-proxy-token/);
    assert.match(payload.operationError || "", /reconcile or remove the stale files/);
  });

  it("serializes startup, compatible-endpoint commit, and recovery (#8704)", {
    timeout: 15_000,
  }, async () => {
    const repoRoot = path.join(import.meta.dirname, "../../..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-ollama-proxy-lock-"));
    const stateDir = path.join(tmpDir, ".nemoclaw");
    const scriptPath = path.join(tmpDir, "concurrent-proxy-check.js");
    const enteredPath = path.join(tmpDir, "startup-entered");
    const activeTokenPath = path.join(tmpDir, "active-token");
    const spawnLogPath = path.join(tmpDir, "proxy-spawns.log");
    const proxyPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "inference", "ollama", "proxy.ts"),
    );
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const waitPath = JSON.stringify(path.join(repoRoot, "src", "lib", "core", "wait.ts"));

    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "ollama-backend"), "http://127.0.0.1:11434\n", {
      mode: 0o600,
    });

    const script = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("child_process");
const runner = require(${runnerPath});
const wait = require(${waitPath});
const mode = process.argv[2];
const enteredPath = ${JSON.stringify(enteredPath)};
const activeTokenPath = ${JSON.stringify(activeTokenPath)};
const spawnLogPath = ${JSON.stringify(spawnLogPath)};
const pause = new Int32Array(new SharedArrayBuffer(4));

wait.waitForPort = () => true;
childProcess.spawn = (_cmd, _args, opts = {}) => {
  const token = opts.env && opts.env.OLLAMA_PROXY_TOKEN;
  fs.appendFileSync(spawnLogPath, mode + ":" + token + "\n");
  fs.writeFileSync(activeTokenPath, token + "\n");
  if (mode === "start") {
    fs.writeFileSync(enteredPath, "entered\n");
    Atomics.wait(pause, 0, 0, 500);
  }
  return { pid: 4242, unref() {} };
};
runner.runCapture = (command) => {
  const text = Array.isArray(command) ? command.join(" ") : command;
  if (text.includes("ps -p 4242") && fs.existsSync(activeTokenPath)) {
    return "node /tmp/ollama-auth-proxy.js";
  }
  return "";
};
runner.run = () => ({ status: 0, stdout: "", stderr: "" });

const originalSpawnSync = childProcess.spawnSync;
childProcess.spawnSync = (...args) => {
  if (args[0] === "curl") {
    const input = String((args[2] && args[2].input) || "");
    const active = fs.existsSync(activeTokenPath)
      ? fs.readFileSync(activeTokenPath, "utf8").trim()
      : "";
    return {
      status: 0,
      stdout: input.includes("Bearer " + active) && active ? "200" : "401",
      stderr: "",
    };
  }
  if (args[0] === "sleep") return { status: 0, stdout: "", stderr: "" };
  return originalSpawnSync(...args);
};

const proxy = require(${proxyPath});
const execute = async () => {
  if (mode === "start" || mode === "start-peer") {
    if (!proxy.startOllamaAuthProxy()) process.exitCode = 1;
  } else if (mode === "transaction") {
    await proxy.withOllamaProxyLifecycleTransaction(async () => {
      const prepared = proxy.noAuthProxy("http://127.0.0.1:8000/v1");
      fs.writeFileSync(enteredPath, "entered\n");
      await new Promise((resolve) => setTimeout(resolve, 500));
      prepared.persist();
    });
  } else {
    proxy.ensureOllamaAuthProxy();
  }
};
execute().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;
    fs.writeFileSync(scriptPath, script);

    const runChild = (mode: "start" | "start-peer" | "transaction" | "ensure") =>
      new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [scriptPath, mode], {
          cwd: repoRoot,
          env: { ...process.env, HOME: tmpDir },
        });
        let stdout = "";
        let stderr = "";
        child.stdout?.on("data", (chunk) => {
          stdout += String(chunk);
        });
        child.stderr?.on("data", (chunk) => {
          stderr += String(chunk);
        });
        child.on("error", reject);
        child.on("close", (code) => {
          code === 0
            ? resolve({ stderr, stdout })
            : reject(new Error(`${mode} child exited ${String(code)}: ${stderr || stdout}`));
        });
      });

    const waitForStartupEntry = async (): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (!fs.existsSync(enteredPath)) {
        assert.ok(Date.now() < deadline, "startup child did not enter proxy spawn");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };

    try {
      const startup = runChild("start");
      await waitForStartupEntry();
      const peerStartup = runChild("start-peer");
      const recovery = runChild("ensure");
      await Promise.all([startup, peerStartup, recovery]);

      const spawnRecords = fs.readFileSync(spawnLogPath, "utf8").trim().split("\n");
      const spawnedTokens = spawnRecords.map((record) => record.split(":")[1]);
      // start launches once, start-peer restarts with that token, and ensure
      // observes the accepted live proxy without spawning a third process.
      assert.equal(spawnRecords[0]?.split(":")[0], "start");
      assert.equal(spawnRecords.length, 2);
      assert.match(spawnedTokens[0] || "", /^[0-9a-f]{48}$/);
      assert.equal(spawnedTokens[1], spawnedTokens[0]);
      assert.equal(
        fs.readFileSync(path.join(stateDir, "ollama-proxy-token"), "utf8").trim(),
        spawnedTokens[0],
      );
      assert.equal(
        fs.readFileSync(path.join(stateDir, "ollama-auth-proxy.pid"), "utf8").trim(),
        "4242",
      );
      assert.equal(fs.readFileSync(activeTokenPath, "utf8").trim(), spawnedTokens[0]);

      fs.rmSync(enteredPath, { force: true });
      fs.writeFileSync(path.join(stateDir, "ollama-proxy-token"), "old-token\n", { mode: 0o600 });
      fs.writeFileSync(path.join(stateDir, "ollama-backend"), "http://127.0.0.1:11434\n", {
        mode: 0o600,
      });
      fs.writeFileSync(spawnLogPath, "");

      const transaction = runChild("transaction");
      await waitForStartupEntry();
      const concurrentRecovery = runChild("ensure");
      await Promise.all([transaction, concurrentRecovery]);

      const transactionSpawns = fs.readFileSync(spawnLogPath, "utf8").trim().split("\n");
      const committedToken = fs
        .readFileSync(path.join(stateDir, "ollama-proxy-token"), "utf8")
        .trim();
      assert.equal(transactionSpawns.length, 1);
      assert.equal(transactionSpawns[0]?.split(":")[0], "transaction");
      assert.match(committedToken, /^[0-9a-f]{48}$/);
      assert.equal(fs.readFileSync(activeTokenPath, "utf8").trim(), committedToken);
      assert.equal(
        fs.readFileSync(path.join(stateDir, "ollama-backend"), "utf8").trim(),
        "http://127.0.0.1:8000",
      );
      assert.deepEqual(
        JSON.parse(fs.readFileSync(path.join(stateDir, "ollama-backend.json"), "utf8")),
        {
          schemaVersion: 1,
          kind: "compatible-endpoint",
          url: "http://127.0.0.1:8000",
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
