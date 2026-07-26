// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import { describe, expect, it } from "vitest";
import {
  closeServer,
  listenServer,
  readRequestBody,
  writeJsonResponse,
  writeSseEvents,
} from "../fixtures/http-protocol.ts";

describe("fake provider HTTP protocol", () => {
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
