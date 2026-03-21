// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

/**
 * Helper: create a temp dir with a sandbox registry containing a non-default
 * model and provider. Returns the temp dir path. Caller must clean up.
 */
function createTestRegistry(sandboxName, model, provider) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-bridge-test-"));
  const registryDir = path.join(tmp, ".nemoclaw");
  fs.mkdirSync(registryDir, { recursive: true });
  fs.writeFileSync(
    path.join(registryDir, "sandboxes.json"),
    JSON.stringify({
      sandboxes: {
        [sandboxName]: {
          name: sandboxName,
          createdAt: new Date().toISOString(),
          model,
          provider,
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: sandboxName,
    }, null, 2),
  );
  return tmp;
}

describe("telegram bridge banner", () => {
  it("reads the model from the sandbox registry instead of hardcoding it", () => {
    const bridgeSrc = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "telegram-bridge.js"),
      "utf-8",
    );

    assert.match(bridgeSrc, /require\(.*registry.*\)/, "should import the registry module");
    assert.match(bridgeSrc, /getSandbox/, "should call getSandbox to look up the model");

    const bannerLines = bridgeSrc.split("\n").filter((l) => l.includes("Model:") && l.includes("│"));
    assert.ok(bannerLines.length > 0, "should have a Model banner line");
    for (const line of bannerLines) {
      assert.doesNotMatch(
        line,
        /["'].*nemotron.*["']/,
        "Model banner line should not contain a hardcoded model string literal",
      );
    }
  });

  // Note: the behavioral tests below use registry.getSandbox() directly rather
  // than executing the full telegram-bridge.js script.  The bridge requires a
  // valid TELEGRAM_BOT_TOKEN and running openshell binary to start, so it
  // cannot be launched in a test environment.  The structural test above guards
  // against regressions in the source, and the behavioral tests verify the
  // registry lookup contract that the bridge depends on.

  it("displays a non-default model from the sandbox registry in the banner", () => {
    const tmp = createTestRegistry("test-sandbox", "ollama/llama3", "ollama-local");
    try {
      const result = spawnSync(
        "node",
        [
          "-e",
          `
          const registry = require("./bin/lib/registry");
          const sandboxInfo = registry.getSandbox("test-sandbox");
          const model = sandboxInfo?.model || "nvidia/nemotron-3-super-120b-a12b";
          const provider = sandboxInfo?.provider || "nvidia-nim";
          console.log("MODEL=" + model);
          console.log("PROVIDER=" + provider);
          `,
        ],
        {
          cwd: path.join(__dirname, ".."),
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, HOME: tmp },
        },
      );

      assert.equal(result.status, 0, `script failed: ${result.stderr}`);
      assert.match(result.stdout, /MODEL=ollama\/llama3/);
      assert.match(result.stdout, /PROVIDER=ollama-local/);
      assert.doesNotMatch(result.stdout, /nemotron-3-super/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("/start response uses registry provider and model instead of hardcoding", () => {
    const bridgeSrc = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "telegram-bridge.js"),
      "utf-8",
    );

    const startBlock = bridgeSrc.slice(
      bridgeSrc.indexOf('"/start"'),
      bridgeSrc.indexOf("continue;", bridgeSrc.indexOf('"/start"')),
    );
    assert.ok(startBlock.length > 0, "should find the /start handler block");
    assert.doesNotMatch(
      startBlock,
      /Nemotron 3 Super 120B/,
      "/start handler should not contain hardcoded 'Nemotron 3 Super 120B'",
    );
    assert.match(
      startBlock,
      /registry\.getSandbox/,
      "/start handler should look up the sandbox from the registry",
    );
    assert.match(
      startBlock,
      /provider/i,
      "/start handler should reference the provider",
    );
  });

  it("/start response reflects configured provider and model from registry", () => {
    const tmp = createTestRegistry("test-sandbox", "qwen2.5:14b-instruct", "ollama-local");
    try {
      const result = spawnSync(
        "node",
        [
          "-e",
          `
          const registry = require("./bin/lib/registry");
          const info = registry.getSandbox("test-sandbox");
          const model = info?.model || "nvidia/nemotron-3-super-120b-a12b";
          const provider = info?.provider || "nvidia-nim";
          const startMsg = "\u{1F980} *NemoClaw* — " + provider + " / " + model;
          console.log(startMsg);
          `,
        ],
        {
          cwd: path.join(__dirname, ".."),
          encoding: "utf-8",
          timeout: 5000,
          env: { ...process.env, HOME: tmp },
        },
      );

      assert.equal(result.status, 0, `script failed: ${result.stderr}`);
      assert.match(result.stdout, /ollama-local/);
      assert.match(result.stdout, /qwen2\.5:14b-instruct/);
      assert.doesNotMatch(result.stdout, /Nemotron/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
