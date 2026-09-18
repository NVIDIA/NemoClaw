// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { mergeOpenClawRestoredConfig } from "./openclaw-config-merge";

describe("mergeOpenClawRestoredConfig", () => {
  it("rejects non-plain top-level values", () => {
    expect(() => mergeOpenClawRestoredConfig([], {})).toThrow(
      "OpenClaw selective config merge requires JSON objects",
    );
  });

  it("keeps current OpenShell runtime and credential projection while restoring user config", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        gateway: { auth: { token: "stale" } },
        mcpServers: { filesystem: { command: "npx" } },
        channels: {
          telegram: { token: "stale-channel-token" },
          custom: { room: "user-room" },
        },
      },
      {
        gateway: { auth: { token: "fresh" } },
        channels: { telegram: { token: "openshell:resolve:env:TELEGRAM_BOT_TOKEN" } },
      },
    ) as Record<string, any>;

    expect(merged.gateway.auth.token).toBe("fresh");
    expect(merged.mcpServers.filesystem.command).toBe("npx");
    expect(merged.channels.telegram.token).toBe("openshell:resolve:env:TELEGRAM_BOT_TOKEN");
    expect(merged.channels.custom).toEqual({ room: "user-room" });
  });

  it("preserves native plugin state without an image ownership baseline (#11766)", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        plugins: {
          allow: ["user-plugin"],
          deny: ["disabled-user-plugin"],
          entries: {
            "user-plugin": { enabled: true, config: { source: "user" } },
            telegram: { enabled: false, config: { stale: true } },
          },
          installs: { transient: { installPath: "/tmp/transient" } },
          load: { paths: ["/sandbox/.openclaw/extensions/user-plugin"] },
          slots: { memory: "user-plugin" },
        },
      },
      {
        plugins: {
          entries: { telegram: { enabled: true, config: { credential: "placeholder" } } },
        },
      },
    ) as Record<string, any>;

    expect(merged.plugins).toEqual({
      allow: ["user-plugin"],
      deny: ["disabled-user-plugin"],
      entries: {
        "user-plugin": { enabled: true, config: { source: "user" } },
        telegram: { enabled: true, config: { credential: "placeholder" } },
      },
      load: { paths: ["/sandbox/.openclaw/extensions/user-plugin"] },
      slots: { memory: "user-plugin" },
    });
  });

  it("keeps fresh provider routing while restoring user model tuning", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        models: {
          providers: {
            inference: {
              baseUrl: "https://stale.invalid/v1",
              apiKey: "stale",
              models: [{ id: "old", name: "old", temperature: 0.25 }],
            },
          },
        },
      },
      {
        models: {
          providers: {
            inference: {
              baseUrl: "https://inference.local/v1",
              apiKey: "unused",
              models: [{ id: "current", name: "current" }],
            },
          },
        },
      },
    ) as Record<string, any>;

    expect(merged.models.providers.inference).toMatchObject({
      baseUrl: "https://inference.local/v1",
      apiKey: "unused",
    });
  });

  it("re-owns primary model routing while retaining other native agent settings", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        agents: {
          defaults: { model: { primary: "inference/stale" }, thinkingDefault: "off" },
          list: [{ id: "main", default: true, model: "inference/stale" }],
        },
      },
      { agents: { defaults: { model: { primary: "inference/current" } } } },
    ) as Record<string, any>;

    expect(merged.agents).toEqual({
      defaults: { model: { primary: "inference/current" }, thinkingDefault: "off" },
      list: [{ id: "main", default: true, model: "inference/current" }],
    });
  });

  it("keeps the fresh generated compaction policy during restore (#11805)", () => {
    const merged = mergeOpenClawRestoredConfig(
      {
        agents: {
          defaults: {
            compaction: { mode: "safeguard", timeoutSeconds: 120, reserveTokens: 20000 },
          },
        },
      },
      {
        agents: {
          defaults: {
            compaction: {
              mode: "safeguard",
              timeoutSeconds: 300,
              reserveTokens: 4096,
              reserveTokensFloor: 4096,
            },
          },
        },
      },
    ) as Record<string, any>;

    expect(merged.agents.defaults.compaction).toEqual({
      mode: "safeguard",
      timeoutSeconds: 300,
      reserveTokens: 4096,
      reserveTokensFloor: 4096,
    });
  });
});
