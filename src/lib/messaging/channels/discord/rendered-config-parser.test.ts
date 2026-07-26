// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelManifest } from "../../manifest";
import { discordRenderedConfigParser } from "./rendered-config-parser";

describe("discord rendered config parser", () => {
  const openClawContext = {
    agentId: "openclaw" as const,
    manifest: { id: "discord" } as ChannelManifest,
    inputs: [],
  };
  const hermesContext = {
    agentId: "hermes" as const,
    manifest: { id: "discord" } as ChannelManifest,
    inputs: [],
  };

  it("treats missing guild mention policy values as unset", () => {
    const requireMentionKey = discordRenderedConfigParser
      .listConfigVisibilityKeys(openClawContext)
      .find((key) => key.key === "guildRequireMention");

    expect(requireMentionKey).toBeDefined();
    expect(
      discordRenderedConfigParser.getValue(requireMentionKey!, {
        kind: "structured",
        value: {
          channels: {
            discord: {
              guilds: {
                "1504155275899437177": {
                  enabled: true,
                },
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("preserves requireMention value types when guilds differ", () => {
    const requireMentionKey = discordRenderedConfigParser
      .listConfigVisibilityKeys(openClawContext)
      .find((key) => key.key === "guildRequireMention");

    expect(requireMentionKey).toBeDefined();
    expect(
      discordRenderedConfigParser.getValue(requireMentionKey!, {
        kind: "structured",
        value: {
          channels: {
            discord: {
              guilds: {
                "1504155275899437177": {
                  requireMention: true,
                },
                "1504155275899437178": {
                  requireMention: false,
                },
              },
            },
          },
        },
      }),
    ).toEqual([true, false]);
  });

  it("extracts OpenClaw guild ids and user allowlists", () => {
    const keys = discordRenderedConfigParser.listConfigVisibilityKeys(openClawContext);
    const source = {
      kind: "structured" as const,
      value: {
        channels: {
          discord: {
            guilds: {
              "1504155275899437177": {
                requireMention: true,
                users: ["U01ABC2DEF3"],
              },
              "1504155275899437178": {
                requireMention: true,
                users: ["U04XYZ5RST6"],
              },
            },
          },
        },
      },
    };

    expect(
      discordRenderedConfigParser.getValue(keys.find((key) => key.key === "guildIds")!, source),
    ).toEqual(["1504155275899437177", "1504155275899437178"]);
    expect(
      discordRenderedConfigParser.getValue(
        keys.find((key) => key.key === "guildRequireMention")!,
        source,
      ),
    ).toBe(true);
    expect(
      discordRenderedConfigParser.getValue(keys.find((key) => key.key === "guildUsers")!, source),
    ).toEqual(["U01ABC2DEF3", "U04XYZ5RST6"]);
  });

  it("extracts Hermes env and config values", () => {
    const keys = discordRenderedConfigParser.listConfigVisibilityKeys(hermesContext);
    const envSource = {
      kind: "env" as const,
      entries: new Map([
        ["NEMOCLAW_DISCORD_GUILD_IDS", "1504155275899437177"],
        ["DISCORD_ALLOWED_USERS", "U01ABC2DEF3"],
      ]),
    };
    const configSource = {
      kind: "structured" as const,
      value: {
        discord: {
          require_mention: true,
        },
      },
    };

    expect(
      discordRenderedConfigParser.getValue(
        keys.find((key) => key.inputId === "serverId")!,
        envSource,
      ),
    ).toBe("1504155275899437177");
    expect(
      discordRenderedConfigParser.getValue(
        keys.find((key) => key.inputId === "userId")!,
        envSource,
      ),
    ).toBe("U01ABC2DEF3");
    expect(
      discordRenderedConfigParser.getValue(
        keys.find((key) => key.inputId === "requireMention")!,
        configSource,
      ),
    ).toBe(true);
  });
});
