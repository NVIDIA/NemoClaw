// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Use a temp dir so tests don't touch real ~/.nemoclaw
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-test-"));
process.env.HOME = tmpDir;

const registry = require("../bin/lib/registry");

const regFile = path.join(tmpDir, ".nemoclaw", "sandboxes.json");

beforeEach(() => {
  if (fs.existsSync(regFile)) fs.unlinkSync(regFile);
});

describe("registry", () => {
  it("starts empty", () => {
    const { sandboxes, defaultSandbox } = registry.listSandboxes();
    assert.equal(sandboxes.length, 0);
    assert.equal(defaultSandbox, null);
  });

  it("registers a sandbox and sets it as default", () => {
    registry.registerSandbox({ name: "alpha", model: "test-model", provider: "nvidia-nim" });
    const sb = registry.getSandbox("alpha");
    assert.equal(sb.name, "alpha");
    assert.equal(sb.model, "test-model");
    assert.equal(registry.getDefault(), "alpha");
  });

  it("first registered becomes default", () => {
    registry.registerSandbox({ name: "first" });
    registry.registerSandbox({ name: "second" });
    assert.equal(registry.getDefault(), "first");
  });

  it("setDefault changes the default", () => {
    registry.registerSandbox({ name: "a" });
    registry.registerSandbox({ name: "b" });
    registry.setDefault("b");
    assert.equal(registry.getDefault(), "b");
  });

  it("setDefault returns false for nonexistent sandbox", () => {
    assert.equal(registry.setDefault("nope"), false);
  });

  it("updateSandbox modifies fields", () => {
    registry.registerSandbox({ name: "up" });
    registry.updateSandbox("up", { policies: ["pypi", "npm"], model: "new-model" });
    const sb = registry.getSandbox("up");
    assert.deepEqual(sb.policies, ["pypi", "npm"]);
    assert.equal(sb.model, "new-model");
  });

  it("registerSandbox and updateSandbox store nimPort", () => {
    registry.registerSandbox({ name: "nim-sb", nimPort: 9000 });
    assert.equal(registry.getSandbox("nim-sb").nimPort, 9000);
    registry.updateSandbox("nim-sb", { nimPort: 9001 });
    assert.equal(registry.getSandbox("nim-sb").nimPort, 9001);
  });

  it("updateSandbox returns false for nonexistent sandbox", () => {
    assert.equal(registry.updateSandbox("nope", {}), false);
  });

  it("removeSandbox deletes and shifts default", () => {
    registry.registerSandbox({ name: "x" });
    registry.registerSandbox({ name: "y" });
    registry.setDefault("x");
    registry.removeSandbox("x");
    assert.equal(registry.getSandbox("x"), null);
    assert.equal(registry.getDefault(), "y");
  });

  it("removeSandbox last sandbox sets default to null", () => {
    registry.registerSandbox({ name: "only" });
    registry.removeSandbox("only");
    assert.equal(registry.getDefault(), null);
    assert.equal(registry.listSandboxes().sandboxes.length, 0);
  });

  it("removeSandbox returns false for nonexistent", () => {
    assert.equal(registry.removeSandbox("nope"), false);
  });

  it("getSandbox returns null for nonexistent", () => {
    assert.equal(registry.getSandbox("nope"), null);
  });

  it("persists to disk and survives reload", () => {
    registry.registerSandbox({ name: "persist", model: "m1" });
    // Read file directly
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    assert.equal(data.sandboxes.persist.model, "m1");
    assert.equal(data.defaultSandbox, "persist");
  });

  it("handles corrupt registry file gracefully", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(regFile, "NOT JSON");
    // Should not throw, returns empty
    const { sandboxes } = registry.listSandboxes();
    assert.equal(sandboxes.length, 0);
  });
});

describe("registry + nim port", () => {
  const nim = require("../bin/lib/nim");

  it("getNimPortForSandbox returns default when sandbox has no nimPort", () => {
    registry.registerSandbox({ name: "no-port" });
    assert.equal(nim.getNimPortForSandbox("no-port"), nim.DEFAULT_NIM_PORT);
  });

  it("getNimPortForSandbox returns stored nimPort", () => {
    registry.registerSandbox({ name: "with-port", nimPort: 9000 });
    assert.equal(nim.getNimPortForSandbox("with-port"), 9000);
  });

  it("getNimPortForSandbox returns default for nonexistent sandbox", () => {
    assert.equal(nim.getNimPortForSandbox("nonexistent-xyz"), nim.DEFAULT_NIM_PORT);
  });
});
