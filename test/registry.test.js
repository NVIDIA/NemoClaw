// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
    expect(sandboxes.length).toBe(0);
    expect(defaultSandbox).toBe(null);
  });

  it("registers a sandbox and sets it as default", () => {
    registry.registerSandbox({ name: "alpha", model: "test-model", provider: "nvidia-nim" });
    const sb = registry.getSandbox("alpha");
    expect(sb.name).toBe("alpha");
    expect(sb.model).toBe("test-model");
    expect(registry.getDefault()).toBe("alpha");
  });

  it("first registered becomes default", () => {
    registry.registerSandbox({ name: "first" });
    registry.registerSandbox({ name: "second" });
    expect(registry.getDefault()).toBe("first");
  });

  it("setDefault changes the default", () => {
    registry.registerSandbox({ name: "a" });
    registry.registerSandbox({ name: "b" });
    registry.setDefault("b");
    expect(registry.getDefault()).toBe("b");
  });

  it("setDefault returns false for nonexistent sandbox", () => {
    expect(registry.setDefault("nope")).toBe(false);
  });

  it("updateSandbox modifies fields", () => {
    registry.registerSandbox({ name: "up" });
    registry.updateSandbox("up", { policies: ["pypi", "npm"], model: "new-model" });
    const sb = registry.getSandbox("up");
    expect(sb.policies).toEqual(["pypi", "npm"]);
    expect(sb.model).toBe("new-model");
  });

  it("updateSandbox returns false for nonexistent sandbox", () => {
    expect(registry.updateSandbox("nope", {})).toBe(false);
  });

  it("removeSandbox deletes and shifts default", () => {
    registry.registerSandbox({ name: "x" });
    registry.registerSandbox({ name: "y" });
    registry.setDefault("x");
    registry.removeSandbox("x");
    expect(registry.getSandbox("x")).toBe(null);
    expect(registry.getDefault()).toBe("y");
  });

  it("removeSandbox last sandbox sets default to null", () => {
    registry.registerSandbox({ name: "only" });
    registry.removeSandbox("only");
    expect(registry.getDefault()).toBe(null);
    expect(registry.listSandboxes().sandboxes.length).toBe(0);
  });

  it("removeSandbox returns false for nonexistent", () => {
    expect(registry.removeSandbox("nope")).toBe(false);
  });

  it("getSandbox returns null for nonexistent", () => {
    expect(registry.getSandbox("nope")).toBe(null);
  });

  it("persists to disk and survives reload", () => {
    registry.registerSandbox({ name: "persist", model: "m1" });
    // Read file directly
    const data = JSON.parse(fs.readFileSync(regFile, "utf-8"));
    expect(data.sandboxes.persist.model).toBe("m1");
    expect(data.defaultSandbox).toBe("persist");
  });

  it("handles corrupt registry file gracefully", () => {
    fs.mkdirSync(path.dirname(regFile), { recursive: true });
    fs.writeFileSync(regFile, "NOT JSON");
    // Should not throw, returns empty
    const { sandboxes } = registry.listSandboxes();
    expect(sandboxes.length).toBe(0);
  });
});
