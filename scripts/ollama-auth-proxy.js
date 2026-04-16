#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Authenticated reverse proxy for Ollama.
 *
 * Ollama has no built-in authentication. This proxy sits in front of it,
 * validating a Bearer token before forwarding requests. Ollama binds to
 * 127.0.0.1 (localhost only) while the proxy listens on 0.0.0.0 so the
 * OpenShell gateway (running in a container) can reach it.
 *
 * Env:
 *   OLLAMA_PROXY_TOKEN  — required, the Bearer token to validate
 *   OLLAMA_PROXY_PORT   — listen port (default: 11435)
 *   OLLAMA_BACKEND_PORT — Ollama port on localhost (default: 11434)
 */

const crypto = require("crypto");
const http = require("http");

const TOKEN = process.env.OLLAMA_PROXY_TOKEN;
if (!TOKEN) {
  console.error("OLLAMA_PROXY_TOKEN required");
  process.exit(1);
}

const LISTEN_PORT = parseInt(process.env.OLLAMA_PROXY_PORT || "11435", 10);
const BACKEND_PORT = parseInt(process.env.OLLAMA_BACKEND_PORT || "11434", 10);

const server = http.createServer((clientReq, clientRes) => {
  const auth = clientReq.headers.authorization;
  // Allow unauthenticated health checks (model list only, not inference)
  const isHealthCheck = clientReq.method === "GET" && clientReq.url === "/api/tags";
  const expected = `Bearer ${TOKEN}`;
  const tokenMatch =
    auth &&
    auth.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
  if (!isHealthCheck && !tokenMatch) {
    clientRes.writeHead(401, { "Content-Type": "text/plain" });
    clientRes.end("Unauthorized");
    return;
  }

  // Strip the auth header before forwarding to Ollama
  const headers = { ...clientReq.headers };
  delete headers.authorization;
  delete headers.host;

  const proxyReq = http.request(
    {
      hostname: "127.0.0.1",
      port: BACKEND_PORT,
      path: clientReq.url,
      method: clientReq.method,
      headers,
    },
    (proxyRes) => {
      clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(clientRes);
    },
  );

  proxyReq.on("error", (err) => {
    clientRes.writeHead(502, { "Content-Type": "text/plain" });
    clientRes.end(`Ollama backend error: ${err.message}`);
  });

  clientReq.pipe(proxyReq);
});

server.listen(LISTEN_PORT, "0.0.0.0", () => {
  console.log(`Ollama auth proxy listening on 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${BACKEND_PORT}`);
});
