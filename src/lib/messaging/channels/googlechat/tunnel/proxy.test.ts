// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  symlinkSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readGooglechatWebhookProxyState,
  startGooglechatWebhookProxy,
  stopGooglechatWebhookProxy,
} from "./proxy";

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

  it("rejects a pre-planted symlink at the state directory instead of chmod-ing its target", async () => {
    const base = mkdtempSync(join(tmpdir(), "nemoclaw-googlechat-proxy-"));
    cleanupDirs.add(base);
    // A local user pre-creates the predictable pidDir as a symlink to a directory
    // they do not own, hoping the detached host process chmods the target to 0o700.
    const victim = join(base, "victim");
    mkdirSync(victim);
    chmodSync(victim, 0o755);
    const pidDir = join(base, "state");
    symlinkSync(victim, pidDir);

    // O_NOFOLLOW refuses the trailing symlink; the exact errno depends on flag
    // check order (ELOOP for the link, ENOTDIR once O_DIRECTORY sees a non-dir).
    await expect(startGooglechatWebhookProxy(pidDir, 18789)).rejects.toThrow(/ELOOP|ENOTDIR/);

    // Startup refused the symlinked state dir (O_NOFOLLOW), so the link is intact
    // and its target keeps its mode — the chmod never followed the link.
    expect(lstatSync(pidDir).isSymbolicLink()).toBe(true);
    expect(statSync(victim).mode & 0o777).toBe(0o755);
  });

  it("rejects a state directory not owned by the effective user", async () => {
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-googlechat-proxy-"));
    cleanupDirs.add(pidDir);
    // Report a uid that differs from the directory's real owner so the ownership
    // guard trips, without an in-body branch (keeps the test linear).
    const foreignUid = statSync(pidDir).uid + 1;
    const getEffectiveUid = vi.spyOn(process, "geteuid").mockReturnValue(foreignUid);

    try {
      await expect(startGooglechatWebhookProxy(pidDir, 18789)).rejects.toThrow(
        /not owned by this process/,
      );
    } finally {
      getEffectiveUid.mockRestore();
    }
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

  it("strips spoofable forwarding metadata and exposes only safe upstream headers", async () => {
    let forwardedHeaders: Record<string, string | string[] | undefined> = {};
    const upstream = createServer((request, response) => {
      forwardedHeaders = request.headers;
      request.resume();
      request.on("end", () => {
        response.writeHead(202, {
          "content-type": "application/json",
          "set-cookie": "session=private",
          server: "internal-dashboard",
          "x-debug-token": "internal-only",
        });
        response.end('{"accepted":true}');
      });
    });
    cleanupServers.add(upstream);
    const upstreamPort = await listen(upstream);
    const pidDir = mkdtempSync(join(tmpdir(), "nemoclaw-googlechat-proxy-"));
    cleanupDirs.add(pidDir);
    const proxyPort = await startGooglechatWebhookProxy(pidDir, upstreamPort);

    const response = await fetch(`http://127.0.0.1:${String(proxyPort)}/googlechat`, {
      method: "POST",
      headers: {
        forwarded: "for=203.0.113.10;proto=https",
        "x-forwarded-for": "203.0.113.10",
        "x-forwarded-host": "attacker.example",
        "x-forwarded-proto": "https",
        "x-real-ip": "203.0.113.10",
      },
      body: "{}",
    });

    expect(response.status).toBe(202);
    expect(forwardedHeaders.forwarded).toBeUndefined();
    expect(forwardedHeaders["x-forwarded-for"]).toBeUndefined();
    expect(forwardedHeaders["x-forwarded-host"]).toBeUndefined();
    expect(forwardedHeaders["x-forwarded-proto"]).toBeUndefined();
    expect(forwardedHeaders["x-real-ip"]).toBeUndefined();
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(response.headers.has("server")).toBe(false);
    expect(response.headers.has("x-debug-token")).toBe(false);
  });
});
