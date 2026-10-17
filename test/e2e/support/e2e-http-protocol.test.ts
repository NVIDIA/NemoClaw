// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import https from "node:https";
import { describe, expect, it } from "vitest";
import {
  closeServer,
  listenServer,
  readRequestBody,
  writeJsonResponse,
  writeSseEvents,
} from "../fixtures/http-protocol.ts";
import { startFakeHttpsCompatibleServer } from "../live/https-pin-compatible-server.ts";
import { startRuntimeIdentityOAuthServer } from "../live/runtime-identity-oauth-server.ts";

describe("fake provider HTTP protocol", () => {
  it.each([
    {
      name: "compatible HTTPS",
      start: () => startFakeHttpsCompatibleServer({ apiKey: "fixture-only", model: "test" }),
      path: "/v1/models",
      method: "GET",
      headers: { authorization: "Bearer fixture-only" },
      status: 200,
    },
    {
      name: "OAuth HTTPS",
      start: () =>
        startRuntimeIdentityOAuthServer({
          clientId: "fixture-client",
          clientSecret: "fixture-secret",
          initialRefreshToken: "fixture-refresh",
        }),
      path: "/resource",
      method: "HEAD",
      headers: {},
      status: 401,
    },
  ])("returns the listening TCP port for the $name fixture", async (scenario) => {
    const fixture = await scenario.start();
    try {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const request = https.request(
          {
            hostname: "127.0.0.1",
            port: fixture.port,
            path: scenario.path,
            method: scenario.method,
            headers: scenario.headers,
            ca: fixture.certificate,
          },
          (response) => {
            response.resume();
            response.on("end", () => resolve(response.statusCode));
            response.on("error", reject);
          },
        );
        request.on("error", reject);
        request.end();
      });
      expect(status).toBe(scenario.status);
    } finally {
      await fixture.close();
    }
  });

  it("reads request bodies and writes JSON responses", async () => {
    let body = "";
    const server = http.createServer(async (req, res) => {
      body = await readRequestBody(req);
      writeJsonResponse(res, 201, { ok: true });
    });
    const port = await listenServer(server, 0, "127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: "payload" });
      expect(response.status).toBe(201);
      expect(await response.json()).toEqual({ ok: true });
      expect(body).toBe("payload");
    } finally {
      await closeServer(server);
    }
  });

  it("writes named and data-only SSE events with a done marker", async () => {
    const server = http.createServer((_req, res) =>
      writeSseEvents(
        res,
        [
          ["message", { text: "one" }],
          [undefined, { text: "two" }],
        ],
        true,
      ),
    );
    const port = await listenServer(server, 0, "127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}`);
      const text = await response.text();
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(text).toContain('event: message\ndata: {"text":"one"}');
      expect(text).toContain("data: [DONE]");
    } finally {
      await closeServer(server);
    }
  });
});
