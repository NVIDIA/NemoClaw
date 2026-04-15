// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OpenClawPluginApi } from "./index.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("./onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(() => "build.nvidia.com"),
  describeOnboardProvider: vi.fn(() => "NVIDIA Endpoint API"),
}));

import { execFileSync } from "node:child_process";
import register, { getPluginConfig } from "./index.js";
import { loadOnboardConfig } from "./onboard/config.js";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);

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
  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockReset();
    mockedLoadOnboardConfig.mockReturnValue(null);
  });

  it("registers a slash command", () => {
    const api = createMockApi();
    register(api);
    expect(api.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "nemoclaw" }));
  });

  it("registers an inference provider", () => {
    const api = createMockApi();
    register(api);
    expect(api.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "inference" }));
  });

  it("does NOT register CLI commands", () => {
    const api = createMockApi();
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

  it("uses probed OpenShell provider and model when onboard config is unavailable", () => {
    mockedExecFileSync.mockReturnValue(
      JSON.stringify({
        provider: "Ollama",
        endpoint: "http://host.docker.internal:11434/v1",
        model: "llama3.2:latest",
      }),
    );

    const api = createMockApi();
    register(api);

    const providerArg = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(providerArg.models?.chat).toEqual([
      expect.objectContaining({
        id: "inference/llama3.2:latest",
        label: "llama3.2:latest",
      }),
    ]);

    const logLines = vi.mocked(api.logger.info).mock.calls.map(([message]) => message);
    expect(
      logLines.some((line) => line.includes("Endpoint:  http://host.docker.internal:11434/v1")),
    ).toBe(true);
    expect(logLines.some((line) => line.includes("Provider:  Ollama"))).toBe(true);
    expect(logLines.some((line) => line.includes("Model:     llama3.2:latest"))).toBe(true);
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
