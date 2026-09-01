#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";

const host = process.env.FAKE_DISCORD_MESSAGE_API_HOST || "0.0.0.0";
const rawPort = process.env.FAKE_DISCORD_MESSAGE_API_PORT || "0";
const port = Number(rawPort);
const portFile = process.env.FAKE_DISCORD_MESSAGE_API_PORT_FILE || "";
const captureFile = process.env.FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE || "";
const expectedToken = process.env.FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN || "";

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(
    `FAKE_DISCORD_MESSAGE_API_PORT must be an integer between 0 and 65535 (received: ${rawPort})`,
  );
}

if (!expectedToken) {
  throw new Error("FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN is required");
}

function record(event: Record<string, unknown>): void {
  if (captureFile) {
    fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  }
}

function tokenFromAuthorization(value: string | undefined): string {
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

function tokenLooksPlaceholder(value: string): boolean {
  return value.includes("openshell:resolve:env:");
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || "/", "http://fake-discord.local");
  const token = tokenFromAuthorization(request.headers.authorization);
  const tokenMatchesExpected = token === expectedToken;

  record({
    event: "request",
    method: request.method,
    path: url.pathname,
    tokenMatchesExpected,
    tokenLooksPlaceholder: tokenLooksPlaceholder(token),
    authorizationPresent: Boolean(request.headers.authorization),
    authorizationRedacted: true,
  });

  if (!tokenMatchesExpected) {
    writeJson(response, 401, { message: "401: Unauthorized", code: 0 });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/v10/users/@me") {
    writeJson(response, 200, {
      id: "420000000000000000",
      username: "NemoClaw E2E",
      bot: true,
    });
    return;
  }

  writeJson(response, 404, { message: "Unknown Endpoint", code: 10_001 });
});

server.on("error", (error) => {
  record({ event: "server_error", error: error.message });
  console.error(error.stack || error.message);
});

server.listen(port, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake Discord message API did not bind a TCP port");
  }
  if (portFile) {
    fs.writeFileSync(portFile, `${address.port}\n`, { mode: 0o600 });
  }
  record({ event: "listening", host, port: address.port });
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  });
}
