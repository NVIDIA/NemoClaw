// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

describe("onboard provider selection UX", () => {
  it("prompts explicitly instead of silently auto-selecting detected Ollama", () => {
    const repoRoot = path.join(__dirname, "..");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-onboard-selection-"));
    const scriptPath = path.join(tmpDir, "selection-check.js");
    const onboardPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "onboard.js"));
    const credentialsPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "credentials.js"));
    const runnerPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "runner.js"));
    const registryPath = JSON.stringify(path.join(repoRoot, "bin", "lib", "registry.js"));
    const script = String.raw`
const credentials = require(${credentialsPath});
const runner = require(${runnerPath});
const registry = require(${registryPath});

let promptCalls = 0;
const messages = [];
const updates = [];

credentials.prompt = async (message) => {
  promptCalls += 1;
  messages.push(message);
  return "";
};
credentials.ensureApiKey = async () => {};
runner.runCapture = (command) => {
  if (command.includes("command -v ollama")) return "/usr/bin/ollama";
  if (command.includes("localhost:11434/api/tags")) return JSON.stringify({ models: [{ name: "nemotron-3-nano:30b" }] });
  if (command.includes("ollama list")) return "nemotron-3-nano:30b  abc  24 GB  now\\nqwen3:32b  def  20 GB  now";
  if (command.includes("localhost:8000/v1/models")) return "";
  return "";
};
registry.updateSandbox = (_name, update) => updates.push(update);

const { setupNim } = require(${onboardPath});

(async () => {
  const originalLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  try {
    const result = await setupNim("selection-test", null);
    originalLog(JSON.stringify({ result, promptCalls, messages, updates, lines }));
  } finally {
    console.log = originalLog;
  }
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

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).not.toBe("");
    const payload = JSON.parse(result.stdout.trim());
    expect(payload.result.provider).toBe("nvidia-nim");
    expect(payload.result.model).toBe("nvidia/nemotron-3-super-120b-a12b");
    expect(payload.promptCalls).toBe(2);
    expect(payload.messages[0]).toMatch(/Choose \[/);
    expect(payload.messages[1]).toMatch(/Choose model \[1\]/);
    expect(
      payload.lines.some((line) => line.includes("Detected local inference option"))
    ).toBeTruthy();
    expect(
      payload.lines.some((line) => line.includes("Press Enter to keep the cloud default"))
    ).toBeTruthy();
    expect(payload.lines.some((line) => line.includes("Cloud models:"))).toBeTruthy();
  });
});
