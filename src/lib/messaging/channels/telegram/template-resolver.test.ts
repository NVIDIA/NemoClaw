// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxMessagingInputReference } from "../../manifest";
import { resolveTelegramTemplateReference } from "./template-resolver";

function openPolicyInputs(requireMention?: "0" | "1"): SandboxMessagingInputReference[] {
  return [
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
}

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
  ] as const)("renders OpenClaw mention mode %s explicitly when group access is open (#5691)", (requireMention, expected) => {
    expect(
      resolveTelegramTemplateReference("telegramConfig.openclawGroups", {
        inputs: openPolicyInputs(requireMention),
      })?.value,
    ).toEqual({ "*": { requireMention: expected } });
  });

  it("defaults to mention-only when requireMention is unset and groupPolicy is open (#5691)", () => {
    expect(
      resolveTelegramTemplateReference("telegramConfig.openclawGroups", {
        inputs: openPolicyInputs(),
      })?.value,
    ).toEqual({ "*": { requireMention: true } });
  });
});
