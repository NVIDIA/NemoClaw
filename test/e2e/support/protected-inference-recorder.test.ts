// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, it } from "vitest";

import { startProtectedInferenceRecorder } from "../lib/protected-inference-recorder.ts";

it("records only authenticated completed requests to the expected local model", async () => {
  let backendRequests = 0;
  const backend = http.createServer((request, response) => {
    backendRequests += 1;
    request.resume();
    request.on("end", () => {
      response.writeHead(request.headers["x-test-fail"] === "1" ? 500 : 200, {
        "content-type": "application/json",
        "x-untrusted-backend-header": "do-not-forward",
      });
      response.end("model response");
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.address() as AddressInfo;
  const recorder = await startProtectedInferenceRecorder({
    bindHost: "127.0.0.1",
    port: 0,
    backendPort: backendAddress.port,
    model: "expected-model",
  });
  const request = (model: string, token = recorder.token, failed = false) =>
    fetch(`http://127.0.0.1:${recorder.port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        ...(failed ? { "x-test-fail": "1" } : {}),
      },
      body: JSON.stringify({ model, messages: [{ role: "user", content: "hello" }] }),
    });
  const receipt = async () => {
    const response = await fetch(
      `http://127.0.0.1:${recorder.port}/_nemoclaw/e2e-inference-receipt`,
      {
        headers: { authorization: `Bearer ${recorder.token}` },
      },
    );
    return response.json() as Promise<{ completedRequests: number }>;
  };
  try {
    expect((await request("expected-model", "wrong-token")).status).toBe(401);
    expect(backendRequests).toBe(0);
    expect((await request("other-model")).status).toBe(200);
    const failed = await request("expected-model", recorder.token, true);
    expect(failed.status).toBe(500);
    expect(failed.headers.get("content-type")).toBe("application/json");
    expect((await receipt()).completedRequests).toBe(0);
    const accepted = await request("expected-model");
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("content-type")).toBe("application/json");
    expect(accepted.headers.get("x-untrusted-backend-header")).toBeNull();
    expect(await accepted.text()).toBe("model response");
    expect((await receipt()).completedRequests).toBe(1);
    expect(backendRequests).toBe(3);
    const publicReceipt = await fetch(
      `http://127.0.0.1:${recorder.port}/_nemoclaw/e2e-inference-receipt`,
    );
    expect(publicReceipt.status).toBe(403);
  } finally {
    await recorder.close();
    await new Promise<void>((resolve, reject) =>
      backend.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
