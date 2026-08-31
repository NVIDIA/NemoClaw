// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

const ATTEMPT_TIMEOUT_MS = 1_000;
const PORT_TRAFFIC_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 100;
const MAX_REPLY_BYTES = 8_192;
const PORT_TRAFFIC_PROBE = "nemoclaw_port_traffic_probe";
const PORT_TRAFFIC_REPLY = "nemoclaw_port_traffic_reply";

function requirePort(raw: string, name: string): number {
  if (!/^[1-9][0-9]{0,4}$/u.test(raw)) throw new Error(`${name} must be a decimal port`);
  const port = Number(raw);
  if (port > 65_535) throw new Error(`${name} must be at most 65535`);
  return port;
}

function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

async function probeHttp(host: string, port: number): Promise<void> {
  const response = await fetch(`http://${urlHost(host)}:${port}/__nemoclaw_e2e_port_traffic`, {
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
  });
  const reader = response.body?.getReader();
  if (!reader) return;
  let replyBytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    replyBytes += value.byteLength;
    if (replyBytes > MAX_REPLY_BYTES) {
      await reader.cancel();
      throw new Error("REST port traffic reply exceeded 8192 bytes");
    }
  }
}

function probeWebsocket(host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://${urlHost(host)}:${port}/socket-mode`);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // Preserve the traffic-check result when the native client is not open.
      }
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      finish(new Error("WebSocket port traffic timed out"));
    }, ATTEMPT_TIMEOUT_MS);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ type: PORT_TRAFFIC_PROBE }));
    });
    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        finish(new Error("WebSocket port traffic reply was not text"));
        return;
      }
      if (Buffer.byteLength(event.data, "utf8") > MAX_REPLY_BYTES) {
        finish(new Error("WebSocket port traffic reply exceeded 8192 bytes"));
        return;
      }
      try {
        const reply = JSON.parse(event.data);
        if (reply?.type !== PORT_TRAFFIC_REPLY) {
          finish(new Error("WebSocket port traffic reply was not recognized"));
          return;
        }
      } catch {
        finish(new Error("WebSocket port traffic reply was not valid JSON"));
        return;
      }
      finish();
    });
    socket.addEventListener("error", () => {
      finish(new Error("WebSocket port traffic connection failed"));
    });
    socket.addEventListener("close", () => {
      finish(new Error("WebSocket port traffic closed before the reply"));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function proveFakeApiPortTraffic(options: {
  host: string;
  restPort: number;
  websocketPort?: number;
}): Promise<void> {
  if (isIP(options.host) === 0) throw new Error("port traffic host must be an IP address");
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
  const deadline = Date.now() + PORT_TRAFFIC_TIMEOUT_MS;
  let lastError: string | undefined;
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
  throw new Error(`fake API port traffic check failed: ${lastError ?? "no reply"}`);
}

async function main(): Promise<void> {
  const [host = "", restPortRaw = "", websocketPortRaw] = process.argv.slice(2);
  await proveFakeApiPortTraffic({
    host,
    restPort: requirePort(restPortRaw, "REST port"),
    ...(websocketPortRaw === undefined
      ? {}
      : { websocketPort: requirePort(websocketPortRaw, "WebSocket port") }),
  });
  process.stdout.write("fake API proxy ports carry traffic\n");
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
