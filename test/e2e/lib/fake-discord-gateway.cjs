#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const net = require("net");

const host = process.env.FAKE_DISCORD_GATEWAY_HOST || "0.0.0.0";
const port = Number(process.env.FAKE_DISCORD_GATEWAY_PORT || "0");
const portFile = process.env.FAKE_DISCORD_GATEWAY_PORT_FILE || "";
const captureFile = process.env.FAKE_DISCORD_GATEWAY_CAPTURE_FILE || "";
const expectedToken = process.env.FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN || "";

if (!expectedToken) {
  console.error("FAKE_DISCORD_GATEWAY_EXPECTED_TOKEN is required");
  process.exit(2);
}

function record(event) {
  if (!captureFile) return;
  fs.appendFileSync(captureFile, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

function encodeText(payload) {
  const body = Buffer.from(payload, "utf8");
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([0x81, body.length]), body]);
  }
  if (body.length <= 0xffff) {
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

function encodeClose(code) {
  const body = Buffer.alloc(2);
  body.writeUInt16BE(code, 0);
  return Buffer.from([0x88, body.length, ...body]);
}

function decodeFrame(buffer) {
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

  let mask;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.slice(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + payloadLength) return null;

  const payload = Buffer.from(buffer.slice(offset, offset + payloadLength));
  if (masked && mask) {
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

function sendJson(socket, payload) {
  socket.write(encodeText(JSON.stringify(payload)));
}

function handleGatewayMessage(socket, payload) {
  let message;
  try {
    message = JSON.parse(payload.toString("utf8"));
  } catch (error) {
    record({ event: "malformed_text", error: error.message });
    socket.write(encodeClose(4002));
    socket.end();
    return;
  }

  if (message.op === 2) {
    const token = message && message.d && message.d.token;
    record({
      event: "identify",
      token,
      tokenMatchesExpected: token === expectedToken,
      tokenLooksPlaceholder: typeof token === "string" && token.includes("openshell:resolve:env:"),
    });
    if (token !== expectedToken) {
      socket.write(encodeClose(4004));
      socket.end();
      return;
    }
    sendJson(socket, {
      op: 0,
      t: "READY",
      s: 1,
      d: {
        session_id: "fake-discord-gateway-session",
        resume_gateway_url: "ws://host.openshell.internal/gateway",
        user: {
          id: "0",
          username: "nemoclaw-fake-gateway",
          discriminator: "0000",
          avatar: null,
          bot: true,
        },
        guilds: [],
      },
    });
    return;
  }

  if (message.op === 1) {
    record({ event: "heartbeat", d: message.d ?? null });
    sendJson(socket, { op: 11, d: null });
    return;
  }

  record({ event: "gateway_message", op: message.op ?? null });
}

const server = net.createServer((socket) => {
  let handshake = Buffer.alloc(0);
  let framed = Buffer.alloc(0);
  let upgraded = false;

  socket.on("data", (chunk) => {
    if (!upgraded) {
      handshake = Buffer.concat([handshake, chunk]);
      const end = handshake.indexOf("\r\n\r\n");
      if (end === -1) return;

      const request = handshake.slice(0, end).toString("latin1");
      const requestLine = request.split("\r\n")[0] || "";
      const keyLine = request
        .split("\r\n")
        .find((line) => line.toLowerCase().startsWith("sec-websocket-key:"));
      const key = keyLine ? keyLine.slice(keyLine.indexOf(":") + 1).trim() : "";
      if (!key) {
        socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }

      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${accept}`,
          "\r\n",
        ].join("\r\n"),
      );
      upgraded = true;
      record({ event: "upgrade", requestLine });
      sendJson(socket, { op: 10, d: { heartbeat_interval: 30000 } });
      framed = Buffer.concat([framed, handshake.slice(end + 4)]);
    } else {
      framed = Buffer.concat([framed, chunk]);
    }

    while (framed.length > 0) {
      const frame = decodeFrame(framed);
      if (!frame) break;
      framed = framed.slice(frame.totalLength);
      if (frame.opcode === 0x1) {
        handleGatewayMessage(socket, frame.payload);
      } else if (frame.opcode === 0x8) {
        socket.write(encodeClose(1000));
        socket.end();
      } else if (frame.opcode === 0x9) {
        socket.write(Buffer.from([0x8a, 0x00]));
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
