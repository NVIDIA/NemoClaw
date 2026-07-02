// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { entry, makeDeps, showSandboxChannelStatus } from "./channel-status.test-helpers";

describe("showSandboxChannelStatus config comparison", () => {
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
                        groupPolicy: "allowlist",
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
            value: "allowlist",
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
      detail: "allowlist",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toBeUndefined();
    const dump = out_lines.join("\n");
    expect(dump).toMatch(/Telegram group policy \(TELEGRAM_GROUP_POLICY\):\s+allowlist/);
    expect(dump).not.toMatch(/Telegram Bot Token/);
    expect(dump).not.toMatch(/TELEGRAM_BOT_TOKEN/);
  });

  it("does not compare Hermes Telegram group policy when the manifest does not render it", async () => {
    const { deps } = makeDeps({
      exec: (_sandbox, command) =>
        command.includes("/sandbox/.hermes/.env")
          ? {
              status: 0,
              stdout: "TELEGRAM_ALLOWED_USERS=7895072570",
              stderr: "",
            }
          : command.includes("/sandbox/.hermes/config.yaml")
            ? {
                status: 0,
                stdout: "telegram:\n  require_mention: true\n",
                stderr: "",
              }
            : {
                status: 1,
                stdout: "",
                stderr: "",
              },
      agentName: "hermes",
      sandbox: entry(
        ["telegram"],
        [],
        {
          telegram: [
            {
              channelId: "telegram",
              inputId: "allowedIds",
              kind: "config",
              required: false,
              sourceEnv: "TELEGRAM_ALLOWED_IDS",
              statePath: "allowedIds.telegram",
              value: "7895072570",
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
              value: "allowlist",
            },
          ],
        },
        "hermes",
      ),
      appliedPresets: ["telegram"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "telegram",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) => signal.label === "Telegram User ID (for DM access) (TELEGRAM_ALLOWED_IDS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "7895072570",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Telegram group mention mode (TELEGRAM_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "1",
    });
    expect(
      signals.find((signal) => signal.label === "Telegram group policy (TELEGRAM_GROUP_POLICY)"),
    ).toBeUndefined();
  });

  it("warns when rendered config source is oversized", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: "x".repeat(64 * 1024 + 1),
        stderr: "",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "2542103c-7a1e-408a-b2f3-667e09e86783",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(signals.filter((signal) => signal.label === "Rendered config source")).toEqual([
      expect.objectContaining({
        severity: "warn",
        detail:
          "rendered config source too large: /sandbox/.openclaw/openclaw.json; config comparisons not checked",
      }),
    ]);
    expect(
      signals.find((signal) => signal.label === "Microsoft Teams Client ID (MSTEAMS_APP_ID)"),
    ).toMatchObject({
      severity: "warn",
      detail: "2542103c-7a1e-408a-b2f3-667e09e86783 (not checked)",
    });
  });

  it("warns when rendered config differs from the sandbox entry", async () => {
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
            value: "allowlist",
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
      severity: "warn",
      detail: "expected allowlist; rendered open",
    });
  });

  it("warns once when a shared rendered config source is unreadable", async () => {
    const { deps, out_lines } = makeDeps({
      exec: () => ({
        status: 1,
        stdout: "",
        stderr: "cat: /sandbox/.openclaw/openclaw.json: No such file or directory",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "2542103c-7a1e-408a-b2f3-667e09e86783",
          },
          {
            channelId: "teams",
            inputId: "tenantId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_TENANT_ID",
            statePath: "teamsConfig.tenantId",
            value: "43083d15-7273-40c1-b7db-39efd9ccc17a",
          },
          {
            channelId: "teams",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_ALLOWED_USERS",
            statePath: "allowedIds.teams",
            value: "205f29da-231e-4a0e-a0b2-b398e6302087",
          },
          {
            channelId: "teams",
            inputId: "webhookPort",
            kind: "config",
            required: false,
            sourceEnv: "MSTEAMS_PORT",
            statePath: "teamsConfig.webhookPort",
            value: "3978",
          },
          {
            channelId: "teams",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_REQUIRE_MENTION",
            statePath: "teamsConfig.requireMention",
            value: "1",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    const sourceWarnings = signals.filter((signal) => signal.label === "Rendered config source");
    expect(sourceWarnings).toHaveLength(1);
    expect(sourceWarnings[0]).toMatchObject({
      severity: "warn",
      detail: "could not read /sandbox/.openclaw/openclaw.json; config comparisons not checked",
    });
    expect(
      signals.find((signal) => signal.label === "Microsoft Teams Client ID (MSTEAMS_APP_ID)"),
    ).toMatchObject({
      severity: "warn",
      detail: "2542103c-7a1e-408a-b2f3-667e09e86783 (not checked)",
    });
    expect(
      signals.find(
        (signal) =>
          signal.label ===
          "Microsoft Teams AAD Object IDs (comma-separated allowlist) (TEAMS_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "warn",
      detail: "205f29da-231e-4a0e-a0b2-b398e6302087 (not checked)",
    });
    expect(
      signals.find(
        (signal) => signal.label === "Microsoft Teams mention mode (TEAMS_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "warn",
      detail: "1 (not checked)",
    });
    const sourceReadFailures = out_lines
      .join("\n")
      .match(/could not read \/sandbox\/\.openclaw\/openclaw\.json/g);
    expect(sourceReadFailures).toHaveLength(1);
  });

  it("warns once when a shared rendered config source is malformed", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: "{not-json",
        stderr: "",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "appId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_APP_ID",
            statePath: "teamsConfig.appId",
            value: "2542103c-7a1e-408a-b2f3-667e09e86783",
          },
          {
            channelId: "teams",
            inputId: "tenantId",
            kind: "config",
            required: true,
            sourceEnv: "MSTEAMS_TENANT_ID",
            statePath: "teamsConfig.tenantId",
            value: "43083d15-7273-40c1-b7db-39efd9ccc17a",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(signals.filter((signal) => signal.label === "Rendered config source")).toEqual([
      expect.objectContaining({
        severity: "warn",
        detail: "could not parse /sandbox/.openclaw/openclaw.json; config comparisons not checked",
      }),
    ]);
    expect(
      signals.find((signal) => signal.label === "Microsoft Teams Client ID (MSTEAMS_APP_ID)"),
    ).toMatchObject({
      severity: "warn",
      detail: "2542103c-7a1e-408a-b2f3-667e09e86783 (not checked)",
    });
  });

  it("treats 0/1 registry config as matching boolean rendered config", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            msteams: {
              requireMention: true,
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "requireMention",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_REQUIRE_MENTION",
            statePath: "teamsConfig.requireMention",
            value: "1",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) => signal.label === "Microsoft Teams mention mode (TEAMS_REQUIRE_MENTION)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "1",
    });
  });

  it("compares manifest-derived allowlist render values", async () => {
    const { deps } = makeDeps({
      exec: () => ({
        status: 0,
        stdout: JSON.stringify({
          channels: {
            msteams: {
              allowFrom: ["205f29da-231e-4a0e-a0b2-b398e6302087"],
            },
          },
        }),
        stderr: "",
      }),
      sandbox: entry(["teams"], [], {
        teams: [
          {
            channelId: "teams",
            inputId: "allowedUsers",
            kind: "config",
            required: false,
            sourceEnv: "TEAMS_ALLOWED_USERS",
            statePath: "allowedIds.teams",
            value: "205f29da-231e-4a0e-a0b2-b398e6302087",
          },
        ],
      }),
      appliedPresets: ["teams"],
    });
    const result = await showSandboxChannelStatus("alpha", {
      deps,
      channel: "teams",
    });

    const signals = result && "signals" in result ? result.signals : [];
    expect(
      signals.find(
        (signal) =>
          signal.label ===
          "Microsoft Teams AAD Object IDs (comma-separated allowlist) (TEAMS_ALLOWED_USERS)",
      ),
    ).toMatchObject({
      severity: "ok",
      detail: "205f29da-231e-4a0e-a0b2-b398e6302087",
    });
  });
});
