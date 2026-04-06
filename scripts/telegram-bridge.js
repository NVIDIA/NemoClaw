#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Telegram → NemoClaw bridge.
 *
 * Messages from Telegram are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Telegram.
 *
 * Env:
 *   TELEGRAM_BOT_TOKEN  — from @BotFather
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 *   ALLOWED_CHAT_IDS    — comma-separated Telegram chat IDs to accept (optional, accepts all if unset)
 */

const https = require("https");
const path = require("path");
const { execFileSync, execFile, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");
const { parseAllowedChatIds, isChatAllowed } = require("../bin/lib/chat-filter");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }
const ALLOWED_CHATS = parseAllowedChatIds(process.env.ALLOWED_CHAT_IDS);

if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let offset = 0;
const activeSessions = new Map(); // chatId → message history

const COOLDOWN_MS = 5000;
const lastMessageTime = new Map();
const busyChats = new Set();

// ── Stderr / setup noise filters (shared) ────────────────────────
// Lines matching any of these are stripped from agent output before
// sending to Telegram. Add new patterns here instead of scattering
// them through the filter logic.
const NOISE_PATTERNS = [
  "Setting up NemoClaw",
  "[plugins]",
  "[SECURITY]",
  "SECURITY WARNING",
  "Config integrity check",
  "(node:",
  "(Use `node",
  "NemoClaw ready",
  "NemoClaw registered",
  "openclaw agent",
  "Running as non-root",
  "privilege separation disabled",
  "gateway Running",
  "CAP_SETPCAP",
  "UNDICI-EHPA",
  "EnvHttpProxyAgent",
  "trace-warnings",
  "gateway connect failed",
  "GatewayClientRequestError",
  "Gateway agent failed",
  "Gateway target:",
  "Source: local loopback",
  "Config: /sandbox/.openclaw",
  "Bind: loopback",
  "pairing required",
  "tools websearch failed",
  "tools cron failed",
  "getaddrinfo",
];
const NOISE_BOX_CHARS = ["┌─", "│ ", "└─"];

function isNoiseLine(line) {
  if (line.trim() === "") return true;
  for (const p of NOISE_PATTERNS) { if (line.includes(p)) return true; }
  for (const c of NOISE_BOX_CHARS) { if (line.includes(c)) return true; }
  return false;
}

// ── Resolve current model from inference route ───────────────────

function getCurrentModel() {
  try {
    const out = execFileSync(OPENSHELL, ["inference", "get"], { encoding: "utf-8", timeout: 5000 });
    // Strip ANSI escape codes from openshell output
    // eslint-disable-next-line no-control-regex
    const clean = out.replace(/\x1b\[[0-9;]*m/g, "");
    const match = clean.match(/Model:\s*(.+)/i);
    if (match) return match[1].trim();
    const provMatch = clean.match(/Provider:\s*(.+)/i);
    if (provMatch) return provMatch[1].trim();
  } catch { /* ignore — we'll return a fallback */ }
  return "unknown";
}

// ── Telegram API helpers ──────────────────────────────────────────

function tgApi(method, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request(
      {
        hostname: "api.telegram.org",
        path: `/bot${TOKEN}/${method}`,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
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

async function sendMessage(chatId, text, replyTo) {
  // Telegram max message length is 4096
  const chunks = [];
  for (let i = 0; i < text.length; i += 4000) {
    chunks.push(text.slice(i, i + 4000));
  }
  for (const chunk of chunks) {
    const res = await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(async (err) => {
      console.error(`[sendMessage] Markdown attempt failed: ${err.message}`);
      // Retry without markdown if it fails (unbalanced formatting)
      return tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo });
    });
    if (res && !res.ok) {
      console.error(`[sendMessage] Telegram API error: ${JSON.stringify(res)}`);
      // If markdown failed at API level, retry without
      if (res.error_code === 400) {
        const retry = await tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo });
        if (retry && !retry.ok) console.error(`[sendMessage] Retry also failed: ${JSON.stringify(retry)}`);
      }
    }
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], { encoding: "utf-8" });

    // Write temp ssh config with unpredictable name
    const confDir = require("fs").mkdtempSync("/tmp/nemoclaw-tg-ssh-");
    const confPath = `${confDir}/config`;
    require("fs").writeFileSync(confPath, sshConfig, { mode: 0o600 });

    // Pass message and API key via stdin to avoid shell interpolation.
    // The remote command reads them from environment/stdin rather than
    // embedding user content in a shell string.
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    // Pass a dummy NVIDIA_API_KEY so the agent uses inference.local routing
    // (which the OpenShell proxy forwards to the configured provider — e.g. Bedrock/LiteLLM).
    // Passing the real key causes the agent to call NVIDIA directly, bypassing the route.
    // NOTE: Do NOT use --local here — it bypasses the Gateway, which means
    // web_search and other Gateway-only tools are unavailable.
    const cmd = `export NVIDIA_API_KEY=unused && nemoclaw-start openclaw agent --agent main -m ${shellQuote(message)} --session-id ${shellQuote("tg-" + safeSessionId)}`;

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

      // Extract the actual agent response — skip setup lines and stderr noise
      const allOutput = stdout + "\n" + stderr;
      const responseLines = allOutput.split("\n").filter((l) => !isNoiseLine(l));
      const response = responseLines.join("\n").trim();

      if (response) {
        resolve(response);
      } else if (code !== 0) {
        const cleanStderr = stderr.split("\n").filter((l) => !isNoiseLine(l)).join("\n").trim();
        resolve(`Agent exited with code ${code}. ${cleanStderr.slice(0, 500)}`);
      } else {
        resolve("(no response)");
      }
    });

    proc.on("error", (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// ── Poll loop ─────────────────────────────────────────────────────

async function poll() {
  try {
    const res = await tgApi("getUpdates", { offset, timeout: 30 });

    if (res.ok && res.result?.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;

        const msg = update.message;
        if (!msg?.text) continue;

        const chatId = String(msg.chat.id);

        // Access control
        if (!isChatAllowed(ALLOWED_CHATS, chatId)) {
          console.log(`[ignored] chat ${chatId} not in allowed list`);
          continue;
        }

        const userName = msg.from?.first_name || "someone";
        console.log(`[${chatId}] ${userName}: ${msg.text}`);

        // Handle /start
        if (msg.text === "/start") {
          const model = getCurrentModel();
          await sendMessage(
            chatId,
            `🦀 *NemoClaw* — model: ${model}\n\n` +
              "Send me a message and I'll run it through the OpenClaw agent " +
              "inside an OpenShell sandbox.\n\n" +
              "Commands:\n/status — check service health\n/reset — clear session\n\n" +
              "If the agent needs external access, the TUI will prompt for approval.",
            msg.message_id,
          );
          continue;
        }

        // Handle /reset
        if (msg.text === "/reset") {
          activeSessions.delete(chatId);
          await sendMessage(chatId, "Session reset.", msg.message_id);
          continue;
        }

        // Handle /status — run health check and report results
        if (msg.text === "/status") {
          await sendTyping(chatId);
          const healthScript = path.join(__dirname, "health-check.sh");
          try {
            const result = await new Promise((resolve, reject) => {
              execFile(healthScript, ["--sandbox", SANDBOX, "--json"], { timeout: 60000 }, (err, stdout) => {
                // health-check.sh exits 1 on failures — that's expected, not an error
                if (err && !stdout) return reject(err);
                resolve(stdout);
              });
            });
            const data = JSON.parse(result);
            const lines = data.checks.map((c) => {
              const icon = c.status === "pass" ? "\u2705" : c.status === "fail" ? "\u274c" : "\u2796";
              return `${icon} *${c.name}*: ${c.detail || "skipped"}`;
            });
            const summary = data.summary.failed === 0
              ? `\u2705 All ${data.summary.passed} checks passed`
              : `\u26a0\ufe0f ${data.summary.failed}/${data.summary.passed + data.summary.failed} checks failed`;
            await sendMessage(chatId, `*NemoClaw Status* (${data.sandbox})\n\n${lines.join("\n")}\n\n${summary}`, msg.message_id);
          } catch (err) {
            await sendMessage(chatId, `Health check error: ${err.message}`, msg.message_id);
          }
          continue;
        }

        // Rate limiting: per-chat cooldown
        const now = Date.now();
        const lastTime = lastMessageTime.get(chatId) || 0;
        if (now - lastTime < COOLDOWN_MS) {
          const wait = Math.ceil((COOLDOWN_MS - (now - lastTime)) / 1000);
          await sendMessage(chatId, `Please wait ${wait}s before sending another message.`, msg.message_id);
          continue;
        }

        // Per-chat serialization: reject if this chat already has an active session
        if (busyChats.has(chatId)) {
          await sendMessage(chatId, "Still processing your previous message.", msg.message_id);
          continue;
        }

        lastMessageTime.set(chatId, now);
        busyChats.add(chatId);

        // Send typing indicator
        await sendTyping(chatId);

        // Keep a typing indicator going while agent runs
        const typingInterval = setInterval(() => sendTyping(chatId), 4000);

        try {
          let response = await runAgentInSandbox(msg.text, chatId);

          // Retry once if the sandbox SSH proxy wasn't ready
          if (response.includes("transport error") || response.includes("Connection refused")) {
            console.log(`[${chatId}] retrying after transport error...`);
            await new Promise((r) => setTimeout(r, 3000));
            response = await runAgentInSandbox(msg.text, chatId);
          }

          clearInterval(typingInterval);
          console.log(`[${chatId}] agent: ${response.slice(0, 100)}...`);
          await sendMessage(chatId, response, msg.message_id);
        } catch (err) {
          clearInterval(typingInterval);
          await sendMessage(chatId, `Error: ${err.message}`, msg.message_id);
        } finally {
          busyChats.delete(chatId);
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  // Continue polling (1s floor prevents tight-loop resource waste)
  setTimeout(poll, 1000);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  const model = getCurrentModel();

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Telegram Bridge                          │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(me.result.username + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    " + (model + "                              ").slice(0, 40) + "│");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  poll();
}

main();
