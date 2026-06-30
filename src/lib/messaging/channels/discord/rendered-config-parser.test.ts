// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { ChannelManifest } from "../../manifest";
import { discordRenderedConfigParser } from "./rendered-config-parser";

describe("discord rendered config parser", () => {
  it("treats missing guild mention policy values as unset", () => {
    const requireMentionKey = discordRenderedConfigParser
      .listConfigVisibilityKeys({
        agentId: "openclaw",
        manifest: { id: "discord" } as ChannelManifest,
        inputs: [],
      })
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
});
