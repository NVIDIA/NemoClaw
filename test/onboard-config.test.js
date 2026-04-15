// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The config module reads process.env.HOME to locate ~/.nemoclaw/config.json.
// We override HOME to an isolated temp directory so tests never touch real config.
let origHome;
let tmpHome;
let moduleVersion = 0;

beforeEach(() => {
  origHome = process.env.HOME;
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-cfg-"));
  process.env.HOME = tmpHome;
});

afterEach(() => {
  process.env.HOME = origHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function loadModule() {
  moduleVersion += 1;
  const moduleUrl = new URL("../nemoclaw/dist/onboard/config.js", import.meta.url);
  return import(`${moduleUrl.href}?v=${moduleVersion}`);
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
  it("returns null when no config exists", async () => {
    const { loadOnboardConfig } = await loadModule();
    expect(loadOnboardConfig()).toBe(null);
  });

  it("saves and loads config round-trip", async () => {
    const { saveOnboardConfig, loadOnboardConfig } = await loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);
    const loaded = loadOnboardConfig();
    expect(loaded).toEqual(SAMPLE_CONFIG);
  });

  it("creates .nemoclaw directory if missing", async () => {
    const { saveOnboardConfig } = await loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);
    const configDir = path.join(tmpHome, ".nemoclaw");
    expect(fs.existsSync(configDir)).toBe(true);
  });

  it("clears config", async () => {
    const { saveOnboardConfig, clearOnboardConfig, loadOnboardConfig } = await loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);
    expect(loadOnboardConfig()).not.toBe(null);
    clearOnboardConfig();
    expect(loadOnboardConfig()).toBe(null);
  });

  it("clear is safe when no config exists", async () => {
    const { clearOnboardConfig } = await loadModule();
    // Should not throw
    expect(() => clearOnboardConfig()).not.toThrow();
  });

  it("overwrites existing config on save", async () => {
    const { saveOnboardConfig, loadOnboardConfig } = await loadModule();
    saveOnboardConfig(SAMPLE_CONFIG);

    const updated = { ...SAMPLE_CONFIG, model: "nvidia/nemotron-3-nano-30b-a3b" };
    saveOnboardConfig(updated);

    const loaded = loadOnboardConfig();
    expect(loaded?.model).toBe("nvidia/nemotron-3-nano-30b-a3b");
  });
});
