// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginLogger, NemoClawConfig } from "../index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  execSync: vi.fn(() => ""),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(() => null),
  saveOnboardConfig: vi.fn(),
}));

vi.mock("../onboard/validate.js", () => ({
  validateApiKey: vi.fn(async () => ({ valid: true, models: ["nvidia/test-model"], error: null })),
  maskApiKey: (k: string) => `****${k.slice(-4)}`,
}));

vi.mock("../onboard/prompt.js", () => ({
  promptInput: vi.fn(async () => ""),
  promptConfirm: vi.fn(async () => true),
  promptSelect: vi.fn(async (_, opts: { value: string }[]) => opts[0]?.value ?? ""),
}));

const { execFileSync } = await import("node:child_process");
const { cliOnboard } = await import("./onboard.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger(): PluginLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

const defaultPluginConfig: NemoClawConfig = {
  sandboxName: "openclaw",
  blueprintVersion: "0.1.0",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  inferenceProvider: "nvidia",
};

// Capture all execFileSync("openshell", ...) calls and return the arg arrays
function openshellCalls(): string[][] {
  return (vi.mocked(execFileSync).mock.calls as unknown as [string, string[]][])
    .filter(([cmd]) => cmd === "openshell")
    .map(([, args]) => args);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let _prevExperimental: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  _prevExperimental = process.env.NEMOCLAW_EXPERIMENTAL;
  // Default: NEMOCLAW_EXPERIMENTAL=1 so ollama endpoint is available
  process.env.NEMOCLAW_EXPERIMENTAL = "1";
});

afterEach(() => {
  if (_prevExperimental === undefined) {
    delete process.env.NEMOCLAW_EXPERIMENTAL;
  } else {
    process.env.NEMOCLAW_EXPERIMENTAL = _prevExperimental;
  }
});

describe("cliOnboard — ollama provider config", () => {
  it("passes OLLAMA_REASONING_EFFORT=none when endpoint is ollama", async () => {
    await cliOnboard({
      endpoint: "ollama",
      model: "llama3.2",
      logger: makeLogger(),
      pluginConfig: defaultPluginConfig,
    });

    const calls = openshellCalls();
    const providerCall = calls.find((args) => args.includes("provider") && args.includes("create"));
    expect(providerCall).toBeDefined();
    expect(providerCall).toContain("--config");
    expect(providerCall).toContain("OLLAMA_REASONING_EFFORT=none");
  });

  it("does NOT pass OLLAMA_REASONING_EFFORT for non-ollama endpoint", async () => {
    await cliOnboard({
      endpoint: "build",
      model: "nvidia/nemotron-3-super-120b-a12b",
      apiKey: "nvapi-test1234",
      logger: makeLogger(),
      pluginConfig: defaultPluginConfig,
    });

    const calls = openshellCalls();
    const allArgs = calls.flat().join(" ");
    expect(allArgs).not.toContain("OLLAMA_REASONING_EFFORT");
  });

  it("includes OLLAMA_REASONING_EFFORT=none in provider update when provider already exists", async () => {
    // Make provider create throw AlreadyExists to trigger the update path
    vi.mocked(execFileSync).mockImplementationOnce(() => {
      const err = Object.assign(new Error("AlreadyExists"), { stderr: "AlreadyExists" });
      throw err;
    });

    await cliOnboard({
      endpoint: "ollama",
      model: "deepseek-r1:7b",
      logger: makeLogger(),
      pluginConfig: defaultPluginConfig,
    });

    const calls = openshellCalls();
    const updateCall = calls.find((args) => args.includes("provider") && args.includes("update"));
    expect(updateCall).toBeDefined();
    expect(updateCall).toContain("OLLAMA_REASONING_EFFORT=none");
  });
});
