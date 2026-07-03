// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";

describe("showSandboxChannelStatus Telegram mention mode", () => {
  it("marks rendered config ok when the sandbox config matches the sandbox entry", async () => {
    const { deps, out_lines } = makeDeps({
      exec: (_sandbox, command) =>
        command.includes("/sandbox/.openclaw/openclaw.json")
          ? {
              status: 0,
              stdout: JSON.stringify({
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
              }),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" },
      sandbox: entry(["telegram"], [], {
        telegram: [
          {
            channelId: "telegram",
            inputId: "botToken",
            kind: "secret",
            required: true,
            sourceEnv: "TELEGRAM_BOT_TOKEN",
            credentialAvailable: true,
          },
          {
            channelId: "telegram",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_REQUIRE_MENTION",
            statePath: "telegramConfig.requireMention",
            value: "1",
          },
          {
            channelId: "telegram",
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "open",
          },
        ],
      }),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    expect(result && "verdict" in result && result.verdict).toBe("info");
    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "ok",
      detail: "open",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "mention-only (1)",
    });
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+open/);
    expect(dump).toMatch(
      /Telegram group mention mode \(TELEGRAM_REQUIRE_MENTION\):\s+mention-only \(1\)/,
    );
    expect(dump).not.toMatch(/Telegram Bot Token/);
    expect(dump).not.toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it("marks Telegram all-message mode ok when OpenClaw renders the explicit override (#5691)", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            telegram: {
              accounts: {
                default: {
                  groupPolicy: "open",
                },
              },
              groups: {
                "*": {
                  requireMention: false,
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["telegram"], [], {
        telegram: [
          {
            channelId: "telegram",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_REQUIRE_MENTION",
            statePath: "telegramConfig.requireMention",
            value: "0",
          },
          {
            channelId: "telegram",
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "open",
          },
        ],
      }),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "all-messages (0)",
    });
  });

  it("warns when all-messages intent falls back to OpenClaw's mention-only default (#5691)", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            telegram: {
              accounts: { default: { groupPolicy: "open" } },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["telegram"], [], {
        telegram: [
          {
            channelId: "telegram",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_REQUIRE_MENTION",
            statePath: "telegramConfig.requireMention",
            value: "0",
          },
          {
            channelId: "telegram",
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "open",
          },
        ],
      }),
      appliedPresets: ["telegram"],
    });

    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });
    const signals = result && "signals" in result ? result.signals : [];

    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "warn",
      detail: "expected all-messages (0); rendered mention-only (1)",
    });
  });
});
