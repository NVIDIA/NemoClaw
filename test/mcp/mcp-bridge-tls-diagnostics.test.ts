// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, expect, it, vi } from "vitest";
import { startFakeMcpHttpsServer } from "../e2e/live/mcp-bridge-servers";

const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-mcp-tls-diagnostics-"));
execFileSync(
  "openssl",
  [
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-sha256",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=127.0.0.1",
    "-addext",
    "subjectAltName=IP:127.0.0.1",
    "-keyout",
    path.join(tlsDir, "server.key"),
    "-out",
    path.join(tlsDir, "server.crt"),
  ],
  { stdio: "ignore" },
);
const tls = {
  cert: fs.readFileSync(path.join(tlsDir, "server.crt")),
  key: fs.readFileSync(path.join(tlsDir, "server.key")),
};
afterAll(() => fs.rmSync(tlsDir, { recursive: true, force: true }));

it.each([0, 7, 8])("bounds TLS diagnostics with %s existing failures", async (retained) => {
  const secret = "tls-fixture-secret";
  const server = await startFakeMcpHttpsServer({ secret, tls });
  server.tlsFailures.push(...Array<string>(retained).fill("OTHER"));
  try {
    await new Promise<void>((resolve) => {
      https.get(`https://127.0.0.1:${server.port}/mcp`, { ca: [] }).on("error", () => resolve());
    });
  } finally {
    // Closing waits for the rejected connection and its server-side TLS event.
    await server.close();
  }
  await vi.waitFor(() => expect(server.tlsFailures).toHaveLength(Math.min(retained + 1, 8)));
  expect(server.requests).toEqual([]);
  expect(
    server.tlsFailures.every((code) =>
      ["ECONNRESET", "ERR_SSL_TLSV1_ALERT_UNKNOWN_CA", "OTHER"].includes(code),
    ),
  ).toBe(true);
  expect(JSON.stringify(server.tlsFailures)).not.toContain(secret);
});
