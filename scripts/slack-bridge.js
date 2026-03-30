#!/usr/bin/env node
/* global WebSocket */
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Slack → NemoClaw bridge.
 *
 * Messages from Slack are forwarded to the OpenClaw agent running
 * inside the sandbox.
 *
 * Env:
 *   SLACK_APP_TOKEN     — xapp-...
 *   SLACK_BOT_TOKEN     — xoxb-...
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 */

const https = require("https");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const APP_TOKEN = process.env.SLACK_APP_TOKEN;
const BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }

if (!APP_TOKEN || !BOT_TOKEN) { console.error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

const activeSessions = new Map(); // channelId → message history
const COOLDOWN_MS = 5000;
const lastMessageTime = new Map();
const busyChats = new Set();


// ── Slack API helpers ─────────────────────────────────────────────

function slackApi(method, body, token) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "slack.com",
        path: `/api/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Authorization": `Bearer ${token}`,
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: buf }); }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

async function sendMessage(channel, text, thread_ts) {
  const chunks = [];
  for (let i = 0; i < text.length; i += 3000) {
    chunks.push(text.slice(i, i + 3000));
  }
  for (const chunk of chunks) {
    await slackApi("chat.postMessage", {
      channel,
      text: chunk,
      thread_ts,
    }, BOT_TOKEN);
  }
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-slack-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd = `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && nemoclaw-start openclaw agent --agent main --local -m ${shellQuote(message)} --session-id ${shellQuote("slack-" + safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); require("fs").rmdirSync(confDir); } catch { /* ignored */ }

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

// ── Socket Mode ───────────────────────────────────────────────────

async function connectSocketMode() {
  const res = await slackApi("apps.connections.open", {}, APP_TOKEN);
  if (!res.ok) {
    console.error("Failed to open socket mode connection:", res);
    process.exit(1);
  }

  const ws = new WebSocket(res.url);

  ws.addEventListener("open", () => {
    console.log("Connected to Slack Socket Mode.");
  });

  ws.addEventListener("message", async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.type === "hello") return;

    if (msg.envelope_id) {
      ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    }

    if (msg.type === "events_api" && msg.payload && msg.payload.event) {
      const event = msg.payload.event;

      // Ignore bot messages
      if (event.bot_id || event.subtype === "bot_message") return;

      if (event.type === "message" || event.type === "app_mention") {
        const text = event.text || "";
        // If app_mention, strip the mention
        const cleanText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
        if (!cleanText) return;

        const channel = event.channel;
        const thread_ts = event.thread_ts || event.ts;
        const sessionId = thread_ts; // Use thread as session

        console.log(`[${channel}] ${event.user}: ${cleanText}`);

        if (cleanText === "reset") {
          activeSessions.delete(sessionId);
          await sendMessage(channel, "Session reset.", thread_ts);
          return;
        }

        const now = Date.now();
        const lastTime = lastMessageTime.get(channel) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          const wait = Math.ceil((COOLDOWN_MS - (now - lastTime)) / 1000);
          await sendMessage(channel, `Please wait ${wait}s before sending another message.`, thread_ts);
          return;
        }

        if (busyChats.has(channel)) {
          await sendMessage(channel, "Still processing your previous message.", thread_ts);
          return;
        }

        lastMessageTime.set(channel, now);
        busyChats.add(channel);

        try {
          const response = await runAgentInSandbox(cleanText, sessionId);
          console.log(`[${channel}] agent: ${response.slice(0, 100)}...`);
          await sendMessage(channel, response, thread_ts);
        } catch (err) {
          await sendMessage(channel, `Error: ${err.message}`, thread_ts);
        } finally {
          busyChats.delete(channel);
        }
      }
    }
  });

  ws.addEventListener("close", () => {
    console.log("Socket Mode connection closed. Reconnecting...");
    setTimeout(connectSocketMode, 3000);
  });

  ws.addEventListener("error", (err) => {
    console.error("WebSocket error:", err);
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const authTest = await slackApi("auth.test", {}, BOT_TOKEN);
  if (!authTest.ok) {
    console.error("Failed to authenticate with Slack:", authTest);
    process.exit(1);
  }


  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Slack Bridge                             │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(authTest.user + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  connectSocketMode();
}

main();
