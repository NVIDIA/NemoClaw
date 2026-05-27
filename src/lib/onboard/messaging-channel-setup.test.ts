// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prompt, saveCredential } from "../credentials/store";
import { KNOWN_CHANNELS } from "../sandbox/channels";
import { setupSelectedMessagingChannels } from "./messaging-channel-setup";

vi.mock("../credentials/store", () => ({
  getCredential: vi.fn(() => null),
  normalizeCredentialValue: vi.fn((value: unknown) =>
    typeof value === "string" ? value.trim() : "",
  ),
  prompt: vi.fn(async () => ""),
  saveCredential: vi.fn(),
}));

vi.mock("./host-qr-dispatch", () => ({
  dispatchHostQrLogin: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

describe("setupSelectedMessagingChannels", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("#4068 prints Telegram group privacy-mode setup guidance during onboarding", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-token";
    process.env.TELEGRAM_REQUIRE_MENTION = "1";
    process.env.TELEGRAM_ALLOWED_IDS = "123456789";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["telegram"],
      new Set(["telegram"]),
      [{ name: "telegram", ...KNOWN_CHANNELS.telegram }],
    );

    const output = logs.join("\n");
    expect(output).toContain("disable privacy mode in @BotFather");
    expect(output).toContain("/setprivacy -> your bot -> Disable");
    expect(output).toContain("remove and re-add the bot to each group");
    expect(output).toContain("reply mode already set: @mentions only");
  });

  it("#3715 re-prompts instead of accepting an invalid preconfigured Slack bot token", async () => {
    process.env.SLACK_BOT_TOKEN = "abcd";
    process.env.SLACK_APP_TOKEN = "xapp-existing";
    vi.mocked(prompt).mockResolvedValueOnce("xoxb-valid-token").mockResolvedValueOnce("");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["slack"],
      new Set(["slack"]),
      [{ name: "slack", ...KNOWN_CHANNELS.slack }],
    );

    expect(prompt).toHaveBeenCalledWith("  Slack Bot Token: ", { secret: true });
    expect(saveCredential).toHaveBeenCalledWith("SLACK_BOT_TOKEN", "xoxb-valid-token");
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-valid-token");
    const output = logs.join("\n");
    expect(output).toContain("Invalid existing slack token ignored");
    expect(output).not.toContain("slack — already configured");
  });

  it("prompts for Slack channel IDs with channel-specific copy", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-1234-test";
    process.env.SLACK_APP_TOKEN = ["xapp", "1", "A0000", "12345", "test"].join("-");
    process.env.SLACK_ALLOWED_USERS = "U01ABC2DEF3";
    vi.mocked(prompt).mockResolvedValueOnce("C012AB3CD,C987ZY6XW");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["slack"],
      new Set(["slack"]),
      [{ name: "slack", ...KNOWN_CHANNELS.slack }],
    );

    expect(process.env.SLACK_ALLOWED_CHANNELS).toBe("C012AB3CD,C987ZY6XW");
    expect(vi.mocked(prompt)).toHaveBeenCalledWith(
      "  Slack Channel IDs (comma-separated allowlist): ",
    );
    const output = logs.join("\n");
    expect(output).toContain("Slack channel IDs");
    expect(output).toContain("channel IDs saved");
  });
});
