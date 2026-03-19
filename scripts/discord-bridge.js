#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord → NemoClaw bridge.
 *
 * Messages from Discord are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Discord.
 *
 * Env:
 *   DISCORD_BOT_TOKEN   — from Discord Developer Portal
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 *   ALLOWED_USER_IDS    — comma-separated Discord user IDs to accept (optional, accepts all if unset)
 *   ALLOWED_CHANNEL_IDS — comma-separated channel IDs to accept (optional, accepts all if unset)
 */

const { Client, GatewayIntentBits, Partials } = require("discord.js");
const { execSync, spawn } = require("child_process");

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
    ? process.env.ALLOWED_USER_IDS.split(",").map((s) => s.trim())
    : null;
const ALLOWED_CHANNELS = process.env.ALLOWED_CHANNEL_IDS
    ? process.env.ALLOWED_CHANNEL_IDS.split(",").map((s) => s.trim())
    : null;

if (!TOKEN) { console.error("DISCORD_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

const activeSessions = new Map(); // uniqueKey → running flag
const MAX_MSG_LEN = 2000; // Discord max message length

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
    return new Promise((resolve) => {
        let sshConfig;
        try {
            sshConfig = execSync(`openshell sandbox ssh-config ${SANDBOX}`, { encoding: "utf-8" });
        } catch (err) {
            resolve(`Error: cannot connect to sandbox '${SANDBOX}'. Is it running?`);
            return;
        }

        const confPath = `/tmp/nemoclaw-dc-ssh-${sessionId}.conf`;
        require("fs").writeFileSync(confPath, sshConfig);

        const escaped = message.replace(/'/g, "'\\''");
        const cmd = `export NVIDIA_API_KEY='${API_KEY}' && nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'dc-${sessionId}'`;

        const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
            timeout: 120000,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        proc.stdout.on("data", (d) => (stdout += d.toString()));
        proc.stderr.on("data", (d) => (stderr += d.toString()));

        proc.on("close", (code) => {
            try { require("fs").unlinkSync(confPath); } catch { }

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

// ── Discord helpers ───────────────────────────────────────────────

async function sendLongMessage(channel, text, replyTo) {
    const chunks = [];
    for (let i = 0; i < text.length; i += MAX_MSG_LEN) {
        chunks.push(text.slice(i, i + MAX_MSG_LEN));
    }
    for (let i = 0; i < chunks.length; i++) {
        const opts = { content: chunks[i] };
        if (i === 0 && replyTo) {
            await replyTo.reply(opts).catch(() => channel.send(opts));
        } else {
            await channel.send(opts).catch(() => { });
        }
    }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
    const client = new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.Channel], // needed for DMs
    });

    client.once("clientReady", () => {
        console.log("");
        console.log("  ┌─────────────────────────────────────────────────────┐");
        console.log("  │  NemoClaw Discord Bridge                           │");
        console.log("  │                                                     │");
        console.log(`  │  Bot:      ${(client.user.tag + "                         ").slice(0, 40)}│`);
        console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
        console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
        console.log("  │                                                     │");
        console.log("  │  Messages are forwarded to the OpenClaw agent      │");
        console.log("  │  inside the sandbox. Run 'openshell term' in       │");
        console.log("  │  another terminal to monitor + approve egress.     │");
        console.log("  └─────────────────────────────────────────────────────┘");
        console.log("");
    });

    client.on("messageCreate", async (message) => {
        // Ignore own messages
        if (message.author.id === client.user.id) return;
        // Ignore bots
        if (message.author.bot) return;

        const userId = message.author.id;
        const channelId = message.channel.id;
        const isDM = !message.guild;

        // Access control — users
        if (ALLOWED_USERS && !ALLOWED_USERS.includes(userId)) {
            console.log(`[ignored] user ${userId} not in allowed list`);
            return;
        }

        // Access control — channels (skip for DMs)
        if (!isDM && ALLOWED_CHANNELS && !ALLOWED_CHANNELS.includes(channelId)) {
            return;
        }

        // Strip bot mention from message text
        let text = message.content
            .replace(new RegExp(`<@!?${client.user.id}>`, "g"), "")
            .trim();

        if (!text) return;

        const userName = message.author.username;
        const sessionKey = isDM ? `dm-${userId}` : `ch-${channelId}`;
        console.log(`[${sessionKey}] ${userName}: ${text}`);

        // Handle /reset or !reset
        if (text === "/reset" || text === "!reset") {
            activeSessions.delete(sessionKey);
            await message.reply("Session reset.").catch(() => { });
            return;
        }

        // Prevent concurrent requests in same session
        if (activeSessions.get(sessionKey)) {
            await message.reply("⏳ Still processing the previous message...").catch(() => { });
            return;
        }

        activeSessions.set(sessionKey, true);

        // Show typing indicator
        const typingInterval = setInterval(() => {
            message.channel.sendTyping().catch(() => { });
        }, 5000);
        message.channel.sendTyping().catch(() => { });

        try {
            const response = await runAgentInSandbox(text, sessionKey);
            clearInterval(typingInterval);
            console.log(`[${sessionKey}] agent: ${response.slice(0, 100)}...`);
            await sendLongMessage(message.channel, response, message);
        } catch (err) {
            clearInterval(typingInterval);
            await message.reply(`Error: ${err.message}`).catch(() => { });
        } finally {
            activeSessions.set(sessionKey, false);
        }
    });

    client.login(TOKEN);
}

main();
