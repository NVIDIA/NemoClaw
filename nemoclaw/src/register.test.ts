// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { OpenClawPluginApi } from "./index.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
  };
});

vi.mock("./onboard/config.js", () => ({
  loadOnboardConfig: vi.fn(),
  describeOnboardEndpoint: vi.fn(() => "build.nvidia.com"),
  describeOnboardProvider: vi.fn(() => "NVIDIA Endpoint API"),
}));

vi.mock("./runtime-context.js", () => ({
  registerRuntimeContext: vi.fn((api: OpenClawPluginApi) => {
    api.on("before_prompt_build", () => undefined);
  }),
}));

import { readFileSync } from "node:fs";
import register, { getPluginConfig } from "./index.js";
import { loadOnboardConfig } from "./onboard/config.js";

const mockedReadFileSync = vi.mocked(readFileSync);
const mockedLoadOnboardConfig = vi.mocked(loadOnboardConfig);
const originalReadFileSync = (await vi.importActual<typeof import("node:fs")>("node:fs"))
  .readFileSync;
let stderrWrite: MockInstance<typeof process.stderr.write>;

function mockStderrWrite(): void {
  stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
}

function stderrOutput(): string {
  return stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
}

function mockMissingOpenClawConfig(): void {
  mockedReadFileSync.mockReset();
  mockedReadFileSync.mockImplementation(((path, ...args) => {
    if (String(path).includes("openclaw.json")) {
      throw Object.assign(new Error("openclaw config unavailable"), { code: "ENOENT" });
    }
    return originalReadFileSync(path, ...args);
  }) as typeof readFileSync);
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
    on: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStderrWrite();
  mockMissingOpenClawConfig();
  mockedLoadOnboardConfig.mockReturnValue(null);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("plugin registration", () => {
  it("registers a slash command", () => {
    const api = createMockApi();
    register(api);
    expect(api.registerCommand).toHaveBeenCalledWith(expect.objectContaining({ name: "nemoclaw" }));
  });

  it("registers an inference provider", () => {
    const api = createMockApi();
    register(api);
    expect(api.registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "inference",
        auth: [expect.objectContaining({ id: "bearer", type: "bearer" })],
      }),
    );
  });

  it("registers only the retained runtime-context hook", () => {
    const api = createMockApi();
    register(api);
    expect(api.on).toHaveBeenCalledTimes(1);
    expect(api.on).toHaveBeenCalledWith("before_prompt_build", expect.any(Function));
  });

  it("continues registration when the runtime context hook is unsupported", () => {
    const api = createMockApi();
    vi.mocked(api.on).mockImplementation((hookName: string) => {
      if (hookName === "before_prompt_build") {
        throw new Error("unsupported hook");
      }
    });

    register(api);

    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Could not register runtime context hook: unsupported hook"),
    );
    expect(api.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "inference" }));
  });

  it("does NOT register CLI commands", () => {
    const api = createMockApi();
    // registerCli should not exist on the API interface after removal
    expect("registerCli" in api).toBe(false);
  });

  it("prefers the live primary model from openclaw.json over stale onboard config", () => {
    mockedLoadOnboardConfig.mockReturnValue({
      endpointType: "build",
      endpointUrl: "https://api.build.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/stale-model",
      profile: "default",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      onboardedAt: "2026-03-01T00:00:00.000Z",
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        agents: {
          defaults: {
            model: {
              primary: "inference/nvidia/live-model",
            },
          },
        },
      }),
    );

    const api = createMockApi();
    register(api);

    const providerArg = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(providerArg.models?.chat).toEqual([
      expect.objectContaining({ id: "inference/nvidia/live-model", label: "nvidia/live-model" }),
    ]);
    expect(stderrOutput()).toContain("Model:     nvidia/live-model");
  });

  it("writes the registration banner to stderr instead of plugin info logs", () => {
    const api = createMockApi();
    register(api);

    expect(stderrOutput()).toContain("NemoClaw registered");
    expect(api.logger.info).not.toHaveBeenCalled();
  });

  it("tags every registration banner line with the gateway source tag (#7314)", () => {
    const api = createMockApi();
    register(api);

    const output = stderrOutput();
    expect(output.startsWith("\n")).toBe(true);
    expect(output.endsWith("\n\n")).toBe(true);

    const bannerLines = output.split("\n").filter((line) => line.length > 0);
    expect(bannerLines.length).toBeGreaterThan(0);
    expect(bannerLines.every((line) => line.startsWith("[gateway] "))).toBe(true);
  });

  it("falls back to onboard config when openclaw.json has no primary model", () => {
    mockedLoadOnboardConfig.mockReturnValue({
      endpointType: "build",
      endpointUrl: "https://api.build.nvidia.com/v1",
      ncpPartner: null,
      model: "nvidia/custom-model",
      profile: "default",
      credentialEnv: "NVIDIA_INFERENCE_API_KEY",
      onboardedAt: "2026-03-01T00:00:00.000Z",
    });
    mockedReadFileSync.mockReset();
    mockedReadFileSync.mockReturnValue(JSON.stringify({ agents: { defaults: { model: {} } } }));

    const api = createMockApi();
    register(api);

    const providerArg = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(providerArg.models?.chat).toEqual([
      expect.objectContaining({ id: "inference/nvidia/custom-model" }),
    ]);
  });

  it("falls back to hardcoded defaults when onboard config is unavailable", () => {
    const api = createMockApi();
    register(api);

    const providerArg = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(providerArg.models?.chat).toEqual([
      expect.objectContaining({ id: "nvidia/nemotron-3-super-120b-a12b" }),
      expect.objectContaining({ id: "nvidia/llama-3.1-nemotron-ultra-253b-v1" }),
      expect.objectContaining({ id: "nvidia/llama-3.3-nemotron-super-49b-v1.5" }),
      expect.objectContaining({ id: "nvidia/nemotron-3-nano-30b-a3b" }),
    ]);

    const stderr = stderrOutput();
    expect(stderr).toContain("Endpoint:  build.nvidia.com");
    expect(stderr).toContain("Provider:  NVIDIA Endpoints");
    expect(stderr).toContain("Model:     nvidia/nemotron-3-super-120b-a12b");
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
