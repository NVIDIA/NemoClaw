// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  type ExecResult,
  entry,
  makeDeps,
  showSandboxChannelStatus,
} from "./channel-status.test-helpers";

describe("showSandboxChannelStatus channel config parsers", () => {
  it("compares Discord guild-derived render values", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            discord: {
              guilds: {
                "1504155275899437177": {
                  requireMention: true,
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["discord"], [], {
        discord: [
          {
            channelId: "discord",
            inputId: "serverId",
            kind: "config",
            required: false,
            sourceEnv: "DISCORD_SERVER_ID",
            statePath: "discordGuilds.serverId",
            value: "1504155275899437177",
          },
          {
            channelId: "discord",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "DISCORD_REQUIRE_MENTION",
            statePath: "discordGuilds.requireMention",
            value: "1",
          },
        ],
      }),
      appliedPresets: ["discord"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "discord",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label === "Discord Server ID (for guild workspace access) (DISCORD_SERVER_ID)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "1504155275899437177",
    });
    expect(
      signals.find((signal) => signal.label === "Discord mention mode (DISCORD_REQUIRE_MENTION)"),
    ).toMatchObject({
      severity: "ok",
      detail: "1",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Discord User ID (optional guild allowlist) (DISCORD_USER_ID)",
      ),
    ).toMatchObject({
      severity: "info",
      detail: "not set",
    });
    const dump = out_lines.join("\n");
    expect(dump).toMatch(
      /Discord Server ID \(for guild workspace access\) \(DISCORD_SERVER_ID\):\s+1504155275899437177/,
    );
    expect(dump).toMatch(/Discord mention mode \(DISCORD_REQUIRE_MENTION\):\s+1/);
  });

  it("compares Slack OpenClaw allowlist render values", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            slack: {
              accounts: {
                default: {
                  allowFrom: ["U01ABC2DEF3"],
                  channels: {
                    C012AB3CD: {
                      enabled: true,
                      requireMention: true,
                      users: ["U01ABC2DEF3"],
                    },
                  },
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["slack"], [], {
        slack: [
          {
            channelId: "slack",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "SLACK_ALLOWED_USERS",
            statePath: "allowedIds.slack",
            value: "U01ABC2DEF3",
          },
          {
            channelId: "slack",
            inputId: "allowedChannels",
            kind: "config",
            required: false,
            sourceEnv: "SLACK_ALLOWED_CHANNELS",
            statePath: "slackConfig.allowedChannels",
            value: "C012AB3CD",
          },
        ],
      }),
      appliedPresets: ["slack"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "slack",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Member IDs (comma-separated allowlist) (SLACK_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "U01ABC2DEF3",
    });
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Channel IDs (comma-separated allowlist) (SLACK_ALLOWED_CHANNELS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "C012AB3CD",
    });
  });

  it("does not treat Slack wildcard channel policy as configured channel IDs", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            slack: {
              accounts: {
                default: {
                  allowFrom: ["U0B5BQABTL4"],
                  channels: {
                    "*": {
                      enabled: true,
                      requireMention: true,
                      users: ["U0B5BQABTL4"],
                    },
                  },
                },
              },
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["slack"], [], {
        slack: [
          {
            channelId: "slack",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "SLACK_ALLOWED_USERS",
            statePath: "allowedIds.slack",
            value: "U0B5BQABTL4",
          },
        ],
      }),
      appliedPresets: ["slack"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "slack",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Member IDs (comma-separated allowlist) (SLACK_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "U0B5BQABTL4",
    });
    expect(
      signals.find(
        (signal) =>
          signal.label === "Slack Channel IDs (comma-separated allowlist) (SLACK_ALLOWED_CHANNELS)",
      ),
    ).toMatchObject({
      severity: "info",
      detail: "not set",
    });
  });

  it("compares OpenClaw WeChat account render values", async () => {
    const renderedResponses: Array<[string, ExecResult]> = [
      [
        "/sandbox/.openclaw/openclaw.json",
        {
          status: 0,
          stdout: JSON.stringify({
            channels: {
              "openclaw-weixin": {
                accounts: {
                  "wechat-account": {
                    enabled: true,
                  },
                },
              },
            },
          }),
          stderr: "",
        },
      ],
      [
        "/sandbox/.openclaw/openclaw-weixin/accounts/wechat-account.json",
        {
          status: 0,
          stdout: JSON.stringify({
            baseUrl: "https://ilinkai.wechat.com",
            userId: "wechat-user",
          }),
          stderr: "",
        },
      ],
    ];
    const { deps } = makeDeps({
      exec: (_sandbox, command) =>
        renderedResponses.find(([needle]) => command.includes(needle))?.[1] ?? {
          status: 1,
          stdout: "",
          stderr: "",
        },
      sandbox: entry(["wechat"], [], {
        wechat: [
          {
            channelId: "wechat",
            inputId: "accountId",
            kind: "config",
            required: true,
            sourceEnv: "WECHAT_ACCOUNT_ID",
            statePath: "wechatConfig.accountId",
            value: "wechat-account",
          },
          {
            channelId: "wechat",
            inputId: "baseUrl",
            kind: "config",
            required: false,
            sourceEnv: "WECHAT_BASE_URL",
            statePath: "wechatConfig.baseUrl",
            value: "https://ilinkai.wechat.com",
          },
          {
            channelId: "wechat",
            inputId: "userId",
            kind: "config",
            required: false,
            sourceEnv: "WECHAT_USER_ID",
            statePath: "wechatConfig.userId",
            value: "wechat-user",
          },
          {
            channelId: "wechat",
            inputId: "allowedIds",
            kind: "config",
            required: false,
            sourceEnv: "WECHAT_ALLOWED_IDS",
            statePath: "allowedIds.wechat",
            value: "wechat-user",
          },
        ],
      }),
      appliedPresets: ["wechat"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "wechat",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(signals.find((signal) => signal.label === "WECHAT_ACCOUNT_ID")).toMatchObject({
      severity: "ok",
      detail: "wechat-account",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_BASE_URL")).toMatchObject({
      severity: "ok",
      detail: "https://ilinkai.wechat.com",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_USER_ID")).toMatchObject({
      severity: "ok",
      detail: "wechat-user",
    });
    expect(
      signals.find(
        (signal) => signal.label === "WeChat User ID(s) (DM allowlist) (WECHAT_ALLOWED_IDS)",
      ),
    ).toBeUndefined();
  });

  it.each([
    "../x",
    "a/b",
    "bad'quote",
    'bad"quote',
    "bad\nline",
  ])("does not read derived WeChat account files for unsafe accountId %j", async (accountId) => {
    const commands: string[] = [];
    const { deps } = makeDeps({
      exec: (_sandbox, command) => {
        commands.push(command);
        return command.includes("/sandbox/.openclaw/openclaw.json")
          ? {
              status: 0,
              stdout: JSON.stringify({
                channels: {
                  "openclaw-weixin": {
                    accounts: {},
                  },
                },
              }),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" };
      },
      sandbox: entry(["wechat"], [], {
        wechat: [
          {
            channelId: "wechat",
            inputId: "accountId",
            kind: "config",
            required: true,
            sourceEnv: "WECHAT_ACCOUNT_ID",
            statePath: "wechatConfig.accountId",
            value: accountId,
          },
        ],
      }),
      appliedPresets: ["wechat"],
    });
    await showSandboxChannelStatus("alpha", {
      deps,
      channel: "wechat",
    });

    expect(commands).toEqual(["head -c 65537 '/sandbox/.openclaw/openclaw.json'"]);
  });

  it("compares Hermes WeChat values through rendered WEIXIN env keys", async () => {
    const { deps } = makeDeps({
      exec: (_sandbox, command) =>
        command.includes("/sandbox/.hermes/.env")
          ? {
              status: 0,
              stdout: [
                "WEIXIN_ACCOUNT_ID=wxid_abc",
                "WEIXIN_BASE_URL=https://wechat.example.test",
                "WEIXIN_ALLOWED_USERS=wxid_abc,wxid_def",
              ].join("\n"),
              stderr: "",
            }
          : { status: 1, stdout: "", stderr: "" },
      agentName: "hermes",
      sandbox: entry(
        ["wechat"],
        [],
        {
          wechat: [
            {
              channelId: "wechat",
              inputId: "accountId",
              kind: "config",
              required: true,
              sourceEnv: "WECHAT_ACCOUNT_ID",
              statePath: "wechatConfig.accountId",
              value: "wxid_abc",
            },
            {
              channelId: "wechat",
              inputId: "baseUrl",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_BASE_URL",
              statePath: "wechatConfig.baseUrl",
              value: "https://wechat.example.test",
            },
            {
              channelId: "wechat",
              inputId: "userId",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_USER_ID",
              statePath: "wechatConfig.userId",
              value: "wxid_abc",
            },
            {
              channelId: "wechat",
              inputId: "allowedIds",
              kind: "config",
              required: false,
              sourceEnv: "WECHAT_ALLOWED_IDS",
              statePath: "allowedIds.wechat",
              value: "wxid_abc,wxid_def",
            },
          ],
        },
        "hermes",
      ),
      appliedPresets: ["wechat"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "wechat",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(signals.find((signal) => signal.label === "WECHAT_ACCOUNT_ID")).toMatchObject({
      severity: "ok",
      detail: "wxid_abc",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_BASE_URL")).toMatchObject({
      severity: "ok",
      detail: "https://wechat.example.test",
    });
    expect(
      signals.find(
        (signal) => signal.label === "WeChat User ID(s) (DM allowlist) (WECHAT_ALLOWED_IDS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "wxid_abc,wxid_def",
    });
    expect(signals.find((signal) => signal.label === "WECHAT_USER_ID")).toBeUndefined();
  });
});
