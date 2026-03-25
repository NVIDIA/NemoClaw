// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import type { OpenClawPluginApi } from "./index.js";

async function loadRegister() {
  vi.resetModules();
  const mod = await import("./index.js");
  return mod.default;
}

function createMockApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {},
    pluginConfig: {},
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerCommand: vi.fn(),
    registerProvider: vi.fn(),
    registerService: vi.fn(),
    resolvePath: vi.fn((p: string) => p),
    on: vi.fn(),
  };
}

describe("plugin registration", () => {
  it("registers a slash command", async () => {
    const api = createMockApi();
    const register = await loadRegister();
    register(api);
    expect(api.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "nemoclaw" }));
  });

  it("registers an inference provider", async () => {
    const api = createMockApi();
    const register = await loadRegister();
    register(api);
    expect(api.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "inference" }));
  });

  it("advertises conservative model limits for Ollama-backed sandboxes", async () => {
    const previousHome = process.env.HOME;
    const homeDir = mkdtempSync(join(tmpdir(), "nemoclaw-plugin-"));
    const configDir = join(homeDir, ".nemoclaw");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.json"),
      JSON.stringify({
        endpointType: "custom",
        endpointUrl: "https://inference.local/v1",
        ncpPartner: null,
        model: "qwen3.5:35b-a3b",
        profile: "inference-local",
        credentialEnv: "OPENAI_API_KEY",
        contextWindow: 8192,
        maxTokens: 4096,
        provider: "ollama-local",
        providerLabel: "Local Ollama",
        onboardedAt: "2026-03-21T18:00:00.000Z",
      }),
    );

    process.env.HOME = homeDir;

    try {
      const api = createMockApi();
      const register = await loadRegister();
      register(api);
      expect(api.registerProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "inference",
          models: {
            chat: [
              expect.objectContaining({
                id: "inference/qwen3.5:35b-a3b",
                contextWindow: 8192,
                maxOutput: 4096,
              }),
            ],
          },
        }),
      );
    } finally {
      process.env.HOME = previousHome;
    }
  });

  it("does NOT register CLI commands", async () => {
    const api = createMockApi();
    await loadRegister();
    // registerCli should not exist on the API interface after removal
    expect("registerCli" in api).toBe(false);
  });

  it("registers custom model when onboard config has a model", () => {
    mockedLoadOnboardConfig.mockReturnValue({
      endpointType: "build",
      endpointUrl: "https://api.build.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/custom-model",
      profile: "default",
      credentialEnv: "NVIDIA_API_KEY",
      onboardedAt: "2026-03-01T00:00:00.000Z",
    });
    const api = createMockApi();
    register(api);
    const providerArg = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(providerArg.models?.chat).toEqual([
      expect.objectContaining({ id: "inference/nvidia/custom-model" }),
    ]);
  });
});

describe("getPluginConfig", () => {
  it("returns defaults when pluginConfig is undefined", () => {
    const api = createMockApi();
    api.pluginConfig = undefined;
    const config = getPluginConfig(api);
    expect(config.blueprintVersion).toBe("latest");
    expect(config.blueprintRegistry).toBe("ghcr.io/nvidia/nemoclaw-blueprint");
    expect(config.sandboxName).toBe("openclaw");
    expect(config.inferenceProvider).toBe("nvidia");
  });

  it("returns defaults when pluginConfig has non-string values", () => {
    const api = createMockApi();
    api.pluginConfig = { blueprintVersion: 42, sandboxName: true };
    const config = getPluginConfig(api);
    expect(config.blueprintVersion).toBe("latest");
    expect(config.sandboxName).toBe("openclaw");
  });

  it("uses string values from pluginConfig", () => {
    const api = createMockApi();
    api.pluginConfig = {
      blueprintVersion: "2.0.0",
      blueprintRegistry: "ghcr.io/custom/registry",
      sandboxName: "custom-sandbox",
      inferenceProvider: "openai",
    };
    const config = getPluginConfig(api);
    expect(config.blueprintVersion).toBe("2.0.0");
    expect(config.blueprintRegistry).toBe("ghcr.io/custom/registry");
    expect(config.sandboxName).toBe("custom-sandbox");
    expect(config.inferenceProvider).toBe("openai");
  });
});
