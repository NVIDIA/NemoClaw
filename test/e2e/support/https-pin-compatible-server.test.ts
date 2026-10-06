// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import https from "node:https";
import { spawnSync } from "node:child_process";
import { nativeCompatibleCurlCommand } from "../live/inference-routing-helpers.ts";
import { expect, it } from "vitest";
import { startFakeHttpsCompatibleServer } from "../live/https-pin-compatible-server.ts";

it("serves authenticated streaming agent chat and records the requested path and model", async () => {
  const apiKey = "test-fixture-key";
  const server = await startFakeHttpsCompatibleServer({
    apiKey,
    model: "fixture-model",
    chatContent: "PONG",
  });
  const request = (authorized: boolean) =>
    new Promise<{ status: number; type: string; body: string; location?: string }>(
      (resolve, reject) => {
        const req = https.request(
          {
            hostname: "127.0.0.1",
            port: server.port,
            path: "/v1/chat/completions",
            method: "POST",
            // The real tunnel likewise terminates the fixture's ephemeral local TLS.
            rejectUnauthorized: false,
            headers: {
              "content-type": "application/json",
              ...(authorized ? { authorization: `Bearer ${apiKey}` } : {}),
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 0,
                type: String(res.headers["content-type"]),
                location: res.headers.location,
                body,
              }),
            );
            res.on("error", reject);
          },
        );
        req.on("error", reject);
        req.end(
          JSON.stringify({
            model: "fixture-model",
            stream: true,
            messages: [{ role: "user", content: "PONG" }],
          }),
        );
      },
    );
  try {
    expect((await request(false)).status).toBe(401);
    const response = await request(true);
    expect(response.status).toBe(200);
    expect(response.type).toBe("text/event-stream");
    const events = response.body
      .split("\n\n")
      .filter(Boolean)
      .map((line) => line.slice("data: ".length));
    expect(JSON.parse(events[0])).toMatchObject({
      model: "fixture-model",
      choices: [{ delta: { role: "assistant", content: "PONG" } }],
    });
    expect(JSON.parse(events[1])).toMatchObject({ choices: [{ finish_reason: "stop" }] });
    expect(events[2]).toBe("[DONE]");
    const recorded = server.requests().at(-1)!;
    expect(recorded).toMatchObject({ method: "POST", path: "/v1/chat/completions", auth: "ok" });
    expect(JSON.parse(recorded.body)).toMatchObject({ model: "fixture-model", stream: true });
    expect(JSON.stringify(server.requests())).not.toContain(apiKey);
    const redirectTarget = "http://192.168.1.10:45678/v1/chat/completions";
    server.setChatRedirect(redirectTarget);
    expect(await request(true)).toMatchObject({ status: 302, location: redirectTarget });
    server.setChatRedirect(null);
    expect((await request(true)).status).toBe(200);
  } finally {
    await server.close();
  }
});

it("uses the shared workload-handle guard before invoking curl", () => {
  const [command, ...args] = nativeCompatibleCurlCommand(["--version"]);
  const result = spawnSync(command, args, {
    env: {
      ...process.env,
      NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY: "real-key-MUST-NOT-LEAVE-WORKLOAD",
    },
    encoding: "utf8",
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("credential-handle-unavailable\n");
  expect(result.stderr).toBe("");
});

it("passes curl arguments through the shared guard with an issued workload handle", () => {
  const [command, ...args] = nativeCompatibleCurlCommand(["--version"]);
  const result = spawnSync(command, args, {
    env: {
      ...process.env,
      NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY:
        "openshell:resolve:env:v7_NEMOCLAW_COMPATIBLE_INFERENCE_API_KEY",
    },
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/^curl /u);
});
