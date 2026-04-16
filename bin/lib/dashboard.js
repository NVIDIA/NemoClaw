// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const http = require("http");
const registry = require("./registry");
const { getSandboxList } = require("./dashboard-metrics");
const {
  stopSandbox,
  startSandbox,
  restartSandbox,
  runSandboxCommand,
  readConfig,
  writeConfig,
} = require("./dashboard-commands");

const SSE_TICK_MS = 5_000;
const SSE_SNAPSHOT_TICKS = 6;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
    "Access-Control-Allow-Origin": "*",
  });
  res.end(payload);
}

function handleSSE(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  res.flushHeaders();

  let tick = 0;
  let previousData = null;

  function sendTick() {
    const data = getSandboxList();
    const isSnapshot = tick % SSE_SNAPSHOT_TICKS === 0;
    const changed = JSON.stringify(data) !== JSON.stringify(previousData);

    if (isSnapshot || changed) {
      const eventType = isSnapshot ? "sandbox.snapshot" : "sandbox.metrics";
      res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
      previousData = data;
    }

    tick++;
  }

  sendTick();
  const timer = setInterval(sendTick, SSE_TICK_MS);

  res.on("close", () => clearInterval(timer));
}

async function sandboxDetail(_req, res, [name]) {
  const sandbox = registry.getSandbox(name);
  if (!sandbox) return json(res, 404, { error: `sandbox '${name}' not found` });
  const { sandboxes } = getSandboxList();
  return json(res, 200, sandboxes.find((s) => s.name === name) ?? sandbox);
}

async function sandboxCommand(req, res, [name]) {
  const body = await readBody(req);
  if (!body.command || typeof body.command !== "string") {
    return json(res, 400, { error: "'command' field is required and must be a string" });
  }
  return json(res, 200, runSandboxCommand(name, body.command));
}

async function configPut(req, res) {
  const body = await readBody(req);
  writeConfig(body);
  return json(res, 200, readConfig());
}

// Route table: [method, regex, handler]. Handler receives (req, res, regexCaptureGroups).
const ROUTES = [
  ["GET", /^\/events\/?$/, (_req, res) => handleSSE(res)],
  ["GET", /^\/sandboxes\/?$/, (_req, res) => json(res, 200, getSandboxList())],
  ["GET", /^\/sandboxes\/([^/]+)\/?$/, sandboxDetail],
  ["POST", /^\/sandboxes\/([^/]+)\/start\/?$/, (_req, res) => json(res, 200, startSandbox())],
  ["POST", /^\/sandboxes\/([^/]+)\/stop\/?$/, (_req, res, [n]) => json(res, 200, stopSandbox(n))],
  [
    "POST",
    /^\/sandboxes\/([^/]+)\/restart\/?$/,
    (_req, res, [n]) => json(res, 200, restartSandbox(n)),
  ],
  ["POST", /^\/sandboxes\/([^/]+)\/commands\/?$/, sandboxCommand],
  ["GET", /^\/config\/?$/, (_req, res) => json(res, 200, readConfig())],
  ["PUT", /^\/config\/?$/, configPut],
];

async function handleRequest(req, res) {
  const { method, url } = req;
  const pathname = url.split("?")[0];

  try {
    for (const [m, pattern, handler] of ROUTES) {
      if (m !== method) continue;
      const match = pattern.exec(pathname);
      if (match) return await handler(req, res, match.slice(1));
    }
    return json(res, 404, { error: "not found" });
  } catch (err) {
    return json(res, 500, { error: err.message });
  }
}

function createServer() {
  return http.createServer(handleRequest);
}

function startDashboard(port) {
  const server = createServer();
  server.listen(port, "127.0.0.1", () => {
    const addr = server.address();
    console.log(`nemoclaw dashboard running at http://127.0.0.1:${addr.port}`);
    console.log("Press Ctrl+C to stop.");
  });
  process.on("SIGINT", () => {
    server.close(() => process.exit(0));
  });
}

module.exports = { createServer, startDashboard };
