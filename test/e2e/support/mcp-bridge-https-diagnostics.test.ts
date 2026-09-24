// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { once } from "node:events";
import https from "node:https";
import net from "node:net";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { startFakeMcpHttpsServer, type StartedHttpServer } from "../live/mcp-bridge-servers.ts";
import { shouldRetryMcpDiscoveryAfterRestart } from "../live/mcp-bridge-tool-discovery.ts";
import { createMcpFixtureTls } from "../fixtures/mcp-fixture-tls.ts";

const { tls: fixtureTls, close: closeFixtureTls } = createMcpFixtureTls();
const servers: StartedHttpServer[] = [];
afterAll(closeFixtureTls);
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
describe("MCP HTTPS transport diagnostics", () => {
  it("records only fixed TLS failure categories and closes when diagnostic persistence fails", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("artifact unavailable"));
    const server = await startFakeMcpHttpsServer({
      secret: "diagnostic-secret",
      tls: fixtureTls,
      onCloseDiagnostics: persist,
    });
    const client = net.connect(server.port, "127.0.0.1");
    let reconnect: net.Socket | undefined;
    try {
      client.on("error", () => {});
      client.resume();
      const closed = once(client, "close");
      client.end("GET /injected-sensitive-marker HTTP/1.1\r\nHost: localhost\r\n\r\n");
      await closed;
      await expect.poll(() => server.diagnostics().tlsClientErrors.ERR_SSL_HTTP_REQUEST).toBe(1);
      expect(server.diagnostics()).toEqual({
        secureConnections: 0,
        requestHeaders: 0,
        requestBodiesComplete: 0,
        tlsClientErrors: {
          ERR_SSL_HTTP_REQUEST: 1,
          ERR_SSL_WRONG_VERSION_NUMBER: 0,
          ERR_SSL_UNEXPECTED_EOF_WHILE_READING: 0,
          ECONNRESET: 0,
          OTHER: 0,
        },
      });
      await expect(server.close()).rejects.toThrow("artifact unavailable");
      expect(persist).toHaveBeenCalledWith(server.diagnostics());
      reconnect = net.connect(server.port, "127.0.0.1");
      const [error] = await once(reconnect, "error");
      expect(error.code).toBe("ECONNREFUSED");
    } finally {
      client.destroy();
      reconnect?.destroy();
      persist.mockResolvedValue(undefined);
      await server.close().catch((error: NodeJS.ErrnoException) => {
        expect(error).toMatchObject({ code: "ERR_SERVER_NOT_RUNNING" });
      });
    }
  });

  it("records a slow POST arrival before its body completes", async () => {
    const secret = "slow-request-secret";
    const server = await startFakeMcpHttpsServer({ secret, tls: fixtureTls });
    servers.push(server);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    const observationOffset = server.observations.length;
    let resolveResponse!: (status: number) => void;
    let rejectResponse!: (error: Error) => void;
    const responseStatus = new Promise<number>((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    const observedStatus = responseStatus.then(
      (status) => ({ ok: true, status }) as const,
      (error: unknown) => ({ error, ok: false }) as const,
    );
    const slowRequest = https.request(
      `https://127.0.0.1:${server.port}/mcp`,
      {
        method: "POST",
        ca: fixtureTls.cert,
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolveResponse(response.statusCode ?? 0));
      },
    );
    slowRequest.on("error", rejectResponse);
    try {
      slowRequest.write(body.slice(0, 1));

      await expect.poll(() => server.observations.length).toBe(observationOffset + 1);
      const arrival = server.observations[observationOffset];
      expect(server.requests).toHaveLength(0);
      expect(server.diagnostics()).toMatchObject({
        secureConnections: 1,
        requestHeaders: 1,
        requestBodiesComplete: 0,
      });
      expect(arrival).toMatchObject({
        method: "POST",
        path: "/mcp",
        auth: `Bearer ${secret}`,
        body: "",
      });
      expect(
        shouldRetryMcpDiscoveryAfterRestart(server.observations.slice(observationOffset)),
      ).toBe(false);

      slowRequest.end(body.slice(1));
      expect(await observedStatus).toEqual({ ok: true, status: 200 });
      expect(server.requests).toHaveLength(1);
      expect(server.observations[observationOffset]).toBe(arrival);
      expect(server.requests[0]).toBe(arrival);
      expect(arrival).toMatchObject({ body, rpcMethod: "initialize" });
      expect(server.diagnostics()).toMatchObject({
        secureConnections: 1,
        requestHeaders: 1,
        requestBodiesComplete: 1,
      });
      const copied = server.diagnostics();
      copied.requestHeaders = 99;
      copied.tlsClientErrors.OTHER = 99;
      expect(server.diagnostics().requestHeaders).toBe(1);
      expect(server.diagnostics().tlsClientErrors.OTHER).toBe(0);
    } finally {
      slowRequest.destroy();
    }
  });
});
