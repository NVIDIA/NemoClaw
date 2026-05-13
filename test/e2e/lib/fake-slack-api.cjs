#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const http = require("http");

const host = process.env.FAKE_SLACK_API_HOST || "0.0.0.0";
const rawPort = process.env.FAKE_SLACK_API_PORT || "0";
const port = Number(rawPort);
const portFile = process.env.FAKE_SLACK_API_PORT_FILE || "";
const captureFile = process.env.FAKE_SLACK_API_CAPTURE_FILE || "";
const expectedBotToken = process.env.FAKE_SLACK_API_EXPECTED_BOT_TOKEN || "";
const expectedAppToken = process.env.FAKE_SLACK_API_EXPECTED_APP_TOKEN || "";
const MAX_BODY_BYTES = 1024 * 1024;

if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`FAKE_SLACK_API_PORT must be an integer between 0 and 65535 (received: ${rawPort})`);
  process.exit(2);
}

if (!expectedBotToken || !expectedAppToken) {
  console.error("FAKE_SLACK_API_EXPECTED_BOT_TOKEN and FAKE_SLACK_API_EXPECTED_APP_TOKEN are required");
  process.exit(2);
}

function record(event) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function expectedTokenForPath(pathname) {
  if (pathname === "/api/apps.connections.open") return expectedAppToken;
  return expectedBotToken;
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
      record({
        event: "request-too-large",
        method: req.method,
        path: new URL(req.url || "/", "http://fake-slack.local").pathname,
        bodyBytes,
      });
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "payload_too_large" }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (bodyTooLarge) return;
    const body = Buffer.concat(chunks).toString("utf8");
    const pathname = new URL(req.url || "/", "http://fake-slack.local").pathname;
    const authorization = req.headers.authorization || "";
    const expectedToken = expectedTokenForPath(pathname);
    const expectedAuthorization = `Bearer ${expectedToken}`;
    const bodyToken = new URLSearchParams(body).get("token") || "";
    const tokenMatchesExpected = authorization === expectedAuthorization;
    const bodyMatchesExpected = bodyToken === expectedToken;
    const authAccepted = tokenMatchesExpected && bodyMatchesExpected;
    const tokenLooksPlaceholder =
      typeof authorization === "string" &&
      (authorization.includes("openshell:resolve:env:") ||
        authorization.includes("OPENSHELL-RESOLVE-ENV-") ||
        body.includes("openshell:resolve:env:") ||
        body.includes("OPENSHELL-RESOLVE-ENV-"));

    record({
      event: "request",
      method: req.method,
      path: pathname,
      tokenMatchesExpected,
      bodyMatchesExpected,
      tokenLooksPlaceholder,
      authorizationPresent: Boolean(authorization),
      bodyTokenPresent: Boolean(bodyToken),
      authorizationRedacted: true,
      bodyRedacted: true,
    });

    res.writeHead(authAccepted ? 200 : 401, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify({
        ok: false,
        error: authAccepted ? "invalid_auth" : "bad_auth",
        endpoint: pathname,
      }),
    );
  });
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
