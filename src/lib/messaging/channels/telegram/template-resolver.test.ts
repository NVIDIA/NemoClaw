// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { resolveTelegramTemplateReference } from "./template-resolver";

describe("Telegram template resolver", () => {
  it.each([
    ["open", { "*": { requireMention: true } }],
    ["allowlist", undefined],
    ["disabled", undefined],
  ] as const)("resolves OpenClaw group policy %s", (groupPolicy, expectedGroups) => {
    const inputs: SandboxMessagingInputReference[] = [
      {
        channelId: "telegram",
        inputId: "requireMention",
        kind: "config",
        required: false,
        statePath: "telegramConfig.requireMention",
        value: "1",
      },
      {
        channelId: "telegram",
        inputId: "groupPolicy",
        kind: "config",
        required: false,
        statePath: "telegramConfig.groupPolicy",
        value: groupPolicy,
      },
    ];

    expect(resolveTelegramTemplateReference("telegramConfig.groupPolicy", { inputs })?.value).toBe(
      groupPolicy,
    );
    expect(
      resolveTelegramTemplateReference("telegramConfig.openclawGroups", { inputs })?.value,
    ).toEqual(expectedGroups);
  });

  it.each([
    ["1", true],
    ["0", false],
    [undefined, true],
  ] as const)("renders OpenClaw mention mode %s explicitly when group access is open (#5691)", (requireMention, expected) => {
    const inputs: SandboxMessagingInputReference[] = [
      {
        channelId: "telegram",
        inputId: "groupPolicy",
        kind: "config",
        required: false,
        statePath: "telegramConfig.groupPolicy",
        value: "open",
      },
      ...(requireMention === undefined
        ? []
        : [
            {
              channelId: "telegram",
              inputId: "requireMention",
              kind: "config" as const,
              required: false,
              statePath: "telegramConfig.requireMention",
              value: requireMention,
            },
          ]),
    ];

    expect(
      resolveTelegramTemplateReference("telegramConfig.openclawGroups", { inputs })?.value,
    ).toEqual({ "*": { requireMention: expected } });
  });
});
