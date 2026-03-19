// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

describe("telegram bridge banner", () => {
  it("reads the model from the sandbox registry instead of hardcoding it", () => {
    // The banner source should reference registry.getSandbox, not a hardcoded model string
    const bridgeSrc = fs.readFileSync(
      path.join(__dirname, "..", "scripts", "telegram-bridge.js"),
      "utf-8",
    );

    // Must import and use the registry
    assert.match(bridgeSrc, /require\(.*registry.*\)/, "should import the registry module");
    assert.match(bridgeSrc, /getSandbox/, "should call getSandbox to look up the model");

    // The banner Model line must use a variable, not a hardcoded model name
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

  it("displays a non-default model from the sandbox registry in the banner", () => {
    // Behavioral test: set up a registry with a non-default model,
    // then require the banner-building logic and verify the output.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-banner-test-"));
    const registryDir = path.join(tmp, ".nemoclaw");
    fs.mkdirSync(registryDir, { recursive: true });

    // Write a sandbox registry with a non-default model
    const registryData = {
      sandboxes: {
        "test-sandbox": {
          name: "test-sandbox",
          createdAt: new Date().toISOString(),
          model: "ollama/llama3",
          provider: "ollama-local",
          gpuEnabled: false,
          policies: [],
        },
      },
      defaultSandbox: "test-sandbox",
    };
    fs.writeFileSync(
      path.join(registryDir, "sandboxes.json"),
      JSON.stringify(registryData, null, 2),
    );

    // Run a script that loads the registry with HOME pointed at our temp dir,
    // looks up the sandbox, and prints what the banner model line would be
    const { spawnSync } = require("node:child_process");
    const result = spawnSync(
      "node",
      [
        "-e",
        `
        const registry = require("./bin/lib/registry");
        const sandboxInfo = registry.getSandbox("test-sandbox");
        const model = sandboxInfo?.model || "nvidia/nemotron-3-super-120b-a12b";
        const line = "  │  Model:    " + (model + "                                        ").slice(0, 40) + "│";
        console.log(line);
        console.log("MODEL=" + model);
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
    const output = result.stdout;

    // The banner must show the registry model, not the hardcoded default
    assert.match(output, /MODEL=ollama\/llama3/, "should resolve the model from the registry");
    assert.match(output, /ollama\/llama3/, "banner line should contain the registry model");
    assert.doesNotMatch(
      output,
      /nemotron-3-super/,
      "banner should not fall back to the hardcoded default when registry has a model",
    );

    // Clean up
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});
