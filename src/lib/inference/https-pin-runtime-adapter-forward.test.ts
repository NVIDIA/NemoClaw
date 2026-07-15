// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import {
  type CaMaterial,
  cleanupCaSetup,
  resolveCaSetup,
  startTlsServer,
} from "../../../test/helpers/corporate-ca-support";
import {
  forwardHttpsPinnedRequest,
  HTTPS_PIN_RUNTIME_ADAPTER_MAX_BODY_BYTES,
  type HttpsPinTarget,
} from "./https-pin-runtime-adapter-forward";

const servers: http.Server[] = [];
const tlsServers: Array<{ close: () => Promise<void> }> = [];

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
  await Promise.all(tlsServers.map((server) => server.close()));
  tlsServers.length = 0;
});

function listen(server: http.Server): Promise<{ baseUrl: string; port: number }> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, port: address.port });
    });
  });
}

const TEST_CREDENTIAL = { name: "x-api-key", value: "secret-upstream-credential" };

/** A minimal server that forwards every request through `forwardHttpsPinnedRequest` against `target`. */
function createForwardTestServer(
  target: HttpsPinTarget,
  options: { upstreamTimeoutMs?: number; bodyTimeoutMs?: number } = {},
): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    await forwardHttpsPinnedRequest({
      req,
      res,
      forwardPath: url.pathname + url.search,
      target,
      upstreamTimeoutMs: options.upstreamTimeoutMs,
      bodyTimeoutMs: options.bodyTimeoutMs,
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

describe("forwardHttpsPinnedRequest header handling (#6141)", () => {
  it("connects to the pinned address while sending the real hostname as Host, and injects the upstream credential", async () => {
    const upstreamRequests: Array<{
      headers: http.IncomingHttpHeaders;
      body: string;
      url: string | undefined;
    }> = [];
    const upstream = http.createServer(async (req, res) => {
      upstreamRequests.push({
        headers: req.headers,
        body: await readRequestBody(req),
        url: req.url,
      });
      res.writeHead(200, { "Content-Type": "application/json", "X-Upstream-Marker": "yes" });
      res.end(JSON.stringify({ ok: true }));
    });
    const { port: upstreamPort } = await listen(upstream);

    const target: HttpsPinTarget = {
      targetUrl: new URL(`http://forward-test.example:${upstreamPort}/base`),
      pinnedAddress: "127.0.0.1",
      credential: TEST_CREDENTIAL,
    };
    const adapter = createForwardTestServer(target);
    const { baseUrl } = await listen(adapter);

    const response = await fetch(`${baseUrl}/base/chat?trace=1`, {
      method: "POST",
      headers: {
        Authorization: "Bearer client-supplied-should-be-dropped",
        "Content-Type": "application/json",
        "X-Trace-Id": "abc123",
      },
      body: JSON.stringify({ hello: "world" }),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("x-upstream-marker")).toBe("yes");
    expect(upstreamRequests).toHaveLength(1);
    const [seen] = upstreamRequests;
    // Host reflects the real target hostname (with its non-default port),
    // not the pinned connect address.
    expect(seen.headers.host).toBe(`forward-test.example:${upstreamPort}`);
    // The adapter's own credential is what reaches upstream...
    expect(seen.headers["x-api-key"]).toBe(TEST_CREDENTIAL.value);
    // ...and the client-supplied Authorization header never does.
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers["x-trace-id"]).toBe("abc123");
    expect(seen.url).toBe("/base/chat?trace=1");
    expect(seen.body).toBe(JSON.stringify({ hello: "world" }));
  });

  it("rejects a request body over the size limit before contacting upstream", async () => {
    const upstreamHandler = () => {
      throw new Error("upstream must not be contacted for an oversized body");
    };
    const upstream = http.createServer(upstreamHandler);
    const { port: upstreamPort } = await listen(upstream);

    const target: HttpsPinTarget = {
      targetUrl: new URL(`http://forward-test.example:${upstreamPort}/base`),
      pinnedAddress: "127.0.0.1",
      credential: TEST_CREDENTIAL,
    };
    const adapter = createForwardTestServer(target);
    const { baseUrl } = await listen(adapter);

    const response = await fetch(`${baseUrl}/base`, {
      method: "POST",
      body: "x".repeat(HTTPS_PIN_RUNTIME_ADAPTER_MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "request_too_large" } });
  });

  it("delivers the 408 timeout body to the client instead of hanging up the shared socket (#6141)", async () => {
    const upstreamHandler = () => {
      throw new Error("upstream must not be contacted for a stalled request body");
    };
    const upstream = http.createServer(upstreamHandler);
    const { port: upstreamPort } = await listen(upstream);

    const target: HttpsPinTarget = {
      targetUrl: new URL(`http://forward-test.example:${upstreamPort}/base`),
      pinnedAddress: "127.0.0.1",
      credential: TEST_CREDENTIAL,
    };
    const adapter = createForwardTestServer(target, { bodyTimeoutMs: 50 });
    const { port: adapterPort } = await listen(adapter);

    // A raw request that declares a body but never finishes sending it, so
    // the adapter's body-read timeout fires instead of the client ever
    // completing the write. Destroying `req` before `res` flushes (the bug
    // this test guards) would tear down the shared socket and the client
    // would see the connection drop instead of a 408 body.
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: adapterPort,
            path: "/base",
            method: "POST",
            headers: { "content-length": "100" },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
            res.on("end", () => {
              resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") });
            });
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        // Fewer bytes than the declared content-length, and `.end()` is
        // deliberately never called.
        req.write("partial-body");
      },
    );

    expect(response.status).toBe(408);
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: "request_timeout" } });
  });

  it("cancels the pinned upstream request when the client disconnects before the response finishes (#6141)", async () => {
    let upstreamRequestSocket: import("node:net").Socket | undefined;
    let resolveUpstreamClosed: () => void;
    const upstreamClosed = new Promise<void>((resolve) => {
      resolveUpstreamClosed = resolve;
    });
    const upstream = http.createServer((req, res) => {
      upstreamRequestSocket = req.socket;
      req.socket.once("close", () => resolveUpstreamClosed());
      res.writeHead(200, { "Content-Type": "application/json" });
      res.write('{"partial":true');
      // Never call res.end(): the upstream response is left open so the
      // only way this promise resolves is via the adapter destroying the
      // pinned outbound connection after the client disconnects.
    });
    const { port: upstreamPort } = await listen(upstream);

    const target: HttpsPinTarget = {
      targetUrl: new URL(`http://forward-test.example:${upstreamPort}/base`),
      pinnedAddress: "127.0.0.1",
      credential: TEST_CREDENTIAL,
    };
    const adapter = createForwardTestServer(target, { upstreamTimeoutMs: 30_000 });
    const { port: adapterPort } = await listen(adapter);

    await new Promise<void>((resolve, reject) => {
      const clientReq = http.request(
        { host: "127.0.0.1", port: adapterPort, path: "/base", method: "POST" },
        (res) => {
          res.once("data", () => {
            // Simulate the original client abandoning the request once it
            // has started receiving a response.
            clientReq.destroy();
            resolve();
          });
          res.once("error", () => resolve());
        },
      );
      clientReq.on("error", () => {
        /* destroying our own request triggers this; expected. */
      });
      clientReq.end("{}");
      setTimeout(() => reject(new Error("timed out waiting for client response data")), 2000);
    });

    // The pinned outbound connection must be torn down promptly, well under
    // the 30s default/configured upstream timeout, rather than lingering
    // until the abandoned upstream response finishes on its own.
    await expect(
      Promise.race([
        upstreamClosed,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("upstream connection was not canceled in time")), 2000),
        ),
      ]),
    ).resolves.toBeUndefined();
    expect(upstreamRequestSocket?.destroyed).toBe(true);
  });

  it("times out a stalled upstream response without hanging (#6141)", async () => {
    const upstream = http.createServer(async (req) => {
      await readRequestBody(req);
      // Never responds.
    });
    const { port: upstreamPort } = await listen(upstream);

    const target: HttpsPinTarget = {
      targetUrl: new URL(`http://forward-test.example:${upstreamPort}/base`),
      pinnedAddress: "127.0.0.1",
      credential: TEST_CREDENTIAL,
    };
    const adapter = createForwardTestServer(target, { upstreamTimeoutMs: 50 });
    const { baseUrl } = await listen(adapter);

    const response = await fetch(`${baseUrl}/base`, { method: "POST", body: "{}" });
    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "upstream_timeout" } });
  });
});

describe("forwardHttpsPinnedRequest redirect fail-closed (#6141)", () => {
  it.each([
    301, 302, 303, 307, 308,
  ])("blocks a %i upstream redirect instead of following or relaying it", async (status) => {
    const upstream = http.createServer(async (req, res) => {
      await readRequestBody(req);
      res.writeHead(status, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    const { port: upstreamPort } = await listen(upstream);

    const target: HttpsPinTarget = {
      targetUrl: new URL(`http://forward-test.example:${upstreamPort}/base`),
      pinnedAddress: "127.0.0.1",
      credential: TEST_CREDENTIAL,
    };
    const adapter = createForwardTestServer(target);
    const { baseUrl } = await listen(adapter);

    const response = await fetch(`${baseUrl}/base`, { method: "POST", body: "{}" });
    expect(response.status).toBe(502);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("redirect_blocked");
    // The attacker-influenced Location header must never reach the client.
    expect(response.headers.get("location")).toBeNull();
    expect(JSON.stringify(body)).not.toContain("169.254.169.254");
  });
});

const sniPinSetup = resolveCaSetup("https-pin-runtime-adapter-forward SNI pinning");

afterAll(() => cleanupCaSetup(sniPinSetup));

describe.skipIf(!sniPinSetup.ok)("forwardHttpsPinnedRequest TLS SNI pinning (#6141)", () => {
  const ca = sniPinSetup as CaMaterial;

  it("validates the certificate against the real target hostname while connecting to the pinned address", async () => {
    const tlsServer = await startTlsServer(ca.serverKey, ca.serverCert);
    tlsServers.push(tlsServer);

    const trustedAgent = new https.Agent({ ca: fs.readFileSync(ca.corporateCaCert) });
    const originalAgent = https.globalAgent;
    https.globalAgent = trustedAgent;
    try {
      const target: HttpsPinTarget = {
        // The leaf cert's SAN covers "localhost"; connecting via the pinned
        // loopback address (not a fresh DNS lookup of the hostname) must still
        // validate against this real hostname through TLS SNI.
        targetUrl: new URL(`https://localhost:${tlsServer.port}/`),
        pinnedAddress: "127.0.0.1",
        credential: TEST_CREDENTIAL,
      };
      const adapter = createForwardTestServer(target);
      const { baseUrl } = await listen(adapter);

      const response = await fetch(`${baseUrl}/`, { method: "POST", body: "{}" });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      https.globalAgent = originalAgent;
      trustedAgent.destroy();
    }
  });

  it("fails closed when the pinned target hostname is not covered by the upstream certificate", async () => {
    const tlsServer = await startTlsServer(ca.serverKey, ca.serverCert);
    tlsServers.push(tlsServer);

    const trustedAgent = new https.Agent({ ca: fs.readFileSync(ca.corporateCaCert) });
    const originalAgent = https.globalAgent;
    https.globalAgent = trustedAgent;
    try {
      const target: HttpsPinTarget = {
        // Same server/cert as the positive case, but a hostname the leaf
        // certificate does not cover: certificate hostname verification must
        // still reject this, proving the pin never disables verification.
        targetUrl: new URL(`https://not-the-real-host.invalid:${tlsServer.port}/`),
        pinnedAddress: "127.0.0.1",
        credential: TEST_CREDENTIAL,
      };
      const adapter = createForwardTestServer(target);
      const { baseUrl } = await listen(adapter);

      const response = await fetch(`${baseUrl}/`, { method: "POST", body: "{}" });
      expect(response.status).toBe(502);
    } finally {
      https.globalAgent = originalAgent;
      trustedAgent.destroy();
    }
  });
});
