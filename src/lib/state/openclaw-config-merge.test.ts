// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mergeOpenClawRestoredConfig } from "../../../dist/lib/state/openclaw-config-merge";

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

  it("does not resurrect managed channels when the rebuilt config omits channels", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        channels: {
          telegram: { accounts: { default: { token: "openshell:resolve:env:v111_TOKEN" } } },
          matrix: { accounts: { default: { room: "#ops" } } },
        },
      },
      { gateway: { auth: { token: "fresh-token" } } },
    );

    expect(merged).toMatchObject({
      gateway: { auth: { token: "fresh-token" } },
      channels: { matrix: { accounts: { default: { room: "#ops" } } } },
    });
    expect((merged as { channels: Record<string, unknown> }).channels.telegram).toBeUndefined();
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
});
