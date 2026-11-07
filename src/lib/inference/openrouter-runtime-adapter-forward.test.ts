// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { forwardOpenRouterRequest } from "./openrouter-runtime-adapter-forward";

const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function listen(server: http.Server): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
}

/** A minimal server that forwards every request through `forwardOpenRouterRequest`. */
function createForwardTestServer(
  upstreamBaseUrl: string,
  options: { bodyTimeoutMs?: number } = {},
): http.Server {
  return http.createServer(async (req, res) => {
    await forwardOpenRouterRequest({
      req,
      res,
      upstreamBaseUrl,
      bodyTimeoutMs: options.bodyTimeoutMs,
    });
  });
}

describe("forwardOpenRouterRequest body-timeout handling", () => {
  it("delivers the 408 timeout body to the client instead of hanging up the shared socket", async () => {
    const upstream = http.createServer(() => {
      throw new Error("upstream must not be contacted for a stalled request body");
    });
    const upstreamPort = await listen(upstream);

    const adapter = createForwardTestServer(`http://127.0.0.1:${upstreamPort}/api/v1`, {
      bodyTimeoutMs: 50,
    });
    const adapterPort = await listen(adapter);

    // A raw request that declares a body but never finishes sending it, so the
    // adapter's body-read timeout fires before the client ever completes the
    // write. Destroying `req` before `res` flushes tears down the shared
    // socket, and the client sees the connection drop instead of a 408 body.
    const response = await new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = http.request(
          {
            host: "127.0.0.1",
            port: adapterPort,
            path: "/v1/chat/completions",
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
});
