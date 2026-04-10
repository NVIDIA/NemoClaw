#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Discord -> NemoClaw bridge.
 *
 * Messages from a configured Discord channel are forwarded to the OpenClaw
 * agent running inside the sandbox. Responses are posted back to Discord.
 *
 * Env:
 *   DISCORD_BOT_TOKEN   - bot token from the Discord developer portal
 *   DISCORD_CHANNEL_ID  - channel to monitor
 *   NVIDIA_API_KEY      - for inference
 *   SANDBOX_NAME        - sandbox name (default: nemoclaw)
 *   ALLOWED_USER_IDS    - comma-separated Discord user IDs to accept (optional)
 */

const https = require("https");
const { spawn, spawnSync } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const DISCORD_TOOL_FALSE_NEGATIVE_PATTERN = /trouble sending messages via the openclaw discord tool/i;
const STDERR_NOISE_PATTERNS = [
  /^\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental.*$/i,
  /^\(Use `node --trace-warnings .*$/i,
  /^\[plugins\] plugins\.allow is empty; discovered non-bundled plugins may auto-load:.*$/i,
  /^nemoclaw \(\/sandbox\/\.openclaw\/extensions\/nemoclaw\/dist\/index\.js\)\. Set plugins\.allow to explicit trusted ids\..*$/i,
];
const STDOUT_NOISE_PATTERNS = [
  /^\[gateway\] Running as non-root \(uid=\d+\) — privilege separation disabled$/,
];

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const TOKEN = process.env.DISCORD_BOT_TOKEN;
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try { validateName(SANDBOX, "SANDBOX_NAME"); } catch (e) { console.error(e.message); process.exit(1); }
const ALLOWED_USERS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((item) => item.trim()).filter(Boolean)
  : null;

if (!TOKEN) { console.error("DISCORD_BOT_TOKEN required"); process.exit(1); }
if (!CHANNEL_ID) { console.error("DISCORD_CHANNEL_ID required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

let botUserId = "";
let lastMessageId = "";

function buildMessageChunks(text, limit = 2000) {
  const value = String(text || "");
  if (value.length === 0) return [""];
  const chunks = [];
  for (let index = 0; index < value.length; index += limit) {
    chunks.push(value.slice(index, index + limit));
  }
  return chunks;
}

function discordApi(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = https.request(
      {
        hostname: "discord.com",
        path: `/api/v10${path}`,
        method,
        headers: {
          Authorization: `Bot ${TOKEN}`,
          "User-Agent": "NemoClaw Discord Bridge/1.0",
          ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let buf = "";
        res.on("data", (chunk) => {
          buf += chunk;
        });
        res.on("end", () => {
          const status = res.statusCode || 0;
          if (!buf) {
            resolve({ ok: status >= 200 && status < 300, status, result: null });
            return;
          }

          try {
            const parsed = JSON.parse(buf);
            resolve({ ok: status >= 200 && status < 300, status, result: parsed });
          } catch {
            resolve({ ok: status >= 200 && status < 300, status, result: buf });
          }
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function sendMessage(channelId, text, replyTo) {
  const chunks = buildMessageChunks(text, 2000);
  for (const chunk of chunks) {
    const body = {
      content: chunk,
      allowed_mentions: { parse: [] },
    };
    if (replyTo) {
      body.message_reference = { channel_id: channelId, message_id: replyTo };
    }
    await discordApi("POST", `/channels/${channelId}/messages`, body);
  }
}

async function sendTyping(channelId) {
  await discordApi("POST", `/channels/${channelId}/typing`).catch(() => {});
}

async function addEyesReaction(channelId, messageId) {
  const emoji = encodeURIComponent("👀");
  await discordApi("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`).catch(() => {});
}

function buildAgentCommand(message, sessionId) {
  return (
    `export NVIDIA_API_KEY=${shellQuote(API_KEY)} DISCORD_BOT_TOKEN=${shellQuote(TOKEN)} && ` +
    "nemoclaw-start openclaw agent " +
    "--agent main " +
    "--local " +
    "--channel discord " +
    `-m ${shellQuote(message)} ` +
    `--session-id 'dc-${sessionId}'`
  );
}

function buildDiscordToolCheckCommand(targetChannelId = CHANNEL_ID) {
  return (
    `export DISCORD_BOT_TOKEN=${shellQuote(TOKEN)} && ` +
    "openclaw message send " +
    "--channel discord " +
    `--target ${shellQuote(String(targetChannelId))} ` +
    "--message 'nemoclaw discord availability check' " +
    "--dry-run --json"
  );
}

function removeTempFile(filePath) {
  try {
    require("fs").unlinkSync(filePath);
  } catch (_error) {
    // Ignore cleanup failures for temporary SSH config files.
  }
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

    const confPath = `/tmp/nemoclaw-dc-ssh-${sessionId}.conf`;
    require("fs").writeFileSync(confPath, result.stdout);

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
      removeTempFile(confPath);
      resolve({ code, stdout, stderr });
    });

    proc.on("error", (error) => {
      removeTempFile(confPath);
      resolve({ code: 1, stdout, stderr: error.message });
    });
  });
}

async function verifyDiscordToolAvailable(targetChannelId = CHANNEL_ID) {
  const result = await runCommandInSandbox(buildDiscordToolCheckCommand(targetChannelId), `check-${targetChannelId}`, 30000);
  return result.code === 0 && result.stdout.includes('"channel": "discord"');
}

function normalizeAgentResponse(response, discordToolAvailable) {
  if (!discordToolAvailable) return response;
  if (!DISCORD_TOOL_FALSE_NEGATIVE_PATTERN.test(response)) return response;
  return "Discord delivery is available from inside the sandbox. The earlier claim that the OpenClaw Discord tool could not send was inaccurate.";
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
    return `${prefix}${detail} Check 'openshell status' and run 'nemoclaw ${SANDBOX} discord-probe' if this keeps happening.`;
  }
  if (summary) {
    return `Agent exited with code ${code}. ${summary}`;
  }
  return `Agent exited with code ${code}.`;
}

function isResponseNoiseLine(line) {
  const trimmedLine = String(line || "").trim();
  if (!trimmedLine) return true;

  return trimmedLine.startsWith("Setting up NemoClaw")
    || trimmedLine.startsWith("[plugins]")
    || trimmedLine.startsWith("(node:")
    || trimmedLine.includes("NemoClaw ready")
    || trimmedLine.includes("NemoClaw registered")
    || trimmedLine.includes("openclaw agent")
    || trimmedLine.includes("┌─")
    || trimmedLine.includes("│ ")
    || trimmedLine.includes("└─")
    || STDOUT_NOISE_PATTERNS.some((pattern) => pattern.test(trimmedLine));
}

function extractAgentResponse(stdout, code, stderr) {
  const lines = stdout.split("\n");
  const responseLines = lines.filter((line) => !isResponseNoiseLine(line));

  const response = responseLines.join("\n").trim();
  if (response) return response;
  if (code !== 0) return formatAgentFailure(code, stderr);
  return "(no response)";
}

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    runCommandInSandbox(buildAgentCommand(message, sessionId), sessionId).then(({ code, stdout, stderr }) => {
      resolve(extractAgentResponse(stdout, code, stderr));
    });
  });
}

function compareSnowflakes(left, right) {
  return BigInt(left) < BigInt(right) ? -1 : BigInt(left) > BigInt(right) ? 1 : 0;
}

async function getBotIdentity() {
  const response = await discordApi("GET", "/users/@me");
  if (!response.ok) {
    throw new Error(typeof response.result === "string" ? response.result : JSON.stringify(response.result));
  }
  return response.result;
}

async function initializeCursor() {
  const response = await discordApi("GET", `/channels/${CHANNEL_ID}/messages?limit=1`);
  if (!response.ok || !Array.isArray(response.result)) {
    return;
  }
  if (response.result[0]?.id) {
    lastMessageId = response.result[0].id;
  }
}

async function handleMessage(message) {
  if (!message?.content || !message.author?.id) return;
  if (message.author.id === botUserId) return;
  if (ALLOWED_USERS && !ALLOWED_USERS.includes(message.author.id)) {
    console.log(`[ignored] user ${message.author.id} not in allowed list`);
    return;
  }

  const authorName = message.author.global_name || message.author.username || "someone";
  console.log(`[${CHANNEL_ID}] ${authorName}: ${message.content}`);

  await addEyesReaction(CHANNEL_ID, message.id);
  await sendTyping(CHANNEL_ID);
  const typingInterval = setInterval(() => sendTyping(CHANNEL_ID), 4000);

  try {
    const [response, discordToolAvailable] = await Promise.all([
      runAgentInSandbox(message.content, message.id),
      verifyDiscordToolAvailable(CHANNEL_ID),
    ]);
    clearInterval(typingInterval);
    const finalResponse = normalizeAgentResponse(response, discordToolAvailable);
    console.log(`[${CHANNEL_ID}] agent: ${finalResponse.slice(0, 100)}...`);
    await sendMessage(CHANNEL_ID, finalResponse, message.id);
  } catch (error) {
    clearInterval(typingInterval);
    await sendMessage(CHANNEL_ID, `Error: ${error.message}`, message.id);
  }
}

async function poll() {
  try {
    const suffix = lastMessageId ? `?after=${lastMessageId}&limit=100` : "?limit=100";
    const response = await discordApi("GET", `/channels/${CHANNEL_ID}/messages${suffix}`);
    if (response.ok && Array.isArray(response.result) && response.result.length > 0) {
      const messages = [...response.result].sort((left, right) => compareSnowflakes(left.id, right.id));
      for (const message of messages) {
        if (!lastMessageId || compareSnowflakes(message.id, lastMessageId) > 0) {
          lastMessageId = message.id;
        }
        await handleMessage(message);
      }
    }
  } catch (error) {
    console.error("Poll error:", error.message);
  }

  setTimeout(poll, 2000);
}

async function main() {
  const me = await getBotIdentity();
  botUserId = String(me.id || "");
  await initializeCursor();

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Discord Bridge                           │");
  console.log("  │                                                     │");
  console.log(`  │  Bot:      @${((me.username || "unknown") + "                    ").slice(0, 37)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │  Channel:  " + (CHANNEL_ID + "                              ").slice(0, 40) + "│");
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
  main().catch((error) => {
    console.error("Failed to start Discord bridge:", error.message);
    process.exit(1);
  });
}

module.exports = {
  buildAgentCommand,
  buildDiscordToolCheckCommand,
  buildMessageChunks,
  formatAgentFailure,
  extractAgentResponse,
  isResponseNoiseLine,
  normalizeAgentResponse,
  runAgentInSandbox,
  summarizeStderr,
  verifyDiscordToolAvailable,
};
