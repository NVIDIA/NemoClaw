#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord -> NemoClaw bridge.
 *
 * Messages from Discord are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Discord.
 *
 * Env:
 *   DISCORD_BOT_TOKEN            — bot token from the Discord developer portal
 *   NVIDIA_API_KEY               — for inference
 *   SANDBOX_NAME                 — sandbox name (default: nemoclaw)
 *   ALLOWED_DISCORD_CHANNEL_IDS  — comma-separated channel IDs to accept (optional)
 */

const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }
const ALLOWED_CHANNELS = process.env.ALLOWED_DISCORD_CHANNEL_IDS
  ? new Set(process.env.ALLOWED_DISCORD_CHANNEL_IDS.split(",").map((s) => s.trim()).filter(Boolean))
  : null;

if (!TOKEN) { console.error("DISCORD_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

const DISCORD_API = "https://discord.com/api/v10";
const INTENTS = (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15);

let botUserId = null;
let botTag = "unknown";
let heartbeatHandle = null;
let heartbeatIntervalMs = 0;
let lastSequence = null;
let gatewayUrl = null;
let reconnectDelayMs = 1000;

async function discordApi(path, options = {}) {
  const headers = {
    Authorization: `Bot ${TOKEN}`,
    ...options.headers,
  };
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${DISCORD_API}${path}`, {
    method: options.method || "GET",
    headers,
    body: options.body,
  });

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    throw new Error(`Discord API ${response.status}: ${typeof payload === "string" ? payload : JSON.stringify(payload)}`);
  }

  return payload;
}

async function sendTyping(channelId) {
  await discordApi(`/channels/${channelId}/typing`, { method: "POST" }).catch(() => {});
}

async function sendMessage(channelId, text, replyToMessageId) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 1900) {
    chunks.push(text.slice(i, i + 1900));
  }

  if (chunks.length === 0) {
    chunks.push("(no response)");
  }

  for (let i = 0; i < chunks.length; i++) {
    const body = { content: chunks[i] };
    if (i === 0 && replyToMessageId) {
      body.message_reference = { message_id: replyToMessageId };
    }
    await discordApi(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }
}

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-discord-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("discord-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch {}

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

async function handleMessage(msg) {
  if (!msg || msg.author?.bot) return;
  if (botUserId && msg.author?.id === botUserId) return;
  if (!msg.content || !msg.channel_id) return;
  if (ALLOWED_CHANNELS && !ALLOWED_CHANNELS.has(msg.channel_id)) {
    console.log(`[ignored] channel ${msg.channel_id} not in allowed list`);
    return;
  }

  const content = msg.content.trim();
  if (!content) return;

  const userName = msg.author?.username || "someone";
  console.log(`[${msg.channel_id}] ${userName}: ${content}`);

  if (content === "/start") {
    await sendMessage(
      msg.channel_id,
      "NemoClaw is connected. Send a message and I'll run it through the OpenClaw agent inside the sandbox.\n\nIf the agent needs external access, approve it from `openshell term`.",
      msg.id,
    );
    return;
  }

  if (content === "/reset") {
    await sendMessage(msg.channel_id, "Session reset is not required here. A fresh sandbox session is keyed per Discord channel.", msg.id);
    return;
  }

  await sendTyping(msg.channel_id);
  const typingInterval = setInterval(() => sendTyping(msg.channel_id), 4000);

  try {
    const response = await runAgentInSandbox(content, msg.channel_id);
    clearInterval(typingInterval);
    console.log(`[${msg.channel_id}] agent: ${response.slice(0, 100)}...`);
    await sendMessage(msg.channel_id, response, msg.id);
  } catch (err) {
    clearInterval(typingInterval);
    await sendMessage(msg.channel_id, `Error: ${err.message}`, msg.id);
  }
}

function startHeartbeat(ws) {
  stopHeartbeat();
  heartbeatHandle = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: 1, d: lastSequence }));
    }
  }, heartbeatIntervalMs);
}

function stopHeartbeat() {
  if (heartbeatHandle) {
    clearInterval(heartbeatHandle);
    heartbeatHandle = null;
  }
}

async function connectGateway() {
  if (!gatewayUrl) {
    const gateway = await discordApi("/gateway/bot");
    gatewayUrl = `${gateway.url}?v=10&encoding=json`;
  }

  const ws = new WebSocket(gatewayUrl);

  ws.addEventListener("open", () => {
    reconnectDelayMs = 1000;
  });

  ws.addEventListener("message", async (event) => {
    let payload;
    try {
      payload = JSON.parse(event.data.toString());
    } catch (err) {
      console.error("Gateway parse error:", err.message);
      return;
    }

    if (payload.s !== null && payload.s !== undefined) {
      lastSequence = payload.s;
    }

    if (payload.op === 10) {
      heartbeatIntervalMs = payload.d.heartbeat_interval;
      ws.send(JSON.stringify({
        op: 2,
        d: {
          token: TOKEN,
          intents: INTENTS,
          properties: {
            os: process.platform,
            browser: "nemoclaw",
            device: "nemoclaw",
          },
        },
      }));
      startHeartbeat(ws);
      return;
    }

    if (payload.op === 7) {
      ws.close();
      return;
    }

    if (payload.op === 1) {
      ws.send(JSON.stringify({ op: 1, d: lastSequence }));
      return;
    }

    if (payload.t === "READY") {
      botUserId = payload.d.user.id;
      botTag = `${payload.d.user.username}#${payload.d.user.discriminator}`;
      console.log("");
      console.log("  ┌─────────────────────────────────────────────────────┐");
      console.log("  │  NemoClaw Discord Bridge                           │");
      console.log("  │                                                     │");
      console.log(`  │  Bot:      ${(botTag + "                                  ").slice(0, 40)}│`);
      console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
      console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
      console.log("  │                                                     │");
      console.log("  │  Messages are forwarded to the OpenClaw agent      │");
      console.log("  │  inside the sandbox. Run 'openshell term' in       │");
      console.log("  │  another terminal to monitor + approve egress.     │");
      console.log("  └─────────────────────────────────────────────────────┘");
      console.log("");
      return;
    }

    if (payload.t === "MESSAGE_CREATE") {
      handleMessage(payload.d).catch((err) => {
        console.error("Message handling error:", err.message);
      });
    }
  });

  ws.addEventListener("close", () => {
    stopHeartbeat();
    setTimeout(() => {
      connectGateway().catch((err) => {
        console.error("Reconnect failed:", err.message);
      });
    }, reconnectDelayMs);
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30000);
  });

  ws.addEventListener("error", (err) => {
    console.error("Gateway error:", err.message || err);
  });
}

async function main() {
  const me = await discordApi("/users/@me");
  botUserId = me.id;
  botTag = `${me.username}#${me.discriminator}`;
  await connectGateway();
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
