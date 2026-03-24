// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildSandboxConfigSyncScript,
  getFutureShellPathHint,
  createSandbox,
  getSandboxInferenceConfig,
  getFutureShellPathHint,
  createSandbox,
  getSandboxInferenceConfig,
  getInstalledOpenshellVersion,
  getStableGatewayImageRef,
  patchStagedDockerfile,
  pruneStaleSandboxEntry,
  runCaptureOpenshell,
  writeSandboxConfigSyncFile,
} from "../bin/lib/onboard";

describe("onboard helpers", () => {
  it("builds a sandbox sync script that only writes nemoclaw config", () => {
    const script = buildSandboxConfigSyncScript({
      endpointType: "custom",
      endpointUrl: "https://inference.local/v1",
      ncpPartner: null,
      model: "nemotron-3-nano:30b",
      profile: "inference-local",
      credentialEnv: "OPENAI_API_KEY",
      onboardedAt: "2026-03-18T12:00:00.000Z",
    });

    assert.match(script, /cat > ~\/\.nemoclaw\/config\.json/);
    assert.match(script, /"model": "nemotron-3-nano:30b"/);
    assert.match(script, /"credentialEnv": "OPENAI_API_KEY"/);
    assert.doesNotMatch(script, /cat > ~\/\.openclaw\/openclaw\.json/);
    assert.doesNotMatch(script, /openclaw models set/);
    assert.match(script, /^exit$/m);
  });

  it("patches the staged Dockerfile with the selected model and chat UI URL", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n")
    );

    try {
      patchStagedDockerfile(dockerfilePath, "gpt-5.4", "http://127.0.0.1:19999", "build-123", "openai-api");
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_MODEL=gpt-5\.4$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROVIDER_KEY=openai$/m);
      assert.match(patched, /^ARG NEMOCLAW_PRIMARY_MODEL_REF=openai\/gpt-5\.4$/m);
      assert.match(patched, /^ARG CHAT_UI_URL=http:\/\/127\.0\.0\.1:19999$/m);
      assert.match(patched, /^ARG NEMOCLAW_BUILD_ID=build-123$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps NVIDIA Endpoints to the routed inference provider", () => {
    assert.deepEqual(
      getSandboxInferenceConfig("qwen/qwen3.5-397b-a17b", "nvidia-prod", "openai-completions"),
      {
        providerKey: "inference",
        primaryModelRef: "inference/qwen/qwen3.5-397b-a17b",
        inferenceBaseUrl: "https://inference.local/v1",
        inferenceApi: "openai-completions",
        inferenceCompat: null,
      }
    );
  });

  it("patches the staged Dockerfile for Anthropic with anthropic-messages routing", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-dockerfile-anthropic-"));
    const dockerfilePath = path.join(tmpDir, "Dockerfile");
    fs.writeFileSync(
      dockerfilePath,
      [
        "ARG NEMOCLAW_MODEL=nvidia/nemotron-3-super-120b-a12b",
        "ARG NEMOCLAW_PROVIDER_KEY=nvidia",
        "ARG NEMOCLAW_PRIMARY_MODEL_REF=nvidia/nemotron-3-super-120b-a12b",
        "ARG CHAT_UI_URL=http://127.0.0.1:18789",
        "ARG NEMOCLAW_INFERENCE_BASE_URL=https://inference.local/v1",
        "ARG NEMOCLAW_INFERENCE_API=openai-completions",
        "ARG NEMOCLAW_INFERENCE_COMPAT_B64=e30=",
        "ARG NEMOCLAW_BUILD_ID=default",
      ].join("\n")
    );

    try {
      patchStagedDockerfile(
        dockerfilePath,
        "claude-sonnet-4-5",
        "http://127.0.0.1:18789",
        "build-claude",
        "anthropic-prod"
      );
      const patched = fs.readFileSync(dockerfilePath, "utf8");
      assert.match(patched, /^ARG NEMOCLAW_MODEL=claude-sonnet-4-5$/m);
      assert.match(patched, /^ARG NEMOCLAW_PROVIDER_KEY=anthropic$/m);
      assert.match(patched, /^ARG NEMOCLAW_PRIMARY_MODEL_REF=anthropic\/claude-sonnet-4-5$/m);
      assert.match(patched, /^ARG NEMOCLAW_INFERENCE_BASE_URL=https:\/\/inference\.local$/m);
      assert.match(patched, /^ARG NEMOCLAW_INFERENCE_API=anthropic-messages$/m);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("maps Gemini to the routed inference provider with supportsStore disabled", () => {
    assert.deepEqual(
      getSandboxInferenceConfig("gemini-2.5-flash", "gemini-api"),
      {
        providerKey: "inference",
        primaryModelRef: "inference/gemini-2.5-flash",
        inferenceBaseUrl: "https://inference.local/v1",
        inferenceApi: "openai-completions",
        inferenceCompat: {
          supportsStore: false,
        },
      }
    );
  });

  it("uses a probed Responses API override when one is available", () => {
    assert.deepEqual(
      getSandboxInferenceConfig("gpt-5.4", "openai-api", "openai-responses"),
      {
        providerKey: "openai",
        primaryModelRef: "openai/gpt-5.4",
        inferenceBaseUrl: "https://inference.local/v1",
        inferenceApi: "openai-responses",
        inferenceCompat: null,
      }
    );
  });

  it("pins the gateway image to the installed OpenShell release version", () => {
    expect(getInstalledOpenshellVersion("openshell 0.0.12")).toBe("0.0.12");
    expect(getInstalledOpenshellVersion("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("0.0.13");
    expect(getInstalledOpenshellVersion("bogus")).toBe(null);
    expect(getStableGatewayImageRef("openshell 0.0.12")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.12");
    expect(getStableGatewayImageRef("openshell 0.0.13-dev.8+gbbcaed2ea")).toBe("ghcr.io/nvidia/openshell/cluster:0.0.13");
    expect(getStableGatewayImageRef("bogus")).toBe(null);
  });

  it("returns a future-shell PATH hint for user-local openshell installs", () => {
    expect(getFutureShellPathHint("/home/test/.local/bin", "/usr/local/bin:/usr/bin")).toBe(
      'export PATH="/home/test/.local/bin:$PATH"'
    );
  });

  it("skips the future-shell PATH hint when the bin dir is already on PATH", () => {
    expect(
      getFutureShellPathHint("/home/test/.local/bin", "/home/test/.local/bin:/usr/local/bin:/usr/bin")
    ).toBe(null);
  });

  it("writes sandbox sync scripts to a temp file for stdin redirection", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-test-"));
    try {
      const scriptFile = writeSandboxConfigSyncFile("echo test", tmpDir, 1234);
      expect(scriptFile).toBe(path.join(tmpDir, "nemoclaw-sync-1234.sh"));
      expect(fs.readFileSync(scriptFile, "utf8")).toBe("echo test\n");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("passes credential names to openshell without embedding secret values in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-inference-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: nvidia-nim",
      "  Model: nvidia/nemotron-3-super-120b-a12b",
      "  Version: 1",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.NVIDIA_API_KEY = "nvapi-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "nvidia/nemotron-3-super-120b-a12b", "nvidia-nim");
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
      },
    });

    expect(result.status).toBe(0);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 3);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'--credential' 'NVIDIA_API_KEY'/);
    assert.doesNotMatch(commands[1].command, /nvapi-secret-value/);
    assert.match(commands[1].command, /provider' 'create'/);
    assert.match(commands[2].command, /inference' 'set'/);
  });

  it("uses native Anthropic provider creation without embedding the secret in argv", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-anthropic-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-anthropic-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: anthropic-prod",
      "  Model: claude-sonnet-4-5",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.ANTHROPIC_API_KEY = "sk-ant-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "claude-sonnet-4-5", "anthropic-prod", "https://api.anthropic.com", "ANTHROPIC_API_KEY");
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 3);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /'--type' 'anthropic'/);
    assert.match(commands[1].command, /'--credential' 'ANTHROPIC_API_KEY'/);
    assert.doesNotMatch(commands[1].command, /sk-ant-secret-value/);
    assert.match(commands[2].command, /'--provider' 'anthropic-prod'/);
  });

  it("updates OpenAI-compatible providers without passing an unsupported --type flag", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-openai-update-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "setup-openai-update-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});

const commands = [];
let callIndex = 0;
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  callIndex += 1;
  return { status: callIndex === 2 ? 1 : 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
    ].join("\n");
  }
  return "";
};
registry.updateSandbox = () => true;

process.env.OPENAI_API_KEY = "sk-secret-value";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 4);
    assert.match(commands[0].command, /gateway' 'select' 'nemoclaw'/);
    assert.match(commands[1].command, /provider' 'create'/);
    assert.match(commands[2].command, /provider' 'update' 'openai-api'/);
    assert.doesNotMatch(commands[2].command, /'--type'/);
    assert.match(commands[3].command, /inference' 'set' '--no-verify'/);
  });

  it("drops stale local sandbox registry entries when the live sandbox is gone", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-stale-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "stale-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const registry = require(${registryPath});
const runner = require(${runnerPath});
runner.runCapture = (command) => (command.includes("'sandbox' 'get' 'my-assistant'") ? "" : "");

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
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.liveExists, false);
    assert.equal(payload.sandbox, null);
  });

  it("builds the sandbox without uploading an external OpenClaw config file", async () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-create-sandbox-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "create-sandbox-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "preflight.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const preflight = require(${preflightPath});
const credentials = require(${credentialsPath});
const childProcess = require("node:child_process");
const { EventEmitter } = require("node:events");

const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("'sandbox' 'get' 'my-assistant'")) return "";
  if (command.includes("'sandbox' 'list'")) return "my-assistant Ready";
  return "";
};
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;
preflight.checkPortAvailable = async () => ({ ok: true });
credentials.prompt = async () => "";

childProcess.spawn = (...args) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  commands.push({ command: args[1][1], env: args[2]?.env || null });
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
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(payload.sandboxName, "my-assistant");
    const createCommand = payload.commands.find((entry) => entry.command.includes("'sandbox' 'create'"));
    assert.ok(createCommand, "expected sandbox create command");
    assert.match(createCommand.command, /'nemoclaw-start'/);
    assert.doesNotMatch(createCommand.command, /'--upload'/);
    assert.doesNotMatch(createCommand.command, /OPENCLAW_CONFIG_PATH/);
    assert.doesNotMatch(createCommand.command, /NVIDIA_API_KEY=/);
    assert.doesNotMatch(createCommand.command, /DISCORD_BOT_TOKEN=/);
    assert.doesNotMatch(createCommand.command, /SLACK_BOT_TOKEN=/);
  });

  it("accepts gateway inference when system inference is separately not configured", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-get-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-get-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Route: inference.local",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 3);
  });

  it("accepts gateway inference output that omits the Route line", () => {
    const repoRoot = path.join(import.meta.dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-inference-route-"));
    const fakeBin = path.join(tmpDir, "bin");
    const scriptPath = path.join(tmpDir, "inference-route-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));

    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, "openshell"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });

    const script = String.raw`
const runner = require(${runnerPath});
const registry = require(${registryPath});
const commands = [];
runner.run = (command, opts = {}) => {
  commands.push({ command, env: opts.env || null });
  return { status: 0 };
};
runner.runCapture = (command) => {
  if (command.includes("inference") && command.includes("get")) {
    return [
      "Gateway inference:",
      "",
      "  Provider: openai-api",
      "  Model: gpt-5.4",
      "  Version: 1",
      "",
      "System inference:",
      "",
      "  Not configured",
    ].join("\\n");
  }
  return "";
};
registry.updateSandbox = () => true;
process.env.OPENAI_API_KEY = "sk-secret-value";
process.env.OPENSHELL_GATEWAY = "nemoclaw";

const { setupInference } = require(${onboardPath});

(async () => {
  await setupInference("test-box", "gpt-5.4", "openai-api", "https://api.openai.com/v1", "OPENAI_API_KEY");
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
      },
    });

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 3);
  });

});
