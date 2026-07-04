// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";

describe("showSandboxChannelStatus Telegram group policy", () => {
  it("uses manifest defaults when no stored config value exists", async () => {
    const { deps, out_lines } = makeDeps({
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
                  requireMention: true,
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "ok",
      detail: "open (default)",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "yes (default)",
    });
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Telegram User ID \(for DM access\) \(TELEGRAM_ALLOWED_IDS\):\s+not set/);
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+open \(default\)/);
    expect(dump).toMatch(
      /Telegram group mention mode \(TELEGRAM_REQUIRE_MENTION\):\s+yes \(default\)/,
    );
  });

  it("accepts Telegram disabled group policy from rendered config", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            telegram: {
              accounts: {
                default: {
                  groupPolicy: "disabled",
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
            inputId: "groupPolicy",
            kind: "config",
            required: false,
            sourceEnv: "TELEGRAM_GROUP_POLICY",
            statePath: "telegramConfig.groupPolicy",
            value: "disabled",
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
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "ok",
      detail: "disabled",
    });
  });
});
