// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prompt, saveCredential } from "../credentials/store";
import { KNOWN_CHANNELS } from "../sandbox/channels";
import { setupSelectedMessagingChannels } from "./messaging-channel-setup";
import { validateSlackCredentials } from "./slack-validation";

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

vi.mock("./slack-validation", () => ({
  formatSlackValidationFailure: vi.fn((result: { message: string }) => result.message),
  validateSlackCredentials: vi.fn(() => ({ ok: true })),
}));

const ORIGINAL_ENV = { ...process.env };

describe("setupSelectedMessagingChannels", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    vi.mocked(validateSlackCredentials).mockReturnValue({ ok: true });
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

  it("accepts Telegram allowlist aliases during channel setup", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-token";
    process.env.TELEGRAM_CHAT_ID = "8388960805";
    process.env.TELEGRAM_REQUIRE_MENTION = "0";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["telegram"],
      new Set(["telegram"]),
      [{ name: "telegram", ...KNOWN_CHANNELS.telegram }],
    );

    expect(process.env.TELEGRAM_ALLOWED_IDS).toBe("8388960805");
    expect(prompt).not.toHaveBeenCalledWith("  Telegram User ID (for DM access): ");
    expect(logs.join("\n")).toContain("telegram — allowed IDs already set: 8388960805");
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

  it("does not save prompted Slack credentials when Slack API rejects them", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    vi.mocked(prompt)
      .mockResolvedValueOnce("xoxb-fake-bot-token")
      .mockResolvedValueOnce("xapp-fake-app-token");
    vi.mocked(validateSlackCredentials).mockReturnValueOnce({
      ok: false,
      kind: "rejected",
      tokenKind: "app",
      credential: "app",
      error: "invalid_auth",
      httpStatus: 200,
      curlStatus: 0,
      message: "Slack app token was rejected by Slack API: invalid_auth.",
    });
    const enabled = new Set(["slack"]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["slack"],
      enabled,
      [{ name: "slack", ...KNOWN_CHANNELS.slack }],
    );

    expect(enabled.has("slack")).toBe(false);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(process.env.SLACK_APP_TOKEN).toBeUndefined();
    const output = logs.join("\n");
    expect(output).toContain("Slack app token was rejected by Slack API");
    expect(output).not.toContain("xoxb-fake-bot-token");
    expect(output).not.toContain("xapp-fake-app-token");
  });

  it("does not save prompted Slack credentials when Slack API validation is indeterminate", async () => {
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_APP_TOKEN;
    vi.mocked(prompt)
      .mockResolvedValueOnce("xoxb-timeout-bot-token")
      .mockResolvedValueOnce("xapp-timeout-app-token");
    vi.mocked(validateSlackCredentials).mockReturnValueOnce({
      ok: false,
      kind: "indeterminate",
      tokenKind: "bot",
      credential: "bot",
      httpStatus: 0,
      curlStatus: 28,
      message: "Slack bot token could not be validated because Slack API was unreachable.",
    });
    const enabled = new Set(["slack"]);

    await setupSelectedMessagingChannels(
      ["slack"],
      enabled,
      [{ name: "slack", ...KNOWN_CHANNELS.slack }],
    );

    expect(enabled.has("slack")).toBe(false);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(process.env.SLACK_BOT_TOKEN).toBeUndefined();
    expect(process.env.SLACK_APP_TOKEN).toBeUndefined();
  });

  it("ignores existing Slack tokens that pass format but fail Slack API validation", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-existing-invalid";
    process.env.SLACK_APP_TOKEN = "xapp-existing-valid";
    vi.mocked(validateSlackCredentials).mockReturnValueOnce({
      ok: false,
      kind: "rejected",
      tokenKind: "bot",
      credential: "bot",
      error: "token_revoked",
      httpStatus: 200,
      curlStatus: 0,
      message: "Slack bot token was rejected by Slack API: token_revoked.",
    });
    const enabled = new Set(["slack"]);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["slack"],
      enabled,
      [{ name: "slack", ...KNOWN_CHANNELS.slack }],
    );

    expect(enabled.has("slack")).toBe(false);
    expect(prompt).not.toHaveBeenCalled();
    expect(saveCredential).not.toHaveBeenCalled();
    const output = logs.join("\n");
    expect(output).toContain("Invalid existing slack token ignored");
    expect(output).toContain("token_revoked");
    expect(output).not.toContain("slack — already configured");
  });
});
