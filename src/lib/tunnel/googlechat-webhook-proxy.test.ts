// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readGooglechatWebhookProxyState,
  startGooglechatWebhookProxy,
  stopGooglechatWebhookProxy,
} from "./googlechat-webhook-proxy";

const cleanupDirs = new Set<string>();
const cleanupServers = new Set<Server>();

afterEach(async () => {
  for (const server of cleanupServers) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  cleanupServers.clear();
  for (const dir of cleanupDirs) {
    stopGooglechatWebhookProxy(dir);
    rmSync(dir, { recursive: true, force: true });
  }
  cleanupDirs.clear();
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  expect(address).not.toBeNull();
  expect(typeof address).not.toBe("string");
  return (address as AddressInfo).port;
}

describe("Google Chat webhook route proxy", () => {
  it("forwards only POST /googlechat and denies dashboard or control routes", async () => {
    const received: Array<{ method?: string; url?: string; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method,
          url: request.url,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(202, { "content-type": "application/json" });
        response.end('{"accepted":true}');
      });
    });
    cleanupServers.add(upstream);
    const upstreamPort = await listen(upstream);
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-googlechat-proxy-"));
    cleanupDirs.add(pidDir);

    const proxyPort = await startGooglechatWebhookProxy(pidDir, upstreamPort);
    const webhook = await fetch(`http://127.0.0.1:${String(proxyPort)}/googlechat?key=value`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"type":"MESSAGE"}',
    });
    expect(webhook.status).toBe(202);
    expect(await webhook.json()).toEqual({ accepted: true });
    expect(received).toEqual([
      {
        method: "POST",
        url: "/googlechat?key=value",
        body: '{"type":"MESSAGE"}',
      },
    ]);

    for (const [path, method] of [
      ["/", "POST"],
      ["/health", "POST"],
      ["/ws", "POST"],
      ["/googlechat", "GET"],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${String(proxyPort)}${path}`, { method });
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(received).toHaveLength(1);

    const state = readGooglechatWebhookProxyState(pidDir);
    expect(state).toEqual({ running: true, port: proxyPort, upstreamPort });
    expect(statSync(join(pidDir, "nemoclaw-googlechat-webhook-proxy.pid")).mode & 0o777).toBe(
      0o600,
    );
    expect(statSync(join(pidDir, "nemoclaw-googlechat-webhook-proxy.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("rejects oversized webhook bodies before they reach the dashboard", async () => {
    let upstreamRequests = 0;
    const upstream = createServer((_request, response) => {
      upstreamRequests += 1;
      response.end("unexpected");
    });
    cleanupServers.add(upstream);
    const upstreamPort = await listen(upstream);
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-googlechat-proxy-"));
    cleanupDirs.add(pidDir);
    const proxyPort = await startGooglechatWebhookProxy(pidDir, upstreamPort);

    const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/googlechat`, {
      method: "POST",
      body: Buffer.alloc(1024 * 1024 + 1, 1),
    });
    expect(response.status).toBe(413);
    expect(upstreamRequests).toBe(0);
  });
});
