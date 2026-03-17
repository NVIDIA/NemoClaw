#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// NemoClaw Discord Bridge
//
// Forwards Discord messages to the OpenClaw gateway running inside the
// NemoClaw sandbox. The gateway handles agent sessions, system prompts,
// SOUL.md loading, and memory.
//
// Env:
//   DISCORD_BOT_TOKEN   - Discord bot token
//   SANDBOX_NAME        - sandbox name (default: nemoclaw)
//   DISCORD_GUILD_ID    - allowed guild (optional, accepts all if unset)
//   DISCORD_CHANNEL_ID  - channel to listen on (optional)
//   ALLOWED_USER_IDS    - comma-separated Discord user IDs (optional)
//   GATEWAY_TOKEN       - OpenClaw gateway auth token

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { spawn } = require("child_process");
const path = require("path");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const GUILD_ID = process.env.DISCORD_GUILD_ID || "";
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || "";
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim())
  : null;

if (!TOKEN) {
  console.error("DISCORD_BOT_TOKEN required");
  process.exit(1);
}

const activeLocks = new Set();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

// -- Run agent via gateway inside sandbox --

function runAgentViaGateway(message, sessionId) {
  return new Promise((resolve) => {
    const escaped = message.replace(/'/g, "'\\''");

    // Use nemoclaw-start to ensure gateway is running, then run agent through it
    const cmd = `nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id '${sessionId}'`;

    const proc = spawn("ssh", ["-T", "openshell-nemoclaw", cmd], {
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:${process.env.PATH}` },
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("[gateway]") &&
          !l.startsWith("[auto-pair]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("UNDICI-EHPA") &&
          !l.includes("openclaw gateway") &&
          !l.includes("auto-pair watcher") &&
          !l.includes("Local UI:") &&
          !l.includes("Remote UI:") &&
          !/^[\s\u2502\u250c\u2514\u2500\u2501]+$/.test(l) &&
          !/^\s*\|/.test(l) &&
          l.trim() !== "",
      );

      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        resolve(`Agent exited with code ${code}. ${stderr.trim().slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => resolve(`Error: ${err.message}`));
  });
}

// -- Discord message handler --

client.on("messageCreate", async (msg) => {
  if (msg.author.bot) return;
  if (GUILD_ID && msg.guild && msg.guild.id !== GUILD_ID) return;
  if (CHANNEL_ID && msg.channel.id !== CHANNEL_ID) return;
  if (ALLOWED_USERS && !ALLOWED_USERS.includes(msg.author.id)) return;

  const isMention = msg.mentions.has(client.user);
  const isDM = !msg.guild;
  const isDesignatedChannel = CHANNEL_ID && msg.channel.id === CHANNEL_ID;

  if (!isMention && !isDM && !isDesignatedChannel) return;

  let content = msg.content.replace(/<@!?\d+>/g, "").trim();
  if (!content) {
    await msg.reply("Send me a message and I'll run it through the NemoClaw agent.");
    return;
  }

  const userId = msg.author.id;
  if (activeLocks.has(userId)) {
    await msg.reply("Still working on your last message. Hang tight.");
    return;
  }

  activeLocks.add(userId);
  // Use a persistent session per user so context carries across messages
  const sessionId = `discord-${userId}`;

  console.log(`[${msg.channel.name || "DM"}] ${msg.author.username}: ${content.slice(0, 80)}`);

  const typingInterval = setInterval(() => {
    msg.channel.sendTyping().catch(() => {});
  }, 5000);
  msg.channel.sendTyping().catch(() => {});

  try {
    const response = await runAgentViaGateway(content, sessionId);
    clearInterval(typingInterval);

    console.log(`[${msg.channel.name || "DM"}] agent: ${response.slice(0, 80)}...`);

    const chunks = [];
    for (let i = 0; i < response.length; i += 1950) {
      chunks.push(response.slice(i, i + 1950));
    }

    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await msg.reply(chunks[i]);
      } else {
        await msg.channel.send(chunks[i]);
      }
    }
  } catch (err) {
    clearInterval(typingInterval);
    console.error(`Error: ${err.message}`);
    await msg.reply(`Error: ${err.message}`).catch(() => {});
  } finally {
    activeLocks.delete(userId);
  }
});

client.once("ready", () => {
  console.log("");
  console.log("  +---------------------------------------------------------+");
  console.log("  |  NemoClaw Discord Bridge                                |");
  console.log("  |                                                         |");
  console.log(`  |  Bot:      ${(client.user.tag + "                           ").slice(0, 44)}|`);
  console.log(`  |  Sandbox:  ${(SANDBOX + "                                    ").slice(0, 44)}|`);
  console.log("  |  Mode:     gateway (nemoclaw-start + openclaw agent)    |");
  console.log("  |  Guild:    " + (GUILD_ID ? "restricted" : "all") + "                                       |");
  console.log("  |                                                         |");
  console.log("  |  Messages forwarded through OpenClaw gateway with       |");
  console.log("  |  full session context, SOUL.md, and memory support.     |");
  console.log("  +---------------------------------------------------------+");
  console.log("");

  client.user.setPresence({
    status: "online",
    activities: [{ name: "NemoClaw on DGX Spark", type: 0 }],
  });
});

client.login(TOKEN);
