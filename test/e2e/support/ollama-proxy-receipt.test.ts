// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { expect, it, vi } from "vitest";

import { readProtectedLocalInferenceCount } from "../../../scripts/checks/managed-image-protected-runtime-contract.ts";
import { buildProxyServer } from "../../../scripts/ollama-auth-proxy.mts";

it("counts only completed authenticated chat requests at the Ollama proxy", async () => {
  const backend = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(request.headers["x-test-fail"] === "1" ? 500 : 200);
      response.end("model response");
    });
  });
  await new Promise<void>((resolve) => backend.listen(0, "127.0.0.1", resolve));
  const backendAddress = backend.address() as AddressInfo;
  const token = "a".repeat(48);
  const proxy = buildProxyServer(token, new URL(`http://127.0.0.1:${backendAddress.port}`));
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const proxyAddress = proxy.address() as AddressInfo;
  const url = `http://127.0.0.1:${proxyAddress.port}`;
  const authorization = `Bearer ${token}`;
  const receipt = async (model = "local-model") => {
    const response = await fetch(
      `${url}/_nemoclaw/e2e-inference-receipt?model=${encodeURIComponent(model)}`,
      {
        headers: { authorization },
      },
    );
    return response.json() as Promise<{ model: string; completedRequests: number }>;
  };
  const request = (auth = authorization, failed = false, model = "local-model") =>
    fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: auth,
        ...(failed ? { "x-test-fail": "1" } : {}),
      },
      body: JSON.stringify({ model, messages: [] }),
    });
  vi.stubEnv(
    "NEMOCLAW_E2E_LOCAL_INFERENCE_BASE_URL",
    `http://host.openshell.internal:${proxyAddress.port}/v1`,
  );
  const selectedModelCount = () =>
    readProtectedLocalInferenceCount(
      {
        agent: "openclaw",
        image: "test-image",
        sandbox: "test-sandbox",
        localProvider: "ollama",
        model: "local-model",
      },
      { NEMOCLAW_OLLAMA_PROXY_TOKEN: token },
    );
  try {
    const activeConfig = await fetch(`${url}/_nemoclaw/proxy-config`, {
      headers: { authorization },
    });
    expect(await activeConfig.json()).not.toHaveProperty("completedRequests");
    expect(await receipt()).toEqual({ model: "local-model", completedRequests: 0 });
    expect((await fetch(`${url}/_nemoclaw/e2e-inference-receipt`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/_nemoclaw/e2e-inference-receipt`, {
          method: "POST",
          headers: { authorization },
        })
      ).status,
    ).toBe(405);
    expect(
      (
        await fetch(`${url}/_nemoclaw/e2e-inference-receipt`, {
          headers: { authorization },
        })
      ).status,
    ).toBe(400);
    expect((await request("Bearer wrong")).status).toBe(401);
    expect((await request(authorization, true)).status).toBe(500);
    expect((await request(authorization, false, "other-model")).status).toBe(200);
    expect((await receipt()).completedRequests).toBe(0);
    expect((await receipt("other-model")).completedRequests).toBe(1);
    expect(await selectedModelCount()).toBe(0);
    const accepted = await request();
    expect(accepted.status).toBe(200);
    expect(await accepted.text()).toBe("model response");
    expect((await receipt()).completedRequests).toBe(1);
    expect(await selectedModelCount()).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    proxy.closeIdleConnections();
    backend.closeIdleConnections();
    await Promise.all([
      new Promise<void>((resolve, reject) =>
        proxy.close((error) => (error ? reject(error) : resolve())),
      ),
      new Promise<void>((resolve, reject) =>
        backend.close((error) => (error ? reject(error) : resolve())),
      ),
    ]);
  }
});
