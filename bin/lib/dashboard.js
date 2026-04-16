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

async function handleRequest(req, res) {
  const { method, url } = req;
  const segments = url.split("?")[0].replace(/\/$/, "").split("/").filter(Boolean);

  try {
    if (method === "GET" && segments[0] === "events") {
      return handleSSE(res);
    }

    if (method === "GET" && segments.length === 1 && segments[0] === "sandboxes") {
      return json(res, 200, getSandboxList());
    }

    if (method === "GET" && segments.length === 2 && segments[0] === "sandboxes") {
      const name = segments[1];
      const sandbox = registry.getSandbox(name);
      if (!sandbox) return json(res, 404, { error: `sandbox '${name}' not found` });
      const { sandboxes } = getSandboxList();
      return json(res, 200, sandboxes.find((s) => s.name === name) ?? sandbox);
    }

    if (method === "POST" && segments.length === 3 && segments[0] === "sandboxes" && segments[2] === "start") {
      return json(res, 200, startSandbox());
    }

    if (method === "POST" && segments.length === 3 && segments[0] === "sandboxes" && segments[2] === "stop") {
      return json(res, 200, stopSandbox(segments[1]));
    }

    if (method === "POST" && segments.length === 3 && segments[0] === "sandboxes" && segments[2] === "restart") {
      return json(res, 200, restartSandbox(segments[1]));
    }

    if (method === "POST" && segments.length === 3 && segments[0] === "sandboxes" && segments[2] === "commands") {
      const body = await readBody(req);
      if (!body.command || typeof body.command !== "string") {
        return json(res, 400, { error: "'command' field is required and must be a string" });
      }
      return json(res, 200, runSandboxCommand(segments[1], body.command));
    }

    if (method === "GET" && segments.length === 1 && segments[0] === "config") {
      return json(res, 200, readConfig());
    }

    if (method === "PUT" && segments.length === 1 && segments[0] === "config") {
      const body = await readBody(req);
      writeConfig(body);
      return json(res, 200, readConfig());
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
