// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

describe("onboard runtime behavior", () => {
  it("keeps OpenClaw source files in the build context", () => {
    const repoRoot = path.join(__dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-runtime-"));
    const scriptPath = path.join(tmpDir, "build-context-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const script = String.raw`
const runner = require(${runnerPath});
const calls = [];
runner.run = (command) => {
  calls.push(command);
  return { status: 0 };
};
const { stageOpenclawSandboxFiles } = require(${onboardPath});
stageOpenclawSandboxFiles("/tmp/nemoclaw-build");
console.log(JSON.stringify(calls));
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });

    assert.equal(result.status, 0, result.stderr);
    const calls = JSON.parse(result.stdout.trim());
    assert.ok(calls.some((command) => command.includes('cp -r "') && command.includes('/nemoclaw"')));
    assert.ok(calls.some((command) => command.includes('rm -rf "/tmp/nemoclaw-build/nemoclaw/node_modules"')));
    assert.ok(!calls.some((command) => command.includes("/tmp/nemoclaw-build/nemoclaw/src")));
  });

  it("checks the reused sandbox port instead of the requested runtime port", () => {
    const repoRoot = path.join(__dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-reuse-"));
    const scriptPath = path.join(tmpDir, "reuse-port-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const nimPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "nim.js"));
    const platformPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "platform.js"));
    const preflightPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "preflight.js"));
    const policiesPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "policies.js"));
    const inferenceConfigPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "inference-config.js"));
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});
const nim = require(${nimPath});
const platform = require(${platformPath});
const preflight = require(${preflightPath});
const policies = require(${policiesPath});
const inferenceConfig = require(${inferenceConfigPath});

const prompts = ["existing", "n", "", "n"];
credentials.prompt = async () => prompts.shift() || "";
credentials.ensureApiKey = async () => {};
credentials.getCredential = () => null;

const checkedPorts = [];
preflight.checkPortAvailable = async (port) => {
  checkedPorts.push(port);
  if (port === 19800) {
    return { ok: false, reason: "busy", process: "other", pid: 123 };
  }
  return { ok: true };
};

runner.run = () => ({ status: 0, stdout: "", stderr: "" });
runner.runCapture = (command) => {
  if (command.includes("docker info")) return "Server: Docker Engine";
  if (command.includes("command -v openshell")) return "/usr/bin/openshell";
  if (command.includes("openshell --version")) return "openshell 0.0";
  if (command.includes("openshell gateway info -g nemoclaw")) return "";
  if (command.includes("openshell status")) return "Connected";
  if (command.includes("localhost:11434/api/tags")) return "";
  if (command.includes("localhost:8000/v1/models")) return "";
  if (command.includes("openshell sandbox list")) return "existing Ready";
  return "";
};

registry.getSandbox = (name) => name === "existing"
  ? { name: "existing", runtime: "openclaw", surface: "openclaw-ui", forwardPort: 18789, policies: [] }
  : null;
registry.defaultSurface = (runtime) => runtime === "nullclaw" ? "nullhub" : "openclaw-ui";
registry.defaultForwardPort = (_runtime, surface) => surface === "nullhub" ? 19800 : surface === "none" ? 3000 : 18789;
registry.updateSandbox = () => true;
registry.registerSandbox = () => true;
registry.removeSandbox = () => true;

nim.detectGpu = () => null;
nim.nimStatus = () => ({ running: false });

platform.inferContainerRuntime = () => "docker";
platform.isUnsupportedMacosRuntime = () => false;
platform.shouldPatchCoredns = () => false;

policies.listPresets = () => [];
policies.getAppliedPresets = () => [];
policies.applyPreset = () => {};

inferenceConfig.getProviderSelectionConfig = () => null;

process.env.NVIDIA_API_KEY = "nvapi-test";

const { onboard } = require(${onboardPath});

(async () => {
  await onboard(["--runtime", "nullclaw"]);
  console.log(JSON.stringify({ checkedPorts }));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
`;
    fs.writeFileSync(scriptPath, script);

    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: { ...process.env, HOME: tmpDir },
    });

    assert.equal(result.status, 0, result.stderr);
    const payload = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.deepEqual(payload.checkedPorts, [8080, 18789]);
  });
});
