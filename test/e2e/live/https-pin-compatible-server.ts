// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  closeServer,
  writeJsonResponse as jsonResponse,
  listenServer as listenOnRandomPort,
  readRequestBody,
} from "../fixtures/http-protocol.ts";
import type { StartedHttpServer } from "./mcp-bridge-servers.ts";

export interface FakeHttpsCompatibleRequest {
  readonly method: string;
  readonly path: string;
  readonly hostHeader?: string;
  readonly auth: "ok" | "missing" | "invalid";
  readonly body: string;
}

export interface FakeHttpsCompatibleServer extends StartedHttpServer {
  requests(): readonly FakeHttpsCompatibleRequest[];
}

function requireTcpPort(server: https.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("fake HTTPS compatible endpoint did not bind to a TCP port");
  }
  return address.port;
}

function generateEphemeralTlsMaterial(): { dir: string; cert: Buffer; key: Buffer } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-https-pin-tls-"));
  const keyPath = path.join(dir, "server.key");
  const certPath = path.join(dir, "server.crt");
  // Only the loopback hop from cloudflared to this process consumes this
  // certificate, and the quick tunnel is launched with --no-tls-verify for
  // that local origin (test/e2e/setup-mcp-test-tls.sh documents the identical
  // rationale for the MCP HTTPS fixture). A self-signed leaf with no separate
  // CA is sufficient; the sandbox only ever sees the public tunnel origin and
  // its real, publicly trusted trycloudflare.com certificate.
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
      "/CN=nemoclaw-https-pin-e2e",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { stdio: "ignore" },
  );
  return { dir, cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

/**
 * A minimal OpenAI-compatible HTTPS endpoint for proving the HTTPS-pin
 * runtime adapter's live routing (#6141): authenticated `/v1/models` and
 * `/v1/chat/completions`, plus a request ledger so the test can assert on
 * exactly what the pinned adapter forwarded (Host header, credential,
 * method/path) once this server sits behind a real public tunnel.
 */
export async function startFakeHttpsCompatibleServer(options: {
  apiKey: string;
  model: string;
  chatContent?: string;
}): Promise<FakeHttpsCompatibleServer> {
  const tls = generateEphemeralTlsMaterial();
  const requests: FakeHttpsCompatibleRequest[] = [];
  const chatContent = options.chatContent ?? "ok";

  const server = https.createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "https://https-pin.local").pathname;
    const body = req.method === "HEAD" ? "" : await readRequestBody(req);
    const authHeader = req.headers.authorization ?? "";
    const auth: FakeHttpsCompatibleRequest["auth"] =
      authHeader === `Bearer ${options.apiKey}` ? "ok" : authHeader ? "invalid" : "missing";

    // The public quick-tunnel readiness probe issues an unauthenticated HEAD
    // request. Keep it out of the request ledger so offset-based assertions
    // in the test only ever measure real chat-completion traffic.
    if (req.method !== "HEAD") {
      requests.push({
        method: req.method ?? "",
        path: requestPath,
        hostHeader: req.headers.host,
        auth,
        body,
      });
    }

    if (auth !== "ok") {
      jsonResponse(res, 401, { error: { message: "missing bearer credential" } });
      return;
    }
    if (
      ["GET", "HEAD"].includes(req.method ?? "") &&
      ["/models", "/v1/models"].includes(requestPath)
    ) {
      jsonResponse(res, 200, { object: "list", data: [{ id: options.model, object: "model" }] });
      return;
    }
    if (
      req.method === "POST" &&
      ["/chat/completions", "/v1/chat/completions"].includes(requestPath)
    ) {
      jsonResponse(res, 200, {
        id: "chatcmpl-https-pin",
        object: "chat.completion",
        created: 0,
        model: options.model,
        choices: [
          { index: 0, message: { role: "assistant", content: chatContent }, finish_reason: "stop" },
        ],
      });
      return;
    }
    jsonResponse(res, 404, { error: { message: "not found" } });
  });

  await listenOnRandomPort(server);
  return {
    port: requireTcpPort(server),
    requests: () => requests,
    close: async () => {
      await closeServer(server);
      fs.rmSync(tls.dir, { recursive: true, force: true });
    },
  };
}
