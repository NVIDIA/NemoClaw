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

let rpcId = 1;
let signalProcess = null;

// ── Signal JSON-RPC helpers ──────────────────────────────────────

function sendSignalMessage(recipient, text) {
  if (!signalProcess || signalProcess.killed) {
    console.error("Signal process not running, cannot send message.");
    return;
  }

  const rpc = {
    jsonrpc: "2.0",
    method: "send",
    params: {
      message: text,
      recipient: [recipient],
    },
    id: rpcId++,
  };

  const rpcStr = JSON.stringify(rpc);
  console.log(`[signal] Sending RPC: ${rpcStr}`);
  signalProcess.stdin.write(rpcStr + "\n");
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
    const cleanSessionId = sessionId.replace(/[^a-zA-Z0-9]/g, '');
    const confPath = `/tmp/nemoclaw-signal-ssh-${cleanSessionId}.conf`;
    fs.writeFileSync(confPath, sshConfig);

    const escaped = message.replace(/'/g, "'\\''");
    const cmd = `export NVIDIA_API_KEY='${API_KEY}' && nemoclaw-start openclaw agent --agent main --local -m '${escaped}' --session-id 'signal-${cleanSessionId}'`;

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
  console.log(`[signal] Starting JSON-RPC daemon for ${PHONE}...`);
  
  signalProcess = spawn("signal-cli", ["-u", PHONE, "jsonRpc"]);

  let buffer = "";

  signalProcess.stdout.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop(); // Keep partial line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;
      
      try {
        const json = JSON.parse(line);
        console.log(`[signal] Received RPC: ${line}`);

        // We only care about the "receive" method (incoming messages)
        if (json.method !== "receive" || !json.params || !json.params.envelope) {
          continue;
        }

        const envelope = json.params.envelope;
        if (!envelope.dataMessage) continue;

        const source = envelope.source; // raw identifier (phone or uuid)
        const uuid = envelope.sourceUuid; 
        const username = envelope.sourceUsername; 
        
        let sender = uuid ? `uuid:${uuid}` : source;
        if (username) sender = `username:${username}`;

        const messageText = envelope.dataMessage.message;
        if (!messageText) continue;

        // Access control
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
          sendSignalMessage(source, 
            "🦀 NemoClaw Signal Bridge\n\n" +
            "Send me a message and I'll run it through the OpenClaw agent " +
            "inside your sandbox."
          );
          continue;
        }

        // Run agent
        runAgentInSandbox(messageText, sender).then(response => {
          console.log(`[${sender}] agent: ${response.slice(0, 100)}...`);
          sendSignalMessage(source, response);
        });

      } catch (err) {
        console.error("Error parsing Signal JSON-RPC line:", err.message);
      }
    }
  });

  signalProcess.stderr.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg.includes("ERROR") || msg.includes("Exception")) {
      console.error(`[signal-cli stderr] ${msg}`);
    }
  });

  signalProcess.on("close", (code) => {
    console.log(`Signal process exited with code ${code}. Restarting in 5s...`);
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
