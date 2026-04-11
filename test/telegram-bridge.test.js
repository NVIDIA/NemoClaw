// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, it, vi } from "vitest";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

describe("telegram bridge", () => {
  it("builds Telegram channel agent commands", () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const {
      buildAgentCommand,
      buildTelegramToolCheckCommand,
    } = require("../scripts/telegram-bridge.js");

    try {
      const command = buildAgentCommand("it's from telegram", "12345");
      const checkCommand = buildTelegramToolCheckCommand("12345");
      assert.match(command, /openclaw agent/);
      assert.match(command, /--channel telegram/);
      assert.match(command, /TELEGRAM_BOT_TOKEN='token'/);
      assert.doesNotMatch(command, /--reply-channel telegram/);
      assert.doesNotMatch(command, /--reply-to '12345'/);
      assert.match(command, /--session-id 'tg-12345'/);
      assert.match(command, /-m 'it'\\''s from telegram'/);
      assert.match(checkCommand, /openclaw message send/);
      assert.match(checkCommand, /TELEGRAM_BOT_TOKEN='token'/);
      assert.match(checkCommand, /--channel telegram/);
      assert.match(checkCommand, /--target '12345'/);
      assert.match(checkCommand, /--dry-run --json/);
    } finally {
      restoreResolve.mockRestore();
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/telegram-bridge.js")];
    }
  });

  it("replaces the known false negative when sandbox Telegram delivery is available", () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { normalizeAgentResponse } = require("../scripts/telegram-bridge.js");

    try {
      const response = normalizeAgentResponse(
        "I'm still having trouble sending messages via the OpenClaw Telegram tool despite the configuration we tried.",
        true,
      );

      assert.match(response, /Telegram delivery is available from inside the sandbox/);
      assert.doesNotMatch(
        response,
        /still having trouble sending messages via the OpenClaw Telegram tool/i,
      );
      assert.equal(normalizeAgentResponse("All good.", true), "All good.");
      assert.match(
        normalizeAgentResponse(
          "I'm still having trouble sending messages via the OpenClaw Telegram tool despite the configuration we tried.",
          false,
        ),
        /still having trouble sending messages via the OpenClaw Telegram tool/i,
      );
    } finally {
      restoreResolve.mockRestore();
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/telegram-bridge.js")];
    }
  });

  it("filters noisy stderr warnings from bridge failures", () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    const originalApiKey = process.env.NVIDIA_API_KEY;

    process.env.TELEGRAM_BOT_TOKEN = "token";
    process.env.NVIDIA_API_KEY = "secret";

    const restoreResolve = vi
      .spyOn(require("../bin/lib/resolve-openshell"), "resolveOpenshell")
      .mockImplementation(() => "/usr/bin/openshell");
    const { formatAgentFailure, summarizeStderr } = require("../scripts/telegram-bridge.js");

    try {
      const stderr = [
        "(node:20407) [UNDICI-EHPA] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time.",
        "(Use `node --trace-warnings ...` to show where the warning was created)",
        "ssh: connect to host failed",
      ].join("\n");

      assert.equal(summarizeStderr(stderr), "ssh: connect to host failed");
      assert.match(formatAgentFailure(255, stderr), /Agent session failed while reaching sandbox/);
      assert.match(formatAgentFailure(255, stderr), /ssh: connect to host failed/);
      assert.doesNotMatch(formatAgentFailure(255, stderr), /UNDICI-EHPA/);
    } finally {
      restoreResolve.mockRestore();
      process.env.TELEGRAM_BOT_TOKEN = originalToken;
      process.env.NVIDIA_API_KEY = originalApiKey;
      delete require.cache[require.resolve("../scripts/telegram-bridge.js")];
    }
  });
});
