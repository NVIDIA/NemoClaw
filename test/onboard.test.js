// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const { buildSandboxConfigSyncScript } = require("../bin/lib/onboard");

describe("onboard helpers", () => {
  it("builds a sandbox sync script that writes config and updates the selected model", () => {
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
    assert.match(script, /openclaw models set 'inference\/nemotron-3-nano:30b'/);
    assert.match(script, /cfg\.setdefault\('agents', \{\}\)\.setdefault\('defaults', \{\}\)\.setdefault\('model', \{\}\)\['primary'\]/);
    assert.match(script, /providers_cfg\["inference"\]/);
    assert.match(script, /json\.loads\("\{\\\"baseUrl\\\":\\\"https:\/\/inference\.local\/v1\\\",\\\"apiKey\\\":\\\"unused\\\"/);
    assert.match(script, /inference\/nemotron-3-nano:30b/);
    assert.match(script, /^exit$/m);
  });

  it("passes credential names to openshell without embedding secret values in argv", () => {
    const repoRoot = path.join(__dirname, "..");
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
    ].join("\n");
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

    assert.equal(result.status, 0, result.stderr);
    const commands = JSON.parse(result.stdout.trim().split("\n").pop());
    assert.equal(commands.length, 2);
    assert.match(commands[0].command, /'--credential' 'NVIDIA_API_KEY'/);
    assert.doesNotMatch(commands[0].command, /nvapi-secret-value/);
    assert.match(commands[0].command, /provider' 'create'/);
    assert.match(commands[1].command, /inference' 'set'/);
  });
});
