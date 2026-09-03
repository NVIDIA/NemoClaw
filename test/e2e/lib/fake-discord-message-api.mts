#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import { pathToFileURL } from "node:url";

export interface DiscordAuthorizationInspection {
  authorizationPresent: boolean;
  authorizationRedacted: true;
  authorizationSchemeValid: boolean;
  tokenLooksPlaceholder: boolean;
  tokenMatchesExpected: boolean;
}

export function inspectAuthorization(
  value: string | undefined,
  expectedToken: string,
): DiscordAuthorizationInspection {
  const raw = value ?? "";
  let tokenStart = 3;
  const hasBotScheme = raw.slice(0, tokenStart).toLowerCase() === "bot";
  const separatorStart = tokenStart;
  while (raw[tokenStart] === " " || raw[tokenStart] === "\t") tokenStart += 1;
  const schemeValid = hasBotScheme && tokenStart > separatorStart && tokenStart < raw.length;
  const token = schemeValid ? raw.slice(tokenStart) : "";
  return {
    authorizationPresent: raw.length > 0,
    authorizationRedacted: true,
    authorizationSchemeValid: schemeValid,
    tokenLooksPlaceholder: token.includes("openshell:resolve:env:"),
    tokenMatchesExpected: token === expectedToken,
  };
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createDiscordMessageApi(
  expectedToken: string,
  record: (event: Record<string, unknown>) => void,
): http.Server {
  if (!expectedToken) throw new Error("expected Discord token is required");
  return http.createServer((request, response) => {
    const url = new URL(request.url || "/", "http://fake-discord.local");
    const authorization = inspectAuthorization(request.headers.authorization, expectedToken);
    record({
      event: "request",
      method: request.method,
      path: url.pathname,
      ...authorization,
    });

    if (!authorization.tokenMatchesExpected) {
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
    writeJson(response, 404, { message: "Unknown Endpoint", code: 10001 });
  });
}

function main(): void {
  const host = process.env.FAKE_DISCORD_MESSAGE_API_HOST || "0.0.0.0";
  const rawPort = process.env.FAKE_DISCORD_MESSAGE_API_PORT || "0";
  const port = Number(rawPort);
  const captureFile = process.env.FAKE_DISCORD_MESSAGE_API_CAPTURE_FILE || "";
  const expectedToken = process.env.FAKE_DISCORD_MESSAGE_API_EXPECTED_TOKEN || "";
  if (!Number.isInteger(port) || port < 0 || port > 65_535 || !captureFile || !expectedToken) {
    throw new Error("fake Discord message API requires a valid port, capture file, and token");
  }
  const record = (event: Record<string, unknown>): void =>
    fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  const server = createDiscordMessageApi(expectedToken, record);
  server.on("error", (error) => {
    record({ event: "server_error", error: error.message });
    console.error(error.stack || error.message);
  });
  server.listen(port, host, () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("fake Discord message API did not bind a TCP port");
    }
    record({ event: "listening", host, port: address.port });
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
