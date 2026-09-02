// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EndpointDnsLookupFn } from "./endpoint-ssrf-preflight";
import {
  __test,
  createHttpsPinRuntimeAdapterServer,
  ensureHttpsPinRuntimeAdapter,
  revokeHttpsPinRuntimeAdapterRoute,
} from "./https-pin-runtime-adapter";

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
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

const TEST_CONTROL_TOKEN = "test-control-plane-token";
const TEST_ROUTE_GENERATION = "11111111111111111111111111111111";

function routeToken(routeId: string, generation = TEST_ROUTE_GENERATION): string {
  return __test.deriveRouteToken(TEST_CONTROL_TOKEN, routeId, generation);
}

function sendRawHttpMethod(
  baseUrl: string,
  method: string,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<number> {
  const url = new URL(baseUrl);
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(Number(url.port), url.hostname, () => {
      const serializedHeaders = Object.entries({
        Host: url.host,
        Connection: "close",
        ...headers,
      })
        .map(([name, value]) => `${name}: ${value}`)
        .join("\r\n");
      socket.write(`${method} ${requestPath} HTTP/1.1\r\n${serializedHeaders}\r\n\r\n`);
    });
    let response = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      response += chunk;
    });
    socket.on("end", () => {
      const match = response.match(/^HTTP\/1\.1 (\d{3})/u);
      match
        ? resolve(Number(match[1]))
        : reject(new Error(`Invalid raw HTTP response: ${response}`));
    });
    socket.on("error", reject);
  });
}

describe("createHttpsPinRuntimeAdapterServer health and auth (#6141)", () => {
  it("derives stable, distinct route tokens without exposing the control secret", () => {
    const routeAFirst = routeToken("route-a");
    const routeASecond = routeToken("route-a");
    const routeB = routeToken("route-b");
    const routeANextGeneration = routeToken("route-a", "22222222222222222222222222222222");

    expect(routeAFirst).toBe(routeASecond);
    expect(routeAFirst).not.toBe(routeB);
    expect(routeAFirst).not.toBe(routeANextGeneration);
    expect(routeAFirst).not.toBe(TEST_CONTROL_TOKEN);
    expect(routeAFirst).toMatch(/^[a-f0-9]{64}$/);
  });

  it("exposes safe health over loopback without leaking the token", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; routeCount: number; tokenHash?: string };
    expect(body).toMatchObject({ ok: true, routeCount: 0 });
    expect(body.tokenHash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(TEST_CONTROL_TOKEN);
  });

  it("proves control-plane identity with a fresh challenge without transmitting the token", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);
    const port = Number(new URL(baseUrl).port);

    await expect(
      __test.probeAdapterControlHealth({ controlToken: TEST_CONTROL_TOKEN, port }),
    ).resolves.toBe(true);
    await expect(
      __test.probeAdapterControlHealth({ controlToken: "wrong-control-token", port }),
    ).resolves.toBe(false);
  });

  it("binds adapter reuse proof to the inspected OpenShell source policy", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      allowedSourceCidrs: ["172.17.0.0/16"],
    });
    const baseUrl = await listen(adapter);
    const port = Number(new URL(baseUrl).port);

    await expect(
      __test.probeAdapterControlHealth({
        controlToken: TEST_CONTROL_TOKEN,
        expectedSourceCidrs: ["172.17.0.0/16"],
        port,
      }),
    ).resolves.toBe(true);
    await expect(
      __test.probeAdapterControlHealth({
        controlToken: TEST_CONTROL_TOKEN,
        expectedSourceCidrs: ["192.168.50.0/24"],
        port,
      }),
    ).resolves.toBe(false);
  });

  it.each([
    ["protocol version", { ...__test.CURRENT_ADAPTER_IDENTITY, protocolVersion: "stale-protocol" }],
    ["build id", { ...__test.CURRENT_ADAPTER_IDENTITY, buildId: "0".repeat(64) }],
  ])("rejects a token-authenticated adapter with a stale %s", async (_label, staleIdentity) => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      adapterIdentity: staleIdentity,
    });
    const baseUrl = await listen(adapter);
    const port = Number(new URL(baseUrl).port);

    // The stale process can still prove control-token possession for its own
    // identity, but the current build must not reuse it.
    await expect(
      __test.probeAdapterControlHealth({
        controlToken: TEST_CONTROL_TOKEN,
        expectedIdentity: staleIdentity,
        port,
      }),
    ).resolves.toBe(true);
    await expect(
      __test.findReusableAdapterControlToken(TEST_CONTROL_TOKEN, ["127.0.0.1/32"], (options) =>
        __test.probeAdapterControlHealth({ ...options, port }),
      ),
    ).resolves.toBeNull();
  });

  it("does not trust an impostor that replays the former public token hash", async () => {
    const seenRequests: Array<{ headers: http.IncomingHttpHeaders; url?: string }> = [];
    const oldPublicHash = crypto.createHash("sha256").update(TEST_CONTROL_TOKEN).digest("hex");
    const impostor = http.createServer((req, res) => {
      seenRequests.push({ headers: req.headers, url: req.url });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, tokenHash: oldPublicHash }));
    });
    const baseUrl = await listen(impostor);

    await expect(
      __test.probeAdapterControlHealth({
        controlToken: TEST_CONTROL_TOKEN,
        nonce: "a".repeat(64),
        port: Number(new URL(baseUrl).port),
      }),
    ).resolves.toBe(false);
    expect(seenRequests).toHaveLength(1);
    expect(seenRequests[0].url).toBe(`/control/health?nonce=${"a".repeat(64)}`);
    expect(seenRequests[0].headers.authorization).toBeUndefined();
    expect(JSON.stringify(seenRequests[0])).not.toContain(TEST_CONTROL_TOKEN);
  });

  it("applies an absolute control-probe deadline even when an impostor drips bytes", async () => {
    const impostor = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const interval = setInterval(() => res.write(" "), 10);
      res.once("close", () => clearInterval(interval));
    });
    const baseUrl = await listen(impostor);
    const started = Date.now();

    await expect(
      __test.probeAdapterControlHealth({
        controlToken: TEST_CONTROL_TOKEN,
        port: Number(new URL(baseUrl).port),
        timeoutMs: 60,
      }),
    ).resolves.toBe(false);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("rejects control-plane and route requests without a valid bearer token", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      initialRoutes: {
        anything: {
          targetBaseUrl: "https://real-upstream.example/v1",
          pinnedAddresses: ["93.184.216.34"],
          providerType: "openai",
          credentialValue: "sk-upstream",
          generation: TEST_ROUTE_GENERATION,
        },
      },
    });
    const baseUrl = await listen(adapter);

    const missingAuth = await fetch(`${baseUrl}/route/anything`);
    expect(missingAuth.status).toBe(401);

    const wrongAuth = await fetch(`${baseUrl}/route/anything`, {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(wrongAuth.status).toBe(401);

    const body = (await wrongAuth.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unauthorized");
  });

  it("returns 404 for an unknown path", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/nonexistent`, {
      headers: { Authorization: `Bearer ${TEST_CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("createHttpsPinRuntimeAdapterServer control plane (#6141)", () => {
  it("registers an HTTPS route via the authenticated control plane", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const putResponse = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetBaseUrl: "https://real-upstream.example/base",
        pinnedAddresses: ["93.184.216.34"],
        providerType: "openai",
        credentialValue: "sk-upstream-secret",
        generation: TEST_ROUTE_GENERATION,
      }),
    });
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toEqual({ ok: true, routeId: "route-1" });

    const health = await fetch(`${baseUrl}/health`);
    await expect(health.json()).resolves.toMatchObject({ routeCount: 1 });
  });

  it("uses the anthropic credential header shape for an anthropic route", async () => {
    const upstreamRequests: Array<{ headers: http.IncomingHttpHeaders }> = [];
    const upstream = http.createServer(async (req, res) => {
      upstreamRequests.push({ headers: req.headers });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const upstreamPort = new URL(upstreamBaseUrl).port;

    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      initialRoutes: {
        "route-anthropic": {
          targetBaseUrl: `http://real-upstream.example:${upstreamPort}/base`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "anthropic",
          credentialValue: "sk-ant-secret",
          generation: TEST_ROUTE_GENERATION,
        },
      },
    });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/route/route-anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": routeToken("route-anthropic"),
        "Content-Type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    expect(upstreamRequests[0].headers["x-api-key"]).toBe("sk-ant-secret");
    expect(upstreamRequests[0].headers.authorization).toBeUndefined();
  });

  it("rejects TRACE, TRACK, and CONNECT without sending injected credentials upstream", async () => {
    let upstreamRequests = 0;
    const upstream = http.createServer((_req, res) => {
      upstreamRequests += 1;
      res.writeHead(200);
      res.end();
    });
    const upstreamPort = new URL(await listen(upstream)).port;
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      initialRoutes: {
        guarded: {
          targetBaseUrl: `https://real-upstream.example:${upstreamPort}/v1`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "openai",
          credentialValue: "sk-must-not-be-echoed",
          generation: TEST_ROUTE_GENERATION,
        },
      },
    });
    const baseUrl = await listen(adapter);
    const headers = { Authorization: `Bearer ${routeToken("guarded")}` };

    await expect(
      sendRawHttpMethod(baseUrl, "TRACE", "/route/guarded/chat/completions", headers),
    ).resolves.toBe(405);
    const trackStatus = await sendRawHttpMethod(
      baseUrl,
      "TRACK",
      "/route/guarded/chat/completions",
      headers,
    );
    // Some Node builds reject TRACK in the HTTP parser with 400 before the
    // request handler's explicit 405 guard runs. Both outcomes fail closed.
    expect([400, 405]).toContain(trackStatus);
    await expect(
      sendRawHttpMethod(baseUrl, "CONNECT", "/route/guarded/chat/completions", headers),
    ).resolves.toBe(405);
    expect(upstreamRequests).toBe(0);
  });

  it("invalidates the prior data token when a revoked route id is registered again", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    const upstreamPort = new URL(await listen(upstream)).port;
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);
    const firstGeneration = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const secondGeneration = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const register = (generation: string) =>
      fetch(`${baseUrl}/control/routes/reused`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          targetBaseUrl: `https://real-upstream.example:${upstreamPort}/v1`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "openai",
          credentialValue: "sk-upstream",
          generation,
        }),
      });

    expect((await register(firstGeneration)).status).toBe(200);
    const firstToken = routeToken("reused", firstGeneration);
    expect(
      (
        await fetch(`${baseUrl}/route/reused/models`, {
          headers: { Authorization: `Bearer ${firstToken}` },
        })
      ).status,
    ).toBe(502);

    const revoked = await fetch(`${baseUrl}/control/routes/reused`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${TEST_CONTROL_TOKEN}` },
    });
    expect(revoked.status).toBe(200);
    expect((await register(secondGeneration)).status).toBe(200);

    const secondToken = routeToken("reused", secondGeneration);
    expect(secondToken).not.toBe(firstToken);
    expect(
      (
        await fetch(`${baseUrl}/route/reused/models`, {
          headers: { Authorization: `Bearer ${firstToken}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${baseUrl}/route/reused/models`, {
          headers: { Authorization: `Bearer ${secondToken}` },
        })
      ).status,
    ).toBe(502);
  });

  it("binds each sandbox credential to exactly one route and keeps the control token off data paths", async () => {
    const routeARequests: http.IncomingHttpHeaders[] = [];
    const routeBRequests: http.IncomingHttpHeaders[] = [];
    const routeAPaths: string[] = [];
    const routeBPaths: string[] = [];
    const adapterEvents: unknown[] = [];
    const upstreamA = http.createServer((req, res) => {
      routeARequests.push(req.headers);
      routeAPaths.push(req.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ route: "a" }));
    });
    const upstreamB = http.createServer((req, res) => {
      routeBRequests.push(req.headers);
      routeBPaths.push(req.url || "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ route: "b" }));
    });
    const upstreamAPort = new URL(await listen(upstreamA)).port;
    const upstreamBPort = new URL(await listen(upstreamB)).port;
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      logger: (event, fields) => adapterEvents.push({ event, fields }),
      initialRoutes: {
        "route-a": {
          targetBaseUrl: `http://real-upstream.example:${upstreamAPort}/base`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "openai",
          credentialValue: "sk-route-a",
          generation: TEST_ROUTE_GENERATION,
        },
        "route-b": {
          targetBaseUrl: `http://real-upstream.example:${upstreamBPort}/base`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "anthropic",
          credentialValue: "sk-route-b",
          generation: TEST_ROUTE_GENERATION,
        },
      },
    });
    const baseUrl = await listen(adapter);

    const tokenA = routeToken("route-a");
    const tokenB = routeToken("route-b");
    expect(tokenA).not.toBe(tokenB);
    expect(tokenA).not.toBe(TEST_CONTROL_TOKEN);

    const crossRouteReplay = await fetch(`${baseUrl}/route/route-b/chat/completions`, {
      headers: { "x-api-key": tokenA },
    });
    expect(crossRouteReplay.status).toBe(401);

    const controlTokenReplay = await fetch(`${baseUrl}/route/route-a/chat/completions`, {
      headers: { Authorization: `Bearer ${TEST_CONTROL_TOKEN}` },
    });
    expect(controlTokenReplay.status).toBe(401);
    const anthropicControlTokenReplay = await fetch(`${baseUrl}/route/route-b/messages`, {
      headers: { "x-api-key": TEST_CONTROL_TOKEN },
    });
    expect(anthropicControlTokenReplay.status).toBe(401);

    const openAiCrossHeader = await fetch(`${baseUrl}/route/route-a/chat/completions`, {
      headers: { "x-api-key": tokenA },
    });
    expect(openAiCrossHeader.status).toBe(401);
    const anthropicCrossHeader = await fetch(`${baseUrl}/route/route-b/messages`, {
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    expect(anthropicCrossHeader.status).toBe(401);

    const dataTokenOnControlPlane = await fetch(`${baseUrl}/control/routes/route-a`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${tokenA}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: `http://real-upstream.example:${upstreamAPort}/base`,
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-replay",
        generation: TEST_ROUTE_GENERATION,
      }),
    });
    expect(dataTokenOnControlPlane.status).toBe(401);
    expect(routeARequests).toHaveLength(0);
    expect(routeBRequests).toHaveLength(0);

    const validA = await fetch(`${baseUrl}/route/route-a/chat/completions`, {
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    const validB = await fetch(`${baseUrl}/route/route-b/messages`, {
      headers: { "x-api-key": tokenB },
    });
    expect(validA.status).toBe(200);
    expect(validB.status).toBe(200);
    expect(routeARequests[0].authorization).toBe("Bearer sk-route-a");
    expect(routeBRequests[0]["x-api-key"]).toBe("sk-route-b");
    expect(routeAPaths[0]).toBe("/base/chat/completions");
    expect(routeBPaths[0]).toBe("/base/messages");

    const logText = JSON.stringify(adapterEvents);
    expect(logText).not.toContain(TEST_CONTROL_TOKEN);
    expect(logText).not.toContain(tokenA);
    expect(logText).not.toContain(tokenB);
    expect(logText).not.toContain("sk-route-a");
    expect(logText).not.toContain("sk-route-b");
    expect(logText).not.toContain("real-upstream.example");
    expect(logText).not.toContain("/base");
  });

  it.each([
    "/route/scoped/v1/../admin",
    "/route/scoped/v1/%2e%2e/admin",
    "/route/scoped/v1/%2E%2e/admin",
    "/route/scoped/v1%2f..%2fadmin",
    "/route/scoped/v1%2F..%2Fadmin",
    "/route/scoped/v1/%252e%252e/admin",
    "/route/scoped/v1/%252E%252fadmin",
  ])("rejects raw or encoded traversal before joining the target base path: %s", (requestPath) => {
    expect(() =>
      __test.buildContainedForwardPath(
        {
          targetBaseUrl: "https://real-upstream.example/v1",
          pinnedAddresses: ["93.184.216.34"],
          providerType: "openai",
          credentialValue: "not-used",
          generation: TEST_ROUTE_GENERATION,
        },
        "/admin",
        "",
        requestPath,
      ),
    ).toThrow("Route path not found");
  });

  it.each([
    ["/", "/v1/chat/completions", "/v1/chat/completions"],
    ["/v1", "/chat/completions?trace=1", "/v1/chat/completions?trace=1"],
    ["/v1", "/v1/chat/completions", "/v1/chat/completions"],
    ["/gateway/v1", "/v1/chat/completions", "/gateway/v1/chat/completions"],
    ["/v1beta/openai", "/v1/chat/completions", "/v1beta/openai/chat/completions"],
    ["/tenant/v1/chat", "/v1/chat/completions", "/tenant/v1/chat/chat/completions"],
    ["/tenant/messages", "/messages", "/tenant/messages/messages"],
    ["/v1", "/admin", "/v1/admin"],
    ["/v1", "/v10/chat/completions", "/v1/v10/chat/completions"],
  ])("translates only the OpenAI gateway prefix when joining target base %s with suffix %s", async (targetPath, suffix, expectedPath) => {
    const upstreamPaths: string[] = [];
    const upstream = http.createServer((req, res) => {
      upstreamPaths.push(req.url || "");
      res.writeHead(200);
      res.end();
    });
    const upstreamPort = new URL(await listen(upstream)).port;
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      initialRoutes: {
        scoped: {
          targetBaseUrl: `http://real-upstream.example:${upstreamPort}${targetPath}`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "openai",
          credentialValue: "sk-scoped",
          generation: TEST_ROUTE_GENERATION,
        },
      },
    });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/route/scoped${suffix}`, {
      headers: { Authorization: `Bearer ${routeToken("scoped")}` },
    });

    expect(response.status).toBe(200);
    expect(upstreamPaths).toEqual([expectedPath]);
  });

  it("preserves the Anthropic v1 API suffix when joining its target base", () => {
    expect(
      __test.buildContainedForwardPath(
        {
          targetBaseUrl: "https://real-upstream.example/base",
          pinnedAddresses: ["93.184.216.34"],
          providerType: "anthropic",
          credentialValue: "not-used",
          generation: TEST_ROUTE_GENERATION,
        },
        "/v1/messages",
        "?trace=1",
        "/route/scoped/v1/messages?trace=1",
      ),
    ).toBe("/base/v1/messages?trace=1");
  });

  it("seeds routes from initialRoutes at construction, before any PUT", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const upstreamPort = new URL(upstreamBaseUrl).port;

    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      initialRoutes: {
        "bootstrap-route": {
          targetBaseUrl: `http://real-upstream.example:${upstreamPort}/base`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "openai",
          credentialValue: "sk-bootstrap",
          generation: TEST_ROUTE_GENERATION,
        },
      },
    });
    const baseUrl = await listen(adapter);

    const health = await fetch(`${baseUrl}/health`);
    await expect(health.json()).resolves.toMatchObject({ routeCount: 1 });

    const response = await fetch(`${baseUrl}/route/bootstrap-route/`, {
      headers: { Authorization: `Bearer ${routeToken("bootstrap-route")}` },
    });
    expect(response.status).toBe(200);
  });

  it("rejects PUT bodies missing required fields with 400 invalid_route", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ targetBaseUrl: "http://example.com/" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_route" } });
  });

  it("rejects PUT bodies with an unparseable targetBaseUrl with 400 invalid_route", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetBaseUrl: "not-a-url",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-secret",
        generation: TEST_ROUTE_GENERATION,
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_route" } });
  });

  it("rejects a cleartext HTTP target before storing its upstream credential", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetBaseUrl: "http://cleartext.example/v1",
        pinnedAddresses: ["93.184.216.34"],
        providerType: "openai",
        credentialValue: "sk-must-not-cross-cleartext",
        generation: TEST_ROUTE_GENERATION,
      }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_route" } });
  });

  it("rejects PUT bodies with an unsupported providerType with 400 invalid_route", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetBaseUrl: "http://example.com/",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "gemini",
        credentialValue: "sk-secret",
        generation: TEST_ROUTE_GENERATION,
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects oversized control-plane bodies with 413", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetBaseUrl: "http://example.com/",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "x".repeat(20 * 1024),
        generation: TEST_ROUTE_GENERATION,
      }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });

  it("returns 404 for a GET on the control-routes path (PUT only)", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      headers: { Authorization: `Bearer ${TEST_CONTROL_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 route_not_found for an unregistered route id", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/route/never-registered`, {
      headers: { Authorization: `Bearer ${routeToken("never-registered")}` },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "route_not_found" } });
  });
});

describe("createHttpsPinRuntimeAdapterServer orphaned route recovery (#6141)", () => {
  it("authenticates an orphan with its stable route token after a same-control-token respawn", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      orphanedRoutes: {
        "orphan-1": { providerType: "openai", generation: TEST_ROUTE_GENERATION },
      },
    });
    const baseUrl = await listen(adapter);

    const orphaned = await fetch(`${baseUrl}/route/orphan-1/v1/messages`, {
      headers: { Authorization: `Bearer ${routeToken("orphan-1")}` },
    });
    expect(orphaned.status).toBe(503);
    await expect(orphaned.json()).resolves.toMatchObject({
      error: { code: "route_needs_recovery" },
    });

    const neverKnown = await fetch(`${baseUrl}/route/never-known/v1/messages`, {
      headers: { Authorization: `Bearer ${routeToken("never-known")}` },
    });
    expect(neverKnown.status).toBe(404);
    await expect(neverKnown.json()).resolves.toMatchObject({ error: { code: "route_not_found" } });
  });

  it("prefers a live route over its own stale orphaned-route id once re-registered", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const upstreamPort = new URL(upstreamBaseUrl).port;

    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      orphanedRoutes: {
        "healed-route": { providerType: "openai", generation: TEST_ROUTE_GENERATION },
      },
    });
    const baseUrl = await listen(adapter);

    await fetch(`${baseUrl}/control/routes/healed-route`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        targetBaseUrl: `https://real-upstream.example:${upstreamPort}/base`,
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-healed",
        generation: TEST_ROUTE_GENERATION,
      }),
    });

    const response = await fetch(`${baseUrl}/route/healed-route/`, {
      headers: { Authorization: `Bearer ${routeToken("healed-route")}` },
    });
    expect(response.status).toBe(502);
  });
});

// Drives the server's request listener directly with a fake req/res instead
// of a real socket, so the simulated `remoteAddress` isn't at the mercy of
// how (or whether) a given host/CI sandbox routes secondary loopback
// addresses like 127.0.0.2 -- only the literal connection identity matters
// to `isLoopbackRemoteAddress`, not real network delivery.
function dispatchFakeRequest(
  server: http.Server,
  options: {
    method: string;
    url: string;
    remoteAddress: string;
    authorization?: string;
    body?: unknown;
  },
): Promise<{ status: number; body: unknown }> {
  const listener = server.listeners("request")[0] as (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => unknown;

  const req = new EventEmitter() as unknown as http.IncomingMessage;
  Object.assign(req, {
    method: options.method,
    url: options.url,
    headers: options.authorization ? { authorization: options.authorization } : {},
    socket: { remoteAddress: options.remoteAddress },
  });

  return new Promise((resolve) => {
    let status = 0;
    const res = {
      writeHead(code: number) {
        status = code;
      },
      end(payload?: string) {
        resolve({ status, body: payload ? JSON.parse(payload) : undefined });
      },
    } as unknown as http.ServerResponse;

    void listener(req, res);
    queueMicrotask(() => {
      const chunks = options.body === undefined ? [] : [Buffer.from(JSON.stringify(options.body))];
      for (const chunk of chunks) (req as unknown as EventEmitter).emit("data", chunk);
      (req as unknown as EventEmitter).emit("end");
    });
  });
}

describe("createHttpsPinRuntimeAdapterServer control-plane loopback restriction (#6141)", () => {
  it("rejects a route registration whose connection did not arrive over loopback", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });

    // The container-gateway address the sandbox actually connects from when
    // it reaches the adapter through `host.openshell.internal` -- distinct
    // from the literal 127.0.0.1 the host process itself always dials from.
    const response = await dispatchFakeRequest(adapter, {
      method: "PUT",
      url: "/control/routes/route-1",
      remoteAddress: "172.17.0.2",
      authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
      body: {
        targetBaseUrl: "http://internal.example/base",
        pinnedAddresses: ["10.0.0.5"],
        providerType: "openai",
        credentialValue: "sk-should-not-register",
        generation: TEST_ROUTE_GENERATION,
      },
    });
    expect(response.status).toBe(404);

    const health = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/health",
      remoteAddress: "172.17.0.2",
    });
    expect(health.status).toBe(404);
    expect(health.body).toMatchObject({ error: { code: "not_found" } });
  });

  it("still allows route registration over loopback", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });

    const response = await dispatchFakeRequest(adapter, {
      method: "PUT",
      url: "/control/routes/route-1",
      remoteAddress: "127.0.0.1",
      authorization: `Bearer ${TEST_CONTROL_TOKEN}`,
      body: {
        targetBaseUrl: "https://real-upstream.example/base",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-upstream-secret",
        generation: TEST_ROUTE_GENERATION,
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, routeId: "route-1" });
  });
});

describe("createHttpsPinRuntimeAdapterServer OpenShell bridge source restriction (#6141)", () => {
  // These drive the gate itself, so an unregistered route ID is enough: a
  // request that passes the private-network gate falls through to the
  // "route_not_found" lookup (which never pipes a real upstream response),
  // while a request blocked by the gate never reaches that lookup at all and
  // instead gets the gate's own "not_found" code.

  it("rejects a route-forward request whose connection arrives from a public address", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });

    // A peer that reached this 0.0.0.0-bound port from outside the intended
    // Docker-bridge sandbox boundary -- an address the adapter should never
    // trust a replayed bearer token from. 203.0.113.0/24 is the reserved
    // TEST-NET-3 documentation range (RFC 5737), never a real bridge subnet.
    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "203.0.113.5",
      authorization: `Bearer ${routeToken("never-registered")}`,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "not_found" } });
  });

  it("still passes a route-forward request from the Docker-bridge sandbox address through to route lookup", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      allowedSourceCidrs: ["172.17.0.0/16"],
    });

    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "172.17.0.2",
      authorization: `Bearer ${routeToken("never-registered")}`,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "route_not_found" } });
  });

  it("rejects a private peer outside the inspected OpenShell bridge subnet", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      allowedSourceCidrs: ["172.17.0.0/16"],
    });

    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "192.168.50.8",
      authorization: `Bearer ${routeToken("never-registered")}`,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "not_found" } });
  });

  it("hides health metadata from a private peer outside the inspected bridge subnet", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({
      controlToken: TEST_CONTROL_TOKEN,
      allowedSourceCidrs: ["172.17.0.0/16"],
    });

    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/health",
      remoteAddress: "192.168.50.8",
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "not_found" } });
    expect(response.body).not.toHaveProperty("routeCount");
  });

  it("still passes a route-forward request over loopback through to route lookup", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ controlToken: TEST_CONTROL_TOKEN });

    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "127.0.0.1",
      authorization: `Bearer ${routeToken("never-registered")}`,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "route_not_found" } });
  });
});

describe("adapter recovery lock (#6141)", () => {
  // The statically-imported `__test.LOCK_PATH` above is derived from this
  // machine's real os.homedir() at module-evaluation time, same as a real,
  // possibly-concurrently-running adapter's lock. Acquiring/deleting it here
  // could steal or wedge that live adapter's lock. Give each test its own
  // HOME (and therefore its own LOCK_PATH under a fresh temp `.nemoclaw`) via
  // vi.resetModules() plus a fresh dynamic import, since STATE_DIR is only
  // ever read once, at import time.
  let tempHome: string;
  let lockModule: typeof import("./https-pin-runtime-adapter");

  beforeEach(async () => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-adapter-lock-test-"));
    vi.stubEnv("HOME", tempHome);
    vi.resetModules();
    lockModule = await import("./https-pin-runtime-adapter");
  });

  afterEach(() => {
    try {
      fs.unlinkSync(lockModule.__test.LOCK_PATH);
    } catch {
      /* nothing to clean up */
    }
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("blocks a second acquire while the first holder has not released", () => {
    const release = lockModule.__test.tryAcquireAdapterLock();
    expect(release).not.toBeNull();
    expect(lockModule.__test.tryAcquireAdapterLock()).toBeNull();
    release?.();
    expect(lockModule.__test.tryAcquireAdapterLock()).not.toBeNull();
  });

  it("serializes concurrent withAdapterLock operations instead of interleaving them", async () => {
    const order: string[] = [];
    const slow = lockModule.__test.withAdapterLock(async () => {
      order.push("slow:start");
      await new Promise((resolve) => setTimeout(resolve, 50));
      order.push("slow:end");
    });
    // Give `slow` a head start so it wins the lock first.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const fast = lockModule.__test.withAdapterLock(async () => {
      order.push("fast:start");
      order.push("fast:end");
    });

    await Promise.all([slow, fast]);

    expect(order).toEqual(["slow:start", "slow:end", "fast:start", "fast:end"]);
  });

  it("reuses a token-authenticated live adapter without requiring PID metadata", async () => {
    const probeHealth = vi.fn(async () => true);

    await expect(
      lockModule.__test.findReusableAdapterControlToken(
        "persisted-control-token",
        ["127.0.0.1/32"],
        probeHealth,
      ),
    ).resolves.toBe("persisted-control-token");
    expect(probeHealth).toHaveBeenCalledWith({
      controlToken: "persisted-control-token",
      expectedIdentity: __test.CURRENT_ADAPTER_IDENTITY,
      expectedSourceCidrs: ["127.0.0.1/32"],
    });
  });

  it("deletes a route from an authenticated live adapter even when PID metadata is missing", async () => {
    const deleteRoute = vi.fn(async () => {});
    const removeRouteState = vi.fn();

    await expect(
      lockModule.__test.revokeRouteLocked("a".repeat(64), {
        loadPid: () => null,
        readControlToken: () => "persisted-control-token",
        readAllowedSourceCidrs: () => ["172.18.0.0/16"],
        probeHealth: async () => true,
        deleteRoute,
        isAdapterProcess: () => false,
        removeRouteState,
      }),
    ).resolves.toBe(true);
    expect(deleteRoute).toHaveBeenCalledWith("persisted-control-token", "a".repeat(64));
    expect(removeRouteState).toHaveBeenCalledWith("a".repeat(64));
    expect(deleteRoute.mock.invocationCallOrder[0]).toBeLessThan(
      removeRouteState.mock.invocationCallOrder[0],
    );
  });

  it("preserves persisted state when the authenticated route DELETE fails", async () => {
    const removeRouteState = vi.fn();

    await expect(
      lockModule.__test.revokeRouteLocked("a".repeat(64), {
        loadPid: () => null,
        readControlToken: () => "persisted-control-token",
        readAllowedSourceCidrs: () => ["172.18.0.0/16"],
        probeHealth: async () => true,
        deleteRoute: async () => {
          throw new Error("delete failed");
        },
        isAdapterProcess: () => false,
        removeRouteState,
      }),
    ).rejects.toThrow("delete failed");
    expect(removeRouteState).not.toHaveBeenCalled();
  });

  it("preserves both route metadata updates when registration transactions overlap", async () => {
    let persistedRoutes: Record<string, { providerType: "openai" | "anthropic" }> = {};
    const register = (routeId: string, providerType: "openai" | "anthropic", delayMs: number) =>
      lockModule.__test.withAdapterLock(async () => {
        const snapshot = { ...persistedRoutes };
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        persistedRoutes = { ...snapshot, [routeId]: { providerType } };
      });

    await Promise.all([register("route-a", "openai", 30), register("route-b", "anthropic", 0)]);

    expect(persistedRoutes).toEqual({
      "route-a": { providerType: "openai" },
      "route-b": { providerType: "anthropic" },
    });
  });

  it("persists only opaque recovery metadata without source URL, pins, or credentials", () => {
    const controlToken = "host-only-control-secret";
    const dataToken = lockModule.__test.deriveRouteToken(
      controlToken,
      "route-a",
      TEST_ROUTE_GENERATION,
    );
    const upstreamCredential = "real-upstream-secret";
    lockModule.__test.persistRouteState("route-a", {
      providerType: "openai",
      generation: TEST_ROUTE_GENERATION,
      registeredAt: "2026-07-18T00:00:00.000Z",
    });

    const stateText = fs.readFileSync(lockModule.__test.STATE_PATH, "utf8");
    expect(stateText).not.toContain(controlToken);
    expect(stateText).not.toContain(dataToken);
    expect(stateText).not.toContain(upstreamCredential);
    expect(stateText).not.toContain("public.example.test");
    expect(stateText).not.toContain("/v1");
    expect(stateText).not.toContain("93.184.216.34");
    expect(JSON.parse(stateText)).toMatchObject({
      routes: {
        "route-a": { providerType: "openai", generation: TEST_ROUTE_GENERATION },
      },
    });
  });

  it("waits for a terminated adapter PID to exit before allowing replacement spawn", async () => {
    const observations = [true, true, false];
    const isRunning = vi.fn(() => observations.shift() ?? false);
    const sleep = vi.fn(async () => {});

    await expect(
      lockModule.__test.waitForAdapterProcessExit(12345, {
        isRunning,
        sleep,
        attempts: 4,
        intervalMs: 25,
      }),
    ).resolves.toBe(true);
    expect(isRunning).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(25);
  });

  it("does not probe or sleep when the adapter exit attempt budget is zero (#9218)", async () => {
    const isRunning = vi.fn(() => true);
    const sleep = vi.fn(async () => {});

    await expect(
      lockModule.__test.waitForAdapterProcessExit(12345, {
        isRunning,
        sleep,
        attempts: 0,
        intervalMs: 25,
      }),
    ).resolves.toBe(false);
    expect(isRunning).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });


  it("refuses replacement when the old adapter never exits within the bounded wait", async () => {
    const sleep = vi.fn(async () => {});

    await expect(
      lockModule.__test.waitForAdapterProcessExit(12345, {
        isRunning: () => true,
        sleep,
        attempts: 3,
        intervalMs: 25,
      }),
    ).resolves.toBe(false);
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("revokeHttpsPinRuntimeAdapterRoute input validation (#6141)", () => {
  it("rejects malformed route ids before touching lifecycle state", async () => {
    await expect(revokeHttpsPinRuntimeAdapterRoute("../control/routes/other")).rejects.toThrow(
      "invalid HTTPS Pin Runtime route id",
    );
  });
});

describe("computeRespawnState orphaned-route bookkeeping (#6141)", () => {
  it("records the source limitation and removal condition for orphan recovery", () => {
    expect(__test.ORPHANED_ROUTE_RECOVERY_BOUNDARY).toEqual({
      whyNotSourceFix:
        "Durable recovery metadata intentionally omits the upstream URL, pinned addresses, and credential; only the owning inference set caller can supply all three.",
      removalCondition:
        "Retire orphaning/manual re-registration only when a reviewed secure recovery source or capability can rehydrate every registered route after respawn without persisting plaintext credentials, exposing them to OpenShell or a sandbox, or weakening per-route token and pinned-address isolation.",
    });
  });

  it("marks every persisted route except the one being bootstrapped as orphaned", () => {
    const priorRoutes = {
      a: {
        providerType: "openai",
        generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        registeredAt: "2026-07-18T00:00:00.000Z",
        targetBaseUrl: "http://a.example/secret-path",
        pinnedAddresses: ["10.0.0.1"],
      },
      b: {
        providerType: "openai",
        generation: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        registeredAt: "2026-07-18T00:00:00.000Z",
      },
      c: {
        providerType: "anthropic",
        generation: "cccccccccccccccccccccccccccccccc",
        registeredAt: "2026-07-18T00:00:00.000Z",
      },
    };

    const { orphanedRoutes, persistedRoutes } = __test.computeRespawnState(priorRoutes, "b");

    expect(orphanedRoutes).toEqual({
      a: { providerType: "openai", generation: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      c: { providerType: "anthropic", generation: "cccccccccccccccccccccccccccccccc" },
    });
    expect(Object.keys(persistedRoutes).sort()).toEqual(["a", "c"]);
    expect(persistedRoutes.a).toMatchObject({ providerType: "openai" });
    expect(JSON.stringify(persistedRoutes)).not.toContain("a.example");
    expect(JSON.stringify(persistedRoutes)).not.toContain("10.0.0.1");
    expect(typeof persistedRoutes.a.orphanedAt).toBe("string");
    expect(persistedRoutes.c).toMatchObject({ providerType: "anthropic" });
    expect(typeof persistedRoutes.c.orphanedAt).toBe("string");
    expect(persistedRoutes.b).toBeUndefined();
  });

  it("orphans nothing when there is no prior state to recover from", () => {
    const { orphanedRoutes, persistedRoutes } = __test.computeRespawnState({}, "bootstrap-only");

    expect(orphanedRoutes).toEqual({});
    expect(persistedRoutes).toEqual({});
  });
});

describe("HTTPS Pin Runtime adapter child environment (#6141)", () => {
  it("keeps upstream route credentials out of the long-lived child environment", () => {
    const env = __test.buildAdapterChildEnv(TEST_CONTROL_TOKEN, ["172.17.0.0/16"], {
      orphaned: {
        providerType: "openai",
        generation: TEST_ROUTE_GENERATION,
      },
    });

    expect(env).not.toHaveProperty("NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_BOOTSTRAP_ROUTE");
    expect(env.NEMOCLAW_HTTPS_PIN_RUNTIME_ADAPTER_ALLOWED_SOURCE_CIDRS).toBe('["172.17.0.0/16"]');
    expect(JSON.stringify(env)).not.toContain("sk-upstream-secret");
    expect(JSON.stringify(env)).not.toContain("real-upstream.example");
  });

  it("accepts only a validated JSON array of bridge source CIDRs", () => {
    expect(__test.parseAllowedSourceCidrs('["172.17.0.0/16","fd00::/64"]')).toEqual([
      "172.17.0.0/16",
      "fd00::/64",
    ]);
    expect(__test.parseAllowedSourceCidrs('["not-a-cidr"]')).toEqual([]);
    expect(__test.parseAllowedSourceCidrs('{"cidr":"172.17.0.0/16"}')).toEqual([]);
  });
});

describe("ensureHttpsPinRuntimeAdapter preflight-before-credential ordering (#6141)", () => {
  const privateLookup: EndpointDnsLookupFn = async () => [{ address: "10.48.203.205", family: 4 }];
  const publicLookup: EndpointDnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];
  const discoverAllowedSourceCidrs = () => ["172.17.0.0/16"];

  it("rejects a cleartext HTTP endpoint at the exported lifecycle boundary", async () => {
    await expect(
      ensureHttpsPinRuntimeAdapter({
        gatewayName: "gw",
        provider: "compatible-endpoint",
        endpointUrl: "http://public.example.test/v1",
        providerType: "openai",
        credentialValue: "sk-secret",
        lookup: publicLookup,
        discoverAllowedSourceCidrs,
      }),
    ).rejects.toThrow("requires an HTTPS endpoint URL");
  });

  it("rejects a DNS-private endpoint before ever considering the credential", async () => {
    await expect(
      ensureHttpsPinRuntimeAdapter({
        gatewayName: "gw",
        provider: "compatible-endpoint",
        endpointUrl: "https://internal.example.test/v1",
        providerType: "openai",
        // Deliberately empty: if the credential check ran first, the error
        // message would mention "credential" instead of the SSRF reason.
        credentialValue: "",
        lookup: privateLookup,
        discoverAllowedSourceCidrs,
      }),
    ).rejects.toThrow(/resolves to private\/internal address/);
  });

  it("rejects an empty credential only after the endpoint already resolved publicly", async () => {
    await expect(
      ensureHttpsPinRuntimeAdapter({
        gatewayName: "gw",
        provider: "compatible-endpoint",
        endpointUrl: "https://public.example.test/v1",
        providerType: "openai",
        credentialValue: "   ",
        lookup: publicLookup,
        discoverAllowedSourceCidrs,
      }),
    ).rejects.toThrow(/requires a non-empty credential value/);
  });

  it("rejects a loopback endpoint (no pinnable address) before the credential check", async () => {
    await expect(
      ensureHttpsPinRuntimeAdapter({
        gatewayName: "gw",
        provider: "compatible-endpoint",
        endpointUrl: "https://localhost/v1",
        providerType: "openai",
        credentialValue: "",
        lookup: publicLookup,
        discoverAllowedSourceCidrs,
      }),
    ).rejects.toThrow(/requires a DNS-resolved public address/);
  });

  it("surfaces the underlying resolver failure when DNS lookup itself errors", async () => {
    const failingLookup: EndpointDnsLookupFn = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(
      ensureHttpsPinRuntimeAdapter({
        gatewayName: "gw",
        provider: "compatible-endpoint",
        endpointUrl: "https://does-not-resolve.example.test/v1",
        providerType: "openai",
        credentialValue: "sk-secret",
        lookup: failingLookup,
        discoverAllowedSourceCidrs,
      }),
    ).rejects.toThrow(/cannot resolve endpoint host/);
  });
});
