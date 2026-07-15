// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EndpointDnsLookupFn } from "./endpoint-ssrf-preflight";
import {
  __test,
  createHttpsPinRuntimeAdapterServer,
  ensureHttpsPinRuntimeAdapter,
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

const TEST_TOKEN = "test-control-plane-token";

function readRequestBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

describe("createHttpsPinRuntimeAdapterServer health and auth (#6141)", () => {
  it("exposes an unauthenticated health endpoint without leaking the token", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; routeCount: number; tokenHash: string };
    expect(body).toMatchObject({ ok: true, routeCount: 0 });
    expect(typeof body.tokenHash).toBe("string");
    expect(JSON.stringify(body)).not.toContain(TEST_TOKEN);
  });

  it("rejects control-plane and route requests without a valid bearer token", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
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
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/nonexistent`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });
});

describe("createHttpsPinRuntimeAdapterServer control plane (#6141)", () => {
  it("registers a route via PUT and then forwards requests to it", async () => {
    const upstreamRequests: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const upstream = http.createServer(async (req, res) => {
      upstreamRequests.push({ headers: req.headers, body: await readRequestBody(req) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const upstreamPort = new URL(upstreamBaseUrl).port;

    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const putResponse = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: `http://real-upstream.example:${upstreamPort}/base`,
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-upstream-secret",
      }),
    });
    expect(putResponse.status).toBe(200);
    await expect(putResponse.json()).resolves.toEqual({ ok: true, routeId: "route-1" });

    const health = await fetch(`${baseUrl}/health`);
    await expect(health.json()).resolves.toMatchObject({ routeCount: 1 });

    const forwardResponse = await fetch(`${baseUrl}/route/route-1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ hello: "world" }),
    });
    expect(forwardResponse.status).toBe(200);
    expect(upstreamRequests).toHaveLength(1);
    expect(upstreamRequests[0].headers.authorization).toBe("Bearer sk-upstream-secret");
    expect(upstreamRequests[0].headers.host).toBe(`real-upstream.example:${upstreamPort}`);
    expect(upstreamRequests[0].body).toBe(JSON.stringify({ hello: "world" }));
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

    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    await fetch(`${baseUrl}/control/routes/route-anthropic`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: `http://real-upstream.example:${upstreamPort}/base`,
        pinnedAddresses: ["127.0.0.1"],
        providerType: "anthropic",
        credentialValue: "sk-ant-secret",
      }),
    });

    await fetch(`${baseUrl}/route/route-anthropic/v1/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: "{}",
    });

    expect(upstreamRequests[0].headers["x-api-key"]).toBe("sk-ant-secret");
    expect(upstreamRequests[0].headers.authorization).toBeUndefined();
  });

  it("seeds routes from initialRoutes at construction, before any PUT", async () => {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const upstreamBaseUrl = await listen(upstream);
    const upstreamPort = new URL(upstreamBaseUrl).port;

    const adapter = createHttpsPinRuntimeAdapterServer({
      token: TEST_TOKEN,
      initialRoutes: {
        "bootstrap-route": {
          targetBaseUrl: `http://real-upstream.example:${upstreamPort}/base`,
          pinnedAddresses: ["127.0.0.1"],
          providerType: "openai",
          credentialValue: "sk-bootstrap",
        },
      },
    });
    const baseUrl = await listen(adapter);

    const health = await fetch(`${baseUrl}/health`);
    await expect(health.json()).resolves.toMatchObject({ routeCount: 1 });

    const response = await fetch(`${baseUrl}/route/bootstrap-route/`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  it("rejects PUT bodies missing required fields with 400 invalid_route", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ targetBaseUrl: "http://example.com/" }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_route" } });
  });

  it("rejects PUT bodies with an unparseable targetBaseUrl with 400 invalid_route", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: "not-a-url",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-secret",
      }),
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "invalid_route" } });
  });

  it("rejects PUT bodies with an unsupported providerType with 400 invalid_route", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: "http://example.com/",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "gemini",
        credentialValue: "sk-secret",
      }),
    });
    expect(response.status).toBe(400);
  });

  it("rejects oversized control-plane bodies with 413", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${TEST_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        targetBaseUrl: "http://example.com/",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "x".repeat(20 * 1024),
      }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });

  it("returns 404 for a GET on the control-routes path (PUT only)", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/control/routes/route-1`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(404);
  });

  it("returns 404 route_not_found for an unregistered route id", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });
    const baseUrl = await listen(adapter);

    const response = await fetch(`${baseUrl}/route/never-registered`, {
      headers: { Authorization: `Bearer ${TEST_TOKEN}` },
    });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "route_not_found" } });
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
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });

    // The container-gateway address the sandbox actually connects from when
    // it reaches the adapter through `host.openshell.internal` -- distinct
    // from the literal 127.0.0.1 the host process itself always dials from.
    const response = await dispatchFakeRequest(adapter, {
      method: "PUT",
      url: "/control/routes/route-1",
      remoteAddress: "172.17.0.2",
      authorization: `Bearer ${TEST_TOKEN}`,
      body: {
        targetBaseUrl: "http://internal.example/base",
        pinnedAddresses: ["10.0.0.5"],
        providerType: "openai",
        credentialValue: "sk-should-not-register",
      },
    });
    expect(response.status).toBe(404);

    const health = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/health",
      remoteAddress: "172.17.0.2",
    });
    expect(health.body).toMatchObject({ routeCount: 0 });
  });

  it("still allows route registration over loopback", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });

    const response = await dispatchFakeRequest(adapter, {
      method: "PUT",
      url: "/control/routes/route-1",
      remoteAddress: "127.0.0.1",
      authorization: `Bearer ${TEST_TOKEN}`,
      body: {
        targetBaseUrl: "http://real-upstream.example/base",
        pinnedAddresses: ["127.0.0.1"],
        providerType: "openai",
        credentialValue: "sk-upstream-secret",
      },
    });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, routeId: "route-1" });
  });
});

describe("createHttpsPinRuntimeAdapterServer route forwarding private-network restriction (#6141)", () => {
  // These drive the gate itself, so an unregistered route ID is enough: a
  // request that passes the private-network gate falls through to the
  // "route_not_found" lookup (which never pipes a real upstream response),
  // while a request blocked by the gate never reaches that lookup at all and
  // instead gets the gate's own "not_found" code.

  it("rejects a route-forward request whose connection arrives from a public address", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });

    // A peer that reached this 0.0.0.0-bound port from outside the intended
    // Docker-bridge sandbox boundary -- an address the adapter should never
    // trust a replayed bearer token from. 203.0.113.0/24 is the reserved
    // TEST-NET-3 documentation range (RFC 5737), never a real bridge subnet.
    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "203.0.113.5",
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "not_found" } });
  });

  it("still passes a route-forward request from the Docker-bridge sandbox address through to route lookup", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });

    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "172.17.0.2",
      authorization: `Bearer ${TEST_TOKEN}`,
    });
    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ error: { code: "route_not_found" } });
  });

  it("still passes a route-forward request over loopback through to route lookup", async () => {
    const adapter = createHttpsPinRuntimeAdapterServer({ token: TEST_TOKEN });

    const response = await dispatchFakeRequest(adapter, {
      method: "GET",
      url: "/route/never-registered",
      remoteAddress: "127.0.0.1",
      authorization: `Bearer ${TEST_TOKEN}`,
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
});

describe("ensureHttpsPinRuntimeAdapter preflight-before-credential ordering (#6141)", () => {
  const privateLookup: EndpointDnsLookupFn = async () => [{ address: "10.48.203.205", family: 4 }];
  const publicLookup: EndpointDnsLookupFn = async () => [{ address: "93.184.216.34", family: 4 }];

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
      }),
    ).rejects.toThrow(/cannot resolve endpoint host/);
  });
});
