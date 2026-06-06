// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getCredential, prompt, saveCredential } from "../credentials/store";
import { HOST_QR_LOGIN_HANDLERS } from "../host-qr-handlers";
import { createBuiltInChannelManifestRegistry, MessagingSetupApplier } from "../messaging";
import { MESSAGING_SETUP_APPLIER_ENV_KEY } from "../messaging/applier/types";
import {
  setupMessagingChannels,
  setupSelectedMessagingChannels,
} from "./messaging-channel-setup";
import { validateSlackCredentials } from "../messaging/channels/slack/hooks/credential-validation";

vi.mock("../credentials/store", () => ({
  getCredential: vi.fn(() => null),
  normalizeCredentialValue: vi.fn((value: unknown) =>
    typeof value === "string" ? value.trim() : "",
  ),
  prompt: vi.fn(async () => ""),
  saveCredential: vi.fn(),
}));

vi.mock("../host-qr-handlers", () => ({
  HOST_QR_LOGIN_HANDLERS: {
    wechat: vi.fn(),
  },
}));

vi.mock("../messaging/channels/slack/hooks/credential-validation", () => ({
  formatSlackValidationFailure: vi.fn((result: { message: string }) => result.message),
  validateSlackCredentials: vi.fn(() => ({ ok: true })),
}));

const ORIGINAL_ENV = { ...process.env };
const manifestRegistry = createBuiltInChannelManifestRegistry();

function manifests(...channelIds: string[]) {
  return channelIds.map((channelId) => {
    const manifest = manifestRegistry.get(channelId);
    if (!manifest) throw new Error(`missing manifest ${channelId}`);
    return manifest;
  });
}

function stubTelegramReachability(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      async json() {
        return { ok: true };
      },
      async text() {
        return "";
      },
    })),
  );
}

describe("setupSelectedMessagingChannels", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    vi.mocked(getCredential).mockReturnValue(null);
    vi.mocked(prompt).mockResolvedValue("");
    stubTelegramReachability();
    vi.mocked(validateSlackCredentials).mockReturnValue({ ok: true });
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
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
      manifests("telegram"),
    );

    const output = logs.join("\n");
    expect(output).toContain("disable privacy mode in @BotFather");
    expect(output).toContain("/setprivacy -> your bot -> Disable");
    expect(output).toContain("remove and re-add the bot to each group");
    expect(output).toContain("reply mode already set: @mentions only");
    expect(output.indexOf("✓ telegram — already configured")).toBeLessThan(
      output.indexOf("disable privacy mode in @BotFather"),
    );
    expect(output.indexOf("disable privacy mode in @BotFather")).toBeLessThan(
      output.indexOf("reply mode already set: @mentions only"),
    );
  });

  it("disables Telegram when reachability rejects the token during interactive setup", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-token";
    process.env.TELEGRAM_REQUIRE_MENTION = "1";
    process.env.TELEGRAM_ALLOWED_IDS = "123456789";
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      async json() {
        return { ok: false };
      },
      async text() {
        return "";
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });
    const enabled = new Set(["telegram"]);

    const plan = await setupSelectedMessagingChannels(
      ["telegram"],
      enabled,
      manifests("telegram"),
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(enabled.has("telegram")).toBe(false);
    expect(plan?.channels[0]).toMatchObject({ channelId: "telegram", active: false });
    expect(
      logs.filter((line) => line.includes("Bot token was rejected by Telegram")),
    ).toHaveLength(1);
  });

  it("accepts Telegram allowlist aliases during manifest channel setup", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:ABC-test-token";
    process.env.TELEGRAM_ALLOWED_IDS = "8388960805";
    process.env.TELEGRAM_AUTHORIZED_CHAT_IDS = "8388960806";
    process.env.TELEGRAM_CHAT_ID = "8388960807";
    process.env.TELEGRAM_REQUIRE_MENTION = "0";
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["telegram"],
      new Set(["telegram"]),
      manifests("telegram"),
    );

    expect(process.env.TELEGRAM_ALLOWED_IDS).toBe("8388960805,8388960806,8388960807");
    expect(prompt).not.toHaveBeenCalledWith("  Telegram User ID (for DM access): ");
    expect(logs.join("\n")).toContain(
      "telegram — allowed IDs already set: 8388960805,8388960806,8388960807",
    );
  });

  it("uses manifest token validation for Slack dual-token enrollment", async () => {
    const logs: string[] = [];
    vi.mocked(prompt).mockResolvedValueOnce("not-a-slack-token");
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });
    const enabled = new Set(["slack"]);

    await setupSelectedMessagingChannels(
      ["slack"],
      enabled,
      manifests("slack"),
    );

    expect(enabled.has("slack")).toBe(false);
    expect(saveCredential).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Slack bot tokens start with 'xoxb-'");
    expect(logs.join("\n")).toContain("Skipped slack (invalid token format)");
    expect(logs.join("\n")).not.toContain("enrollment failed");
  });

  it("reprompts for an invalid existing Slack token during interactive setup", async () => {
    process.env.SLACK_BOT_TOKEN = "not-a-slack-token";
    process.env.SLACK_APP_TOKEN = "xapp-existing-token";
    const logs: string[] = [];
    const questions: string[] = [];
    vi.mocked(prompt).mockImplementation(async (question: string) => {
      questions.push(question);
      if (question.includes("Slack Bot Token")) return "xoxb-recovered-token";
      return "";
    });
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });
    const enabled = new Set(["slack"]);

    const plan = await setupSelectedMessagingChannels(
      ["slack"],
      enabled,
      manifests("slack"),
    );

    expect(enabled.has("slack")).toBe(true);
    expect(plan?.channels[0]).toMatchObject({ channelId: "slack", active: true });
    expect(questions).toEqual([
      "  Slack Bot Token: ",
      "  Slack Member IDs (comma-separated allowlist): ",
      "  Slack Channel IDs (comma-separated allowlist): ",
    ]);
    expect(saveCredential).toHaveBeenCalledWith(
      "SLACK_BOT_TOKEN",
      "xoxb-recovered-token",
    );
    expect(saveCredential).not.toHaveBeenCalledWith(
      "SLACK_APP_TOKEN",
      "xapp-existing-token",
    );
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-recovered-token");
    expect(process.env.SLACK_APP_TOKEN).toBe("xapp-existing-token");
    expect(logs.join("\n")).toContain("Invalid existing slack token ignored");
    expect(logs.join("\n")).not.toContain("Skipped slack (invalid token format)");
  });

  it("prompts each channel's config before enrolling the next selected channel", async () => {
    const questions: string[] = [];
    vi.mocked(prompt).mockImplementation(async (question: string) => {
      questions.push(question);
      if (question.includes("Telegram Bot Token")) return "123456:telegram-token";
      if (question.includes("Reply only")) return "n";
      if (question.includes("Telegram User ID")) return "123456789";
      if (question.includes("Discord Bot Token")) return "discord-token";
      return "";
    });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await setupSelectedMessagingChannels(
      ["telegram", "discord"],
      new Set(["telegram", "discord"]),
      manifests("telegram", "discord"),
    );

    expect(questions).toEqual([
      "  Telegram Bot Token: ",
      "  Reply only when @mentioned? [Y/n]: ",
      "  Telegram User ID (for DM access): ",
      "  Discord Bot Token: ",
      "  Discord Server ID (for guild workspace access): ",
    ]);
    expect(process.env.TELEGRAM_REQUIRE_MENTION).toBe("0");
    expect(process.env.TELEGRAM_ALLOWED_IDS).toBe("123456789");
  });

  it("prompts Discord guild-only config after the manifest server ID input is set", async () => {
    process.env.DISCORD_BOT_TOKEN = "discord-token";
    vi.mocked(prompt)
      .mockResolvedValueOnce("1491590992753590594")
      .mockResolvedValueOnce("n")
      .mockResolvedValueOnce("1005536447329222676");
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    await setupSelectedMessagingChannels(
      ["discord"],
      new Set(["discord"]),
      manifests("discord"),
    );

    expect(process.env.DISCORD_SERVER_ID).toBe("1491590992753590594");
    expect(process.env.DISCORD_REQUIRE_MENTION).toBe("0");
    expect(process.env.DISCORD_USER_ID).toBe("1005536447329222676");
    expect(logs.join("\n")).toContain("discord server ID saved");
    expect(logs.join("\n")).toContain("discord reply mode saved: all messages");
    expect(logs.join("\n")).toContain("discord allowed IDs saved");
  });

  it("runs WeChat host-QR enrollment through the manifest hook", async () => {
    vi.mocked(HOST_QR_LOGIN_HANDLERS.wechat).mockResolvedValue({
      kind: "ok",
      token: "wechat-token",
      extraEnv: {
        WECHAT_ACCOUNT_ID: "wechat-account",
        WECHAT_BASE_URL: "https://ilinkai.wechat.example",
        WECHAT_USER_ID: "wechat-user",
      },
      defaultUserId: "wechat-user",
      summary: "account wechat-account",
    });
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    const plan = await setupSelectedMessagingChannels(
      ["wechat"],
      new Set(["wechat"]),
      manifests("wechat"),
    );

    expect(saveCredential).toHaveBeenCalledWith("WECHAT_BOT_TOKEN", "wechat-token");
    expect(process.env.WECHAT_ACCOUNT_ID).toBe("wechat-account");
    expect(process.env.WECHAT_BASE_URL).toBe("https://ilinkai.wechat.example");
    expect(process.env.WECHAT_USER_ID).toBe("wechat-user");
    expect(process.env.WECHAT_ALLOWED_IDS).toBe("wechat-user");
    expect(plan?.channels[0]).toMatchObject({ channelId: "wechat", active: true });
    expect(logs.join("\n")).toContain("wechat token saved (account wechat-account)");
  });

  it("enrolls tokenless WhatsApp without credential prompts or providers", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    const plan = await setupSelectedMessagingChannels(
      ["whatsapp"],
      new Set(["whatsapp"]),
      manifests("whatsapp"),
      { agent: { name: "hermes" } },
    );

    expect(prompt).not.toHaveBeenCalled();
    expect(getCredential).not.toHaveBeenCalled();
    expect(plan?.credentialBindings).toEqual([]);
    expect(plan?.channels[0]).toMatchObject({
      channelId: "whatsapp",
      authMode: "in-sandbox-qr",
      active: true,
    });
    expect(logs.join("\n")).toContain("WhatsApp Web pairs via QR code");
    expect(logs.join("\n")).toContain("channels status --channel whatsapp");
  });

  it("threads the resolved sandbox name into manifest provider bindings", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-token";

    const plan = await setupSelectedMessagingChannels(
      ["telegram"],
      new Set(["telegram"]),
      manifests("telegram"),
      { interactive: false, sandboxName: "actual-sandbox" },
    );

    expect(plan?.credentialBindings).toContainEqual(
      expect.objectContaining({
        channelId: "telegram",
        providerName: "actual-sandbox-telegram-bridge",
      }),
    );
    expect(JSON.stringify(plan)).not.toContain("pending-sandbox");
    expect(MessagingSetupApplier.requirePlanFromEnv()).toEqual(plan);
  });
});

describe("setupMessagingChannels", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.clearAllMocks();
    vi.mocked(getCredential).mockReturnValue(null);
    vi.mocked(prompt).mockResolvedValue("");
    vi.mocked(validateSlackCredentials).mockReturnValue({ ok: true });
    stubTelegramReachability();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("orchestrates non-interactive manifest selection with injected onboard deps", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "123456:telegram-token";
    process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
    process.env.SLACK_APP_TOKEN = "xapp-test-slack-token";
    const steps: string[] = [];
    const notes: string[] = [];

    const result = await setupMessagingChannels(null, null, {
      step: (current, total, label) => steps.push(`${current}/${total} ${label}`),
      note: (message) => notes.push(message),
      isNonInteractive: () => true,
    });

    expect(result).toEqual(["telegram", "slack"]);
    expect(steps).toEqual(["5/8 Messaging channels"]);
    expect(notes).toEqual([
      "  [non-interactive] Messaging channel inputs detected: telegram, slack",
    ]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("skips partially configured multi-secret channels in non-interactive mode", async () => {
    process.env.SLACK_BOT_TOKEN = "xoxb-test-slack-token";
    const notes: string[] = [];

    const result = await setupMessagingChannels(null, null, {
      note: (message) => notes.push(message),
      isNonInteractive: () => true,
    });

    expect(result).toEqual([]);
    expect(notes).toEqual([
      "  [non-interactive] No complete messaging channel inputs configured. Skipping.",
    ]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("clears any stale serialized messaging plan when no channels are selected", async () => {
    process.env[MESSAGING_SETUP_APPLIER_ENV_KEY] = "stale-plan";

    const result = await setupMessagingChannels(null, null, {
      isNonInteractive: () => true,
    });

    expect(result).toEqual([]);
    expect(process.env[MESSAGING_SETUP_APPLIER_ENV_KEY]).toBeUndefined();
  });

  it("skips channels missing required non-secret inputs in non-interactive mode", async () => {
    process.env.WECHAT_BOT_TOKEN = "wechat-token";
    process.env.WECHAT_ACCOUNT_ID = "   ";
    const notes: string[] = [];

    const result = await setupMessagingChannels(null, null, {
      note: (message) => notes.push(message),
      isNonInteractive: () => true,
    });

    expect(result).toEqual([]);
    expect(notes).toEqual([
      "  [non-interactive] No complete messaging channel inputs configured. Skipping.",
    ]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("seeds channels with all required secret and non-secret inputs in non-interactive mode", async () => {
    process.env.WECHAT_BOT_TOKEN = "wechat-token";
    process.env.WECHAT_ACCOUNT_ID = "wechat-account";
    const notes: string[] = [];

    const result = await setupMessagingChannels(null, null, {
      note: (message) => notes.push(message),
      isNonInteractive: () => true,
    });

    expect(result).toEqual(["wechat"]);
    expect(notes).toEqual([
      "  [non-interactive] Messaging channel inputs detected: wechat",
    ]);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("validates detected non-interactive Slack inputs before returning enabled channels", async () => {
    process.env.SLACK_BOT_TOKEN = "not-a-slack-token";
    process.env.SLACK_APP_TOKEN = "xapp-existing-token";
    const logs: string[] = [];
    const notes: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message = "") => {
      logs.push(String(message));
    });

    const result = await setupMessagingChannels(null, null, {
      note: (message) => notes.push(message),
      isNonInteractive: () => true,
    });

    expect(result).toEqual([]);
    expect(notes).toEqual([
      "  [non-interactive] Messaging channel inputs detected: slack",
    ]);
    expect(logs.join("\n")).toContain("Slack bot tokens start with 'xoxb-'");
    expect(logs.join("\n")).toContain("Skipped slack (invalid token format)");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("disables Slack when Slack API rejects prompted credentials", async () => {
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
      manifests("slack"),
    );

    expect(enabled.has("slack")).toBe(false);
    expect(saveCredential).toHaveBeenCalledWith("SLACK_BOT_TOKEN", "xoxb-fake-bot-token");
    expect(saveCredential).toHaveBeenCalledWith("SLACK_APP_TOKEN", "xapp-fake-app-token");
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-fake-bot-token");
    expect(process.env.SLACK_APP_TOKEN).toBe("xapp-fake-app-token");
    const output = logs.join("\n");
    expect(output).toContain("Slack app token was rejected by Slack API");
    expect(output).not.toContain("xoxb-fake-bot-token");
    expect(output).not.toContain("xapp-fake-app-token");
  });

  it("disables Slack when Slack API validation is indeterminate", async () => {
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
      manifests("slack"),
    );

    expect(enabled.has("slack")).toBe(false);
    expect(saveCredential).toHaveBeenCalledWith("SLACK_BOT_TOKEN", "xoxb-timeout-bot-token");
    expect(saveCredential).toHaveBeenCalledWith("SLACK_APP_TOKEN", "xapp-timeout-app-token");
    expect(process.env.SLACK_BOT_TOKEN).toBe("xoxb-timeout-bot-token");
    expect(process.env.SLACK_APP_TOKEN).toBe("xapp-timeout-app-token");
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
      manifests("slack"),
    );

    expect(enabled.has("slack")).toBe(false);
    expect(prompt).toHaveBeenCalledWith("  Slack Member IDs (comma-separated allowlist): ");
    expect(prompt).toHaveBeenCalledWith("  Slack Channel IDs (comma-separated allowlist): ");
    expect(saveCredential).not.toHaveBeenCalled();
    const output = logs.join("\n");
    expect(output).toContain("token_revoked");
    expect(output).toContain("slack — already configured");
  });
});
