// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NemoClawOnboardConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// In-memory filesystem store
const fsStore: Record<string, string> = {};
let dirCreated = false;

vi.mock("node:fs", () => ({
  existsSync: vi.fn((path: string) => path in fsStore || (path.endsWith(".nemoclaw") && dirCreated)),
  mkdirSync: vi.fn((_path: string) => {
    dirCreated = true;
  }),
  readFileSync: vi.fn((path: string) => {
    if (path in fsStore) return fsStore[path];
    throw new Error(`ENOENT: no such file or directory, open '${path}'`);
  }),
  writeFileSync: vi.fn((path: string, data: string) => {
    fsStore[path] = data;
  }),
  unlinkSync: vi.fn((path: string) => {
    delete fsStore[path];
  }),
}));

// Import after mocks are set up
const { loadOnboardConfig, saveOnboardConfig, clearOnboardConfig } = await import("./config.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sampleConfig(): NemoClawOnboardConfig {
  return {
    endpointType: "build",
    endpointUrl: "https://integrate.api.nvidia.com/v1",
    ncpPartner: null,
    model: "nvidia/nemotron-3-super-120b-a12b",
    profile: "default",
    credentialEnv: "NVIDIA_API_KEY",
    onboardedAt: "2026-03-15T10:30:00.000Z",
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  // Clear in-memory filesystem
  for (const key of Object.keys(fsStore)) {
    delete fsStore[key];
  }
  dirCreated = false;
});

describe("loadOnboardConfig", () => {
  it("returns null when config file does not exist", () => {
    const result = loadOnboardConfig();
    expect(result).toBeNull();
  });
});

describe("saveOnboardConfig + loadOnboardConfig", () => {
  it("round-trips a config through save and load", () => {
    const config = sampleConfig();

    saveOnboardConfig(config);
    const loaded = loadOnboardConfig();

    expect(loaded).toEqual(config);
  });

  it("overwrites existing config on second save", () => {
    const config1 = sampleConfig();
    saveOnboardConfig(config1);

    const config2: NemoClawOnboardConfig = {
      ...config1,
      model: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
      endpointType: "nim-local",
    };
    saveOnboardConfig(config2);

    const loaded = loadOnboardConfig();
    expect(loaded).toEqual(config2);
    expect(loaded!.model).toBe("nvidia/llama-3.1-nemotron-ultra-253b-v1");
  });
});

describe("clearOnboardConfig", () => {
  it("removes an existing config", () => {
    saveOnboardConfig(sampleConfig());
    expect(loadOnboardConfig()).not.toBeNull();

    clearOnboardConfig();
    expect(loadOnboardConfig()).toBeNull();
  });

  it("does not throw when config file does not exist", () => {
    expect(() => clearOnboardConfig()).not.toThrow();
  });
});
