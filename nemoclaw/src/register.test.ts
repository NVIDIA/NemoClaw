// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { OpenClawPluginApi } from "./index.js";

vi.mock("./runtime-context.js", () => ({
  registerRuntimeContext: vi.fn((api: OpenClawPluginApi) => {
    api.on("before_prompt_build", () => undefined);
  }),
}));

import register, { getPluginConfig } from "./index.js";

let stderrWrite: MockInstance<typeof process.stderr.write>;

function mockStderrWrite(): void {
  stderrWrite = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((() => true) as typeof process.stderr.write);
}

function stderrOutput(): string {
  return stderrWrite.mock.calls.map(([chunk]) => String(chunk)).join("");
}

function createMockApi(): OpenClawPluginApi {
  return {
    id: "nemoclaw",
    name: "NemoClaw",
    version: "0.1.0",
    config: {
      agents: { defaults: { model: { primary: "inference/nvidia/live-model" } } },
      models: {
        providers: {
          inference: {
            baseUrl: "https://inference.local/v1",
            apiKey: "${LIVE_KEY}",
            models: [{ id: "nvidia/live-model", contextWindow: 64000, maxTokens: 4000 }],
          },
        },
      },
    },
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

beforeEach(() => {
  vi.clearAllMocks();
  mockStderrWrite();
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

  it("registers the native model and credential reference without defaults", () => {
    const api = createMockApi();
    register(api);
    const provider = vi.mocked(api.registerProvider).mock.calls[0][0];
    expect(provider.models?.chat).toEqual([
      {
        id: "inference/nvidia/live-model",
        label: "nvidia/live-model",
        contextWindow: 64000,
        maxOutput: 4000,
      },
    ]);
    expect(provider.envVars).toEqual(["LIVE_KEY"]);
    expect(provider.auth[0].envVar).toBe("LIVE_KEY");
    expect(stderrOutput()).toContain("Model:     inference/nvidia/live-model");
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

  it("does not register a fallback provider when native primary is absent", () => {
    const api = createMockApi();
    api.config = {};
    register(api);
    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(stderrOutput()).toContain("Model:     (not configured)");
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });

  it("leaves a native provider change to OpenClaw", () => {
    const api = createMockApi();
    api.config = {
      agents: { defaults: { model: { primary: "anthropic/new-model" } } },
      models: { providers: { anthropic: { baseUrl: "https://native.example/v1" } } },
    };
    register(api);
    expect(api.registerProvider).not.toHaveBeenCalled();
    expect(stderrOutput()).toContain("Provider:  anthropic");
    expect(stderrOutput()).toContain("Model:     anthropic/new-model");
    expect(stderrOutput()).toContain("https://native.example/v1");
  });

  it("does not invent an environment credential for a native literal credential", () => {
    const api = createMockApi();
    api.config = {
      agents: { defaults: { model: { primary: "inference/changed-model" } } },
      models: { providers: { inference: { apiKey: "private-literal" } } },
    };
    register(api);
    expect(api.registerProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        envVars: [],
        auth: [],
        models: { chat: [{ id: "inference/changed-model", label: "changed-model" }] },
      }),
    );
    expect(stderrOutput()).not.toContain("private-literal");
  });
});

describe("before_tool_call secret scanner hook (#1233)", () => {
  function getHookHandler(api: OpenClawPluginApi) {
    register(api);
    const onCalls = vi.mocked(api.on).mock.calls;
    const hookCall = onCalls.find(([name]) => name === "before_tool_call");
    expect(hookCall).toBeDefined();
    return hookCall![1];
  }

  it("registers a before_tool_call hook", () => {
    const api = createMockApi();
    register(api);
    expect(api.on).toHaveBeenCalledWith("before_tool_call", expect.any(Function));
  });

  it("blocks write to memory path containing NVIDIA API key", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    const result = handler({
      toolName: "write",
      params: {
        file_path: "/sandbox/.openclaw/memory/project.md",
        content: `api key: ${fakeKey}`,
      },
    });
    expect(result).toMatchObject({ block: true });
    expect((result as { blockReason: string }).blockReason).toContain("NVIDIA API key");
  });

  it("blocks write to an absolute named workspace containing an NVIDIA API key", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    const result = handler({
      toolName: "write",
      params: {
        file_path: "/sandbox/.openclaw/workspace-main/memory/2026-05-29.md",
        content: `api key: ${fakeKey}`,
      },
    });
    expect(result).toMatchObject({ block: true });
  });

  it("blocks edit to memory path containing secrets", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeToken = "ghp_" + "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmn";
    const result = handler({
      toolName: "edit",
      params: {
        file_path: "/sandbox/.openclaw/memory/notes.md",
        new_string: `token: ${fakeToken}`,
      },
    });
    expect(result).toMatchObject({ block: true });
  });

  it("blocks apply_patch to memory path containing secrets", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeKey = "sk-" + "abc123def456ghi789jkl012mno";
    const result = handler({
      toolName: "apply_patch",
      params: {
        file_path: "/sandbox/.openclaw/agents/config.json",
        patch: fakeKey,
      },
    });
    expect(result).toMatchObject({ block: true });
  });

  it("blocks notebook_edit to memory path containing secrets", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    const result = handler({
      toolName: "notebook_edit",
      params: {
        file_path: "/sandbox/.openclaw/memory/notebook.ipynb",
        content: `api_key: ${fakeKey}`,
      },
    });
    expect(result).toMatchObject({ block: true });
  });

  it("allows write to memory path with clean content", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const result = handler({
      toolName: "write",
      params: {
        file_path: "/sandbox/.openclaw/memory/project.md",
        content: "# My Project\n\nThis is a regular memory note.",
      },
    });
    expect(result).toBeUndefined();
  });

  it("allows write to non-memory path even with secrets", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    const result = handler({
      toolName: "write",
      params: {
        file_path: "/sandbox/project/src/config.ts",
        content: `const key = '${fakeKey}';`,
      },
    });
    expect(result).toBeUndefined();
  });

  it("allows non-write tools regardless of content", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const result = handler({
      toolName: "read",
      params: {
        file_path: "/sandbox/.openclaw/memory/project.md",
      },
    });
    expect(result).toBeUndefined();
  });

  it("handles missing event gracefully", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    expect(handler(undefined)).toBeUndefined();
    expect(handler({})).toBeUndefined();
    expect(handler({ toolName: "write" })).toBeUndefined();
  });

  it("logs a warning when blocking", () => {
    const api = createMockApi();
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    void handler({
      toolName: "write",
      params: {
        file_path: "/sandbox/.openclaw/memory/creds.md",
        content: fakeKey,
      },
    });
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("[SECURITY] Blocked memory write"),
    );
  });

  it("does not throw when the host resolver returns undefined", () => {
    const api = createMockApi();
    (api.resolvePath as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined as unknown as string,
    );
    const handler = getHookHandler(api);
    expect(() =>
      handler({
        toolName: "write",
        params: {
          file_path: "IDENTITY.md",
          content: "# IDENTITY.md - Who Am I?\nhello",
        },
      }),
    ).not.toThrow();
  });

  it("blocks a relative workspace basename when the host resolver is unavailable", () => {
    const api = createMockApi();
    (api.resolvePath as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined as unknown as string,
    );
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    const result = handler({
      toolName: "write",
      params: {
        file_path: "IDENTITY.md",
        content: `api key: ${fakeKey}`,
      },
    });
    expect(result).toMatchObject({ block: true });
  });

  it.each([
    "./memory/2026-05-29.md",
    "foo/../memory/2026-05-29.md",
    "workspace-main/memory/2026-05-29.md",
  ])("blocks normalized relative memory path %s when the host resolver is unavailable", (path) => {
    const api = createMockApi();
    (api.resolvePath as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      undefined as unknown as string,
    );
    const handler = getHookHandler(api);
    const fakeKey = "nvapi-" + "abcdefghijklmnopqrstuvwxyz";
    const result = handler({
      toolName: "write",
      params: {
        path,
        content: `api key: ${fakeKey}`,
      },
    });
    expect(result).toMatchObject({ block: true });
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
