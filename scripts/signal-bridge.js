#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Signal → NemoClaw bridge.
 *
 * Messages from Signal are forwarded to the OpenClaw agent running
 * inside the sandbox. When the agent needs external access, the
 * OpenShell TUI lights up for approval. Responses go back to Signal.
 *
 * Env:
 *   SIGNAL_PHONE_NUMBER — your registered Signal number (e.g. +1234567890)
 *   NVIDIA_API_KEY      — for inference
 *   SANDBOX_NAME        — sandbox name (default: nemoclaw)
 *   ALLOWED_NUMBERS     — comma-separated phone numbers to accept (optional)
 */

const { execSync, spawn } = require("child_process");
const fs = require("fs");

const PHONE = process.env.SIGNAL_PHONE_NUMBER;
const API_KEY = process.env.NVIDIA_API_KEY;
const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
const ALLOWED_IDS = process.env.ALLOWED_IDS || process.env.ALLOWED_NUMBERS
  ? (process.env.ALLOWED_IDS || process.env.ALLOWED_NUMBERS).split(",").map((s) => s.trim())
  : null;

if (!PHONE) { console.error("SIGNAL_PHONE_NUMBER required"); process.exit(1); }
if (!API_KEY) { console.error("NVIDIA_API_KEY required"); process.exit(1); }

// ── Signal CLI helpers ──────────────────────────────────────────

function sendSignalMessage(recipient, text) {
  try {
    // Escape single quotes for shell
    const escapedText = text.replace(/'/g, "'\\''");
    // Recipient can be phone number or UUID
    execSync(`signal-cli -u "${PHONE}" send -m '${escapedText}' "${recipient}"`, { stdio: "inherit" });
  } catch (err) {
    console.error(`Failed to send Signal message to ${recipient}:`, err.message);
  }
}

// ── Run agent inside sandbox ──────────────────────────────────────

function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    let sshConfig;
    try {
      sshConfig = execSync(`openshell sandbox ssh-config ${SANDBOX}`, { encoding: "utf-8" });
    } catch (err) {
      resolve(`Error: Could not get ssh-config for sandbox ${SANDBOX}. Is it running?`);
      return;
    }

    // Write temp ssh config
    const confPath = `/tmp/nemoclaw-signal-ssh-${sessionId.replace(/\+/g, '')}.conf`;
    fs.writeFileSync(confPath, sshConfig);

    const escaped = message.replace(/'/g, "'\\''");
    const cmd = `export NVIDIA_API_KEY='${API_KEY}' && nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'signal-${sessionId}'`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      try { fs.unlinkSync(confPath); } catch {}

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

// ── Listen loop ───────────────────────────────────────────────────

function listen() {
  console.log(`[signal] Listening for messages on ${PHONE}...`);
  
  const receiver = spawn("signal-cli", ["-u", PHONE, "receive", "--json"]);

  receiver.stdout.on("data", async (data) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const json = JSON.parse(line);
        const envelope = json.envelope;
        if (!envelope || !envelope.dataMessage) continue;

        const source = envelope.source; // phone number
        const uuid = envelope.sourceUuid; // uuid
        const username = envelope.sourceUsername; // username (if set)
        
        let sender = uuid ? `uuid:${uuid}` : source;
        if (username) sender = `username:${username}`;

        const messageText = envelope.dataMessage.message;
        if (!messageText) continue;

        // Access control: check against allowed IDs
        // Can match "username:<user>", "uuid:<id>", "+123...", or just raw uuid/phone if user provided it that way
        if (ALLOWED_IDS) {
          const isAllowed = ALLOWED_IDS.some(id => 
            id === sender || id === source || id === uuid || id === username ||
            (uuid && id === `uuid:${uuid}`) || (username && id === `username:${username}`)
          );
          if (!isAllowed) {
            console.log(`[ignored] message from ${sender} not in allowed list`);
            continue;
          }
        }

        console.log(`[${sender}] Signal: ${messageText}`);

        // Handle special commands
        if (messageText === "/start") {
          sendSignalMessage(sender, 
            "🦀 NemoClaw Signal Bridge\n\n" +
            "Send me a message and I'll run it through the OpenClaw agent " +
            "inside your sandbox."
          );
          continue;
        }

        // Run agent
        const response = await runAgentInSandbox(messageText, sender);
        console.log(`[${sender}] agent: ${response.slice(0, 100)}...`);
        sendSignalMessage(sender, response);

      } catch (err) {
        console.error("Error parsing Signal message:", err.message);
      }
    }
  });

  receiver.stderr.on("data", (data) => {
    // signal-cli is quite chatty on stderr
    const msg = data.toString().trim();
    if (msg.includes("ERROR") || msg.includes("Exception")) {
      console.error(`[signal-cli stderr] ${msg}`);
    }
  });

  receiver.on("close", (code) => {
    console.log(`Signal receiver exited with code ${code}. Restarting in 5s...`);
    setTimeout(listen, 5000);
  });
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log("  │  NemoClaw Signal Bridge                            │");
  console.log("  │                                                     │");
  console.log(`  │  Phone:    ${(PHONE + "                              ").slice(0, 40)}│`);
  console.log(`  │  Sandbox:  ${(SANDBOX + "                              ").slice(0, 40)}│`);
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");

  listen();
}

main();
