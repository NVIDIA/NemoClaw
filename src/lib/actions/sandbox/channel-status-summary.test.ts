// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";

describe("showSandboxChannelStatus summary", () => {
  it("emits a compact all-channel report when no channel is selected", async () => {
    const commands: string[] = [];
    const { deps, out_lines } = makeDeps({
      exec: (_sandbox, command) => {
        commands.push(command);
        return command.includes("/sandbox/.openclaw/openclaw.json")
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
                  },
                },
              }),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" };
      },
      sandbox: entry(["telegram", "whatsapp"], [], {
        telegram: [
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
      appliedPresets: ["telegram", "whatsapp"],
    });
    const result = await showSandboxChannelStatus("alpha", { deps });

    expect(
      result && "channels" in result && result.channels.map((channel) => channel.channel),
    ).toEqual(["telegram", "whatsapp"]);
    expect(commands.join("\n")).not.toMatch(/NEMOCLAW_WA_DIAG_OK/);
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/NemoClaw channels status:.*alpha/);
    expect(dump).toMatch(/\btelegram\b/);
    expect(dump).toMatch(/\bwhatsapp\b/);
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+open/);
    expect(dump).not.toMatch(/Deep diagnostics/);
    expect(dump).not.toMatch(/Probed at/);
  });

  it("prints an empty-state hint when no channels are configured", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry([]),
      appliedPresets: [],
    });
    const result = await showSandboxChannelStatus("alpha", { deps });

    expect(result && "channels" in result && result.channels).toEqual([]);
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Configured channels: none/);
    expect(dump).toMatch(/channels add <channel>/);
  });

  it("rejects an explicit unknown channel without falling back to summary probing", async () => {
    const commands: string[] = [];
    const { deps, out_lines } = makeDeps({
      exec: (_sandbox, command) => {
        commands.push(command);
        return { status: 0, stdout: "", stderr: "" };
      },
      sandbox: entry(["telegram", "whatsapp"]),
      appliedPresets: ["telegram", "whatsapp"],
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);

    let threw: Error | undefined;
    try {
      await showSandboxChannelStatus("alpha", { deps, channel: "bogus" });
    } catch (error) {
      threw = error as Error;
    } finally {
      exitSpy.mockRestore();
    }

    expect(threw?.message).toBe("process.exit(1)");
    expect(commands).toEqual([]);
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Unknown channel 'bogus'/);
    expect(dump).not.toMatch(/NemoClaw channels status:/);
  });

  it("emits a basic per-channel report for non-whatsapp channels", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({ status: 0, stdout: "", stderr: "" }),
      sandbox: entry(["telegram"]),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });
    expect(result && "verdict" in result && result.verdict).toBe("info");
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/telegram registered/);
    expect(dump).toMatch(/preset applied/);
  });
});
