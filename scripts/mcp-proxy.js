#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Stdio-to-HTTP MCP proxy.
 *
 * Spawns a stdio-based MCP server as a child process and exposes it
 * over HTTP so it can be forwarded into a NemoClaw sandbox.
 *
 * Usage:
 *   node scripts/mcp-proxy.js --command "npx @modelcontextprotocol/server-github" \
 *     --env GITHUB_TOKEN --port 3101
 *
 * The proxy binds to 127.0.0.1 only. API keys are inherited from the
 * host environment via --env flags and never logged or written to disk.
 */

const http = require("http");
const { spawn } = require("child_process");

// ── Parse args ──────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { command: null, env: [], port: 3101 };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--command":
        args.command = argv[++i];
        break;
      case "--env":
        args.env.push(argv[++i]);
        break;
      case "--port":
        args.port = parseInt(argv[++i], 10);
        break;
    }
  }
  return args;
}

const config = parseArgs(process.argv.slice(2));

if (!config.command) {
  console.error("Usage: mcp-proxy.js --command <cmd> [--env VAR ...] [--port PORT]");
  process.exit(1);
}

// Validate that named env vars are set
for (const name of config.env) {
  if (!process.env[name]) {
    console.error(`Environment variable ${name} is not set.`);
    process.exit(1);
  }
}

// ── MCP stdio child process ─────────────────────────────────────

let child = null;
let childReady = false;
let pendingRequests = [];

function startChild() {
  const parts = config.command.split(/\s+/);
  const cmd = parts[0];
  const cmdArgs = parts.slice(1);

  // Build env with only the named variables passed through
  const childEnv = { ...process.env };

  child = spawn(cmd, cmdArgs, {
    stdio: ["pipe", "pipe", "pipe"],
    env: childEnv,
  });

  let buffer = "";

  child.stdout.on("data", (data) => {
    buffer += data.toString();
    // MCP stdio uses newline-delimited JSON-RPC
    const lines = buffer.split("\n");
    buffer = lines.pop(); // keep incomplete line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        handleChildMessage(msg);
      } catch {
        // not JSON, ignore
      }
    }
  });

  child.stderr.on("data", (data) => {
    process.stderr.write(`[mcp-proxy:child] ${data}`);
  });

  child.on("close", (code) => {
    console.error(`[mcp-proxy] child exited with code ${code}`);
    process.exit(code || 1);
  });

  child.on("error", (err) => {
    console.error(`[mcp-proxy] child spawn error: ${err.message}`);
    process.exit(1);
  });

  childReady = true;

  // Flush pending requests
  for (const req of pendingRequests) {
    sendToChild(req);
  }
  pendingRequests = [];
}

// ── JSON-RPC message routing ────────────────────────────────────

const responseCallbacks = new Map();
let nextId = 1;

function sendToChild(msg) {
  if (!child || !child.stdin.writable) return;
  child.stdin.write(JSON.stringify(msg) + "\n");
}

function handleChildMessage(msg) {
  // Check if this is a response to a pending request
  if (msg.id !== undefined && responseCallbacks.has(msg.id)) {
    const callback = responseCallbacks.get(msg.id);
    responseCallbacks.delete(msg.id);
    callback(msg);
    return;
  }
  // Notifications or server-initiated messages are logged
  if (msg.method) {
    console.log(`[mcp-proxy:notify] ${msg.method}`);
  }
}

function callChild(method, params) {
  return new Promise((resolve) => {
    const id = nextId++;
    responseCallbacks.set(id, resolve);
    const msg = { jsonrpc: "2.0", id, method, params };
    if (childReady) {
      sendToChild(msg);
    } else {
      pendingRequests.push(msg);
    }
  });
}

// ── HTTP server ─────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS for sandbox access
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Method not allowed" }));
    return;
  }

  let body = "";
  for await (const chunk of req) {
    body += chunk;
  }

  let request;
  try {
    request = JSON.parse(body);
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32700, message: "Parse error" } }));
    return;
  }

  try {
    const response = await callChild(request.method, request.params);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(response));
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32603, message: err.message },
    }));
  }
});

// ── Start ───────────────────────────────────────────────────────

server.listen(config.port, "127.0.0.1", () => {
  console.log(`[mcp-proxy] listening on 127.0.0.1:${config.port}`);
  console.log(`[mcp-proxy] command: ${config.command}`);
  console.log(`[mcp-proxy] env: ${config.env.join(", ") || "(none)"}`);
  startChild();
});

// Graceful shutdown
process.on("SIGTERM", () => {
  if (child) child.kill();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  if (child) child.kill();
  server.close();
  process.exit(0);
});
