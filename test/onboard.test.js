// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// Use a stable dirname for both CJS and ESM-like runners without self-referencing TDZ.
const TEST_DIR =
  typeof globalThis.__dirname === "string"
    ? globalThis.__dirname
    : typeof import.meta !== "undefined" && import.meta.url
      ? path.dirname(new URL(import.meta.url).pathname)
      : process.cwd();
const { spawnSync } = require("node:child_process");

const {
  buildAuthenticatedDashboardUrl,
  buildControlUiConfigSyncScript,
  buildSandboxConfigSyncScript,
  classifySandboxCreateFailure,
  getOllamaProbeOutcome,
  getControlUiAllowedOrigins,
  getDashboardForwardPort,
  getDashboardForwardStartCommand,
  getDashboardAccessInfo,
  getDashboardGuidanceLines,
  isWslEnvironment,
} = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("classifies sandbox create timeout failures and tracks upload progress", () => {
    expect(
      classifySandboxCreateFailure("Error: failed to read image export stream\nTimeout error").kind,
    ).toBe("image_transfer_timeout");
    expect(
      classifySandboxCreateFailure(
        [
          '  Pushing image openshell/sandbox-from:123 into gateway "nemoclaw"',
          "  [progress] Uploaded to gateway",
          "Error: failed to read image export stream",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "image_transfer_timeout",
      uploadedToGateway: true,
    });
  });

  it("classifies sandbox create connection resets and incomplete create streams", () => {
    expect(classifySandboxCreateFailure("Connection reset by peer").kind).toBe(
      "image_transfer_reset",
    );
    expect(
      classifySandboxCreateFailure(
        [
          "  Image openshell/sandbox-from:123 is available in the gateway.",
          "Created sandbox: my-assistant",
          "Error: stream closed unexpectedly",
        ].join("\n"),
      ),
    ).toEqual({
      kind: "sandbox_create_incomplete",
      uploadedToGateway: true,
    });
  });

  it("treats Ollama warm-up probe failures as warnings during restore", () => {
    const result = getOllamaProbeOutcome(
      "qwen3.5:9b-64k",
      {
        ok: false,
        message: "Selected Ollama model 'qwen3.5:9b-64k' did not answer the local probe in time.",
      },
      { allowWarmupFailure: true },
    );

    assert.equal(result.fatal, false);
    assert.match(
      result.message,
      /Continuing because the inference route is configured and the model may still be loading\./,
    );
  });

  it("builds a sandbox sync script that only writes nemoclaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "ollama-local",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);
    assert.match(script, /openclaw models set 'inference\/nemotron-3-nano:30b'/);
    assert.match(
      script,
      /cfg\.setdefault\('agents', {}\)\.setdefault\('defaults', {}\)\.setdefault\('model', {}\)\['primary'\]/,
    );
    assert.match(script, /providers_cfg\["inference"\]/);
    assert.match(script, /providers_cfg\["inference"\]\s*=\s*json\.loads\(/);
    assert.match(script, /inference\/nemotron-3-nano:30b/);
    assert.match(script, /^exit$/m);
  });

  it("creates agent workspace and agentDir directories from agents.list", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "ollama-local",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /for agent in cfg\.get\('agents', \{\}\)\.get\('list', \[\]\)/);
    assert.match(script, /os\.makedirs\(dir_path\.strip\(\), exist_ok=True\)/);
  });

  it("initialises webchat sessions for agents so they appear in Control UI", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      provider: "ollama-local",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /sessions\.json/);
    assert.match(script, /lastChannel.*webchat/);
    assert.match(script, /deliveryContext.*webchat/);
  });

  it("uses Ollama-safe context metadata for non-default Ollama models", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "qwen3.5:35b-a3b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      contextWindow: 8192,
      maxTokens: 4096,
      provider: "ollama-local",
      onboardedAt: "2026-03-21T18:00:00.000Z",
    });

    assert.match(script, /openclaw models set 'inference\/qwen3\.5:35b-a3b'/);
    assert.match(script, /"contextWindow"\s*:\s*8192/);
    assert.match(script, /"maxTokens"\s*:\s*4096/);
  });

  it("merges Control UI allowed origins into the sandbox OpenClaw config", () => {
    const script = buildSandboxConfigSyncScript(
      {
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "qwen3.5:9b-64k",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        provider: "ollama-local",
        onboardedAt: "2026-03-22T18:00:00.000Z",
      },
      {
        controlUiAllowedOrigins: ["http://127.0.0.1:18789", "http://172.18.117.56:18789"],
      },
    );

    assert.match(script, /control_ui_allowed_origins = json\.loads/);
    assert.match(script, /allowedOrigins/);
    assert.match(script, /http:\/\/172\.18\.117\.56:18789/);
  });

  it("detects WSL dashboard origins and exposes the host fallback URL", () => {
    const origins = getControlUiAllowedOrigins({
      env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
      platform: "linux",
      release: "5.15.167.4-microsoft-standard-WSL2",
      runCapture: () => "172.18.117.56 10.255.255.254",
    });

    assert.deepEqual(origins, [
      "http://127.0.0.1:18789",
      "http://localhost:18789",
      "http://172.18.117.56:18789",
    ]);
  });

  it("builds an authenticated WSL dashboard URL", () => {
    const url = buildAuthenticatedDashboardUrl("http://172.18.117.56:18789", "abc123");

    assert.equal(
      url,
      "http://172.18.117.56:18789/?gatewayUrl=ws%3A%2F%2F172.18.117.56%3A18789#token=abc123",
    );
  });

  it("binds the dashboard forward on all interfaces in WSL", () => {
    assert.equal(
      getDashboardForwardPort({
        env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
        platform: "linux",
        release: "5.15.167.4-microsoft-standard-WSL2",
      }),
      "0.0.0.0:18789",
    );
  });

  it("keeps the default dashboard forward binding outside WSL", () => {
    assert.equal(
      getDashboardForwardPort({
        env: {},
        platform: "linux",
        release: "6.8.0-generic",
      }),
      "18789",
    );
  });

  it("builds the expected dashboard forward command for the current platform", () => {
    const expectedPort = isWslEnvironment() ? "0.0.0.0:18789" : "18789";
    assert.equal(
      getDashboardForwardStartCommand("the-crucible"),
      `openshell forward start --background ${expectedPort} "the-crucible"`,
    );
  });

  it("builds a control ui sync script that repairs allowed origins and signals the gateway", () => {
    const script = buildControlUiConfigSyncScript([
      "http://127.0.0.1:18789",
      "http://localhost:18789",
      "http://172.18.117.56:18789",
    ]);

    assert.match(script, /allowedOrigins/);
    assert.match(script, /http:\/\/localhost:18789/);
    assert.match(script, /http:\/\/172\.18\.117\.56:18789/);
    assert.match(script, /signal\.SIGUSR1/);
    assert.match(script, /gateway run/);
    assert.ok(!script.includes("\0"), "sync script must not include raw NUL bytes");
    assert.match(script, /replace\(b'\\x00', b' '\)/);
  });

  it("includes the authenticated WSL dashboard URL in onboarding output data", () => {
    const access = getDashboardAccessInfo("the-crucible", {
      env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
      platform: "linux",
      release: "5.15.167.4-microsoft-standard-WSL2",
      runCapture: (command) => {
        if (command.includes("hostname -I")) return "172.18.117.56";
        if (command.includes("NEMOCLAW_GATEWAY_TOKEN=")) {
          return "NEMOCLAW_GATEWAY_TOKEN=abc123";
        }
        return "";
      },
    });

    assert.deepEqual(access, [
      {
        label: "Dashboard",
        url: "http://127.0.0.1:18789/?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#token=abc123",
      },
      {
        label: "VS Code/WSL",
        url: "http://172.18.117.56:18789/?gatewayUrl=ws%3A%2F%2F172.18.117.56%3A18789#token=abc123",
      },
    ]);
  });

  it("includes the authenticated primary dashboard URL outside WSL", () => {
    const access = getDashboardAccessInfo("the-crucible", {
      env: {},
      platform: "linux",
      release: "6.8.0-generic",
      runCapture: (command) => {
        if (command.includes("NEMOCLAW_GATEWAY_TOKEN=")) {
          return "NEMOCLAW_GATEWAY_TOKEN=abc123";
        }
        return "";
      },
    });

    assert.deepEqual(access, [
      {
        label: "Dashboard",
        url: "http://127.0.0.1:18789/?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#token=abc123",
      },
    ]);
  });

  it("falls back to the plain primary dashboard URL when the token is unavailable", () => {
    const access = getDashboardAccessInfo("the-crucible", {
      env: {},
      platform: "linux",
      release: "6.8.0-generic",
      runCapture: () => "",
    });

    assert.deepEqual(access, [{ label: "Dashboard", url: "http://127.0.0.1:18789/" }]);
  });

  it("parses the real token line when command source text is echoed", () => {
    const access = getDashboardAccessInfo("the-crucible", {
      env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
      platform: "linux",
      release: "5.15.167.4-microsoft-standard-WSL2",
      runCapture: (command) => {
        if (command.includes("hostname -I")) return "172.18.117.56";
        if (command.includes("NEMOCLAW_GATEWAY_TOKEN=")) {
          return ["print(f'NEMOCLAW_GATEWAY_TOKEN={token}')", "NEMOCLAW_GATEWAY_TOKEN=abc123"].join(
            "\n",
          );
        }
        return "";
      },
    });

    assert.deepEqual(access, [
      {
        label: "Dashboard",
        url: "http://127.0.0.1:18789/?gatewayUrl=ws%3A%2F%2F127.0.0.1%3A18789#token=abc123",
      },
      {
        label: "VS Code/WSL",
        url: "http://172.18.117.56:18789/?gatewayUrl=ws%3A%2F%2F172.18.117.56%3A18789#token=abc123",
      },
    ]);
  });

  it("prints explicit WSL guidance when the direct WSL IP URL is available", () => {
    const guidance = getDashboardGuidanceLines(
      [
        { label: "Dashboard", url: "http://127.0.0.1:18789/" },
        {
          label: "VS Code/WSL",
          url: "http://172.18.117.56:18789/?gatewayUrl=ws%3A%2F%2F172.18.117.56%3A18789#token=abc123",
        },
      ],
      {
        env: { WSL_DISTRO_NAME: "Ubuntu-24.04" },
        platform: "linux",
        release: "5.15.167.4-microsoft-standard-WSL2",
      },
    );

    assert.deepEqual(guidance, [
      "WSL/Win     If Windows cannot load http://127.0.0.1:18789/, use the VS Code/WSL URL above exactly as printed.",
      "WSL path    Use the direct WSL host IP URL above from Windows. Do not replace it with localhost.",
    ]);
  });

  it("does not print WSL guidance on non-WSL hosts", () => {
    const guidance = getDashboardGuidanceLines(
      [{ label: "Dashboard", url: "http://127.0.0.1:18789/" }],
      {
        env: {},
        platform: "linux",
        release: "6.8.0-generic",
      },
    );

    assert.deepEqual(guidance, []);
  });

  it("recreates when the local registry is stale instead of offering to keep a missing sandbox", () => {
    const repoRoot = path.join(TEST_DIR, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-"));
    const scriptPath = path.join(tmpDir, "stale-registry-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');

const prompts = [];
const commands = [];
const spawnCommands = [];

registry.registerSandbox({ name: "my-assistant" });

credentials.prompt = async (message) => {
  prompts.push(message);
  return "";
};

runner.runCapture = (command) => {
  if (command.includes("sandbox") && command.includes("get") && command.includes("my-assistant")) return "";
  if (command.includes("sandbox") && command.includes("list")) return "my-assistant   Ready   2m ago";
  return "";
};

runner.run = (command) => {
  commands.push(command);
  return { status: 0 };
};

childProcess.spawn = (command, args) => {
  spawnCommands.push([command, ...(args || [])].join(' '));
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.unref = () => {};
  setImmediate(() => {
    child.stdout.emit('data', "  Building image openshell/sandbox-from:123 from /tmp/build/Dockerfile\n");
    child.stdout.emit('data', "Created sandbox: my-assistant\n");
    child.emit('close', 0);
  });
  return child;
};

const { createSandbox } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  const result = await createSandbox(null);
  console.log = originalLog;
  console.log(JSON.stringify({
    result,
    prompts,
    commands,
    spawnCommands,
    lines,
    sandbox: registry.getSandbox("my-assistant"),
  }));
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split("\n").at(-1);
    const payload = JSON.parse(output);
    assert.equal(payload.result, "my-assistant");
    assert.equal(payload.prompts.length, 1);
    assert.ok(
      payload.spawnCommands.some((command) =>
        command.includes("bash -lc openshell sandbox create"),
      ),
    );
    assert.ok(
      payload.commands.some((command) => command.includes("openshell forward start --background")),
    );
    assert.ok(payload.lines.some((line) => line.includes("Detected stale local sandbox entry")));
    assert.ok(payload.lines.some((line) => line.includes("OpenShell does not have this sandbox")));
    assert.ok(payload.sandbox);
  });

  it("keeps a live sandbox and hydrates missing local registry state", () => {
    const repoRoot = path.join(TEST_DIR, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-live-"));
    const scriptPath = path.join(tmpDir, "live-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const childProcess = require('node:child_process');

const prompts = [];
const commands = [];
const spawnCommands = [];

credentials.prompt = async (message) => {
  prompts.push(message);
  return "";
};

runner.runCapture = (command) => {
  if (command.includes("sandbox") && command.includes("get") && command.includes("my-assistant")) return "Name: my-assistant";
  if (command.includes("sandbox") && command.includes("list")) return "my-assistant   Ready   2m ago";
  return "";
};

runner.run = (command) => {
  commands.push(command);
  return { status: 0 };
};

childProcess.spawn = (...args) => {
  spawnCommands.push(args.join(' '));
  throw new Error('spawn should not be called when reusing a ready sandbox');
};

const { createSandbox } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  const result = await createSandbox(null);
  console.log = originalLog;
  console.log(JSON.stringify({
    result,
    prompts,
    commands,
    spawnCommands,
    lines,
    sandbox: registry.getSandbox("my-assistant"),
  }));
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const output = result.stdout.trim().split("\n").at(-1);
    const payload = JSON.parse(output);
    assert.equal(payload.result, "my-assistant");
    assert.equal(payload.prompts.length, 1);
    assert.equal(payload.spawnCommands.length, 0);
    assert.equal(payload.commands.length, 0);
    assert.ok(
      payload.lines.some((line) =>
        line.includes("Found existing OpenShell sandbox 'my-assistant'."),
      ),
    );
    assert.ok(
      payload.lines.some((line) =>
        line.includes("Syncing local NemoClaw state before continuing."),
      ),
    );
    assert.ok(
      payload.lines.some((line) =>
        line.includes("Found existing OpenShell sandbox 'my-assistant'."),
      ),
    );
    assert.ok(
      payload.lines.some((line) =>
        line.includes("Sandbox 'my-assistant' already exists and is ready."),
      ),
    );
    assert.ok(payload.lines.some((line) => line.includes("Reusing existing sandbox.")));
    assert.equal(payload.sandbox.name, "my-assistant");
  });
});
