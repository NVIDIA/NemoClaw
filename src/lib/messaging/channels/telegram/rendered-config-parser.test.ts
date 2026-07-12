// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { telegramManifest } from "./manifest";
import { telegramRenderedConfigParser } from "./rendered-config-parser";

describe("telegram rendered config parser", () => {
  const openClawContext = {
    agentId: "openclaw" as const,
    manifest: telegramManifest,
    inputs: [],
  };

  it("extracts OpenClaw wildcard group mention mode (#5691)", () => {
    const requireMentionKey = telegramRenderedConfigParser
      .listConfigVisibilityKeys(openClawContext)
      .find((key) => key.key === "openclawGroupRequireMention");

    expect(requireMentionKey).toBeDefined();
    expect(
      telegramRenderedConfigParser.getValue(requireMentionKey!, {
        kind: "structured",
        value: {
          channels: {
            telegram: {
              accounts: {
                default: {
                  groupPolicy: "open",
                },
              },
              groups: {
                "*": {
                  requireMention: true,
                },
              },
            },
          },
        },
      }),
    ).toBe(true);
  });

  it("treats missing OpenClaw groups as all-message mode when group policy is open (#5691)", () => {
    const requireMentionKey = telegramRenderedConfigParser
      .listConfigVisibilityKeys(openClawContext)
      .find((key) => key.key === "openclawGroupRequireMention");

    expect(requireMentionKey).toBeDefined();
    expect(
      telegramRenderedConfigParser.getValue(requireMentionKey!, {
        kind: "structured",
        value: {
          channels: {
            telegram: {
              accounts: {
                default: {
                  groupPolicy: "open",
                },
              },
            },
          },
        },
      }),
    ).toBe(false);
  });

  it("treats missing OpenClaw group policy as unknown mention mode (#5691)", () => {
    const requireMentionKey = telegramRenderedConfigParser
      .listConfigVisibilityKeys(openClawContext)
      .find((key) => key.key === "openclawGroupRequireMention");

    expect(requireMentionKey).toBeDefined();
    expect(
      telegramRenderedConfigParser.getValue(requireMentionKey!, {
        kind: "structured",
        value: {
          channels: {
            telegram: {
              accounts: {
                default: {},
              },
            },
          },
        },
      }),
    ).toBeUndefined();
  });

  it("does not expose OpenClaw mention mode when group policy is not open", () => {
    const keys = telegramRenderedConfigParser.listConfigVisibilityKeys({
      ...openClawContext,
      inputs: [
        {
          channelId: "telegram",
          inputId: "groupPolicy",
          kind: "config",
          required: false,
          statePath: "telegramConfig.groupPolicy",
          value: "allowlist",
        },
      ],
    });

    expect(keys.find((key) => key.key === "openclawGroupRequireMention")).toBeUndefined();
  });
});
