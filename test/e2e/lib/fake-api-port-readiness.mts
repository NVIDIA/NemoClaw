// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";
import net from "node:net";
import { pathToFileURL } from "node:url";

const ATTEMPT_TIMEOUT_MS = 1_000;
const READINESS_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 100;
const MAX_HANDSHAKE_BYTES = 8_192;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function requirePort(raw: string, name: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error(`${name} must be a decimal port`);
  const port = Number(raw);
  if (port > 65_535) throw new Error(`${name} must be at most 65535`);
  return port;
}

function probeHttp(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let bodyBytes = 0;
    let request: http.ClientRequest;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("REST readiness timed out")),
      ATTEMPT_TIMEOUT_MS,
    );
    request = http.get(
      {
        host,
        port,
        path: "/__nemoclaw_e2e_readiness",
      },
      (response) => {
        response.on("data", (chunk) => {
          bodyBytes += chunk.length;
          if (bodyBytes > MAX_HANDSHAKE_BYTES) {
            finish(new Error("REST readiness response exceeded 8192 bytes"));
          }
        });
        response.once("end", () => finish());
        response.once("error", (error) => finish(error));
      },
    );
    request.once("error", (error) => finish(error));
  });
}

function encodeClientText(payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(body.length);
  for (let index = 0; index < body.length; index += 1) {
    masked[index] = body[index] ^ mask[index % mask.length];
  }
  return Buffer.concat([Buffer.from([0x81, 0x80 | body.length]), mask, masked]);
}

function hasServerTextFrame(buffer: Buffer): boolean {
  if (buffer.length < 2) return false;
  const opcode = buffer[0] & 0x0f;
  let payloadLength = buffer[1] & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return false;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return false;
    const length = buffer.readBigUInt64BE(2);
    if (length > BigInt(MAX_HANDSHAKE_BYTES)) return false;
    payloadLength = Number(length);
    offset = 10;
  }
  return opcode === 1 && buffer.length >= offset + payloadLength;
}

function probeWebsocket(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64");
    const expectedAccept = crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
    const socket = net.createConnection({ host, port });
    let settled = false;
    let response = Buffer.alloc(0);
    let upgraded = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(ATTEMPT_TIMEOUT_MS, () => finish(new Error("WebSocket readiness timed out")));
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(
        [
          "GET /socket-mode HTTP/1.1",
          `Host: ${host}:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "\r\n",
        ].join("\r\n"),
      );
    });
    socket.on("data", (chunk) => {
      response = Buffer.concat([response, Buffer.from(chunk)]);
      if (response.length > MAX_HANDSHAKE_BYTES) {
        finish(new Error("WebSocket readiness response exceeded 8192 bytes"));
        return;
      }
      if (!upgraded) {
        const end = response.indexOf("\r\n\r\n");
        if (end === -1) return;
        const headers = response.slice(0, end).toString("latin1");
        const status = headers.split("\r\n", 1)[0] ?? "";
        const acceptLine = headers
          .split("\r\n")
          .find((line) => /^sec-websocket-accept:/iu.test(line));
        const accept = acceptLine?.slice(acceptLine.indexOf(":") + 1).trim();
        if (!/^HTTP\/1[.]1 101\b/u.test(status) || accept !== expectedAccept) {
          finish(new Error("WebSocket readiness handshake was rejected"));
          return;
        }
        upgraded = true;
        response = response.slice(end + 4);
        socket.write(encodeClientText(JSON.stringify({ type: "nemoclaw_readiness" })));
      }
      if (hasServerTextFrame(response)) finish();
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function proveFakeApiPortReadiness(options: {
  host: string;
  restPort: number;
  websocketPort?: number;
}): Promise<void> {
  if (net.isIP(options.host) === 0) throw new Error("readiness host must be an IP address");
  if (!Number.isInteger(options.restPort) || options.restPort < 1 || options.restPort > 65_535) {
    throw new Error("REST port must be an integer between 1 and 65535");
  }
  if (
    options.websocketPort !== undefined &&
    (!Number.isInteger(options.websocketPort) ||
      options.websocketPort < 1 ||
      options.websocketPort > 65_535)
  ) {
    throw new Error("WebSocket port must be an integer between 1 and 65535");
  }
  const deadline = Date.now() + READINESS_TIMEOUT_MS;
  let lastError = "readiness probe did not run";
  do {
    try {
      await probeHttp(options.host, options.restPort);
      if (options.websocketPort !== undefined) {
        await probeWebsocket(options.host, options.websocketPort);
      }
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await sleep(RETRY_DELAY_MS);
  } while (Date.now() < deadline);
  throw new Error(`fake API port readiness failed: ${lastError}`);
}

async function main(): Promise<void> {
  const [host = "", restPortRaw = "", websocketPortRaw] = process.argv.slice(2);
  await proveFakeApiPortReadiness({
    host,
    restPort: requirePort(restPortRaw, "REST port"),
    ...(websocketPortRaw === undefined
      ? {}
      : { websocketPort: requirePort(websocketPortRaw, "WebSocket port") }),
  });
  process.stdout.write("fake API proxy ports are ready\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
