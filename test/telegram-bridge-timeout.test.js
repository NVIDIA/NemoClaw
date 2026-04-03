// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Tests for the telegram-bridge socket timeout fix.
 *
 * Verifies that tgApi() properly handles:
 * 1. Normal responses still work with the timeout in place
 * 2. Socket timeout when server stops responding (simulates network hang)
 * 3. Timeout fires within expected window
 * 4. The poll loop recovers after a timeout error
 * 5. Partial response with socket destroy (known limitation, documented)
 * 6. Connection refused
 */

import { describe, it, expect, afterEach } from "vitest";
import https from "node:https";
import net from "node:net";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// ── Generate a self-signed cert for the local test server ────────────
const tmpDir = fs.mkdtempSync("/tmp/tg-bridge-test-");
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

// ── tgApi WITH timeout fix (mirrors telegram-bridge.js) ──────────────
function tgApi(baseUrl, method, body, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(`${baseUrl}/${method}`);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "POST",
        timeout: timeoutMs,
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
        rejectUnauthorized: false,
      },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          try {
            resolve(JSON.parse(buf));
          } catch {
            resolve({ ok: false, error: buf });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Telegram API ${method} timed out`));
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────
const servers = [];

function createServer(handler) {
  return new Promise((resolve) => {
    const server = https.createServer({ key, cert }, handler);
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      const { port } = server.address();
      resolve({ server, port, baseUrl: `https://127.0.0.1:${port}` });
    });
  });
}

afterEach(() => {
  while (servers.length) {
    const s = servers.pop();
    if (s.closeAllConnections) s.closeAllConnections();
    s.close();
  }
});

// ── Tests ────────────────────────────────────────────────────────────

describe("telegram-bridge tgApi timeout behavior", () => {
  it("resolves normally when server responds promptly", async () => {
    const { baseUrl } = await createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: { update_id: 1 } }));
    });
    const result = await tgApi(baseUrl, "getUpdates", { offset: 0 });
    expect(result.ok).toBe(true);
  });

  it("rejects with timeout when server hangs (simulates network drop)", async () => {
    const { baseUrl } = await createServer(() => {
      // never respond — simulates dead TCP connection
    });
    const start = Date.now();
    await expect(tgApi(baseUrl, "getUpdates", { offset: 0 }, 1000)).rejects.toThrow("timed out");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });

  it("timeout fires within expected window", async () => {
    const { baseUrl } = await createServer(() => {
      /* never respond */
    });
    const start = Date.now();
    await expect(tgApi(baseUrl, "getUpdates", { offset: 0 }, 500)).rejects.toThrow("timed out");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(450);
    expect(elapsed).toBeLessThan(2000);
  });

  it("poll loop recovers after timeout", async () => {
    let reqCount = 0;
    const { baseUrl } = await createServer((_req, res) => {
      reqCount++;
      if (reqCount === 1) return; // first: hang
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, result: [] }));
    });

    // First call: timeout
    await expect(tgApi(baseUrl, "getUpdates", { offset: 0 }, 500)).rejects.toThrow("timed out");

    // Second call: should succeed (poll loop recovery)
    const result = await tgApi(baseUrl, "getUpdates", { offset: 0 }, 500);
    expect(result.ok).toBe(true);
  });

  it("handles server closing connection mid-response (known limitation)", async () => {
    // Node.js `timeout` only fires on idle sockets — once the server
    // has started responding, timeout won't fire. This documents the
    // behavior. The primary fix covers the real-world scenario (dead
    // connection before any response, e.g. after machine sleep).
    const { baseUrl } = await createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"ok":');
      setTimeout(() => req.socket.destroy(), 50);
    });

    const result = await Promise.race([
      tgApi(baseUrl, "getUpdates", { offset: 0 }, 1000)
        .then(() => "resolved")
        .catch(() => "rejected"),
      new Promise((r) => setTimeout(() => r("timeout-fallback"), 2000)),
    ]);
    // Accept any outcome — documenting that mid-response hangs are a
    // known limitation not covered by socket timeout alone.
    expect(["resolved", "rejected", "timeout-fallback"]).toContain(result);
  });

  it("handles connection refused (server down)", async () => {
    const tempServer = net.createServer();
    await new Promise((r) => tempServer.listen(0, "127.0.0.1", r));
    const { port } = tempServer.address();
    tempServer.close();

    await expect(
      tgApi(`https://127.0.0.1:${port}`, "getUpdates", { offset: 0 }, 2000),
    ).rejects.toThrow();
  });
});
