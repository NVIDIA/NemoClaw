// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { startFakeMcpHttpsServer } from "../e2e/live/mcp-bridge-servers";

it("records a TLS rejection before any MCP request without application credentials", async () => {
  const directory = mkdtempSync(join(tmpdir(), "mcp-tls-diagnostic-"));
  try {
    const cert = join(directory, "server.crt");
    const key = join(directory, "server.key");
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
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    const server = await startFakeMcpHttpsServer({
      secret: "private-fixture-secret",
      tls: { cert: readFileSync(cert), key: readFileSync(key) },
    });
    try {
      const error = await new Promise<Error>((resolve, reject) => {
        const request = https.get(`https://127.0.0.1:${server.port}/mcp`, (response) => {
          response.resume();
          reject(new Error("untrusted fixture certificate unexpectedly accepted"));
        });
        request.on("error", resolve);
      });
      expect(error.message).toContain("self-signed");
      await vi.waitFor(() => expect(server.tlsFailures).toHaveLength(1));
      expect(server.requests).toEqual([]);
      expect(JSON.stringify(server.tlsFailures)).not.toContain("private-fixture-secret");
    } finally {
      await server.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
