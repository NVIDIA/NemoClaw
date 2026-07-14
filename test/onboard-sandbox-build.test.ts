// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, it } from "vitest";
import { writeOkOpenshell } from "./helpers/onboard-openshell-fixture";
import {
  type CommandEntry,
  onboardScriptMocksPath,
  parseStdoutJson,
  stripMessagingEnv,
} from "./helpers/onboard-split-context";

describe("onboard helpers", () => {
  it("drops stale local sandbox registry entries when the live sandbox is gone", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "stale-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const registry = require(${registryPath});
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
runner.runCapture = (command) => (_n(command).includes("sandbox get my-assistant") ? "" : "");

registry.registerSandbox({ name: "my-assistant" });

const { pruneStaleSandboxEntry } = require(${onboardPath});

const liveExists = pruneStaleSandboxEntry("my-assistant");
console.log(JSON.stringify({ liveExists, sandbox: registry.getSandbox("my-assistant") }));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...process.env,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.liveExists, false);
    assert.equal(payload.sandbox, null);
  });

  it("builds the sandbox without uploading an external OpenClaw config file", {
    timeout: 90_000,
  }, async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const preflightPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
const registerCalls = [];
const updateCalls = [];
const defaultCalls = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = (entry) => {
  registerCalls.push(entry);
  return true;
};
registry.updateSandbox = (name, updates) => {
  updateCalls.push({ name, updates });
  return true;
};
registry.setDefault = (name) => {
  defaultCalls.push(name);
  return true;
};
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands, registerCalls, updateCalls, defaultCalls }));
})().catch((error) => {
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    assert.equal(payload.sandboxName, "my-assistant");
    // createSandbox no longer marks the sandbox default — that is deferred to the
    // finalization step so a cancel at policy presets can't leave an unconfigured
    // sandbox as default (#4614).
    assert.deepEqual(payload.defaultCalls, []);
    assert.ok(
      payload.registerCalls.some(
        (entry: Record<string, unknown>) =>
          entry.name === "my-assistant" &&
          entry.model === "gpt-5.4" &&
          Object.prototype.hasOwnProperty.call(entry, "agentVersion"),
      ),
      "expected registry metadata for created sandbox",
    );
    assert.ok(
      payload.updateCalls.every(
        (call: { name: string; updates: Record<string, unknown> }) =>
          call.name === "my-assistant" && call.updates,
      ),
      "expected any registry metadata updates to target the created sandbox",
    );
    const createCommand = payload.commands.find((entry: CommandEntry) =>
      entry.command.includes("sandbox create"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    assert.match(createCommand.command, /nemoclaw-start/);
    assert.doesNotMatch(createCommand.command, /--upload/);
    assert.doesNotMatch(createCommand.command, /OPENCLAW_CONFIG_PATH/);
    assert.doesNotMatch(createCommand.command, /NVIDIA_INFERENCE_API_KEY=/);
    assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
    assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
    assert.ok(
      payload.commands.some(
        (entry: CommandEntry) =>
          entry.command.includes("forward start --background 18789 my-assistant") ||
          entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
      ),
      "expected dashboard forward (loopback or WSL 0.0.0.0)",
    );
  });

  it("skips OpenClaw sandbox-base resolution for agent-staged Dockerfiles", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-base-skip-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "agent-base-skip.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const preflightPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const agentOnboardPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "agent", "onboard.ts"),
    );
    const sandboxBaseImagePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "sandbox-base-image.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const agentOnboard = require(${agentOnboardPath});
const sandboxBaseImage = require(${sandboxBaseImagePath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");
require(${JSON.stringify(path.join(repoRoot, "src", "lib", "onboard", "docker-driver-platform.ts"))}).isLinuxDockerDriverGatewayEnabled = () => false;
const commands = [];
const logs = [];
const warnings = [];
const baseResolutionCalls = [];
const originalLog = console.log;
const originalWarn = console.warn;
console.log = (...args) => {
  logs.push(args.join(" "));
  originalLog(...args);
};
console.warn = (...args) => {
  warnings.push(args.join(" "));
  originalWarn(...args);
};

sandboxBaseImage.resolveSandboxBaseImage = (options) => {
  baseResolutionCalls.push(options);
  return {
    ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    source: "latest",
    glibcVersion: "2.39",
  };
};

agentOnboard.createAgentSandbox = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-agent-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(
    stagedDockerfile,
    [
      "ARG BASE_IMAGE=nemoclaw-hermes-sandbox-base-local:test",
      "FROM \${BASE_IMAGE}",
      "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
      "ARG NEMOCLAW_PROVIDER_KEY=custom",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
      "ARG CHAT_UI_URL=http://127.0.0.1:18789",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
      "ARG NEMOCLAW_INFERENCE_API=openai-completions",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
      "ARG NEMOCLAW_MESSAGING_PLAN_B64=",
      "ARG NEMOCLAW_HERMES_TOOL_GATEWAY_BROKER=0",
      "ARG NEMOCLAW_HERMES_TOOL_GATEWAY_PRESETS_B64=W10=",
      "ARG NEMOCLAW_BUILD_ID=default",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      "CMD [\"/bin/bash\"]",
    ].join("\\n"),
  );
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
  if (_n(command).includes("sandbox get hermes-sandbox")) return "";
  if (_n(command).includes("sandbox list")) return "hermes-sandbox Ready";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "hermes-sandbox 127.0.0.1 18789 12345 running\nhermes-sandbox 127.0.0.1 8642 12346 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
registry.getSandbox = () => null;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: hermes-sandbox\\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const agent = {
    name: "hermes",
    displayName: "Hermes Agent",
    forwardPort: 18789,
    forward_ports: [18789, 8642],
    healthProbe: { url: "http://127.0.0.1:8642/health", port: 8642, timeout_seconds: 90 },
    dashboard: { kind: "ui", label: "Dashboard", path: "/", healthPath: "/api/status", auth: "session" },
    expectedVersion: "2026.4.23",
    policyAdditionsPath: null,
  };
  await createSandbox(
    null,
    "gpt-5.4",
    "nvidia-prod",
    null,
    "hermes-sandbox",
    null,
    [],
    null,
    agent,
    null,
    null,
    null,
    ["nous-web"],
  );
  console.log(JSON.stringify({ commands, logs, warnings, baseResolutionCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...stripMessagingEnv(process.env),
        HOME: tmpDir,
        NEMOCLAW_HOME: path.join(tmpDir, ".nemoclaw"),
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      commands: CommandEntry[];
      logs: string[];
      warnings: string[];
      baseResolutionCalls: unknown[];
    }>(result.stdout);
    assert.equal(payload.baseResolutionCalls.length, 0);
    const createCommand = payload.commands.find((entry) =>
      entry.command.includes("sandbox create"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    assert.match(createCommand.command, /--provider hermes-sandbox-hermes-tool-gateway/);
    assert.doesNotMatch(createCommand.command, /TOOL_GATEWAY_USER_TOKEN=/);
    assert.doesNotMatch(createCommand.command, /NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN=/);
    assert.ok(
      !payload.logs.some((line) => line.includes("Using sandbox base image")),
      "Hermes agent Dockerfile path should not log OpenClaw sandbox-base usage",
    );
    assert.ok(
      !payload.warnings.some((line) => line.includes("base image")),
      "Hermes agent Dockerfile path should not warn about OpenClaw sandbox-base availability",
    );
  });

  it("keeps resolving the OpenClaw sandbox base image on the default Dockerfile path", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-base-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "openclaw-base-resolve.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const preflightPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );
    const buildContextPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "sandbox", "build-context.ts"),
    );
    const sandboxBaseImagePath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "sandbox-base-image.ts"),
    );
    const platformPath = JSON.stringify(path.join(repoRoot, "src", "lib", "platform.ts"));

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const buildContext = require(${buildContextPath});
const sandboxBaseImage = require(${sandboxBaseImagePath});
const platform = require(${platformPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

platform.isWsl = () => false;

const commands = [];
const logs = [];
const baseResolutionCalls = [];
const originalLog = console.log;
console.log = (...args) => {
  logs.push(args.join(" "));
  originalLog(...args);
};

sandboxBaseImage.resolveSandboxBaseImage = (options) => {
  baseResolutionCalls.push(options);
  return {
    ref: "ghcr.io/nvidia/nemoclaw/sandbox-base@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    source: "latest",
    glibcVersion: "2.39",
  };
};
buildContext.stageOptimizedSandboxBuildContext = () => {
  const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-openclaw-build-"));
  const stagedDockerfile = path.join(buildCtx, "Dockerfile");
  fs.writeFileSync(
    stagedDockerfile,
    [
      "ARG BASE_IMAGE=ghcr.io/nvidia/nemoclaw/sandbox-base:latest",
      "FROM \${BASE_IMAGE}",
      "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
      "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
      "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
      "ARG CHAT_UI_URL=http://127.0.0.1:18789",
      "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
      "ARG NEMOCLAW_INFERENCE_API=openai-completions",
      "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
      "ARG NEMOCLAW_MESSAGING_PLAN_B64=",
      "ARG NEMOCLAW_BUILD_ID=default",
      "ARG NEMOCLAW_DARWIN_VM_COMPAT=0",
      "CMD [\"/bin/bash\"]",
    ].join("\\n"),
  );
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
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
registry.getSandbox = () => null;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  await createSandbox(null, "gpt-5.4", "nvidia-prod", null, "my-assistant");
  console.log(JSON.stringify({ commands, logs, baseResolutionCalls }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...stripMessagingEnv(process.env),
        HOME: tmpDir,
        NEMOCLAW_HOME: path.join(tmpDir, ".nemoclaw"),
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = parseStdoutJson<{
      logs: string[];
      baseResolutionCalls: Array<{ imageName?: string }>;
    }>(result.stdout);
    assert.equal(payload.baseResolutionCalls.length, 1);
    assert.equal(payload.baseResolutionCalls[0]?.imageName, "ghcr.io/nvidia/nemoclaw/sandbox-base");
    assert.ok(
      payload.logs.some((line) => line.includes("Pinning base image to sha256:bbbbbbbbbbbb")),
      "default OpenClaw path should still log base-image pinning",
    );
  });

  it("binds the dashboard forward to 0.0.0.0 when CHAT_UI_URL points to a remote host", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-remote-forward-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-remote-forward.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const preflightPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 18789 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  process.env.CHAT_UI_URL = "https://chat.example.com";
  await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify(commands));
})().catch((error) => {
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = parseStdoutJson<CommandEntry[]>(result.stdout);
    assert.ok(
      commands.some((entry: CommandEntry) =>
        entry.command.includes("forward start --background 0.0.0.0:18789 my-assistant"),
      ),
      "expected remote dashboard forward target",
    );
  });

  it("injects NEMOCLAW_DASHBOARD_PORT into sandbox create envArgs when set (#1925)", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dashboard-port-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "dashboard-port-envargs.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "src", "lib", "onboard.ts"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "src", "lib", "runner.ts"));
    const registryPath = JSON.stringify(path.join(repoRoot, "src", "lib", "state", "registry.ts"));
    const preflightPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "onboard", "preflight.ts"),
    );
    const credentialsPath = JSON.stringify(
      path.join(repoRoot, "src", "lib", "credentials", "store.ts"),
    );

    fs.mkdirSync(fakeBin, { recursive: true });
    writeOkOpenshell(fakeBin);

    const script = String.raw`
const runner = require(${runnerPath});
const _n = (c) => (Array.isArray(c) ? c.join(" ") : String(c)).replace(/'/g, "");
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command: _n(command), env: opts.env || null });
  return { status: 0 };
};
runner.runFile = (file, args = [], opts = {}) => {
  commands.push({ command: _n([file, ...args]), env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (_n(command).includes("sandbox get my-assistant")) return "";
  if (_n(command).includes("sandbox list")) return "my-assistant Ready";
  // Custom port: dashboard readiness curl uses 19000 (DASHBOARD_PORT from env)
  {
    const mockedCapture = require(${onboardScriptMocksPath}).mockOnboardRunCapture(command);
    if (mockedCapture !== null) return mockedCapture;
  }
  if (_n(command).includes("forward list")) return "my-assistant 127.0.0.1 19000 12345 running";
  return "";
};
registry.registerSandbox = () => true;
registry.updateSandbox = () => true;
registry.setDefault = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  child.pid = 4242;
  commands.push({ command: _n([args[0], ...(Array.isArray(args[1]) ? args[1] : [])]), env: args[2]?.env || null });
  process.nextTick(() => {
    child.stdout.emit("data", Buffer.from("Created sandbox: my-assistant\n"));
    child.emit("close", 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  process.env.OPENSHELL_GATEWAY = "nemoclaw";
  const sandboxName = await createSandbox(null, "gpt-5.4");
  console.log(JSON.stringify({ sandboxName, commands }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    // Strip CHAT_UI_URL so createSandbox falls back to http://127.0.0.1:19000.
    // Without this, a CHAT_UI_URL set in the developer's shell or CI would be
    // inherited, causing chatUiUrl to use the wrong port and making the forward
    // command assertion below fail spuriously.
    const {
      CHAT_UI_URL: _stripped,
      HTTP_PROXY: _httpProxy,
      HTTPS_PROXY: _httpsProxy,
      NO_PROXY: _noProxy,
      http_proxy: _lowerHttpProxy,
      https_proxy: _lowerHttpsProxy,
      no_proxy: _lowerNoProxy,
      ...inheritedEnv
    } = process.env;
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: {
        ...inheritedEnv,
        HOME: tmpDir,
        PATH: `${fakeBin}:${process.env.PATH || ""}`,
        NEMOCLAW_NON_INTERACTIVE: "1",
        NEMOCLAW_DASHBOARD_PORT: "19000",
        HTTP_PROXY: "http://127.0.0.1:8888",
        HTTPS_PROXY: "http://127.0.0.1:8888",
        NO_PROXY: "corp.internal",
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const payloadLine = result.stdout
      .trim()
      .split("\n")
      .slice()
      .reverse()
      .find((line) => line.startsWith("{") && line.endsWith("}"));
    assert.ok(payloadLine, `expected JSON payload in stdout:\n${result.stdout}`);
    const payload = JSON.parse(payloadLine);
    const createCommand = payload.commands.find((entry: CommandEntry) =>
      entry.command.includes("sandbox create"),
    );
    assert.ok(createCommand, "expected sandbox create command");
    // Part 1 of fix (#1925): NEMOCLAW_DASHBOARD_PORT must be in envArgs so
    // nemoclaw-start.sh can unconditionally override CHAT_UI_URL at runtime,
    // overriding whatever value the Docker image had baked in.
    assert.match(createCommand.command, /NEMOCLAW_DASHBOARD_PORT=19000/);
    assert.match(createCommand.command, /HTTP_PROXY=http:\/\/127\.0\.0\.1:8888/);
    assert.match(createCommand.command, /HTTPS_PROXY=http:\/\/127\.0\.0\.1:8888/);
    // OpenClaw home/state/workspace dirs must be pinned in the sandbox env so
    // `openclaw skills install` and `openclaw skills list` resolve the same
    // paths. Without this, the upstream skill loader can fall back to a
    // hardcoded DEFAULT_AGENT_WORKSPACE_DIR that drifts from the install path
    // and hides workspace-installed skills from `skills list`.
    assert.match(createCommand.command, /OPENCLAW_HOME=\/sandbox(?:\s|$)/);
    assert.match(createCommand.command, /OPENCLAW_STATE_DIR=\/sandbox\/\.openclaw(?:\s|$)/);
    assert.match(
      createCommand.command,
      /OPENCLAW_WORKSPACE_DIR=\/sandbox\/\.openclaw\/workspace(?:\s|$)/,
    );
    const noProxyMatch = createCommand.command.match(/(?:^|\s)NO_PROXY=([^\s]+)/);
    assert.ok(
      noProxyMatch,
      `expected NO_PROXY in sandbox create command:\n${createCommand.command}`,
    );
    const noProxyEntries = noProxyMatch[1].split(",");
    assert.ok(noProxyEntries.includes("corp.internal"));
    assert.ok(noProxyEntries.includes("localhost"));
    assert.ok(noProxyEntries.includes("127.0.0.1"));
    assert.ok(noProxyEntries.includes("host.docker.internal"));
    // Forward must use same-port mapping (openshell does not support asymmetric)
    assert.ok(
      payload.commands.some(
        (entry: CommandEntry) =>
          entry.command.includes("forward start --background 19000 my-assistant") ||
          entry.command.includes("forward start --background 0.0.0.0:19000 my-assistant"),
      ),
      "expected dashboard forward for port 19000",
    );
    assert.ok(
      !payload.commands.some((entry: CommandEntry) => entry.command.includes("19000:18789")),
      "forward must not use asymmetric 19000:18789 mapping",
    );
    assert.ok(
      !payload.commands.some((entry: CommandEntry) => entry.command.includes("19000:19000")),
      "forward must not use port:port form (openshell does not support it)",
    );
  });
});
