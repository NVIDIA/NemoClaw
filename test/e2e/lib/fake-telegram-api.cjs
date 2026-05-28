#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const http = require("http");

const host = process.env.FAKE_TELEGRAM_API_HOST || "0.0.0.0";
const rawPort = process.env.FAKE_TELEGRAM_API_PORT || "0";
const port = Number(rawPort);
const portFile = process.env.FAKE_TELEGRAM_API_PORT_FILE || "";
const captureFile = process.env.FAKE_TELEGRAM_API_CAPTURE_FILE || "";
const expectedToken = process.env.FAKE_TELEGRAM_API_EXPECTED_TOKEN || "";
const MAX_BODY_BYTES = 1024 * 1024;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`FAKE_TELEGRAM_API_PORT must be an integer between 0 and 65535 (received: ${rawPort})`);
  process.exit(2);
}

if (!expectedToken) {
  console.error("FAKE_TELEGRAM_API_EXPECTED_TOKEN is required");
  process.exit(2);
}

function record(event) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function tokenLooksPlaceholder(value) {
  return typeof value === "string" && value.includes("openshell:resolve:env:");
}

function readFields(req, body) {
  const contentType = String(req.headers["content-type"] || "");
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body || "{}");
    } catch {
      return {};
    }
  }
  const params = new URLSearchParams(body);
  return Object.fromEntries(params.entries());
}

function writeJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
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
      writeJson(res, 413, { ok: false, error_code: 413, description: "payload too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });

  req.on("end", () => {
    if (bodyTooLarge) return;
    const body = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url || "/", "http://fake-telegram.local");
    const match = /^\/bot([^/]+)\/([^/?]+)$/.exec(url.pathname);
    const token = match?.[1] || "";
    const endpoint = match?.[2] || "";
    const fields = readFields(req, body);
    const tokenMatchesExpected = token === expectedToken;

    record({
      event: "request",
      method: req.method,
      path: url.pathname,
      endpoint,
      tokenMatchesExpected,
      tokenLooksPlaceholder: tokenLooksPlaceholder(token),
      tokenRedacted: true,
      chatId: fields.chat_id ? String(fields.chat_id) : "",
      text: fields.text ? String(fields.text) : "",
      textLength: fields.text ? String(fields.text).length : 0,
    });

    if (!match) {
      writeJson(res, 404, { ok: false, error_code: 404, description: "not found" });
      return;
    }

    if (!tokenMatchesExpected) {
      writeJson(res, 401, { ok: false, error_code: 401, description: "Unauthorized" });
      return;
    }

    if (endpoint === "getMe") {
      writeJson(res, 200, {
        ok: true,
        result: {
          id: 420000001,
          is_bot: true,
          first_name: "NemoClaw E2E",
          username: "nemoclaw_e2e_bot",
        },
      });
      return;
    }

    if (endpoint === "sendMessage") {
      writeJson(res, 200, {
        ok: true,
        result: {
          message_id: 4201,
          date: Math.floor(Date.now() / 1000),
          chat: {
            id: Number(fields.chat_id) || String(fields.chat_id || ""),
            type: "private",
          },
          text: String(fields.text || ""),
        },
      });
      return;
    }

    writeJson(res, 200, { ok: true, result: true });
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
