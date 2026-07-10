// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { OPENROUTER_DEFAULT_HEADERS } from "./openrouter";
import {
  adapterAuthorizationHash,
  createOpenRouterRuntimeAdapterServer,
} from "./openrouter-runtime-adapter";
import { OPENROUTER_RUNTIME_ADAPTER_MAX_BODY_BYTES } from "./openrouter-runtime-adapter-forward";

const servers: http.Server[] = [];
const OPENROUTER_TEST_TOKEN = "sk-or-test";
const OPENROUTER_TEST_AUTHORIZATION_HASH = adapterAuthorizationHash(OPENROUTER_TEST_TOKEN);

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
      expect(address).toEqual(expect.objectContaining({ address: "127.0.0.1" }));
      resolve(`http://127.0.0.1:${(address as AddressInfo).port}`);
    });
  });
}

function createTestAdapter(
  options: Parameters<typeof createOpenRouterRuntimeAdapterServer>[0] = {},
): http.Server {
  return createOpenRouterRuntimeAdapterServer({
    authorizationHash: OPENROUTER_TEST_AUTHORIZATION_HASH,
    ...options,
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

describe("OpenRouter Runtime adapter", () => {
  it("forwards chat completions with OpenRouter attribution headers (#5826)", async () => {
    const upstreamRequests: Array<{
      method: string | undefined;
      url: string | undefined;
      headers: http.IncomingHttpHeaders;
      body: string;
    }> = [];
    const upstream = http.createServer(async (req, res) => {
      upstreamRequests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: await readRequestBody(req),
      });
      res.writeHead(200, {
        "Content-Type": "application/json",
        "X-Upstream-Trace": "ok",
      });
      res.end(JSON.stringify({ id: "chatcmpl-test", choices: [] }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const adapter = createTestAdapter({
      upstreamBaseUrl: `${upstreamBaseUrl}/api/v1`,
    });
    const adapterBaseUrl = await listen(adapter);
    const payload = JSON.stringify({
      model: "moonshotai/kimi-k2.6",
      messages: [{ role: "user", content: "hello" }],
    });

    const response = await fetch(`${adapterBaseUrl}/v1/chat/completions?trace=1`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_TEST_TOKEN}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://example.invalid/",
        "X-OpenRouter-Title": "Wrong Title",
      },
      body: payload,
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-trace")).toBe("ok");
    await expect(response.json()).resolves.toMatchObject({ id: "chatcmpl-test" });
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/chat/completions?trace=1",
      body: payload,
    });
    expect(upstreamRequests[0].headers.authorization).toBe(`Bearer ${OPENROUTER_TEST_TOKEN}`);
    expect(upstreamRequests[0].headers["http-referer"]).toBe(OPENROUTER_DEFAULT_HEADERS[0][1]);
    expect(upstreamRequests[0].headers["x-openrouter-title"]).toBe(
      OPENROUTER_DEFAULT_HEADERS[1][1],
    );
  });

  it("requires bearer auth for runtime paths and exposes safe health (#5826)", async () => {
    const upstreamHandler = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) =>
      res.end("unexpected"),
    );
    const upstream = http.createServer(upstreamHandler);
    const upstreamBaseUrl = await listen(upstream);
    const adapter = createTestAdapter({
      upstreamBaseUrl: `${upstreamBaseUrl}/api/v1`,
    });
    const adapterBaseUrl = await listen(adapter);

    const health = await fetch(`${adapterBaseUrl}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as Record<string, unknown>;
    expect(healthBody).toMatchObject({
      ok: true,
      adapter: "openrouter-runtime",
      authorizationHash: OPENROUTER_TEST_AUTHORIZATION_HASH,
      headerNames: ["HTTP-Referer", "X-OpenRouter-Title"],
    });
    expect(JSON.stringify(healthBody)).not.toContain(OPENROUTER_TEST_TOKEN);

    const missingAuth = await fetch(`${adapterBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await fetch(`${adapterBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: "Bearer sk-or-other", "Content-Type": "application/json" },
      body: "{}",
    });
    expect(wrongAuth.status).toBe(401);

    const unsupported = await fetch(`${adapterBaseUrl}/v1/models`, {
      headers: { Authorization: `Bearer ${OPENROUTER_TEST_TOKEN}` },
    });
    expect(unsupported.status).toBe(404);
    expect(upstreamHandler).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before reaching upstream (#5826)", async () => {
    const upstreamHandler = vi.fn((_req: http.IncomingMessage, res: http.ServerResponse) =>
      res.end("unexpected"),
    );
    const upstream = http.createServer(upstreamHandler);
    const upstreamBaseUrl = await listen(upstream);
    const adapter = createTestAdapter({
      upstreamBaseUrl: `${upstreamBaseUrl}/api/v1`,
    });
    const adapterBaseUrl = await listen(adapter);

    const response = await fetch(`${adapterBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: "x".repeat(OPENROUTER_RUNTIME_ADAPTER_MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "request_too_large" },
    });
    expect(upstreamHandler).not.toHaveBeenCalled();
  });

  it("returns a generic error when upstream connection details fail (#5826)", async () => {
    const adapter = createTestAdapter({
      upstreamBaseUrl: "http://127.0.0.1:1/api/v1",
      upstreamTimeoutMs: 100,
    });
    const adapterBaseUrl = await listen(adapter);

    const response = await fetch(`${adapterBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages: [] }),
    });

    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { message: string; code: string } };
    expect(body.error).toMatchObject({
      message: "OpenRouter request failed.",
      code: "openrouter_runtime_error",
    });
    expect(JSON.stringify(body)).not.toContain("127.0.0.1");
    expect(JSON.stringify(body)).not.toContain("ECONNREFUSED");
  });

  it("times out stalled upstream requests without hanging (#5826)", async () => {
    const upstream = http.createServer(async (req, res) => {
      await readRequestBody(req);
      req.on("close", () => res.destroy());
    });
    const upstreamBaseUrl = await listen(upstream);
    const adapter = createTestAdapter({
      upstreamBaseUrl: `${upstreamBaseUrl}/api/v1`,
      upstreamTimeoutMs: 25,
    });
    const adapterBaseUrl = await listen(adapter);

    const response = await fetch(`${adapterBaseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENROUTER_TEST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages: [] }),
    });

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "upstream_timeout" },
    });
  });

  it("handles upstream mid-response aborts without crashing (#5826)", async () => {
    const upstream = http.createServer(async (req, res) => {
      await readRequestBody(req);
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": "1024" });
      res.write('{"partial":');
      setImmediate(() => res.socket?.destroy());
    });
    const upstreamBaseUrl = await listen(upstream);
    const adapter = createTestAdapter({
      upstreamBaseUrl: `${upstreamBaseUrl}/api/v1`,
      upstreamTimeoutMs: 100,
    });
    const adapterBaseUrl = await listen(adapter);

    await expect(
      fetch(`${adapterBaseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${OPENROUTER_TEST_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "moonshotai/kimi-k2.6", messages: [] }),
      }).then((response) => response.text()),
    ).rejects.toThrow();

    await expect(fetch(`${adapterBaseUrl}/health`)).resolves.toMatchObject({ status: 200 });
  });
});
