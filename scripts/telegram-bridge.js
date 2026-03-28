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
const { execFileSync, spawn, spawnSync } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const TELEGRAM_TOOL_FALSE_NEGATIVE_PATTERN = /trouble sending messages via the openclaw telegram tool/i;
const STDERR_NOISE_PATTERNS = [
  /^\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental.*$/i,
  /^\(Use `node --trace-warnings .*$/i,
  /^\[plugins\] plugins\.allow is empty; discovered non-bundled plugins may auto-load:.*$/i,
  /^nemoclaw \(\/sandbox\/\.openclaw\/extensions\/nemoclaw\/dist\/index\.js\)\. Set plugins\.allow to explicit trusted ids\..*$/i,
];

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }
const ALLOWED_CHATS = process.env.ALLOWED_CHAT_IDS
  ? process.env.ALLOWED_CHAT_IDS.split(",").map((s) => s.trim())
  : null;

if (!TOKEN) { console.error("TELEGRAM_BOT_TOKEN required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let offset = 0;
const activeSessions = new Map(); // chatId → message history

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
    await tgApi("sendMessage", {
      chat_id: chatId,
      text: chunk,
      reply_to_message_id: replyTo,
      parse_mode: "Markdown",
    }).catch(() =>
      // Retry without markdown if it fails (unbalanced formatting)
      tgApi("sendMessage", { chat_id: chatId, text: chunk, reply_to_message_id: replyTo }),
    );
  }
}

async function sendTyping(chatId) {
  await tgApi("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
}

// ── Run agent inside sandbox ──────────────────────────────────────


function buildAgentCommand(message, sessionId) {
  return (
    `export NVIDIA_API_KEY=${shellQuote(API_KEY)} TELEGRAM_BOT_TOKEN=${shellQuote(TOKEN)} && ` +
    "nemoclaw-start openclaw agent " +
    "--agent main " +
    "--local " +
    "--channel telegram " +
    `-m ${shellQuote(message)} ` +
    `--session-id 'tg-${sessionId}'`
  );
}

function buildTelegramToolCheckCommand(sessionId) {
  const telegramTarget = String(sessionId);
  return (
    `export TELEGRAM_BOT_TOKEN=${shellQuote(TOKEN)} && ` +
    "openclaw message send " +
    "--channel telegram " +
    `--target ${shellQuote(telegramTarget)} ` +
    "--message 'nemoclaw telegram availability check' " +
    "--dry-run --json"
  );
}

function runCommandInSandbox(command, sessionId, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const result = spawnSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      resolve({ code: 1, stdout: "", stderr: `Failed to get ssh-config: ${result.stderr}` });
      return;
    }
    const sshConfig = result.stdout;
    const confPath = `/tmp/nemoclaw-tg-ssh-${sessionId}.conf`;
    require("fs").writeFileSync(confPath, sshConfig);

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, command], {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data) => {
      stdout += data.toString();
    });
    proc.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      try { require("fs").unlinkSync(confPath); } catch {}
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (err) => {
      try { require("fs").unlinkSync(confPath); } catch {}
      resolve({ code: 1, stdout, stderr: err.message });
    });
  });
}

async function verifyTelegramToolAvailable(sessionId) {
  const result = await runCommandInSandbox(buildTelegramToolCheckCommand(sessionId), `check-${sessionId}`, 30000);
  return result.code === 0 && result.stdout.includes('"channel": "telegram"');
}

function normalizeAgentResponse(response, telegramToolAvailable) {
  if (!telegramToolAvailable) return response;
  if (!TELEGRAM_TOOL_FALSE_NEGATIVE_PATTERN.test(response)) return response;
  return "Telegram delivery is available from inside the sandbox. The earlier claim that the OpenClaw Telegram tool could not send was inaccurate.";
}

function summarizeStderr(stderr) {
  const lines = String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !STDERR_NOISE_PATTERNS.some((pattern) => pattern.test(line)));
  return lines.join(" ").slice(0, 500);
}

function formatAgentFailure(code, stderr) {
  const summary = summarizeStderr(stderr);
  if (code === 255) {
    const prefix = `Agent session failed while reaching sandbox '${SANDBOX}'.`;
    const detail = summary ? ` ${summary}` : "";
    return `${prefix}${detail} Check 'openshell status' and run 'nemoclaw ${SANDBOX} telegram-probe' if this keeps happening.`;
  }
  if (summary) {
    return `Agent exited with code ${code}. ${summary}`;
  }
  return `Agent exited with code ${code}.`;
}

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    const cmd = buildAgentCommand(message, sessionId);
    runCommandInSandbox(cmd, sessionId).then(({ code, stdout, stderr }) => {

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
        resolve(formatAgentFailure(code, stderr));
      } else {
        resolve("(no response)");
      }
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
        if (ALLOWED_CHATS && !ALLOWED_CHATS.includes(chatId)) {
          console.log(`[ignored] chat ${chatId} not in allowed list`);
          continue;
        }

        const userName = msg.from?.first_name || "someone";
        console.log(`[${chatId}] ${userName}: ${msg.text}`);

        // Handle /start
        if (msg.text === "/start") {
          await sendMessage(
            chatId,
            "🦀 *NemoClaw* — powered by Nemotron 3 Super 120B\n\n" +
              "Send me a message and I'll run it through the OpenClaw agent " +
              "inside an OpenShell sandbox.\n\n" +
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

        // Send typing indicator
        await sendTyping(chatId);

        // Keep a typing indicator going while agent runs
        const typingInterval = setInterval(() => sendTyping(chatId), 4000);

        try {
          const [response, telegramToolAvailable] = await Promise.all([
            runAgentInSandbox(msg.text, chatId),
            verifyTelegramToolAvailable(chatId),
          ]);
          clearInterval(typingInterval);
          const finalResponse = normalizeAgentResponse(response, telegramToolAvailable);
          console.log(`[${chatId}] agent: ${finalResponse.slice(0, 100)}...`);
          await sendMessage(chatId, finalResponse, msg.message_id);
        } catch (err) {
          clearInterval(typingInterval);
          await sendMessage(chatId, `Error: ${err.message}`, msg.message_id);
        }
      }
    }
  } catch (err) {
    console.error("Poll error:", err.message);
  }

  // Continue polling
  setTimeout(poll, 100);
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const me = await tgApi("getMe", {});
  if (!me.ok) {
    console.error("Failed to connect to Telegram:", JSON.stringify(me));
    process.exit(1);
  }

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Telegram Bridge                          │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${(me.result.username + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Model:    nvidia/nemotron-3-super-120b-a12b       │");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  poll();
}

if (require.main === module) {
  main();
}

module.exports = {
  buildAgentCommand,
  buildTelegramToolCheckCommand,
  formatAgentFailure,
  normalizeAgentResponse,
  runAgentInSandbox,
  summarizeStderr,
  verifyTelegramToolAvailable,
};
