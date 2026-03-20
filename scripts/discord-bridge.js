#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord → NemoClaw bridge.
 *
 * Messages from Discord channels are forwarded to the OpenClaw agent
 * running inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to the channel.
 *
 * The bridge runs on the host because the sandbox proxy does not support
 * CONNECT tunneling for WebSockets, which the Discord gateway requires.
 *
 * Env:
 *   DISCORD_BOT_TOKEN   — from the Discord Developer Portal
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: default, matches start-services.sh)
 *   NEMOCLAW_MODEL      — model ID (default: nvidia/nemotron-3-super-120b-a12b)
 *   ALLOWED_GUILD_IDS   — comma-separated guild IDs to accept (optional, accepts all if unset)
 *   DEBUG_DISCORD       — set to "true" to log full message content (default: off)
 */

const { execSync, spawn } = require("child_process");
const { Client, GatewayIntentBits } = require("discord.js");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "default";
const MODEL = process.env.NEMOCLAW_MODEL || "nvidia/nemotron-3-super-120b-a12b";
const ALLOWED_GUILDS = process.env.ALLOWED_GUILD_IDS
  ? process.env.ALLOWED_GUILD_IDS.split(",").map((s) => s.trim())
  : null;
const DEBUG = process.env.DEBUG_DISCORD === "true";

if (!TOKEN) { console.error("DISCORD_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

// Discord max message length is 2000 characters
const DISCORD_MAX_LENGTH = 2000;

// Per-channel session continuity: channelId → sessionId
// A session ID is a unique string created when the channel first sends a message
// or after !reset. Using a timestamp suffix ensures reset truly starts a new session.
const activeSessions = new Map();

// ── Run agent inside sandbox ──────────────────────────────────────

/**
 * Forward a message to the OpenClaw agent running inside the sandbox via SSH
 * and return the agent's response as a string.
 *
 * @param {string} message   - The user message to send to the agent.
 * @param {string} sessionId - The session identifier for conversation continuity.
 * @returns {Promise<string>} The agent's response text.
 */
function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execSync(`"${OPENSHELL}" sandbox ssh-config "${SANDBOX}"`, { encoding: "utf-8" });

    // Use a unique path per invocation to avoid races when multiple messages
    // arrive concurrently in the same channel.
    const confPath = `/tmp/nemoclaw-dc-ssh-${sessionId}-${Date.now()}-${Math.random().toString(36).slice(2)}.conf`;
    require("fs").writeFileSync(confPath, sshConfig);

    const escaped = message.replace(/'/g, "'\\''");
    const cmd = `export NVIDIA_API_KEY='${API_KEY}' && export NEMOCLAW_MODEL='${MODEL}' && nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'dc-${sessionId}'`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); } catch {}

      // Extract the actual agent response — skip setup lines
      const lines = stdout.split("\n");
      const responseLines = lines.filter(
        (l) =>
          !l.startsWith("Setting up NemoClaw") &&
          !l.startsWith("[plugins]") &&
          !l.startsWith("(node:") &&
          !l.includes("NemoClaw ready") &&
          !l.includes("NemoClaw registered") &&
          !l.includes("openclaw agent") &&
          !l.includes("┌─") &&
          !l.includes("│ ") &&
          !l.includes("└─") &&
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

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Send chunked message ──────────────────────────────────────────

/**
 * Send a text response to a Discord channel, splitting it into chunks
 * when it exceeds Discord's 2000-character message limit.
 *
 * @param {import("discord.js").TextChannel} channel - The Discord channel to send to.
 * @param {string} text - The full response text to send.
 * @returns {Promise<void>}
 */
async function sendChunked(channel, text) {
  const chunks = [];
  for (let i = 0; i < text.length; i += DISCORD_MAX_LENGTH) {
    chunks.push(text.slice(i, i + DISCORD_MAX_LENGTH));
  }
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

// ── Discord client ────────────────────────────────────────────────

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.on("messageCreate", async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Require a guild context (no DMs)
  if (!message.guild) return;

  // Access control
  if (ALLOWED_GUILDS && !ALLOWED_GUILDS.includes(message.guild.id)) {
    return;
  }

  const channelId = message.channel.id;
  const content = message.content.trim();

  // Handle !reset — delete the stored session so the next message gets a fresh ID
  if (content === "!reset") {
    activeSessions.delete(channelId);
    await message.reply("Session reset.");
    return;
  }

  if (!content) return;

  // Log only metadata by default; full content only when DEBUG_DISCORD=true
  if (DEBUG) {
    console.log(`[${message.guild.id}/#${channelId}] ${message.author.username}: ${content}`);
  } else {
    console.log(`[${message.guild.id}/#${channelId}] ${message.author.id}: ${content.length} chars`);
  }

  // Reuse the existing session for this channel, or create a new one
  if (!activeSessions.has(channelId)) {
    activeSessions.set(channelId, `ch-${channelId}-${Date.now()}`);
  }
  const sessionId = activeSessions.get(channelId);

  // Show typing indicator while agent runs
  const typingInterval = setInterval(() => {
    message.channel.sendTyping().catch(() => {});
  }, 8000);
  await message.channel.sendTyping().catch(() => {});

  try {
    const response = await runAgentInSandbox(content, sessionId);
    clearInterval(typingInterval);
    console.log(`[${channelId}] agent responded (${response.length} chars)`);
    await sendChunked(message.channel, response);
  } catch (err) {
    clearInterval(typingInterval);
    await message.reply(`Error: ${err.message}`);
  }
});

client.once("ready", () => {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Discord Bridge                           │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      ${(client.user.tag + "                              ").slice(0, 42)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    " + (MODEL + "                              ").slice(0, 40) + "│");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  │                                                     │");
  console.log("  │  Commands:  !reset  — clear channel session        │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
});

client.login(TOKEN).catch((err) => {
  console.error("Failed to connect to Discord:", err.message);
  process.exit(1);
});
