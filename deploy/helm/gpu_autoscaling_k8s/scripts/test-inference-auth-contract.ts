#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.resolve(scriptDir, "../files/metrics-proxy-server.ts");
const loadGeneratorPath = path.resolve(scriptDir, "../files/load-generator.ts");
const model = "test-model:1";
const apiKey = "test-only-inference-key";
let observedModel = "";

const unauthenticatedLoadGenerator = spawn(process.execPath, [loadGeneratorPath], {
  env: { ...process.env, INFERENCE_API_KEY: "" },
  stdio: ["ignore", "ignore", "pipe"],
});
let loadGeneratorStderr = "";
unauthenticatedLoadGenerator.stderr.on("data", (chunk: Buffer) => {
  loadGeneratorStderr += chunk.toString();
});
const [loadGeneratorExit] = await once(unauthenticatedLoadGenerator, "exit");
assert.notEqual(loadGeneratorExit, 0);
assert.match(loadGeneratorStderr, /INFERENCE_API_KEY is required/u);

const backend = http.createServer((req, res) => {
  if (req.url === "/api/tags") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: model }] }));
    return;
  }
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      observedModel = JSON.parse(raw).model;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "test-completion", choices: [] }));
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

backend.listen(0, "127.0.0.1");
await once(backend, "listening");
const backendAddress = backend.address();
assert.equal(typeof backendAddress, "object");
assert.ok(backendAddress);
const backendPort = (backendAddress as AddressInfo).port;

const child = spawn(process.execPath, [serverPath], {
  env: {
    ...process.env,
    PORT: "0",
    INFERENCE_MODEL: model,
    INFERENCE_API_KEY: apiKey,
    INFERENCE_AUTH_REQUIRED: "true",
    INFERENCE_BASE_URL: `http://127.0.0.1:${backendPort}/v1`,
    INFERENCE_RUNTIME: "ollama",
    INFERENCE_RUNTIME_BASE_URL: `http://127.0.0.1:${backendPort}`,
  },
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk: Buffer) => {
  stderr += chunk.toString();
});

try {
  const listeningPort = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`metrics-proxy startup timeout: ${stderr}`)), 10_000);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`metrics-proxy exited before startup (${code}): ${stderr}`));
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const match = chunk.toString().match(/listening on :(\d+)/u);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
  });
  const baseUrl = `http://127.0.0.1:${listeningPort}`;
  const authHeaders = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };

  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  assert.equal((await fetch(`${baseUrl}/v1/models`)).status, 401);
  assert.equal(
    (await fetch(`${baseUrl}/v1/models`, { headers: { Authorization: "Bearer wrong" } })).status,
    401,
  );
  const modelsResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  assert.equal(modelsResponse.status, 200);
  assert.deepEqual(await modelsResponse.json(), {
    object: "list",
    data: [{ id: model, object: "model", created: 0, owned_by: "on-prem" }],
  });

  const headerKeyResponse = await fetch(`${baseUrl}/v1/models`, {
    headers: { "X-Api-Key": apiKey },
  });
  assert.equal(headerKeyResponse.status, 200);

  const unauthenticatedChat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "not-installed", messages: [] }),
  });
  assert.equal(unauthenticatedChat.status, 401);

  const chatResponse = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({ model: "not-installed", messages: [] }),
  });
  assert.equal(chatResponse.status, 200);
  assert.equal(observedModel, model);

  const nullBody = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: "null",
  });
  assert.equal(nullBody.status, 400);
  assert.equal(await nullBody.text(), "request body must be a JSON object\n");

  const arrayBody = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: "[]",
  });
  assert.equal(arrayBody.status, 400);
  assert.equal(await arrayBody.text(), "request body must be a JSON object\n");

  const invalidJson = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: authHeaders,
    body: "{",
  });
  assert.equal(invalidJson.status, 400);
  assert.equal(await invalidJson.text(), "invalid json\n");

  console.log(
    "OK: inference proxy and load generator require the API key and serve the configured model",
  );
} finally {
  child.kill("SIGTERM");
  backend.close();
  await Promise.allSettled([once(child, "exit"), once(backend, "close")]);
}
