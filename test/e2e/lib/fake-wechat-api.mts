#!/usr/bin/env -S node --experimental-strip-types
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";

const host = process.env.FAKE_WECHAT_API_HOST || "0.0.0.0";
const rawPort = process.env.FAKE_WECHAT_API_PORT || "0";
const port = Number(rawPort);
const portFile = process.env.FAKE_WECHAT_API_PORT_FILE || "";
const captureFile = process.env.FAKE_WECHAT_API_CAPTURE_FILE || "";
const expectedToken = process.env.FAKE_WECHAT_API_EXPECTED_TOKEN || "";
const expectedTarget = process.env.FAKE_WECHAT_API_EXPECTED_TARGET || "";
const expectedText = process.env.FAKE_WECHAT_API_EXPECTED_TEXT || "";
const MAX_BODY_BYTES = 1024 * 1024;

if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error(
    `FAKE_WECHAT_API_PORT must be an integer between 0 and 65535 (received: ${rawPort})`,
  );
}
if (!expectedToken) {
  throw new Error("FAKE_WECHAT_API_EXPECTED_TOKEN is required");
}
if (!expectedTarget || !expectedText) {
  throw new Error("FAKE_WECHAT_API_EXPECTED_TARGET and FAKE_WECHAT_API_EXPECTED_TEXT are required");
}

function record(event: Record<string, unknown>): void {
  if (captureFile) {
    fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
  }
}

function tokenLooksPlaceholder(value: string): boolean {
  return value.includes("openshell:resolve:env:");
}

function writeJson(response: http.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

const server = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  let bodyBytes = 0;
  let bodyTooLarge = false;
  request.on("data", (chunk: Buffer) => {
    if (bodyTooLarge) return;
    bodyBytes += chunk.length;
    if (bodyBytes > MAX_BODY_BYTES) {
      bodyTooLarge = true;
      record({ event: "request-too-large", method: request.method, path: request.url, bodyBytes });
      writeJson(response, 413, { ret: 413, errmsg: "payload too large" });
      request.destroy();
      return;
    }
    chunks.push(chunk);
  });

  request.on("end", () => {
    if (bodyTooLarge) return;
    const authorization = String(request.headers.authorization || "");
    const token = authorization.match(/^Bearer (.+)$/u)?.[1] ?? "";
    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
    } catch {
      writeJson(response, 400, { ret: 400, errmsg: "invalid json" });
      return;
    }
    const message = (body.msg ?? {}) as Record<string, unknown>;
    const items = Array.isArray(message.item_list) ? message.item_list : [];
    const firstItem = (items[0] ?? {}) as Record<string, unknown>;
    const textItem = (firstItem.text_item ?? {}) as Record<string, unknown>;
    const baseInfo = (body.base_info ?? {}) as Record<string, unknown>;
    const tokenMatchesExpected = token === expectedToken;

    record({
      event: "request",
      method: request.method,
      path: request.url,
      authorizationType: request.headers.authorizationtype,
      tokenMatchesExpected,
      tokenLooksPlaceholder: tokenLooksPlaceholder(token),
      tokenRedacted: true,
      targetMatchesExpected: message.to_user_id === expectedTarget,
      textMatchesExpected: textItem.text === expectedText,
      contextTokenPresent: typeof message.context_token === "string",
      channelVersionPresent: typeof baseInfo.channel_version === "string",
      botAgentPresent: typeof baseInfo.bot_agent === "string",
    });

    if (request.method !== "POST" || request.url !== "/ilink/bot/sendmessage") {
      writeJson(response, 404, { ret: 404, errmsg: "not found" });
      return;
    }
    if (!tokenMatchesExpected) {
      writeJson(response, 401, { ret: 401, errmsg: "unauthorized" });
      return;
    }
    writeJson(response, 200, { ret: 0, errmsg: "ok" });
  });
});

server.on("error", (error) => {
  record({ event: "server-error", error: error.message });
  console.error(error.stack || error.message);
});

server.listen(port, host, () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake WeChat API did not bind a TCP port");
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
