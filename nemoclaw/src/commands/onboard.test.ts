// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginLogger, NemoClawConfig } from "../index.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
  execSync: vi.fn(() => {
    throw new Error("command not found");
  }),
}));

vi.mock("../onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(() => null),
  saveOnboardConfig: vi.fn(),
}));

vi.mock("../onboard/prompt.js", () => ({
  promptInput: vi.fn(),
  promptConfirm: vi.fn(() => Promise.resolve(true)),
  promptSelect: vi.fn(),
}));

vi.mock("../onboard/validate.js", () => ({
  validateApiKey: vi.fn(() => Promise.resolve({ valid: true, models: [], error: null })),
  maskApiKey: vi.fn((key: string) => `****${key.slice(-4)}`),
}));

// Import after mocks are set up
const { execFileSync, execSync } = await import("node:child_process");
const { loadOnboardConfig, saveOnboardConfig } = await import("../onboard/config.js");
const { promptInput, promptConfirm, promptSelect } = await import("../onboard/prompt.js");
const { validateApiKey } = await import("../onboard/validate.js");
const { cliOnboard } = await import("./onboard.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultConfig: NemoClawConfig = {
  blueprintVersion: "latest",
  blueprintRegistry: "ghcr.io/nvidia/nemoclaw-blueprint",
  sandboxName: "openclaw",
  inferenceProvider: "nvidia",
};

function captureLogger(): { lines: string[]; logger: PluginLogger } {
  const lines: string[] = [];
  return {
    lines,
    logger: {
      info: (msg: string) => lines.push(msg),
      warn: (msg: string) => lines.push(`WARN: ${msg}`),
      error: (msg: string) => lines.push(`ERROR: ${msg}`),
      debug: (_msg: string) => {},
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(loadOnboardConfig).mockReturnValue(null);
  vi.mocked(saveOnboardConfig).mockReturnValue(undefined);
  vi.mocked(execFileSync).mockReturnValue("");
  // Default: execSync throws so detectOllama returns { installed: false, running: false }
  vi.mocked(execSync).mockImplementation(() => {
    throw new Error("not found");
  });
  vi.mocked(validateApiKey).mockResolvedValue({ valid: true, models: [], error: null });
  vi.mocked(promptConfirm).mockResolvedValue(true);
  vi.mocked(promptInput).mockResolvedValue("llama3");
  vi.mocked(promptSelect).mockResolvedValue("llama3");
});

afterEach(() => {
  delete process.env.OLLAMA_BASE_URL;
  delete process.env.NEMOCLAW_EXPERIMENTAL;
});

describe("cliOnboard — Ollama non-interactive", () => {
  it("uses default localhost URL when neither endpointUrl nor OLLAMA_BASE_URL is set", async () => {
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://localhost:11434/v1" }),
    );
  });

  it("prefers --endpoint-url flag over OLLAMA_BASE_URL env var", async () => {
    process.env.OLLAMA_BASE_URL = "http://ai.example.org:11434";
    const { logger } = captureLogger();
    await cliOnboard({
      endpoint: "ollama",
      model: "llama3",
      endpointUrl: "http://custom.example.org:11434",
      logger,
      pluginConfig: defaultConfig,
    });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://custom.example.org:11434/v1" }),
    );
  });

  it("uses OLLAMA_BASE_URL env var when no --endpoint-url flag is provided", async () => {
    process.env.OLLAMA_BASE_URL = "http://ai.example.org:11434";
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://ai.example.org:11434/v1" }),
    );
  });

  it("does not double-append /v1 when OLLAMA_BASE_URL already ends with /v1", async () => {
    process.env.OLLAMA_BASE_URL = "http://ai.example.org:11434/v1";
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://ai.example.org:11434/v1" }),
    );
  });

  it("normalizes URL with trailing slash", async () => {
    process.env.OLLAMA_BASE_URL = "http://ai.example.org:11434/";
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointUrl: "http://ai.example.org:11434/v1" }),
    );
  });

  it("creates provider with --type ollama (not openai)", async () => {
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(execFileSync).toHaveBeenCalledWith(
      "openshell",
      expect.arrayContaining(["--type", "ollama"]),
      expect.anything(),
    );
    expect(execFileSync).not.toHaveBeenCalledWith(
      "openshell",
      expect.arrayContaining(["--type", "openai"]),
      expect.anything(),
    );
  });

  it("creates provider with OLLAMA_BASE_URL config key (not OPENAI_BASE_URL)", async () => {
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    const calls = vi.mocked(execFileSync).mock.calls;
    const createCall = calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("create"),
    );
    expect(createCall).toBeDefined();
    const args = createCall![1] as string[];
    const configIdx = args.indexOf("--config");
    expect(configIdx).toBeGreaterThan(-1);
    expect(args[configIdx + 1]).toMatch(/^OLLAMA_BASE_URL=/);
    expect(args[configIdx + 1]).not.toMatch(/^OPENAI_BASE_URL=/);
  });

  it("saves config with ollama endpointType, profile, and credential", async () => {
    const { logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        endpointType: "ollama",
        profile: "ollama",
        credentialEnv: "OPENAI_API_KEY",
        model: "llama3",
      }),
    );
  });

  it("does not log an experimental warning for ollama endpoint", async () => {
    const { lines, logger } = captureLogger();
    await cliOnboard({ endpoint: "ollama", model: "llama3", logger, pluginConfig: defaultConfig });

    expect(lines.join("\n")).not.toContain("experimental");
  });
});

describe("cliOnboard — Ollama model selection (interactive)", () => {
  it("shows all discovered models for selection", async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      valid: true,
      models: ["llama3", "mistral", "phi3"],
      error: null,
    });
    vi.mocked(promptSelect).mockResolvedValue("mistral");

    const { logger } = captureLogger();
    await cliOnboard({
      endpoint: "ollama",
      endpointUrl: "http://localhost:11434/v1",
      logger,
      pluginConfig: defaultConfig,
    });

    expect(promptSelect).toHaveBeenCalledWith(expect.any(String), [
      { label: "llama3", value: "llama3" },
      { label: "mistral", value: "mistral" },
      { label: "phi3", value: "phi3" },
    ]);
  });

  it("does not filter for nemotron when endpoint is ollama", async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      valid: true,
      models: ["llama3", "mistral"],
      error: null,
    });
    vi.mocked(promptSelect).mockResolvedValue("llama3");

    const { logger } = captureLogger();
    await cliOnboard({
      endpoint: "ollama",
      endpointUrl: "http://localhost:11434/v1",
      logger,
      pluginConfig: defaultConfig,
    });

    const selectCall = vi.mocked(promptSelect).mock.calls[0];
    const options = selectCall[1] as Array<{ value: string }>;
    expect(options.map((o) => o.value)).toEqual(["llama3", "mistral"]);
  });

  it("falls back to free-text prompt when endpoint returns no models", async () => {
    vi.mocked(validateApiKey).mockResolvedValue({
      valid: false,
      models: [],
      error: "connection refused",
    });
    vi.mocked(promptInput).mockResolvedValue("mymodel");

    const { logger } = captureLogger();
    await cliOnboard({
      endpoint: "ollama",
      endpointUrl: "http://localhost:11434/v1",
      logger,
      pluginConfig: defaultConfig,
    });

    expect(promptInput).toHaveBeenCalledWith(
      expect.stringMatching(/model/i),
      expect.any(String),
    );
    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ model: "mymodel" }),
    );
  });
});

describe("cliOnboard — Ollama auto-detection", () => {
  it("auto-selects ollama without NEMOCLAW_EXPERIMENTAL when local Ollama is running", async () => {
    // Make execSync succeed only for the Ollama health-check curl command
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("api/tags")) return "";
      throw new Error("not found");
    });
    vi.mocked(promptInput).mockResolvedValue("llama3");

    const { lines, logger } = captureLogger();
    await cliOnboard({ logger, pluginConfig: defaultConfig });

    expect(lines.join("\n")).toContain("Detected Ollama");
    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointType: "ollama" }),
    );
  });

  it("does not require NEMOCLAW_EXPERIMENTAL to be set for auto-detection", async () => {
    delete process.env.NEMOCLAW_EXPERIMENTAL;
    vi.mocked(execSync).mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("api/tags")) return "";
      throw new Error("not found");
    });
    vi.mocked(promptInput).mockResolvedValue("llama3");

    const { logger } = captureLogger();
    await cliOnboard({ logger, pluginConfig: defaultConfig });

    expect(saveOnboardConfig).toHaveBeenCalledWith(
      expect.objectContaining({ endpointType: "ollama" }),
    );
  });
});
