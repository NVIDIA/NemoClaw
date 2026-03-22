// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord messaging adapter.
 *
 * Uses discord.js for WebSocket-based gateway connection.
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");

module.exports = function createAdapter(config) {
  const TOKEN = process.env[config.credential_env];
  const ALLOWED = process.env[config.allowed_env]
    ? process.env[config.allowed_env].split(",").map((s) => s.trim())
    : null;

  return {
    name: "discord",

    start(onMessage) {
      return new Promise((resolve, reject) => {
        const client = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.DirectMessages,
          ],
          partials: [Partials.Channel],
        });

        client.on("messageCreate", async (message) => {
          if (message.author.bot) return;

          const channelId = message.channel.id;
          if (ALLOWED && !ALLOWED.includes(channelId)) return;
          if (!message.content) return;

          await onMessage({
            channelId,
            userName: message.author.username,
            text: message.content,
            async sendTyping() {
              await message.channel.sendTyping().catch(() => {});
            },
            async reply(text) {
              await message.reply(text);
            },
          });
        });

        client.once("ready", () => resolve(client.user.tag));
        client.login(TOKEN).catch(reject);
      });
    },
  };
};
