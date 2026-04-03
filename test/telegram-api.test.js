// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for bin/lib/telegram-api.js — the shared Telegram API client.
 *
 * Uses local TLS servers to simulate Telegram API behavior without
 * hitting the real API. Verifies socket timeout, recovery, and error
 * handling using the actual production tgApi function.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(import.meta.url);
const { tgApi } = require("../bin/lib/telegram-api");

// ── Self-signed cert for local test servers ──────────────────────────
const tmpDir = fs.mkdtempSync("/tmp/tg-api-test-");
const keyPath = path.join(tmpDir, "key.pem");
const certPath = path.join(tmpDir, "cert.pem");
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-keyout",
    keyPath,
    "-out",
    certPath,
    "-days",
    "1",
    "-nodes",
    "-subj",
    "/CN=localhost",
  ],
  { stdio: "ignore" },
);
const key = fs.readFileSync(keyPath);
const cert = fs.readFileSync(certPath);
fs.rmSync(tmpDir, { recursive: true });

// ── Helpers ──────────────────────────────────────────────────────────
const servers = [];

function createServer(handler) {
  return new Promise((resolve) => {
    const server = https.createServer({ key, cert }, handler);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const { port } = server.address();
      resolve({ server, port });
    });
  });
}

/** Build opts that point tgApi at a local test server. */
function localOpts(port, timeoutMs = 2000) {
  return { hostname: "127.0.0.1", port, timeout: timeoutMs, rejectUnauthorized: false };
}

afterEach(async () => {
  const toClose = servers.splice(0, servers.length);
  await Promise.all(
    toClose.map(
      (s) =>
        new Promise((resolve) => {
          if (s.closeAllConnections) s.closeAllConnections();
          s.close(() => resolve());
        }),
    ),
  );
});

// ── Tests ────────────────────────────────────────────────────────────

describe("tgApi (bin/lib/telegram-api)", () => {
  it("resolves normally when server responds promptly", async () => {
    const { port } = await createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { update_id: 1 } }));
    });

    const result = await tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port));
    expect(result.ok).toBe(true);
  });

  it("rejects with timeout when server hangs (simulates network drop)", async () => {
    const { port } = await createServer(() => {
      // never respond — simulates dead TCP connection
    });

    const start = Date.now();
    await expect(
      tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port, 1000)),
    ).rejects.toThrow("timed out");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it("timeout fires within expected window", async () => {
    const { port } = await createServer(() => {
      /* never respond */
    });

    const start = Date.now();
    await expect(
      tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port, 500)),
    ).rejects.toThrow("timed out");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);
  });

  it("poll loop recovers after timeout", async () => {
    let reqCount = 0;
    const { port } = await createServer((_req, res) => {
      reqCount++;
      if (reqCount === 1) return; // first: hang
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: [] }));
    });

    // First call: timeout
    await expect(
      tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port, 500)),
    ).rejects.toThrow("timed out");

    // Second call: should succeed (poll loop recovery)
    const result = await tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port, 500));
    expect(result.ok).toBe(true);
  });

  it("rejects when server closes connection mid-response", async () => {
    const { port } = await createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":');
      setTimeout(() => req.socket.destroy(), 50);
    });

    // With res.on("aborted") and res.on("error") handlers, a
    // mid-response socket destroy now rejects instead of hanging.
    const result = await Promise.race([
      tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port, 2000))
        .then(() => "resolved")
        .catch(() => "rejected"),
      new Promise((r) => setTimeout(() => r("hung"), 3000)),
    ]);
    expect(result).not.toBe("hung");
  });

  it("handles connection refused (server down)", async () => {
    const tempServer = net.createServer();
    await new Promise((r) => tempServer.listen(0, "127.0.0.1", r));
    const { port } = tempServer.address();
    await new Promise((resolve, reject) =>
      tempServer.close((err) => (err ? reject(err) : resolve())),
    );

    await expect(
      tgApi("fake-token", "getUpdates", { offset: 0 }, localOpts(port, 2000)),
    ).rejects.toThrow();
  });
});
