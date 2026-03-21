// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  describeOnboardEndpoint,
  describeOnboardProvider,
  loadOnboardConfig,
  saveOnboardConfig,
  clearOnboardConfig,
  type NemoClawOnboardConfig,
  type EndpointType,
} from "./config.js";

// Mock node:fs so tests don't touch the real filesystem.
// The config module uses: existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync.
const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    existsSync: (p: string) => store.has(p),
    mkdirSync: vi.fn(),
    readFileSync: (p: string) => {
      const content = store.get(p);
      if (content === undefined) throw new Error(`ENOENT: ${p}`);
      return content;
    },
    writeFileSync: (p: string, data: string) => {
      store.set(p, data);
    },
    unlinkSync: (p: string) => {
      store.delete(p);
    },
  };
});

function makeConfig(overrides: Partial<NemoClawOnboardConfig> = {}): NemoClawOnboardConfig {
  return {
    endpointType: "build",
    endpointUrl: "https://api.build.nvidia.com/v1",
    ncpPartner: null,
    model: "nvidia/nemotron-3-super-120b-a12b",
    profile: "default",
    credentialEnv: "NVIDIA_API_KEY",
    onboardedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("onboard/config", () => {
  beforeEach(() => {
    store.clear();
  });

  // -------------------------------------------------------------------------
  // describeOnboardEndpoint
  // -------------------------------------------------------------------------

  describe("describeOnboardEndpoint", () => {
    it("returns managed route description for inference.local", () => {
      const config = makeConfig({ endpointUrl: "https://inference.local/v1" });
      expect(describeOnboardEndpoint(config)).toBe("Managed Inference Route (inference.local)");
    });

    it("returns type and URL for other endpoints", () => {
      const config = makeConfig({
        endpointType: "ollama",
        endpointUrl: "http://localhost:11434/v1",
      });
      expect(describeOnboardEndpoint(config)).toBe("ollama (http://localhost:11434/v1)");
    });
  });

  // -------------------------------------------------------------------------
  // describeOnboardProvider
  // -------------------------------------------------------------------------

  describe("describeOnboardProvider", () => {
    it("returns providerLabel when set", () => {
      const config = makeConfig({ providerLabel: "My Custom Provider" });
      expect(describeOnboardProvider(config)).toBe("My Custom Provider");
    });

    const endpointCases: [EndpointType, string][] = [
      ["build", "NVIDIA Endpoint API"],
      ["ollama", "Local Ollama"],
      ["vllm", "Local vLLM"],
      ["nim-local", "Local NIM"],
      ["ncp", "NVIDIA Cloud Partner"],
      ["custom", "Managed Inference Route"],
    ];

    for (const [endpointType, expected] of endpointCases) {
      it(`returns "${expected}" for endpoint type "${endpointType}"`, () => {
        const config = makeConfig({ endpointType, providerLabel: undefined });
        expect(describeOnboardProvider(config)).toBe(expected);
      });
    }
  });

  // -------------------------------------------------------------------------
  // loadOnboardConfig / saveOnboardConfig / clearOnboardConfig
  // -------------------------------------------------------------------------

  describe("loadOnboardConfig", () => {
    it("returns null when no config file exists", () => {
      expect(loadOnboardConfig()).toBeNull();
    });

    it("returns parsed config when file exists", () => {
      const config = makeConfig();
      const configPath = `${process.env.HOME ?? "/tmp"}/.nemoclaw/config.json`;
      store.set(configPath, JSON.stringify(config));
      expect(loadOnboardConfig()).toEqual(config);
    });
  });

  describe("saveOnboardConfig", () => {
    it("writes config and can be loaded back", () => {
      const config = makeConfig({ model: "nvidia/test-model" });
      saveOnboardConfig(config);
      const loaded = loadOnboardConfig();
      expect(loaded).toEqual(config);
    });
  });

  describe("clearOnboardConfig", () => {
    it("removes existing config file", () => {
      const config = makeConfig();
      saveOnboardConfig(config);
      expect(loadOnboardConfig()).not.toBeNull();
      clearOnboardConfig();
      expect(loadOnboardConfig()).toBeNull();
    });

    it("does not throw when no config file exists", () => {
      expect(() => {
        clearOnboardConfig();
      }).not.toThrow();
    });
  });
});
