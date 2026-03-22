// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack messaging adapter.
 *
 * Uses @slack/bolt in Socket Mode (requires SLACK_APP_TOKEN).
 */

const { App } = require("@slack/bolt");

module.exports = function createAdapter(config) {
  const BOT_TOKEN = process.env[config.credential_env];
  const APP_TOKEN = process.env.SLACK_APP_TOKEN;
  const ALLOWED = process.env[config.allowed_env]
    ? process.env[config.allowed_env].split(",").map((s) => s.trim())
    : null;

  if (!APP_TOKEN) {
    console.error("SLACK_APP_TOKEN required (xapp-... for Socket Mode)");
    process.exit(1);
  }

  return {
    name: "slack",

    async start(onMessage) {
      const app = new App({
        token: BOT_TOKEN,
        appToken: APP_TOKEN,
        socketMode: true,
      });

      app.message(async ({ message, say }) => {
        if (message.subtype) return;
        if (!message.text) return;

        const channelId = message.channel;
        if (ALLOWED && !ALLOWED.includes(channelId)) return;

        await onMessage({
          channelId,
          userName: message.user || "someone",
          text: message.text,
          async sendTyping() {
            // Slack doesn't have a direct typing indicator API for bots
          },
          async reply(text) {
            await say({ text, thread_ts: message.ts });
          },
        });
      });

      await app.start();
      return "Slack Bot (Socket Mode)";
    },
  };
};
