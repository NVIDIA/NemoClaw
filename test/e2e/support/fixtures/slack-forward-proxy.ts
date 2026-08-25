// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import net from "node:net";
import vm from "node:vm";

import { SLACK_PAIRING_SCRIPT } from "../../live/openclaw-pairing-helpers.ts";

export function createSlackSocketClient(proxyPort: number, targetPort: number) {
  const sourceStart = SLACK_PAIRING_SCRIPT.indexOf("function parseFakeSlackPort");
  const sourceEnd = SLACK_PAIRING_SCRIPT.indexOf("function postPairingReply");
  if (sourceStart < 0 || sourceEnd <= sourceStart) {
    throw new Error("Slack Socket Mode client source is missing");
  }
  const source = SLACK_PAIRING_SCRIPT.slice(sourceStart, sourceEnd);
  return vm.runInNewContext(`${source}\nreceiveSlackSocketEvent`, {
    Buffer,
    URL,
    clearTimeout,
    crypto,
    net: {
      createConnection: () => net.createConnection({ host: "127.0.0.1", port: proxyPort }),
    },
    process: {
      env: {
        FAKE_SLACK_WEBSOCKET_PORT: String(targetPort),
        HTTP_PROXY: "http://10.200.0.1:3128",
        http_proxy: "",
      },
    },
    setTimeout,
  }) as () => Promise<Record<string, unknown>>;
}

function encodeServerText(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  if (body.length > 125) throw new Error("test WebSocket payload is too large");
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

export async function listenOnLoopback(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test proxy has no TCP port");
  return address.port;
}

export async function closeServer(server: net.Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

export function createSuccessfulSlackForwardProxy(envelope: Record<string, unknown>): {
  server: net.Server;
  requests: string[];
  websocketBytes: () => number;
} {
  const requests: string[] = [];
  let receivedWebsocketBytes = 0;
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      if (upgraded) {
        receivedWebsocketBytes += chunk.length;
        return;
      }
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) return;
      requests.push(buffer.slice(0, end).toString("latin1"));
      upgraded = true;
      socket.write(
        Buffer.concat([
          Buffer.from(
            "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
            "latin1",
          ),
          encodeServerText(envelope),
        ]),
      );
    });
  });
  return {
    server,
    requests,
    websocketBytes: () => receivedWebsocketBytes,
  };
}

export function createRejectedSlackForwardProxy(): net.Server {
  return net.createServer((socket) => {
    socket.once("data", () => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
  });
}
