// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createOpenRouterRuntimeAdapterServer } from "./openrouter-runtime-adapter";

type CapturedRequest = {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
};

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  servers.length = 0;
});

function listen(server: http.Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("expected TCP address");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function createFakeOpenRouter() {
  const captured: CapturedRequest[] = [];
  const server = http.createServer(async (req, res) => {
    captured.push({
      method: req.method || "",
      path: req.url || "",
      headers: req.headers,
      body: await readRequestBody(req),
    });
    res.writeHead(200, { "Content-Type": "application/json", "X-Upstream": "openrouter" });
    res.end(JSON.stringify({ ok: true }));
  });
  const baseUrl = await listen(server);
  return { baseUrl, captured };
}

describe("OpenRouter Runtime adapter", () => {
  it("preserves OpenShell auth and adds OpenRouter attribution headers", async () => {
    const upstream = await createFakeOpenRouter();
    const adapter = createOpenRouterRuntimeAdapterServer({
      upstreamBaseUrl: `${upstream.baseUrl}/api/v1`,
    });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/v1/chat/completions?debug=1`, {
      method: "POST",
      headers: {
        Authorization: "Bearer sk-or-test",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://example.invalid/",
        "X-OpenRouter-Title": "wrong title",
        "X-Api-Key": "must-not-forward",
      },
      body: JSON.stringify({
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(upstream.captured).toHaveLength(1);
    const request = upstream.captured[0];
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/api/v1/chat/completions?debug=1");
    expect(request.headers.authorization).toBe("Bearer sk-or-test");
    expect(request.headers["http-referer"]).toBe("https://www.nvidia.com/nemoclaw/");
    expect(request.headers["x-openrouter-title"]).toBe("NVIDIA NemoClaw");
    expect(request.headers["x-api-key"]).toBeUndefined();
    expect(JSON.parse(request.body)).toMatchObject({ model: "moonshotai/kimi-k2.6" });
  });

  it("rejects requests that do not carry OpenShell-injected Authorization", async () => {
    const upstream = await createFakeOpenRouter();
    const adapter = createOpenRouterRuntimeAdapterServer({
      upstreamBaseUrl: `${upstream.baseUrl}/v1`,
    });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "openrouter/auto", messages: [] }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      error: { code: "unauthorized" },
    });
    expect(upstream.captured).toEqual([]);
  });

  it("forwards the OpenAI-compatible models endpoint without a duplicate credential", async () => {
    const upstream = await createFakeOpenRouter();
    const adapter = createOpenRouterRuntimeAdapterServer({
      upstreamBaseUrl: `${upstream.baseUrl}/v1`,
    });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: { Authorization: "Bearer sk-or-test" },
    });

    expect(response.status).toBe(200);
    expect(upstream.captured).toHaveLength(1);
    expect(upstream.captured[0]).toMatchObject({
      method: "GET",
      path: "/v1/models",
    });
    expect(upstream.captured[0].headers.authorization).toBe("Bearer sk-or-test");
    expect(upstream.captured[0].headers["http-referer"]).toBe("https://www.nvidia.com/nemoclaw/");
  });

  it("keeps health output free of credential material", async () => {
    const adapter = createOpenRouterRuntimeAdapterServer();
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/health`);

    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("openrouter-runtime-adapter");
    expect(text).not.toContain("OPENROUTER_API_KEY");
    expect(text).not.toContain("sk-or-test");
    expect(text).not.toContain("Authorization");
  });
});
