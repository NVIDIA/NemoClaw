// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  onTestFinished,
  vi,
} from "vitest";
import type { OpenClawPluginApi } from "./index.js";

vi.mock("./runtime-context.js", () => ({
  registerRuntimeContext: vi.fn((api: OpenClawPluginApi) => {
    api.on("before_prompt_build", () => undefined);
  }),
}));

// A smaller supported limit exercises overflow with a direct three-turn setup.
vi.mock("./denied-search-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./denied-search-state.js")>();
  return {
    ...actual,
    DeniedSearchState: class extends actual.DeniedSearchState {
      constructor(onCapacity: () => void) {
        super(onCapacity, 2);
      }
    },
  };
});

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

  it.each([
    { hook: "before_prompt_build", enabled: false },
    { hook: "before_prompt_build", enabled: true },
    { hook: "before_agent_run", enabled: false },
    { hook: "before_tool_call", enabled: false },
    { hook: "before_agent_run", enabled: true },
    { hook: "before_tool_call", enabled: true },
    { hook: "gateway_stop", enabled: false },
    { hook: "agent_end", enabled: false },
  ])(
    "refuses plugin registration when required $hook fails with search enabled=$enabled",
    ({ hook, enabled }) => {
      const api = createMockApi();
      api.config.tools = { web: { search: { enabled } } };
      const failure = new Error("unsupported required hook");
      vi.mocked(api.on).mockImplementation((hookName) => {
        if (hookName === hook) throw failure;
      });
      expect(() => register(api)).toThrow(failure);
      expect(stderrOutput()).not.toContain("NemoClaw registered");
    },
  );

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

describe("disabled web search before_tool_call hook (#13594)", () => {
  function searchHook(enabled: boolean | undefined) {
    const api = createMockApi();
    api.config.tools = { web: { search: { enabled } } };
    register(api);
    const handler = vi.mocked(api.on).mock.calls.find(([name]) => name === "before_tool_call")?.[1];
    expect(handler).toBeDefined();
    onTestFinished(async () => {
      const stop = vi.mocked(api.on).mock.calls.find(([name]) => name === "gateway_stop")?.[1];
      await stop?.({}, {});
    });
    const admission = vi
      .mocked(api.on)
      .mock.calls.find(([name]) => name === "before_agent_run")?.[1];
    // Tool-hook cases enter through the same admission gate as a host turn.
    const admittedHandler: typeof handler = (...args) => {
      void admission?.(...args);
      return handler!(...args);
    };
    return { api, handler: admittedHandler!, admission: admission! };
  }

  it.each([
    { toolName: "web_search", params: { query: "NemoClaw installation" } },
    { toolName: "openclaw:core:web_search", params: {} },
    { toolName: "TAVILY_SEARCH", params: { query: "installation" } },
    { toolName: "brave_search", params: {} },
    { toolName: "search", params: { query: "official installation documentation" } },
    { toolName: "tool_search", params: { query: "search" } },
    {
      toolName: "tool_call",
      params: { id: "openclaw:core:tool_search", args: { query: "Tavily" } },
    },
    { toolName: "tool_search", params: { query: "Tavily" } },
    { toolName: "tool_describe", params: { id: "openclaw:core:web_search" } },
    {
      toolName: "tool_call",
      params: { id: "openclaw:core:web_search", args: { query: "install" } },
    },
    { toolName: "exec", params: { command: "curl https://api.tavily.com/search" } },
    { toolName: "web_fetch", params: { url: "https://api.search.brave.com/res/v1/web/search" } },
  ])("blocks disabled search and provider probing: $toolName $params", (event) => {
    const { handler } = searchHook(false);
    expect(handler(event)).toMatchObject({
      block: true,
      blockReason: expect.stringContaining("Web search is unavailable in this sandbox"),
    });
  });

  it.each([
    {
      toolName: "tool_call",
      params: {
        id: "openclaw:core:web_fetch",
        args: { url: "https://docs.nvidia.com/nemoclaw/install" },
      },
    },
    {
      toolName: "web_fetch",
      params: { url: "https://nvidianews.nvidia.com/news/nvidia-announces-nemoclaw" },
    },
    { toolName: "memory_search", params: { query: "NemoClaw installation documentation" } },
    {
      toolName: "exec",
      params: { command: "find /sandbox/.openclaw/extensions/nemoclaw -type f" },
    },
    {
      toolName: "read",
      params: { file_path: "/usr/local/lib/nemoclaw/openclaw-runtime/docs/start/why-openclaw.md" },
    },
    { toolName: "read", params: { file_path: "/sandbox/project/README.md" } },
  ])(
    "blocks substitute probing only in the run whose search was denied: $toolName $params",
    (event) => {
      const { handler } = searchHook(false);
      expect(handler({ toolName: "web_search", params: {}, runId: "search-run" })).toMatchObject({
        block: true,
      });
      expect(handler({ ...event, runId: "search-run" })).toMatchObject({ block: true });
      expect(handler({ ...event, runId: "other-run" })).toBeUndefined();
    },
  );

  it.each([
    { toolName: "read", params: { file_path: "/sandbox/project/nemoclaw-installation.md" } },
    { toolName: "web_fetch", params: { url: "https://docs.tavily.com/documentation" } },
    { toolName: "read", params: { file_path: "/sandbox/project/search-provider-config.md" } },
    { toolName: "exec", params: { command: "cat /sandbox/project/nemoclaw-installation.md" } },
    { toolName: "memory_search", params: { query: "my NemoClaw installation notes" } },
    {
      toolName: "web_fetch",
      params: { url: "https://docs.nvidia.com/nemoclaw/latest/get-started" },
    },
  ])(
    "allows ordinary local and direct-fetch work before search is attempted: $toolName $params",
    (event) => {
      const { handler } = searchHook(false);
      expect(handler({ ...event, runId: "ordinary-run" })).toBeUndefined();
    },
  );

  it.each([true, undefined])("allows search when enabled is %s", (enabled) => {
    const { handler } = searchHook(enabled);
    expect(handler({ toolName: "web_search", params: { query: "NemoClaw" } })).toBeUndefined();
  });

  it.each([
    { toolName: "web_fetch", params: { url: "https://www.wikidata.org/wiki/Q1" } },
    {
      toolName: "tool_call",
      params: { id: "openclaw:core:web_fetch", args: { url: "https://example.com" } },
    },
    { toolName: "exec", params: { command: "curl https://wttr.in/:help" } },
    { toolName: "read", params: { file_path: "/sandbox/project/README.md" } },
    { toolName: "exec", params: { command: "rg search /sandbox/project" } },
    { toolName: "web_fetch", params: { url: "https://nvidianews.nvidia.com/news/earnings" } },
    { toolName: "tool_search", params: { query: "execute shell command" } },
    { toolName: "memory_search", params: { query: "my shopping list" } },
  ])(
    "preserves unrelated tools in identified runs when search is disabled: $toolName $params",
    (event) => {
      const { handler } = searchHook(false);
      expect(handler(event, { runId: "ordinary-run" })).toBeUndefined();
    },
  );

  it.each([
    {},
    { tools: null },
    { tools: [] },
    { tools: { web: [] } },
    { tools: { web: { search: null } } },
    { tools: { web: { search: [] } } },
    { tools: { web: { search: { enabled: true } } } },
    { tools: { web: { search: { enabled: "false" } } } },
  ])("does not infer disabled search from malformed configuration: %j", (config) => {
    const { api, handler } = searchHook(false);
    api.config = config;
    expect(handler({ toolName: "web_search", params: {} })).toBeUndefined();
  });

  it("reads configuration changes without registering another hook", () => {
    const { api, handler } = searchHook(true);
    api.config.tools = { web: { search: { enabled: false } } };
    expect(handler({ toolName: "web_search", params: {} })).toMatchObject({ block: true });
  });

  it.each([true, false])(
    "clears denied-search state after a run ends with success=%s",
    async (success) => {
      const { api, handler } = searchHook(false);
      await handler({ toolName: "web_search", params: {} }, { runId: "finished-run" });
      const end = vi.mocked(api.on).mock.calls.find(([name]) => name === "agent_end")?.[1];
      expect(end).toBeDefined();
      await end!({ success }, { runId: "finished-run" });
      expect(
        handler(
          { toolName: "read", params: { file_path: "/sandbox/project/nemoclaw-installation.md" } },
          { runId: "finished-run" },
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    { toolName: "read", params: { file_path: "/sandbox/project/nemoclaw-installation.md" } },
    { toolName: "exec", params: { command: "cat README.md" } },
    { toolName: "memory_search", params: { query: "installation" } },
    { toolName: "web_fetch", params: { url: "https://example.com/install" } },
    { toolName: "tool_search", params: { query: "read file" } },
  ])(
    "keeps unidentified substitutes blocked across unrelated lifecycle events: $toolName",
    async (event) => {
      const { api, handler } = searchHook(false);
      expect(handler(event)).toMatchObject({ block: true });
      expect(handler({ toolName: "web_search", params: {} })).toMatchObject({ block: true });
      expect(handler(event)).toMatchObject({ block: true });
      expect(handler(event, { runId: "independent-run" })).toBeUndefined();
      const end = vi.mocked(api.on).mock.calls.find(([name]) => name === "agent_end")?.[1];
      await end!({ success: false }, { runId: "ended-run", sessionKey: "ended-session" });
      expect(handler(event)).toMatchObject({ block: true });
      await end!({ success: true }, {});
      expect(handler(event)).toMatchObject({ block: true });
    },
  );

  it.each(["sessionKey", "sessionId"])(
    "uses compatible %s context when runId is absent",
    async (identity) => {
      const { api, handler } = searchHook(false);
      const event = { toolName: "read", params: { file_path: "/sandbox/project/README.md" } };
      const context = { [identity]: "affected-session" };
      expect(handler({ toolName: "web_search", params: {} }, context)).toMatchObject({
        block: true,
      });
      expect(handler(event, context)).toMatchObject({ block: true });
      expect(handler(event, { [identity]: "independent-session" })).toBeUndefined();
      expect(handler(event)).toMatchObject({ block: true });
      const end = vi.mocked(api.on).mock.calls.find(([name]) => name === "agent_end")?.[1];
      await end!({ success: true }, { [identity]: "independent-session" });
      expect(handler(event, context)).toMatchObject({ block: true });
      await end!({ success: true }, { ...context, runId: "ended-run" });
      expect(handler(event, context)).toBeUndefined();
    },
  );

  it("allows unidentified substitutes only while search is enabled", () => {
    const { api, handler } = searchHook(false);
    const event = { toolName: "read", params: { file_path: "/sandbox/project/README.md" } };
    expect(handler({ toolName: "web_search", params: {} })).toMatchObject({ block: true });
    api.config.tools = { web: { search: { enabled: true } } };
    expect(handler(event)).toBeUndefined();
    api.config.tools = { web: { search: { enabled: false } } };
    expect(handler(event)).toMatchObject({ block: true });
  });

  it("clears a run's denial when search is reenabled", async () => {
    const { api, handler } = searchHook(false);
    await handler({ toolName: "web_search", params: {}, runId: "reconfigured-run" });
    api.config.tools = { web: { search: { enabled: true } } };
    expect(
      handler({
        toolName: "read",
        params: { file_path: "/sandbox/project/nemoclaw-installation.md" },
        runId: "reconfigured-run",
      }),
    ).toBeUndefined();
    api.config.tools = { web: { search: { enabled: false } } };
    expect(
      handler({
        toolName: "read",
        params: { file_path: "/sandbox/project/nemoclaw-installation.md" },
        runId: "reconfigured-run",
      }),
    ).toBeUndefined();
  });

  it("expires abandoned identities after the host maximum turn deadline and cleanup grace", () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(1_000);
      const { handler } = searchHook(false);
      const read = { toolName: "read", params: { file_path: "/sandbox/project/README.md" } };
      expect(handler({ toolName: "web_search", params: {} }, { runId: "abandoned" })).toMatchObject(
        { block: true },
      );
      now.mockReturnValue(1_000 + 2_147_483_647);
      expect(handler(read, { runId: "abandoned" })).toMatchObject({ block: true });
      now.mockReturnValue(1_000 + 2_147_483_647 + 60_000);
      expect(handler(read, { runId: "abandoned" })).toBeUndefined();
      expect(handler({ toolName: "web_search", params: {} }, { runId: "new-run" })).toMatchObject({
        block: true,
      });
      expect(handler(read, { runId: "new-run" })).toMatchObject({ block: true });
    } finally {
      now.mockRestore();
    }
  });

  it("rejects excess turns and recovers capacity through matching lifecycle cleanup", async () => {
    const { api, admission } = searchHook(false);
    const tool = vi.mocked(api.on).mock.calls.find(([name]) => name === "before_tool_call")![1];
    const end = vi.mocked(api.on).mock.calls.find(([name]) => name === "agent_end")![1];
    const read = { toolName: "read", params: {} };
    expect(admission({}, { runId: "ordinary-active" })).toBeUndefined();
    expect(admission({}, { runId: "denied-active" })).toBeUndefined();
    expect(tool({ toolName: "web_search", params: {} }, { runId: "denied-active" })).toMatchObject({
      block: true,
    });
    expect(admission({}, { runId: "overflow" })).toMatchObject({ outcome: "block" });
    expect(tool(read, { runId: "overflow" })).toMatchObject({ block: true });
    expect(tool(read, { runId: "ordinary-active" })).toBeUndefined();
    expect(tool(read, { runId: "denied-active" })).toMatchObject({ block: true });
    // Retrying admission for the same active turn must not erase its denial.
    expect(admission({}, { runId: "denied-active" })).toBeUndefined();
    expect(tool(read, { runId: "denied-active" })).toMatchObject({ block: true });
    await end({ success: true }, { runId: "ordinary-active" });
    expect(admission({}, { runId: "next-turn" })).toBeUndefined();
    expect(tool(read, { runId: "next-turn" })).toBeUndefined();
    expect(tool(read, { runId: "denied-active" })).toMatchObject({ block: true });
    await end({ success: true }, { runId: "denied-active" });
    await end({ success: false }, { runId: "next-turn" });
    expect(admission({}, { runId: "unrelated-run" })).toBeUndefined();
    expect(tool(read, { runId: "unrelated-run" })).toBeUndefined();
    expect(api.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("identity capacity reached"),
    );
  });

  it.each(["sessionKey", "sessionId"])(
    "releases run admission through its associated %s on completion",
    async (field) => {
      const { api, admission } = searchHook(false);
      const end = vi.mocked(api.on).mock.calls.find(([name]) => name === "agent_end")![1];
      const tool = vi.mocked(api.on).mock.calls.find(([name]) => name === "before_tool_call")![1];
      expect(admission({}, { runId: "first", [field]: "associated" })).toBeUndefined();
      expect(admission({}, { runId: "second" })).toBeUndefined();
      expect(admission({}, { runId: "excess" })).toMatchObject({ outcome: "block" });
      expect(tool({ toolName: "web_search", params: {} }, { runId: "first" })).toMatchObject({
        block: true,
      });
      expect(tool({ toolName: "read", params: {} }, { [field]: "associated" })).toMatchObject({
        block: true,
      });
      await end({ success: true }, { [field]: "associated" });
      expect(admission({}, { runId: "new-turn" })).toBeUndefined();
      expect(tool({ toolName: "read", params: {} }, { runId: "new-turn" })).toBeUndefined();
    },
  );

  it("does not release another active run through a shared session alias", async () => {
    const { api, admission } = searchHook(false);
    const end = vi.mocked(api.on).mock.calls.find(([name]) => name === "agent_end")![1];
    const tool = vi.mocked(api.on).mock.calls.find(([name]) => name === "before_tool_call")![1];
    expect(admission({}, { runId: "first", sessionKey: "shared" })).toBeUndefined();
    expect(admission({}, { runId: "second", sessionKey: "shared" })).toBeUndefined();
    expect(tool({ toolName: "web_search", params: {} }, { runId: "second" })).toMatchObject({
      block: true,
    });
    await end({ success: true }, { sessionKey: "shared" });
    expect(admission({}, { runId: "excess" })).toMatchObject({ outcome: "block" });
    await end({ success: true }, { runId: "unrelated", sessionKey: "shared" });
    expect(admission({}, { runId: "excess" })).toMatchObject({ outcome: "block" });
    await end({ success: true }, { runId: "first", sessionKey: "shared" });
    expect(admission({}, { runId: "new-turn" })).toBeUndefined();
    await end({ success: true }, { runId: "unrelated", sessionKey: "shared" });
    expect(admission({}, { runId: "excess" })).toMatchObject({ outcome: "block" });
    expect(tool({ toolName: "read", params: {} }, { runId: "second" })).toMatchObject({
      block: true,
    });
  });

  it("rejects a disabled-search turn without correlatable identity", () => {
    const { admission } = searchHook(false);
    expect(admission({}, {})).toMatchObject({ outcome: "block" });
  });

  it("recovers from identity capacity when search is reenabled", () => {
    vi.useFakeTimers();
    try {
      const { api, handler } = searchHook(false);
      expect(handler({ toolName: "web_search", params: {}, runId: "denied-first" })).toMatchObject({
        block: true,
      });
      expect(handler({ toolName: "web_search", params: {}, runId: "denied-second" })).toMatchObject(
        { block: true },
      );
      expect(
        handler({ toolName: "web_search", params: {}, runId: "denied-overflow" }),
      ).toMatchObject({ block: true });
      api.config.tools = { web: { search: { enabled: true } } };
      expect(handler({ toolName: "read", params: {}, runId: "ordinary-run" })).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      api.config.tools = { web: { search: { enabled: false } } };
      expect(handler({ toolName: "read", params: {}, runId: "ordinary-run" })).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still blocks secrets in memory when search is disabled", () => {
    const { handler } = searchHook(false);
    expect(
      handler({
        toolName: "write",
        params: {
          file_path: "/sandbox/.openclaw/memory/notes.md",
          content: "nvapi-abcdefghijklmnopqrstuvwxyz",
        },
      }),
    ).toMatchObject({ block: true, blockReason: expect.stringContaining("Memory write blocked") });
  });
});
