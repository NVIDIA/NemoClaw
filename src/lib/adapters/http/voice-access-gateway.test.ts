// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createVoiceAccessGatewayServer,
  readVoiceAccessTokenFile,
  VOICE_ACCESS_MAX_REQUEST_BYTES,
  VOICE_ACCESS_MAX_RESPONSE_BYTES,
} from "./voice-access-gateway";

const AUTH_TOKEN = "voice-access-test-token-0123456789";
const openServers = new Set<http.Server>();
const temporaryDirectories: string[] = [];

async function listen(server: http.Server): Promise<number> {
  openServers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const address = server.address();
  return address !== null && typeof address !== "string"
    ? address.port
    : Promise.reject(new Error("Test server did not bind TCP."));
}

async function close(server: http.Server): Promise<void> {
  openServers.delete(server);
  await (server.listening
    ? new Promise<void>((resolve) => server.close(() => resolve()))
    : Promise.resolve());
}

async function request(
  port: number,
  options: {
    body?: Buffer | string;
    headers?: http.OutgoingHttpHeaders;
    method?: string;
    path?: string;
  } = {},
): Promise<{
  body: Buffer;
  headers: http.IncomingHttpHeaders;
  status: number;
}> {
  const body = options.body ?? "";
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        headers: {
          ...(body !== "" ? { "content-length": Buffer.byteLength(body) } : {}),
          ...options.headers,
        },
        host: "127.0.0.1",
        method: options.method ?? "GET",
        path: options.path ?? "/healthz",
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            headers: response.headers,
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    client.once("error", reject);
    client.end(body);
  });
}

async function chunkedRequest(
  port: number,
  body: Buffer,
): Promise<{ body: Buffer; status: number }> {
  return new Promise((resolve, reject) => {
    const client = http.request(
      {
        headers: authorize({ "transfer-encoding": "chunked" }),
        host: "127.0.0.1",
        method: "POST",
        path: "/api/offer",
        port,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            body: Buffer.concat(chunks),
            status: response.statusCode ?? 0,
          });
        });
      },
    );
    client.once("error", reject);
    const midpoint = Math.floor(body.length / 2);
    client.write(body.subarray(0, midpoint));
    client.end(body.subarray(midpoint));
  });
}

async function rawTcpRequest(port: number, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.end(payload));
    socket.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once("error", reject);
    socket.once("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function authorize(headers: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return { authorization: `Bearer ${AUTH_TOKEN}`, ...headers };
}

async function startGateway(
  upstreamPort: number,
  options: { upstreamTimeoutMs?: number } = {},
): Promise<number> {
  return listen(
    createVoiceAccessGatewayServer({
      authToken: AUTH_TOKEN,
      upstreamPort,
      upstreamTimeoutMs: options.upstreamTimeoutMs,
    }),
  );
}

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-voice-access-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all([...openServers].map((server) => close(server)));
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("voice access token file", () => {
  it("reads one private regular file without returning its trailing newline (#7781)", () => {
    const filePath = path.join(makeTemporaryDirectory(), "token");
    fs.writeFileSync(filePath, `${AUTH_TOKEN}\n`, { mode: 0o600 });

    expect(readVoiceAccessTokenFile(filePath)).toBe(AUTH_TOKEN);
  });

  it.each([
    {
      name: "relative path",
      arrange: () => "relative-token",
      message: "must be absolute",
    },
    {
      name: "group-readable file",
      arrange: () => {
        const filePath = path.join(makeTemporaryDirectory(), "token");
        fs.writeFileSync(filePath, AUTH_TOKEN, { mode: 0o640 });
        fs.chmodSync(filePath, 0o640);
        return filePath;
      },
      message: "must not be accessible by group or others",
    },
    {
      name: "directory",
      arrange: () => makeTemporaryDirectory(),
      message: "not a regular file",
    },
    {
      name: "symbolic link",
      arrange: () => {
        const directory = makeTemporaryDirectory();
        const target = path.join(directory, "target");
        const link = path.join(directory, "token");
        fs.writeFileSync(target, AUTH_TOKEN, { mode: 0o600 });
        fs.symlinkSync(target, link);
        return link;
      },
      message: "symbolic-link",
    },
    {
      name: "token containing whitespace",
      arrange: () => {
        const filePath = path.join(makeTemporaryDirectory(), "token");
        fs.writeFileSync(filePath, "first token second", { mode: 0o600 });
        return filePath;
      },
      message: "bearer token is malformed",
    },
    {
      name: "short token",
      arrange: () => {
        const filePath = path.join(makeTemporaryDirectory(), "token");
        fs.writeFileSync(filePath, "short-token", { mode: 0o600 });
        return filePath;
      },
      message: "bearer token is malformed",
    },
    {
      name: "oversized token",
      arrange: () => {
        const filePath = path.join(makeTemporaryDirectory(), "token");
        fs.writeFileSync(filePath, "a".repeat(4098), { mode: 0o600 });
        return filePath;
      },
      message: "invalid size",
    },
  ])("rejects a $name before serving requests", ({ arrange, message }) => {
    expect(() => readVoiceAccessTokenFile(arrange())).toThrow(message);
  });
});

describe("voice access gateway request boundary", () => {
  it.each([
    { name: "missing authorization", authorization: undefined },
    { name: "wrong token", authorization: "Bearer wrong-token" },
    { name: "wrong scheme", authorization: `Basic ${AUTH_TOKEN}` },
    { name: "token with whitespace", authorization: `Bearer ${AUTH_TOKEN} extra` },
    { name: "non-ASCII token", authorization: "Bearer véry-secret" },
  ])("returns an empty 401 for $name without reaching Talker (#7781)", async ({
    authorization,
  }) => {
    let upstreamRequests = 0;
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        upstreamRequests += 1;
        response.end();
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      headers: authorization ? { authorization } : {},
      path: "/api/ice-servers",
    });

    expect(result.status).toBe(401);
    expect(result.body).toHaveLength(0);
    expect(upstreamRequests).toBe(0);
  });

  it("requires authorization before probing Talker health (#7781)", async () => {
    let connections = 0;
    const upstream = http.createServer();
    upstream.on("connection", () => {
      connections += 1;
    });
    const upstreamPort = await listen(upstream);
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort);

    expect(result.status).toBe(401);
    expect(result.body).toHaveLength(0);
    expect(connections).toBe(0);
  });

  it.each([
    { method: "GET", path: "/api/offer" },
    { method: "POST", path: "/api/ice-servers" },
    { method: "PATCH", path: "/api/offer?conversation_id=one" },
    { method: "POST", path: "/api/offer?other=value" },
    { method: "POST", path: "/api/offer?conversation_id=one&conversation_id=two" },
    { method: "POST", path: "/api/offer?conversation_id=bad%20id" },
    { method: "POST", path: "/api/offer?conversation_id=Uppercase" },
    { method: "POST", path: "/api/offer?conversation_id=foo_bar" },
    { method: "POST", path: "/api/offer?conversation_id=foo.bar" },
    { method: "POST", path: "/api/offer?conversation_id=-leading" },
    { method: "POST", path: "/api/offer?conversation_id=trailing-" },
    { method: "POST", path: `/api/offer?conversation_id=${"a".repeat(41)}` },
    { method: "POST", path: "/api/offer?conversation_id=ios%2Dclient" },
    { method: "GET", path: "/api/ice-servers?extra=true" },
    { method: "GET", path: "/api/../api/ice-servers" },
    { method: "GET", path: "/ws" },
    { method: "GET", path: "/health" },
  ])("rejects $method $path without reaching Talker (#7781)", async ({ method, path }) => {
    let upstreamRequests = 0;
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        upstreamRequests += 1;
        response.end();
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      headers: authorize(),
      method,
      path,
    });

    expect(result.status).toBe(404);
    expect(result.body).toHaveLength(0);
    expect(upstreamRequests).toBe(0);
  });

  it("rejects an upstream host that is not a loopback IP literal (#7781)", () => {
    expect(() =>
      createVoiceAccessGatewayServer({
        authToken: AUTH_TOKEN,
        upstreamHost: "talker.example",
        upstreamPort: 18_790,
      }),
    ).toThrow("must be a loopback IP literal");
  });

  it("contains a malformed request target and continues serving (#7781)", async () => {
    let upstreamRequests = 0;
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        upstreamRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const malformed = await rawTcpRequest(
      gatewayPort,
      ["GET /\\ HTTP/1.1", `Host: 127.0.0.1:${gatewayPort}`, "Connection: close", "", ""].join(
        "\r\n",
      ),
    );

    expect(malformed).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/u);
    expect(malformed.split("\r\n\r\n", 2)[1]).toBe("");
    expect(upstreamRequests).toBe(0);

    const healthy = await request(gatewayPort, {
      headers: authorize(),
      path: "/api/ice-servers",
    });
    expect(healthy.status).toBe(200);
    expect(upstreamRequests).toBe(1);
  });

  it("forwards an authorized offer without external credentials or proxy headers (#7781)", async () => {
    let received:
      | {
          body: string;
          headers: http.IncomingHttpHeaders;
          method: string | undefined;
          url: string | undefined;
        }
      | undefined;
    const upstreamPort = await listen(
      http.createServer((incoming, response) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          received = {
            body: Buffer.concat(chunks).toString("utf8"),
            headers: incoming.headers,
            method: incoming.method,
            url: incoming.url,
          };
          response.writeHead(201, { "content-type": "application/json", "x-internal": "omit" });
          response.end('{"answer":"ok"}');
        });
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);
    const offer = '{"sdp":"private-offer"}';

    const result = await request(gatewayPort, {
      body: offer,
      headers: authorize({
        accept: "application/json",
        connection: "content-type",
        cookie: "private-cookie",
        "content-type": "application/json",
        "proxy-authorization": "Basic external-proxy-secret",
        "x-forwarded-host": "public.example",
      }),
      method: "POST",
      path: "/api/offer?conversation_id=ios-client-1",
    });

    expect(result.status).toBe(201);
    expect(result.body.toString("utf8")).toBe('{"answer":"ok"}');
    expect(result.headers["content-type"]).toContain("application/json");
    expect(result.headers["x-internal"]).toBeUndefined();
    expect(received).toMatchObject({
      body: offer,
      method: "POST",
      url: "/api/offer?conversation_id=ios-client-1",
    });
    expect(received?.headers.authorization).toBeUndefined();
    expect(received?.headers.cookie).toBeUndefined();
    expect(received?.headers["content-type"]).toBeUndefined();
    expect(received?.headers["proxy-authorization"]).toBeUndefined();
    expect(received?.headers["x-forwarded-host"]).toBeUndefined();
    expect(received?.headers.host).toBe(`127.0.0.1:${upstreamPort}`);
  });

  it.each([
    { method: "GET", path: "/api/ice-servers", body: "", cacheControl: "no-store" },
    {
      method: "PATCH",
      path: "/api/offer",
      body: '{"candidate":"candidate:1"}',
      cacheControl: undefined,
    },
  ])("forwards an authorized $method signaling operation (#7781)", async ({
    body,
    cacheControl,
    method,
    path,
  }) => {
    const seen: Array<{ body: string; method: string | undefined; url: string | undefined }> = [];
    const upstreamPort = await listen(
      http.createServer((incoming, response) => {
        const chunks: Buffer[] = [];
        incoming.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        incoming.on("end", () => {
          seen.push({
            body: Buffer.concat(chunks).toString("utf8"),
            method: incoming.method,
            url: incoming.url,
          });
          response.writeHead(200, { "content-type": "application/json" });
          response.end('{"ok":true}');
        });
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      body,
      headers: authorize(body ? { "content-type": "application/json" } : {}),
      method,
      path,
    });

    expect(result.status).toBe(200);
    expect(result.body.toString("utf8")).toBe('{"ok":true}');
    expect(seen).toEqual([{ body, method, url: path }]);
    expect(result.headers["cache-control"]).toBe(cacheControl);
  });

  it("rejects an oversized body from its declared length before reaching Talker (#7781)", async () => {
    let upstreamRequests = 0;
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        upstreamRequests += 1;
        response.end();
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      headers: authorize({ "content-length": String(VOICE_ACCESS_MAX_REQUEST_BYTES + 1) }),
      method: "POST",
      path: "/api/offer",
    });

    expect(result.status).toBe(413);
    expect(result.body).toHaveLength(0);
    expect(upstreamRequests).toBe(0);
  });

  it("rejects an oversized streamed body before reaching Talker (#7781)", async () => {
    let upstreamRequests = 0;
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        upstreamRequests += 1;
        response.end();
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await chunkedRequest(
      gatewayPort,
      Buffer.alloc(VOICE_ACCESS_MAX_REQUEST_BYTES + 1),
    );

    expect(result.status).toBe(413);
    expect(result.body).toHaveLength(0);
    expect(upstreamRequests).toBe(0);
  });

  it("rejects oversized request headers before reaching Talker (#7781)", async () => {
    let upstreamRequests = 0;
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        upstreamRequests += 1;
        response.end();
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await rawTcpRequest(
      gatewayPort,
      [
        "GET /api/ice-servers HTTP/1.1",
        `Host: 127.0.0.1:${gatewayPort}`,
        `Authorization: Bearer ${AUTH_TOKEN}`,
        `X-Oversized: ${"a".repeat(20 * 1024)}`,
        "Connection: close",
        "",
        "",
      ].join("\r\n"),
    );

    expect(result).toMatch(/^HTTP\/1\.1 400 Bad Request\r\n/u);
    expect(result.split("\r\n\r\n", 2)[1]).toBe("");
    expect(upstreamRequests).toBe(0);
  });
});

describe("voice access gateway failure boundary", () => {
  it("returns content-free health status from Talker reachability (#7781)", async () => {
    const upstream = http.createServer((_incoming, response) => response.end());
    const upstreamPort = await listen(upstream);
    const gatewayPort = await startGateway(upstreamPort);

    const healthy = await request(gatewayPort, { headers: authorize() });
    expect(healthy.status).toBe(204);
    expect(healthy.body).toHaveLength(0);

    await close(upstream);
    const unhealthy = await request(gatewayPort, { headers: authorize() });
    expect(unhealthy.status).toBe(503);
    expect(unhealthy.body).toHaveLength(0);
  });

  it("returns an empty 502 when Talker refuses the connection (#7781)", async () => {
    const probe = http.createServer();
    const upstreamPort = await listen(probe);
    await close(probe);
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      headers: authorize(),
      path: "/api/ice-servers",
    });

    expect(result.status).toBe(502);
    expect(result.body).toHaveLength(0);
  });

  it("returns an empty 502 and aborts a stalled Talker request (#7781)", async () => {
    const upstreamPort = await listen(http.createServer(() => {}));
    const gatewayPort = await startGateway(upstreamPort, { upstreamTimeoutMs: 20 });

    const result = await request(gatewayPort, {
      body: "{}",
      headers: authorize({ "content-type": "application/json" }),
      method: "POST",
      path: "/api/offer",
    });

    expect(result.status).toBe(502);
    expect(result.body).toHaveLength(0);
  });

  it("replaces a Talker server error with an empty 502 (#7781)", async () => {
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("internal Talker error with private topology");
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      body: "{}",
      headers: authorize({ "content-type": "application/json" }),
      method: "POST",
      path: "/api/offer",
    });

    expect(result.status).toBe(502);
    expect(result.body).toHaveLength(0);
  });

  it("preserves a Talker client-error status without exposing its body (#7781)", async () => {
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        response.writeHead(400, { "content-type": "text/plain" });
        response.end("invalid SDP: private client payload");
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      body: "{}",
      headers: authorize({ "content-type": "application/json" }),
      method: "POST",
      path: "/api/offer",
    });

    expect(result.status).toBe(400);
    expect(result.body).toHaveLength(0);
  });

  it("strips response headers nominated by Talker's Connection header (#7781)", async () => {
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        response.writeHead(200, {
          connection: "content-type",
          "content-type": "application/private",
        });
        response.end("{}");
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      headers: authorize(),
      path: "/api/ice-servers",
    });

    expect(result.status).toBe(200);
    expect(result.headers["content-type"]).toBeUndefined();
  });

  it("replaces an oversized Talker response with an empty 502 (#7781)", async () => {
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(Buffer.alloc(VOICE_ACCESS_MAX_RESPONSE_BYTES + 1));
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      headers: authorize(),
      path: "/api/ice-servers",
    });

    expect(result.status).toBe(502);
    expect(result.body).toHaveLength(0);
  });

  it("aborts the Talker request when the downstream client disconnects (#7781)", async () => {
    let upstreamSocketClosed = false;
    let resolveUpstreamRequest: () => void = () => {};
    const upstreamRequest = new Promise<void>((resolve) => {
      resolveUpstreamRequest = resolve;
    });
    const upstream = http.createServer((_incoming, _response) => {
      resolveUpstreamRequest();
    });
    upstream.on("connection", (socket) => {
      socket.once("close", () => {
        upstreamSocketClosed = true;
      });
    });
    const upstreamPort = await listen(upstream);
    const gatewayPort = await startGateway(upstreamPort);
    const client = http.request({
      headers: authorize(),
      host: "127.0.0.1",
      path: "/api/ice-servers",
      port: gatewayPort,
    });
    client.on("error", () => {});
    client.end();

    await upstreamRequest;
    client.destroy();

    await vi.waitFor(() => expect(upstreamSocketClosed).toBe(true));
  });

  it("buffers the upstream response so an abort does not expose partial SDP (#7781)", async () => {
    const upstreamPort = await listen(
      http.createServer((_incoming, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"sdp":"partial');
        response.destroy();
      }),
    );
    const gatewayPort = await startGateway(upstreamPort);

    const result = await request(gatewayPort, {
      body: "{}",
      headers: authorize({ "content-type": "application/json" }),
      method: "POST",
      path: "/api/offer",
    });

    expect(result.status).toBe(502);
    expect(result.body).toHaveLength(0);
  });
});
