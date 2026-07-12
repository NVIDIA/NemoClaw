#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const http = require("http");

const host = process.env.FAKE_DISCORD_MESSAGE_API_HOST || "0.0.0.0";
const rawPort = process.env.FAKE_DISCORD_MESSAGE_API_PORT || "0";
const port = Number(rawPort);
const portFile = process.env.FAKE_DISCORD_MESSAGE_API_PORT_FILE || "";
const captureFile = process.env.FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE || "";
const expectedToken = process.env.FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN || "";
const MAX_BODY_BYTES = 1024 * 1024;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`FAKE_DISCORD_MESSAGE_API_PORT must be an integer between 0 and 65535 (received: ${rawPort})`);
  process.exit(2);
}

if (!expectedToken) {
  console.error("FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN is required");
  process.exit(2);
}

function record(event) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function tokenFromAuthorization(value) {
  const raw = String(value || "");
  if (raw.length < 4 || raw.slice(0, 3).toLowerCase() !== "bot") return raw;
  const next = raw.charCodeAt(3);
  if (next !== 0x20 && next !== 0x09) return raw;
  let index = 4;
  while (index < raw.length) {
    const code = raw.charCodeAt(index);
    if (code !== 0x20 && code !== 0x09) break;
    index += 1;
  }
  return raw.slice(index);
}

function tokenLooksPlaceholder(value) {
  return typeof value === "string" && value.includes("openshell:resolve:env:");
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function parseJson(body) {
  try {
    return JSON.parse(body || "{}");
  } catch {
    return {};
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  req.on("data", (chunk) => {
    if (bodyTooLarge) return;
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      record({ event: "request-too-large", method: req.method, path: req.url || "/", bodyBytes });
      writeJson(res, 413, { message: "payload too large", code: 413 });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (bodyTooLarge) return;
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url || "/", "http://fake-discord.local");
    const token = tokenFromAuthorization(req.headers.authorization);
    const tokenMatchesExpected = token === expectedToken;
    const messageMatch = /^\/api\/v10\/channels\/([^/]+)\/messages$/.exec(url.pathname);
    const channelMatch = /^\/api\/v10\/channels\/([^/]+)$/.exec(url.pathname);
    const parsed = parseJson(body);
    const content = typeof parsed.content === "string" ? parsed.content : "";

    record({
      event: "request",
      method: req.method,
      path: url.pathname,
      tokenMatchesExpected,
      tokenLooksPlaceholder: tokenLooksPlaceholder(token),
      authorizationPresent: Boolean(req.headers.authorization),
      authorizationRedacted: true,
      bodyRedacted: true,
      channelId: messageMatch?.[1] || channelMatch?.[1] || "",
      content,
      contentLength: content.length,
    });

    if (!tokenMatchesExpected) {
      writeJson(res, 401, { message: "401: Unauthorized", code: 0 });
      return;
    }

    if (req.method === "GET" && channelMatch) {
      writeJson(res, 200, {
        id: channelMatch[1],
        type: 0,
        name: "nemoclaw-e2e",
      });
      return;
    }

    if (req.method === "POST" && messageMatch) {
      writeJson(res, 200, {
        id: "420000000000000001",
        channel_id: messageMatch[1],
        content,
        timestamp: new Date().toISOString(),
        author: {
          id: "420000000000000000",
          username: "NemoClaw E2E",
          bot: true,
        },
      });
      return;
    }

    writeJson(res, 404, { message: "Unknown Endpoint", code: 10001 });
  });
});

server.on("error", (error) => {
  record({ event: "server_error", error: error.message });
  console.error(error.stack || error.message);
});

server.listen(port, host, () => {
  const address = server.address();
  if (portFile) {
    fs.writeFileSync(portFile, `${address.port}\n`, { mode: 0o600 });
  }
  record({ event: "listening", host, port: address.port });
});

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
