#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared bridge infrastructure for host-side messaging integrations.
 *
 * Handles the sandbox connection via OpenShell SSH — each messaging bridge
 * (Telegram, Discord, Slack) imports this module for the relay logic and
 * implements its own platform-specific API client.
 *
 * Env:
 *   NVIDIA_API_KEY  — for inference (required)
 *   SANDBOX_NAME    — sandbox name (default: nemoclaw)
 */

const fs = require("fs");
const { execFileSync, spawn } = require("child_process");
const { resolveOpenshell } = require("../bin/lib/resolve-openshell");
const { shellQuote, validateName } = require("../bin/lib/runner");

const OPENSHELL = resolveOpenshell();
if (!OPENSHELL) {
  console.error("openshell not found on PATH or in common locations");
  process.exit(1);
}

const API_KEY = process.env.NVIDIA_API_KEY;
if (!API_KEY) {
  console.error("NVIDIA_API_KEY required");
  process.exit(1);
}

const SANDBOX = process.env.SANDBOX_NAME || "nemoclaw";
try {
  validateName(SANDBOX, "SANDBOX_NAME");
} catch (e) {
  console.error(e.message);
  process.exit(1);
}

/**
 * Run the OpenClaw agent inside the sandbox via OpenShell SSH.
 *
 * @param {string} message - The user message to send to the agent
 * @param {string} sessionId - Session identifier (prefixed per-platform by the caller)
 * @returns {Promise<string>} The agent's response text
 */
function runAgentInSandbox(message, sessionId) {
  return new Promise((resolve) => {
    let sshConfig;
    try {
      sshConfig = execFileSync(OPENSHELL, ["sandbox", "ssh-config", SANDBOX], {
        encoding: "utf-8",
      });
    } catch (err) {
      resolve(`Error: sandbox SSH config failed — is '${SANDBOX}' running? ${err.message || err}`);
      return;
    }

    const confDir = fs.mkdtempSync("/tmp/nemoclaw-bridge-ssh-");
    const confPath = `${confDir}/config`;
    fs.writeFileSync(confPath, sshConfig, { mode: 0o600 });

    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9-]/g, "");
    const cmd =
      `export NVIDIA_API_KEY=${shellQuote(API_KEY)} && ` +
      `nemoclaw-start openclaw agent --agent main --local ` +
      `-m ${shellQuote(message)} --session-id ${shellQuote(safeSessionId)}`;

    const proc = spawn("ssh", ["-T", "-F", confPath, `openshell-${SANDBOX}`, cmd], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    // spawn() does not support timeout — implement manually
    const killTimer = setTimeout(() => {
      proc.kill("SIGTERM");
    }, 120000);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));

    proc.on("close", (code) => {
      clearTimeout(killTimer);
      try {
        fs.unlinkSync(confPath);
        fs.rmdirSync(confDir);
      } catch {}

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
      clearTimeout(killTimer);
      resolve(`Error: ${err && err.message ? err.message : String(err)}`);
    });
  });
}

module.exports = {
  runAgentInSandbox,
  SANDBOX,
  API_KEY,
  OPENSHELL,
  shellQuote,
  validateName,
};
