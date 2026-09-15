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
      writeJsonResponse(res, 201, { text: "café" });
    });
    const port = await listenServer(server, 0, "127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, { method: "POST", body: "entrée" });
      expect(response.status).toBe(201);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("content-length")).toBe("16");
      expect(await response.json()).toEqual({ text: "café" });
      expect(body).toBe("entrée");
    } finally {
      await closeServer(server);
    }
  });

  it.each([false, true])("writes SSE event boundaries with done=%s", async (done) => {
    const server = http.createServer((_req, res) =>
      writeSseEvents(
        res,
        [
          ["message", { text: "one" }],
          [undefined, { text: "two" }],
        ],
        done,
      ),
    );
    const port = await listenServer(server, 0, "127.0.0.1");
    try {
      const response = await fetch(`http://127.0.0.1:${port}`);
      const text = await response.text();
      expect(response.headers.get("content-type")).toBe("text/event-stream");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-cache");
      expect(text).toBe(
        'event: message\ndata: {"text":"one"}\n\ndata: {"text":"two"}\n\n' +
          (done ? "data: [DONE]\n\n" : ""),
      );
    } finally {
      await closeServer(server);
    }
  });
});
