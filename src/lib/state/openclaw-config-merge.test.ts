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
