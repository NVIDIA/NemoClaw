// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

// The config module reads process.env.HOME to locate ~/.nemoclaw/config.json.
// We override HOME to an isolated temp directory so tests never touch real config.
let origHome;
let tmpHome;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cfg-"));
  process.env.HOME = tmpHome;

  // Force re-require so the module picks up the new HOME
  delete require.cache[require.resolve("../nemoclaw/dist/onboard/config.js")];
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function loadModule() {
  return require("../nemoclaw/dist/onboard/config.js");
}

const SAMPLE_CONFIG = {
  endpointType: "build",
  endpointUrl: "https://integrate.api.nvidia.com/v1",
  ncpPartner: null,
  model: "nvidia/nemotron-3-super-120b-a12b",
  profile: "default",
  credentialEnv: "NVIDIA_API_KEY",
  onboardedAt: "2026-03-17T00:00:00.000Z",
};

describe("onboard config", () => {
  it("returns null when no config exists", () => {
    const { loadOnboardConfig } = loadModule();
    assert.equal(loadOnboardConfig(), null);
  });

  it("saves and loads config round-trip", () => {
    const { saveOnboardConfig, loadOnboardConfig } = loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);
    const loaded = loadOnboardConfig();
    assert.deepEqual(loaded, SAMPLE_CONFIG);
  });

  it("creates .nemoclaw directory if missing", () => {
    const { saveOnboardConfig } = loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);
    const configDir = path.join(tmpHome, ".nemoclaw");
    assert.ok(fs.existsSync(configDir));
  });

  it("clears config", () => {
    const { saveOnboardConfig, clearOnboardConfig, loadOnboardConfig } = loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);
    assert.notEqual(loadOnboardConfig(), null);
    clearOnboardConfig();
    assert.equal(loadOnboardConfig(), null);
  });

  it("clear is safe when no config exists", () => {
    const { clearOnboardConfig } = loadModule();
    // Should not throw
    clearOnboardConfig();
  });

  it("overwrites existing config on save", () => {
    const { saveOnboardConfig, loadOnboardConfig } = loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);

    const updated = { ...SAMPLE_CONFIG, model: "nvidia/nemotron-3-nano-30b-a3b" };
    saveOnboardConfig(updated);

    const loaded = loadOnboardConfig();
    assert.equal(loaded.model, "nvidia/nemotron-3-nano-30b-a3b");
  });
});
