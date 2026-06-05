#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const fs = require("fs");
const crypto = require("crypto");
const http = require("http");

const host = process.env.FAKE_SLACK_API_HOST || "0.0.0.0";
const rawPort = process.env.FAKE_SLACK_API_PORT || "0";
const port = Number(rawPort);
const portFile = process.env.FAKE_SLACK_API_PORT_FILE || "";
const captureFile = process.env.FAKE_SLACK_API_CAPTURE_FILE || "";
const expectedBotToken = process.env.FAKE_SLACK_API_EXPECTED_BOT_TOKEN || "";
const expectedAppToken = process.env.FAKE_SLACK_API_EXPECTED_APP_TOKEN || "";
const socketUserId = process.env.FAKE_SLACK_API_SOCKET_USER_ID || "U3730E2E";
const socketChannelId = process.env.FAKE_SLACK_API_SOCKET_CHANNEL_ID || "D3730E2E";
const socketTeamId = process.env.FAKE_SLACK_API_SOCKET_TEAM_ID || "T3730E2E";
const MAX_BODY_BYTES = 1024 * 1024;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

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

function tokenLooksPlaceholder(value) {
  return (
    typeof value === "string" &&
    (value.includes("openshell:resolve:env:") || value.includes("OPENSHELL-RESOLVE-ENV-"))
  );
}

function slackResponseFor(pathname, authAccepted, message = {}) {
  if (pathname === "/api/chat.postMessage") {
    return {
      status: 200,
      body: authAccepted
        ? {
            ok: true,
            channel: message.channel || socketChannelId,
            ts: "1710000000.000200",
            message: {
              type: "message",
              channel: message.channel || socketChannelId,
              text: message.text || "",
              ts: "1710000000.000200",
              ...(message.threadTs ? { thread_ts: message.threadTs } : {}),
            },
          }
        : {
            ok: false,
            error: "bad_auth",
            endpoint: pathname,
          },
    };
  }
  if (!authAccepted) {
    return { status: 401, body: { ok: false, error: "bad_auth", endpoint: pathname } };
  }
  return { status: 200, body: { ok: false, error: "invalid_auth", endpoint: pathname } };
}

function encodeServerText(payload) {
  const body = Buffer.from(payload, "utf8");
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function decodeClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    payloadLength = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskOffset = offset;
  if (masked) offset += 4;
  if (buffer.length < offset + payloadLength) return null;
  const payload = Buffer.from(buffer.slice(offset, offset + payloadLength));
  if (masked) {
    const mask = buffer.slice(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }
  return {
    opcode,
    payload,
    totalLength: offset + payloadLength,
  };
}

function sendSocketModeEvent(socket) {
  const envelope = {
    envelope_id: "slack-e2e-envelope-3730",
    type: "events_api",
    accepts_response_payload: true,
    payload: {
      token: "verification-token",
      team_id: socketTeamId,
      api_app_id: "A3730E2E",
      type: "event_callback",
      event_id: "Ev3730E2E",
      event_time: Math.floor(Date.now() / 1000),
      authorizations: [{ team_id: socketTeamId, user_id: "UOPENCLAWBOT", is_bot: true }],
      event: {
        type: "message",
        channel_type: "im",
        channel: socketChannelId,
        user: socketUserId,
        text: "pair me",
        ts: `${Math.floor(Date.now() / 1000)}.000000`,
      },
    },
  };
  socket.write(encodeServerText(JSON.stringify(envelope)));
  record({ event: "websocket-event-sent", path: "/socket-mode", envelopeId: envelope.envelope_id });
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
    const bodyParams = new URLSearchParams(body);
    const bodyToken = bodyParams.get("token") || "";
    const channel = bodyParams.get("channel") || "";
    const text = bodyParams.get("text") || "";
    const threadTs = bodyParams.get("thread_ts") || "";
    const tokenMatchesExpected = authorization === expectedAuthorization;
    const bodyMatchesExpected = bodyToken === expectedToken;
    const authAccepted = tokenMatchesExpected && bodyMatchesExpected;
    const requestTokenLooksPlaceholder =
      tokenLooksPlaceholder(authorization) || tokenLooksPlaceholder(body);

    record({
      event: "request",
      method: req.method,
      path: pathname,
      tokenMatchesExpected,
      bodyMatchesExpected,
      tokenLooksPlaceholder: requestTokenLooksPlaceholder,
      authorizationPresent: Boolean(authorization),
      bodyTokenPresent: Boolean(bodyToken),
      authorizationRedacted: true,
      bodyRedacted: true,
      ...(pathname === "/api/chat.postMessage"
        ? {
            channel,
            text,
            textLength: text.length,
            threadTs,
          }
        : {}),
    });

    const response = slackResponseFor(pathname, authAccepted, { channel, text, threadTs });
    res.writeHead(response.status, {
      "content-type": "application/json",
    });
    res.end(JSON.stringify(response.body));
  });
});

server.on("upgrade", (req, socket) => {
  const pathname = new URL(req.url || "/", "http://fake-slack.local").pathname;
  if (pathname !== "/socket-mode") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || !key) {
    socket.destroy();
    return;
  }

  const accept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "\r\n",
    ].join("\r\n"),
  );
  record({ event: "websocket-upgrade", path: pathname });

  let buffer = Buffer.alloc(0);
  let sentEvent = false;

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length > 0) {
      const frame = decodeClientFrame(buffer);
      if (!frame) break;
      buffer = buffer.slice(frame.totalLength);
      if (frame.opcode === 8) {
        socket.end();
        return;
      }
      if (frame.opcode !== 1) continue;
      const text = frame.payload.toString("utf8");
      let token = "";
      let messageType = "";
      let envelopeId = "";
      try {
        const parsed = JSON.parse(text);
        token = typeof parsed.token === "string" ? parsed.token : "";
        messageType = typeof parsed.type === "string" ? parsed.type : "";
        envelopeId = typeof parsed.envelope_id === "string" ? parsed.envelope_id : "";
      } catch {
        // Capture classification below is still useful for malformed frames.
      }
      record({
        event: "websocket-message",
        path: pathname,
        messageType,
        tokenMatchesExpected: token === expectedAppToken,
        tokenLooksPlaceholder: tokenLooksPlaceholder(text),
        textRedacted: true,
      });
      if (!sentEvent) {
        sentEvent = true;
        sendSocketModeEvent(socket);
      } else if (envelopeId === "slack-e2e-envelope-3730") {
        socket.end();
      }
    }
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
