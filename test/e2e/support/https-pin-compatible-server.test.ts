// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import https from "node:https";
import { expect, it, onTestFinished } from "vitest";
import { startFakeHttpsCompatibleServer } from "../live/https-pin-compatible-server.ts";

it("serves an authenticated streamed completion for the native HTTPS agent fixture (#12636)", async () => {
  const server = await startFakeHttpsCompatibleServer({
    apiKey: "test-fixture-key",
    model: "model",
    chatContent: "PONG",
  });
  onTestFinished(() => server.close());
  const response = await new Promise<{
    status: number | undefined;
    type: string | undefined;
    body: string;
  }>((resolve, reject) => {
    const request = https.request(
      {
        hostname: "127.0.0.1",
        port: server.port,
        path: "/v1/chat/completions",
        method: "POST",
        rejectUnauthorized: false,
        headers: { authorization: "Bearer test-fixture-key", "content-type": "application/json" },
      },
      (result) => {
        let body = "";
        result.setEncoding("utf8");
        result.on("data", (chunk: string) => {
          body += chunk;
        });
        result.on("end", () =>
          resolve({ status: result.statusCode, type: result.headers["content-type"], body }),
        );
      },
    );
    request.on("error", reject);
    request.end(
      JSON.stringify({
        model: "model",
        stream: true,
        messages: [{ role: "user", content: "PONG" }],
      }),
    );
  });
  expect(response.status).toBe(200);
  expect(response.type).toBe("text/event-stream");
  const frames = response.body.trim().split("\n\n");
  expect(JSON.parse(frames[0]!.slice(6))).toMatchObject({
    model: "model",
    choices: [{ delta: { content: "PONG" } }],
  });
  expect(JSON.parse(frames[1]!.slice(6))).toMatchObject({ choices: [{ finish_reason: "stop" }] });
  expect(frames[2]).toBe("data: [DONE]");
  expect(server.requests()).toMatchObject([
    { auth: "ok", method: "POST", path: "/v1/chat/completions" },
  ]);
});
