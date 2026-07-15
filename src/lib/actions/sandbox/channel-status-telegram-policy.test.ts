// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import {
  entry,
  makeDeps,
  reportSignals,
  showSandboxChannelStatus,
  withTelegramProbe,
} from "./channel-status.test-helpers";

describe("showSandboxChannelStatus Telegram group policy", () => {
  it("uses manifest defaults when no stored config value exists", async () => {
    const { deps, out_lines } = makeDeps({
      exec: withTelegramProbe(() => ({
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
      })),
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
      gatewayPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = reportSignals(result);
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
      exec: withTelegramProbe(() => ({
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
      })),
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
      gatewayPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = reportSignals(result);
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toMatchObject({
      severity: "ok",
      detail: "disabled",
    });
  });
});

describe("showSandboxChannelStatus Telegram health exit propagation", () => {
  it("exits non-zero in text mode for an unhealthy (unreachable) telegram probe (#6743)", async () => {
    // The whole point of the probe is a non-zero exit on an unhealthy channel so
    // automation cannot treat a failed health check as success. Drive an
    // `unreachable` verdict end-to-end and assert the command exits 1.
    const unreachableProbe = [
      "NEMOCLAW_TG_DIAG_OK",
      "NEMOCLAW_TG_LOG_BEGIN",
      "[telegram] [default] Bot API startup probe failed: ETIMEDOUT",
      "NEMOCLAW_TG_LOG_END",
      "PROC 42 node /opt/openclaw gateway",
      "NEMOCLAW_TG_PROC_DONE",
    ].join("\n");
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const { deps, out_lines } = makeDeps({
      exec: withTelegramProbe(() => ({ status: 0, stdout: "{}", stderr: "" }), unreachableProbe),
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
      gatewayPresets: ["telegram"],
    });
    let threw: Error | null = null;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "telegram" });
    } catch (err) {
      threw = err as Error;
    } finally {
      exitSpy.mockRestore();
    }
    expect(threw?.message).toBe("process.exit(1)");
    expect(out_lines.join("\n")).toMatch(/Verdict:.*unreachable/);
  });
});
