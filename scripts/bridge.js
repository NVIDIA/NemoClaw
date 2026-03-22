#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Generic bridge runner.
 *
 * Reads bridge definitions from nemoclaw-blueprint/bridges/<type>/*.yaml,
 * loads the corresponding adapter, and runs the message flow. Credentials
 * stay on the host — messages relay to the sandbox via OpenShell SSH.
 *
 * Usage:
 *   node scripts/bridge.js <name>          Run a specific bridge by name
 *   node scripts/bridge.js --list          List available bridges
 *
 * Env:
 *   NVIDIA_API_KEY   — required for inference
 *   SANDBOX_NAME     — sandbox name (default: nemoclaw)
 *   Platform-specific tokens (see bridge YAML for token_env)
 */

const fs = require("fs");
const path = require("path");
const { runAgentInSandbox, SANDBOX } = require("./bridge-core");

const yaml = require("js-yaml");

const BLUEPRINT_PATH = path.join(__dirname, "..", "nemoclaw-blueprint", "blueprint.yaml");

// ── Load bridge configs from blueprint.yaml ───────────────────────

function loadBridgeConfigs() {
  if (!fs.existsSync(BLUEPRINT_PATH)) {
    console.error(`Blueprint not found: ${BLUEPRINT_PATH}`);
    return [];
  }

  const blueprint = yaml.load(fs.readFileSync(BLUEPRINT_PATH, "utf-8"));
  const bridges = blueprint.components?.bridges;
  if (!bridges) return [];

  return Object.entries(bridges).map(([name, config]) => ({
    name,
    ...config,
  }));
}

function findAdapter(config) {
  const adapterPath = path.join(__dirname, "adapters", config.type, `${config.adapter}.js`);
  if (!fs.existsSync(adapterPath)) {
    console.error(`Adapter not found: ${adapterPath}`);
    return null;
  }
  return require(adapterPath);
}

// ── Message flow engine ───────────────────────────────────────────

async function runBridge(config) {
  const tokenEnv = config.credential_env;
  const token = process.env[tokenEnv];
  if (!token) {
    console.error(`${tokenEnv} required for ${config.name} bridge`);
    process.exit(1);
  }

  // Check extra required env vars (e.g., SLACK_APP_TOKEN)
  const extraEnvs = config.extra_credential_env;
  if (Array.isArray(extraEnvs)) {
    for (const env of extraEnvs) {
      if (!process.env[env]) {
        console.error(`${env} required for ${config.name} bridge`);
        process.exit(1);
      }
    }
  }

  const createAdapter = findAdapter(config);
  if (!createAdapter) process.exit(1);

  const adapter = createAdapter(config);
  const prefix = config.session_prefix;
  const maxChunk = config.max_chunk_size;

  async function onMessage(msg) {
    console.log(`[${config.name}] [${msg.channelId}] ${msg.userName}: inbound (len=${msg.text.length})`);

    // Typing indicator
    await msg.sendTyping();
    const typingInterval = setInterval(() => msg.sendTyping(), 4000);

    try {
      const response = await runAgentInSandbox(msg.text, `${prefix}-${msg.channelId}`);
      clearInterval(typingInterval);
      console.log(`[${config.name}] [${msg.channelId}] agent: response (len=${response.length})`);

      // Chunk response per platform limit
      const chunks = [];
      for (let i = 0; i < response.length; i += maxChunk) {
        chunks.push(response.slice(i, i + maxChunk));
      }
      for (const chunk of chunks) {
        await msg.reply(chunk);
      }
    } catch (err) {
      clearInterval(typingInterval);
      const errorMsg = err && err.message ? err.message : String(err);
      await msg.reply(`Error: ${errorMsg}`).catch(() => {});
    }
  }

  const botName = await adapter.start(onMessage);

  console.log("");
  console.log("  ┌─────────────────────────────────────────────────────┐");
  console.log(`  │  NemoClaw ${(config.name.charAt(0).toUpperCase() + config.name.slice(1) + " Bridge                     ").slice(0, 41)}│`);
  console.log("  │                                                     │");
  console.log(`  │  Bot:      ${(String(botName) + "                              ").slice(0, 41)}│`);
  console.log("  │  Sandbox:  " + (SANDBOX + "                              ").slice(0, 40) + "│");
  console.log("  │                                                     │");
  console.log("  │  Messages are forwarded to the OpenClaw agent      │");
  console.log("  │  inside the sandbox. Run 'openshell term' in       │");
  console.log("  │  another terminal to monitor + approve egress.     │");
  console.log("  └─────────────────────────────────────────────────────┘");
  console.log("");
}

// ── CLI ───────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args[0] === "--list") {
  const configs = loadBridgeConfigs();
  console.log("\nAvailable bridges:\n");
  for (const c of configs) {
    const hasMain = !!process.env[c.credential_env];
    const extraEnvs = Array.isArray(c.extra_credential_env) ? c.extra_credential_env : [];
    const hasAll = hasMain && extraEnvs.every((e) => !!process.env[e]);
    const status = hasAll ? "✓" : "✗";
    const envList = [c.credential_env, ...extraEnvs].join(", ");
    console.log(`  ${status} ${c.name.padEnd(12)} ${c.type} bridge  (${envList})`);
  }
  console.log("");
  process.exit(0);
}

if (!args[0]) {
  console.error("Usage: node scripts/bridge.js <name>");
  console.error("       node scripts/bridge.js --list");
  process.exit(1);
}

const configs = loadBridgeConfigs();
const config = configs.find((c) => c.name === args[0]);
if (!config) {
  console.error(`Unknown bridge: ${args[0]}`);
  console.error(`Available: ${configs.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

runBridge(config);
