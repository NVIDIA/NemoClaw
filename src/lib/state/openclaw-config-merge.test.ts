// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mergeOpenClawRestoredConfig } from "./openclaw-config-merge";

const WEATHER_V1_PATH = "/sandbox/.openclaw/extensions/weather";
const WEATHER_V2_PATH = "/sandbox/.openclaw/extensions/weather-v2";
const USER_PLUGIN_PATH = "/sandbox/.openclaw/extensions/user-plugin";

function pluginConfig(
  entries: Record<string, unknown>,
  installs: Record<string, unknown>,
  paths: string[],
) {
  return { plugins: { entries, installs, load: { paths } } };
}

function imageInstall(id: string, installPath: string, loadPaths: string[] = []) {
  return { id, installPath, loadPaths };
}

describe("mergeOpenClawRestoredConfig", () => {
  it("keeps rebuilt runtime-owned config while restoring durable backup-only settings", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        gateway: undefined,
        models: {
          providers: {
            nvidia: { models: [{ id: "stale-model" }] },
            custom: { models: [{ id: "custom-model" }] },
          },
        },
        channels: {
          discord: { accounts: { default: { token: "openshell:resolve:env:v111_TOKEN" } } },
          slack: { accounts: { default: { botToken: "[STRIPPED_BY_MIGRATION]" } } },
          matrix: { accounts: { default: { room: "#ops" } } },
        },
        plugins: { entries: { discord: { enabled: false }, customPlugin: { enabled: true } } },
        mcpServers: { filesystem: { command: "npx" } },
        customAgents: { researcher: { prompt: "be thorough" } },
      },
      {
        gateway: { auth: { token: "fresh-token" } },
        diagnostics: { otel: true },
        models: { providers: { nvidia: { models: [{ id: "fresh-model" }] } } },
        channels: {
          discord: { accounts: { default: { token: "openshell:resolve:env:v222_TOKEN" } } },
          whatsapp: { accounts: { default: { enabled: true } } },
        },
        plugins: { entries: { discord: { enabled: true } } },
      },
    );

    expect(merged).toMatchObject({
      gateway: { auth: { token: "fresh-token" } },
      diagnostics: { otel: true },
      models: {
        providers: {
          nvidia: { models: [{ id: "fresh-model" }] },
          custom: { models: [{ id: "custom-model" }] },
        },
      },
      channels: {
        discord: { accounts: { default: { token: "openshell:resolve:env:v222_TOKEN" } } },
        whatsapp: { accounts: { default: { enabled: true } } },
        matrix: { accounts: { default: { room: "#ops" } } },
      },
      plugins: { entries: { discord: { enabled: true }, customPlugin: { enabled: true } } },
      mcpServers: { filesystem: { command: "npx" } },
      customAgents: { researcher: { prompt: "be thorough" } },
    });
    expect((merged as { channels: Record<string, unknown> }).channels.slack).toBeUndefined();
  });

  it("keeps the rebuilt gateway section — including the reload pin — over the backup's (#4710)", () => {
    // gateway.reload.mode="hot" is what keeps the in-sandbox gateway from
    // SIGUSR1-restarting itself out from under the nemoclaw-start respawn
    // loop. A backup taken before the pin existed (or carrying a different
    // mode) must not reintroduce restart-mode reloads on restore.
    const merged = mergeOpenClawRestoredConfig(
      {
        gateway: {
          auth: { token: "stale-token" },
          reload: { mode: "hybrid" },
          controlUi: { allowInsecureAuth: true },
        },
      },
      { gateway: { auth: { token: "fresh-token" }, reload: { mode: "hot" } } },
    ) as { gateway: unknown };

    expect(merged.gateway).toEqual({
      auth: { token: "fresh-token" },
      reload: { mode: "hot" },
    });
  });

  it("does not resurrect managed channels when the rebuilt config omits channels", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        channels: {
          telegram: { accounts: { default: { token: "openshell:resolve:env:v111_TOKEN" } } },
          whatsapp: { accounts: { default: { session: "stale" } } },
          wechat: { accounts: { default: { accountId: "legacy" } } },
          "openclaw-weixin": { accounts: { default: { accountId: "stale-current" } } },
          matrix: { accounts: { default: { room: "#ops" } } },
        },
      },
      { gateway: { auth: { token: "fresh-token" } } },
    );

    expect(merged).toMatchObject({
      gateway: { auth: { token: "fresh-token" } },
      channels: {
        wechat: { accounts: { default: { accountId: "legacy" } } },
        matrix: { accounts: { default: { room: "#ops" } } },
      },
    });
    expect((merged as { channels: Record<string, unknown> }).channels.telegram).toBeUndefined();
    expect((merged as { channels: Record<string, unknown> }).channels.whatsapp).toBeUndefined();
    expect(
      (merged as { channels: Record<string, unknown> }).channels["openclaw-weixin"],
    ).toBeUndefined();
  });

  it("preserves backup provider and plugin entries when current entry maps are absent", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: { providers: { custom: { models: [{ id: "custom-model" }] } } },
        plugins: { entries: { customPlugin: { enabled: true } } },
      },
      { models: { mode: "route-through-gateway" }, plugins: { load: { paths: ["/plugins"] } } },
    );

    expect(merged).toMatchObject({
      models: {
        mode: "route-through-gateway",
        providers: { custom: { models: [{ id: "custom-model" }] } },
      },
      plugins: {
        load: { paths: ["/plugins"] },
        entries: { customPlugin: { enabled: true } },
      },
    });
  });

  it("restores reporter-owned model metadata while keeping fresh provider routing (#5202)", () => {
    // Reporter scenario: same provider id and same model id after rebuild, but
    // the freshly generated v0.0.63 model block resets the user's tuning. The
    // merge must keep fresh runtime routing/credentials while restoring the
    // backed-up non-secret model metadata.
    const merged = mergeOpenClawRestoredConfig(
      {
        models: {
          mode: "merge",
          providers: {
            inference: {
              baseUrl: "http://127.0.0.1:8789/v1",
              apiKey: "unused",
              api: "chat-completions",
              models: [
                {
                  compat: { supportsUsageInStreaming: true, toolCallStyle: "openai" },
                  id: "moonshotai/kimi-k2",
                  name: "stale-display-name",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.2 },
                  contextWindow: 131072,
                  maxTokens: 32768,
                },
              ],
            },
          },
        },
        mcp: { servers: { filesystem: { command: "npx", args: ["-y", "fs-server", "/work"] } } },
      },
      {
        models: {
          mode: "merge",
          providers: {
            inference: {
              baseUrl: "http://127.0.0.1:9999/v1",
              apiKey: "unused",
              api: "chat-completions",
              models: [
                {
                  id: "moonshotai/kimi-k2",
                  name: "fresh-display-name",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 131072,
                  maxTokens: 4096,
                },
              ],
            },
          },
        },
        gateway: { auth: { token: "fresh-token" } },
      },
    );

    const provider = (
      merged as {
        models: { providers: { inference: Record<string, unknown> } };
      }
    ).models.providers.inference;
    // Runtime-owned provider routing/credentials win from the fresh rebuild.
    expect(provider.baseUrl).toBe("http://127.0.0.1:9999/v1");
    expect(provider.apiKey).toBe("unused");
    expect(provider.api).toBe("chat-completions");

    const model = (provider.models as Record<string, unknown>[])[0];
    // Routing identity (id/name) stays fresh; tuning metadata is restored.
    expect(model.id).toBe("moonshotai/kimi-k2");
    expect(model.name).toBe("fresh-display-name");
    expect(model.reasoning).toBe(true);
    expect(model.cost).toEqual({ input: 0.5, output: 1.5, cacheRead: 0.1, cacheWrite: 0.2 });
    expect(model.maxTokens).toBe(32768);
    expect(model.compat).toEqual({ supportsUsageInStreaming: true, toolCallStyle: "openai" });
    expect(model.input).toEqual(["text", "image"]);
    expect(model.contextWindow).toBe(131072);

    // Fresh runtime gateway is preserved; durable user mcp.servers survives.
    expect((merged as { gateway: unknown }).gateway).toEqual({ auth: { token: "fresh-token" } });
    expect(
      (merged as { mcp: { servers: Record<string, unknown> } }).mcp.servers.filesystem,
    ).toEqual({ command: "npx", args: ["-y", "fs-server", "/work"] });
  });

  it("keeps current provider and plugin entries for matching keys", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: {
          providers: {
            nvidia: { models: [{ id: "stale" }], apiKey: "unused" },
            custom: { models: [{ id: "stale-custom" }] },
            backupOnly: { models: [{ id: "backup-only" }] },
          },
        },
        plugins: {
          entries: {
            discord: { enabled: false },
            customPlugin: { enabled: true },
            backupOnlyPlugin: { enabled: true },
          },
        },
      },
      {
        models: {
          providers: {
            nvidia: { models: [{ id: "fresh" }], apiKey: "unused" },
            custom: { models: [{ id: "fresh-custom" }] },
          },
        },
        plugins: { entries: { discord: { enabled: true }, customPlugin: { enabled: false } } },
      },
    );

    expect(merged).toMatchObject({
      models: {
        providers: {
          nvidia: { models: [{ id: "fresh" }], apiKey: "unused" },
          custom: { models: [{ id: "fresh-custom" }] },
          backupOnly: { models: [{ id: "backup-only" }] },
        },
      },
      plugins: {
        entries: {
          discord: { enabled: true },
          customPlugin: { enabled: false },
          backupOnlyPlugin: { enabled: true },
        },
      },
    });
  });

  it("keeps fresh Tavily search config authoritative while preserving user plugins", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        tools: {
          web: {
            search: { enabled: true, provider: "brave" },
            fetch: { enabled: false, maxChars: 5000 },
            customSetting: "keep-me",
          },
        },
        plugins: {
          entries: {
            brave: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:OLD_BRAVE_API_KEY" } },
            },
            customPlugin: { enabled: true, config: { value: "keep-me" } },
          },
        },
      },
      {
        tools: {
          web: {
            search: { enabled: true, provider: "tavily" },
            fetch: { enabled: true, useTrustedEnvProxy: true },
          },
        },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
          },
        },
      },
    ) as {
      tools: { web: Record<string, unknown> };
      plugins: { entries: Record<string, unknown> };
    };

    expect(merged.tools.web.search).toEqual({ enabled: true, provider: "tavily" });
    expect(merged.tools.web.fetch).toEqual({
      enabled: false,
      maxChars: 5000,
      useTrustedEnvProxy: true,
    });
    expect(merged.tools.web.customSetting).toBe("keep-me");
    expect(merged.plugins.entries.tavily).toEqual({
      enabled: true,
      config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
    });
    expect(merged.plugins.entries.brave).toBeUndefined();
    expect(merged.plugins.entries.customPlugin).toEqual({
      enabled: true,
      config: { value: "keep-me" },
    });
  });

  it("does not resurrect web search config or managed plugins after disablement", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        tools: {
          web: {
            search: { enabled: true, provider: "tavily" },
            fetch: { enabled: false },
          },
        },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
            customPlugin: { enabled: true },
          },
        },
      },
      {
        tools: { web: { fetch: { enabled: true, useTrustedEnvProxy: true } } },
        plugins: { entries: {} },
      },
    ) as {
      tools: { web: Record<string, unknown> };
      plugins: { entries: Record<string, unknown> };
    };

    expect(merged.tools.web.search).toBeUndefined();
    expect(merged.plugins.entries.tavily).toBeUndefined();
    expect(merged.plugins.entries.customPlugin).toEqual({ enabled: true });
  });

  it("does not restore managed search state when fresh config omits whole sections", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        tools: {
          customTool: { enabled: true },
          web: {
            search: { enabled: true, provider: "tavily" },
            fetch: { enabled: false },
          },
        },
        plugins: {
          entries: {
            tavily: {
              enabled: true,
              config: { webSearch: { apiKey: "openshell:resolve:env:TAVILY_API_KEY" } },
            },
            customPlugin: { enabled: true },
          },
        },
      },
      { gateway: { auth: { token: "fresh-token" } } },
    ) as {
      tools: { customTool: unknown; web: Record<string, unknown> };
      plugins: { entries: Record<string, unknown> };
    };

    expect(merged.tools.web.search).toBeUndefined();
    expect(merged.tools.web.fetch).toEqual({ enabled: false });
    expect(merged.tools.customTool).toEqual({ enabled: true });
    expect(merged.plugins.entries.tavily).toBeUndefined();
    expect(merged.plugins.entries.customPlugin).toEqual({ enabled: true });
  });

  it("removes all prior image-owned config while preserving user-owned plugin state", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        channels: {
          weather: { token: "stale-image-channel" },
          "user-channel": { room: "keep" },
        },
        plugins: {
          allow: ["weather", "user-plugin"],
          deny: ["weather", "user-denied"],
          entries: {
            weather: { enabled: true, config: { revision: "v1" } },
            "user-plugin": { enabled: true },
          },
          installs: {
            weather: { installPath: WEATHER_V1_PATH },
            "user-plugin": { installPath: USER_PLUGIN_PATH },
          },
          load: { paths: [WEATHER_V1_PATH, USER_PLUGIN_PATH] },
          slots: { memory: "weather", contextEngine: "user-plugin" },
        },
      },
      { channels: {}, plugins: { allow: [], deny: [], entries: {}, load: { paths: [] } } },
      {
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH, [WEATHER_V1_PATH])],
      },
    );

    expect(merged).toMatchObject({
      channels: { "user-channel": { room: "keep" } },
      plugins: {
        allow: ["user-plugin"],
        deny: ["user-denied"],
        entries: { "user-plugin": { enabled: true } },
        load: { paths: [USER_PLUGIN_PATH] },
        slots: { contextEngine: "user-plugin" },
      },
    });
    expect((merged as { channels: Record<string, unknown> }).channels.weather).toBeUndefined();
    expect((merged as { plugins: Record<string, unknown> }).plugins.installs).toBeUndefined();
  });

  it("keeps only the fresh plugin when an image plugin is renamed", () => {
    const merged = mergeOpenClawRestoredConfig(
      pluginConfig(
        { weather: { enabled: true, config: { revision: "v1" } } },
        { weather: { installPath: WEATHER_V1_PATH } },
        [WEATHER_V1_PATH],
      ),
      pluginConfig(
        { "weather-v2": { enabled: true, config: { revision: "v2" } } },
        { "weather-v2": { installPath: WEATHER_V2_PATH } },
        [WEATHER_V2_PATH],
      ),
      {
        freshImagePluginInstalls: [imageInstall("weather-v2", WEATHER_V2_PATH, [WEATHER_V2_PATH])],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH, [WEATHER_V1_PATH])],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins).toEqual({
      entries: { "weather-v2": { enabled: true, config: { revision: "v2" } } },
      load: { paths: [WEATHER_V2_PATH] },
    });
  });

  it("preserves backup-only user plugins while removing a retired image plugin", () => {
    const merged = mergeOpenClawRestoredConfig(
      pluginConfig(
        {
          weather: { enabled: true },
          "user-plugin": { enabled: true, config: { owner: "user" } },
        },
        {
          weather: { installPath: WEATHER_V1_PATH },
          "user-plugin": { installPath: USER_PLUGIN_PATH },
        },
        [WEATHER_V1_PATH, USER_PLUGIN_PATH],
      ),
      pluginConfig({}, {}, []),
      {
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH, [WEATHER_V1_PATH])],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins).toEqual({
      entries: { "user-plugin": { enabled: true, config: { owner: "user" } } },
      load: { paths: [USER_PLUGIN_PATH] },
    });
  });

  it("does not treat a non-linked install path as an owned load path", () => {
    const merged = mergeOpenClawRestoredConfig(
      pluginConfig({ weather: { enabled: true } }, { weather: { installPath: WEATHER_V1_PATH } }, [
        WEATHER_V1_PATH,
      ]),
      pluginConfig({}, {}, []),
      {
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins).toEqual({ entries: {}, load: { paths: [WEATHER_V1_PATH] } });
  });

  it("preserves retained allow and deny state when the fresh image omits those lists", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        channels: { weather: { token: "stale" } },
        plugins: {
          allow: ["weather", "user-plugin"],
          deny: ["weather", "user-denied"],
          entries: { weather: { enabled: false }, "user-plugin": { enabled: true } },
          slots: { memory: "weather" },
        },
      },
      { channels: {}, plugins: { entries: { weather: { enabled: true } } } },
      {
        freshImagePluginInstalls: [imageInstall("weather", WEATHER_V2_PATH)],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { channels: Record<string, unknown>; plugins: Record<string, unknown> };

    expect(merged.channels.weather).toBeUndefined();
    expect(merged.plugins).toMatchObject({
      allow: ["weather", "user-plugin"],
      deny: ["weather", "user-denied"],
      entries: { weather: { enabled: true }, "user-plugin": { enabled: true } },
    });
    expect(merged.plugins.slots).toBeUndefined();
  });

  it("lets an explicit fresh allowlist own prior image IDs while retaining user IDs", () => {
    const merged = mergeOpenClawRestoredConfig(
      { plugins: { allow: ["weather", "user-plugin"], entries: {} } },
      { plugins: { allow: ["weather"], entries: { weather: { enabled: true } } } },
      {
        freshImagePluginInstalls: [imageInstall("weather", WEATHER_V2_PATH)],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins.allow).toEqual(["weather", "user-plugin"]);
  });

  it("lets a fresh allowlist override stale backup deny entries", () => {
    const merged = mergeOpenClawRestoredConfig(
      { plugins: { deny: ["weather", "user-denied"], entries: {} } },
      { plugins: { allow: ["weather"], entries: { weather: { enabled: true } } } },
      {
        freshImagePluginInstalls: [imageInstall("weather", WEATHER_V2_PATH)],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins.allow).toEqual(["weather"]);
    expect(merged.plugins.deny).toEqual(["user-denied"]);
  });

  it("lets a fresh denylist override stale backup allow entries", () => {
    const merged = mergeOpenClawRestoredConfig(
      { plugins: { allow: ["weather", "user-plugin"], entries: {} } },
      { plugins: { deny: ["weather"], entries: { weather: { enabled: true } } } },
      {
        freshImagePluginInstalls: [imageInstall("weather", WEATHER_V2_PATH)],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins.allow).toEqual(["user-plugin"]);
    expect(merged.plugins.deny).toEqual(["weather"]);
  });

  it("lets an explicit fresh denylist own prior image IDs while retaining user IDs", () => {
    const merged = mergeOpenClawRestoredConfig(
      { plugins: { deny: ["weather", "user-denied"], entries: {} } },
      { plugins: { deny: [], entries: { weather: { enabled: true } } } },
      {
        freshImagePluginInstalls: [imageInstall("weather", WEATHER_V2_PATH)],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { plugins: Record<string, unknown> };

    expect(merged.plugins.deny).toEqual(["user-denied"]);
  });

  it("does not merge stale same-ID channel fallback into the fresh image channel", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        channels: { weather: { enabled: false, token: "stale" } },
        plugins: { entries: { weather: { enabled: false } } },
      },
      {
        channels: { weather: { enabled: true } },
        plugins: { entries: { weather: { enabled: true } } },
      },
      {
        freshImagePluginInstalls: [imageInstall("weather", WEATHER_V2_PATH)],
        previousImagePluginInstalls: [imageInstall("weather", WEATHER_V1_PATH)],
      },
    ) as { channels: Record<string, unknown> };

    expect(merged.channels.weather).toEqual({ enabled: true });
  });

  it("keeps legacy backup-only plugins but drops transient install records", () => {
    const backup = pluginConfig(
      { weather: { enabled: true, config: { revision: "v1" } } },
      { weather: { installPath: WEATHER_V1_PATH } },
      [WEATHER_V1_PATH],
    );

    expect(mergeOpenClawRestoredConfig(backup, pluginConfig({}, {}, []))).toEqual({
      plugins: {
        entries: { weather: { enabled: true, config: { revision: "v1" } } },
        load: { paths: [WEATHER_V1_PATH] },
      },
    });
  });

  it("fails closed when reconciliation receives incomplete or one-sided provenance", () => {
    expect(() =>
      mergeOpenClawRestoredConfig(pluginConfig({}, {}, []), pluginConfig({}, {}, []), {
        previousImagePluginInstalls: [
          { id: "weather", installPath: WEATHER_V1_PATH, loadPaths: undefined },
        ],
      }),
    ).toThrow("Complete previous and fresh OpenClaw image plugin provenance is required");
    expect(() =>
      mergeOpenClawRestoredConfig(pluginConfig({}, {}, []), pluginConfig({}, {}, []), {
        freshImagePluginInstalls: [],
      }),
    ).toThrow("Complete previous and fresh OpenClaw image plugin provenance is required");
    expect(() =>
      mergeOpenClawRestoredConfig(pluginConfig({}, {}, []), pluginConfig({}, {}, []), {
        freshImagePluginInstalls: [],
        previousImagePluginInstalls: [
          { id: "weather", installPath: WEATHER_V1_PATH, loadPaths: undefined },
        ],
      }),
    ).toThrow("missing explicit load paths");
  });
});
