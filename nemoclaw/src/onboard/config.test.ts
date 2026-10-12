// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, beforeEach, vi } from "vitest";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  loadOnboardConfig,
  saveOnboardConfig,
  clearOnboardConfig,
  type NemoClawOnboardConfig,
} from "./config.js";

// Mock node:fs so tests don't touch the real filesystem.
// The config module uses: existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync.
const store = new Map<string, string>();

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
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
    profile: "default",
    onboardedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("onboard/config", () => {
  beforeEach(() => {
    store.clear();
  });

  it("discards routing from historical onboarding snapshots", () => {
    const metadata = makeConfig();
    store.set(
      join(homedir(), ".nemoclaw", "config.json"),
      JSON.stringify({
        ...metadata,
        provider: "stale-provider",
        model: "stale/model",
        endpointUrl: "https://stale.example/v1",
        credentialEnv: "STALE_KEY",
      }),
    );
    expect(loadOnboardConfig()).toEqual(metadata);
  });

  describe("loadOnboardConfig", () => {
    it("returns null when no config file exists", () => {
      expect(loadOnboardConfig()).toBeNull();
    });

    it("returns parsed config when file exists", () => {
      const config = makeConfig();
      const configPath = join(homedir(), ".nemoclaw", "config.json");
      store.set(configPath, JSON.stringify(config));
      expect(loadOnboardConfig()).toEqual(config);
    });

    it("returns null when the parsed JSON root is not a valid onboard config", () => {
      const configPath = join(homedir(), ".nemoclaw", "config.json");
      store.set(configPath, JSON.stringify({ endpointType: "bogus" }));
      expect(loadOnboardConfig()).toBeNull();
    });

    it("returns null without throwing for an empty (0-byte) config file", () => {
      const configPath = join(homedir(), ".nemoclaw", "config.json");
      store.set(configPath, "");
      expect(() => loadOnboardConfig()).not.toThrow();
      expect(loadOnboardConfig()).toBeNull();
    });

    it("returns null without throwing for a whitespace-only config file", () => {
      const configPath = join(homedir(), ".nemoclaw", "config.json");
      store.set(configPath, "  \n\t  ");
      expect(() => loadOnboardConfig()).not.toThrow();
      expect(loadOnboardConfig()).toBeNull();
    });

    it("returns null without throwing for malformed JSON", () => {
      const configPath = join(homedir(), ".nemoclaw", "config.json");
      store.set(configPath, "{ not json");
      expect(() => loadOnboardConfig()).not.toThrow();
      expect(loadOnboardConfig()).toBeNull();
    });
  });

  describe("saveOnboardConfig", () => {
    it("writes config and can be loaded back", () => {
      const config = makeConfig({ profile: "custom" });
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
