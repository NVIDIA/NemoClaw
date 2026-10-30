// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadSwitchyardOnboardConfig,
  parseSwitchyardOnboardConfig,
  SWITCHYARD_ONBOARD_CONFIG_MAX_BYTES,
} from "./config";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-switchyard-config-"));
});

afterEach(() => {
  fs.rmSync(root, { force: true, recursive: true });
});

function validConfig(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    efficient: { provider: "nvidia-prod", model: "nvidia/nemotron-nano" },
    capable: { provider: "openai-api", model: "gpt-5.2" },
    ...overrides,
  });
}

describe("Switchyard onboarding config", () => {
  it("accepts only high-level efficient and capable selections (#13862)", () => {
    expect(parseSwitchyardOnboardConfig(validConfig())).toMatchObject({
      routeId: "switchyard",
      efficient: { provider: "nvidia-prod", model: "nvidia/nemotron-nano" },
      capable: { provider: "openai-api", model: "gpt-5.2" },
      judge: { mode: "reuse-capable", target: "capable" },
    });
  });

  it.each([
    ["unknown top-level fields", validConfig({ endpoint: "https://example.test/v1" })],
    ["raw credential fields", validConfig({ apiKey: "sk-test-secret-value" })],
    ["Relay fragments", validConfig({ plugins: { dynamic: [] } })],
    ["Switchyard fragments", validConfig({ routes: { switchyard: { type: "weighted_random" } } })],
    [
      "target fields outside the schema",
      validConfig({
        efficient: {
          provider: "nvidia-prod",
          model: "nvidia/nemotron-nano",
          baseUrl: "https://example.test/v1",
        },
      }),
    ],
    ["a user-selected judge", validConfig({ judge: { provider: "nvidia-prod", model: "judge" } })],
    [
      "duplicate JSON keys",
      '{"schemaVersion":1,"schemaVersion":1,"efficient":{"provider":"nvidia-prod","model":"model-a"},"capable":{"provider":"openai-api","model":"model-b"}}',
    ],
  ])("rejects %s (#13862)", (_name, config) => {
    expect(() => parseSwitchyardOnboardConfig(config)).toThrow("Invalid --switchyard-config");
  });

  it("reads one bounded regular UTF-8 file and rejects links (#13862)", () => {
    const configPath = path.join(root, "switchyard.json");
    const linkPath = path.join(root, "switchyard-link.json");
    const hardLinkPath = path.join(root, "switchyard-hard-link.json");
    fs.writeFileSync(configPath, validConfig(), { mode: 0o600 });
    fs.symlinkSync(configPath, linkPath);

    expect(loadSwitchyardOnboardConfig(configPath).routeId).toBe("switchyard");
    expect(() => loadSwitchyardOnboardConfig(linkPath)).toThrow("not a symlink");
    fs.linkSync(configPath, hardLinkPath);
    expect(() => loadSwitchyardOnboardConfig(hardLinkPath)).toThrow("stable regular file");
  });

  it("rejects oversized and invalid UTF-8 files (#13862)", () => {
    const oversized = path.join(root, "oversized.json");
    const invalidUtf8 = path.join(root, "invalid-utf8.json");
    fs.writeFileSync(oversized, "x".repeat(SWITCHYARD_ONBOARD_CONFIG_MAX_BYTES + 1));
    fs.writeFileSync(invalidUtf8, Buffer.from([0xff, 0xfe]));

    expect(() => loadSwitchyardOnboardConfig(oversized)).toThrow("must not exceed");
    expect(() => loadSwitchyardOnboardConfig(invalidUtf8)).toThrow("valid UTF-8");
  });
});
