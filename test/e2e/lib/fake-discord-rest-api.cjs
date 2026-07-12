#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const https = require("https");

const host = process.env.FAKE_DISCORD_REST_HOST || "0.0.0.0";
const port = Number(process.env.FAKE_DISCORD_REST_PORT || "0");
const keyPath = process.env.FAKE_DISCORD_REST_KEY_PATH || "";
const certPath = process.env.FAKE_DISCORD_REST_CERT_PATH || "";
const portFile = process.env.FAKE_DISCORD_REST_PORT_FILE || "";
const captureFile = process.env.FAKE_DISCORD_REST_CAPTURE_FILE || "";

if (!keyPath || !certPath) {
  console.error("FAKE_DISCORD_REST_KEY_PATH and FAKE_DISCORD_REST_CERT_PATH are required");
  process.exit(2);
}

function record(event) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

const server = https.createServer(
  {
    key: fs.readFileSync(keyPath),
    cert: fs.readFileSync(certPath),
  },
  (req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      record({
        event: "request",
        method: req.method,
        url: req.url,
        userAgent: req.headers["user-agent"] || "",
        bodyLength: body.length,
      });

      if (req.url === "/api/v10/gateway") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ url: "wss://gateway.discord.gg" }));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("fake discord cdn ok\n");
    });
  },
);

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
