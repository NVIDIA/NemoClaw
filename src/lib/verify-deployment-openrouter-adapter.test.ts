// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { buildChain } from "./dashboard/contract.js";
import {
  adapterAuthorizationHash,
  createOpenRouterRuntimeAdapterServer,
} from "./inference/openrouter-runtime-adapter.js";
import { verifyDeployment } from "./verify-deployment.js";

const TOKEN = "sk-or-verifier-contract";
const MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
const servers: http.Server[] = [];

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
});

function listen(server: http.Server): Promise<string> {
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      expect(address).toEqual(expect.objectContaining({ address: "127.0.0.1" }));
      resolve(`http://127.0.0.1:${String((address as AddressInfo).port)}`);
    });
  });
}

async function probeCatalog(baseUrl: string, statuses: number[]) {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  statuses.push(response.status);
  return { status: 0, stdout: String(response.status), stderr: "" };
}

describe("OpenRouter adapter deployment verification", () => {
  it("accepts the real catalog 404 only while the real chat route serves inference (#12621)", async () => {
    let upstreamStatus = 200;
    const upstreamRequests: Array<{ method: string | undefined; url: string | undefined }> = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({ method: req.method, url: req.url });
      res.writeHead(upstreamStatus, { "Content-Type": "application/json" });
      res.end(
        upstreamStatus === 200
          ? JSON.stringify({ choices: [{ message: { content: "PONG" } }] })
          : JSON.stringify({ error: { message: "model unavailable" } }),
      );
    });
    const upstreamBaseUrl = await listen(upstream);
    const adapter = createOpenRouterRuntimeAdapterServer({
      authorizationHash: adapterAuthorizationHash(TOKEN),
      upstreamBaseUrl: `${upstreamBaseUrl}/api/v1`,
    });
    const adapterBaseUrl = await listen(adapter);
    const catalogStatuses: number[] = [];

    const deps = {
      executeSandboxCommand: (_name: string, script: string) =>
        script.includes("inference.local")
          ? probeCatalog(adapterBaseUrl, catalogStatuses)
          : Promise.resolve({ status: 0, stdout: "200", stderr: "" }),
      probeHostPort: (_port: number, _path: string) => 200,
      captureForwardList: () => "my-sandbox  127.0.0.1  18789  12345  running",
      getMessagingChannels: (_name: string) => [] as string[],
      providerExistsInGateway: (_name: string) => true,
      probeInferenceInvocation: async () => {
        const response = await fetch(`${adapterBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ model: MODEL, messages: [{ role: "user", content: "PONG" }] }),
        });
        return {
          ok: response.ok,
          detail: `HTTP ${String(response.status)}`,
          httpStatus: response.status,
        };
      },
    };
    const options = {
      retryDelaysMs: [],
      sleep: async (_ms: number) => {},
      inferenceRouteContext: { provider: "openrouter-api" },
    };

    const served = await verifyDeployment("my-sandbox", buildChain(), deps, options);
    expect(served.verification.inferenceRouteWorking).toBe(true);
    expect(served.healthy).toBe(true);

    upstreamStatus = 404;
    const unavailable = await verifyDeployment("my-sandbox", buildChain(), deps, options);
    expect(unavailable.verification.inferenceRouteWorking).toBe(false);
    expect(unavailable.healthy).toBe(false);

    expect(catalogStatuses).toEqual([404, 404]);
    expect(upstreamRequests).toEqual([
      { method: "POST", url: "/api/v1/chat/completions" },
      { method: "POST", url: "/api/v1/chat/completions" },
    ]);
  });
});
