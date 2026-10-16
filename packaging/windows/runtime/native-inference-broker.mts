// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage } from "node:http";
import { createNativeServiceBootstrap, type NativeOptions } from "./native-options.mts";
import { brokerOperationForRequest, resolveBrokerUpstreamUrl } from "./native-security.mts";
import { responseChunks } from "./native-inference-download.mts";
function fail(message: string): never {
  throw new Error(`NemoClaw native inference broker failed: ${message}`);
}

async function readBrokerRequest(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024 * 1024) fail("the agent request exceeded the broker limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function startNativeInferenceBroker(
  configuration: { endpoint: string; inference: string },
  credential: string,
  brokerToken: string,
  services: { options: NativeOptions; environment: Record<string, string> },
) {
  const serviceBootstrap = createNativeServiceBootstrap(services, brokerToken);
  const server = createServer(async (request, response) => {
    const cancelled = new AbortController();
    const closed = () => cancelled.abort();
    response.once("close", closed);
    try {
      if (serviceBootstrap(request, response)) return;
      const operation = brokerOperationForRequest(request.method, request.url);
      if (operation === null) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${brokerToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      const upstreamUrl = resolveBrokerUpstreamUrl(configuration.endpoint, operation);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await readBrokerRequest(request);
      const headers: Record<string, string> = {
        accept: request.headers.accept ?? "application/json",
      };
      if (request.headers["content-type"])
        headers["content-type"] = request.headers["content-type"];
      if (credential) headers.authorization = `Bearer ${credential}`;
      if (configuration.inference === "openrouter") {
        headers["http-referer"] = "https://www.nvidia.com/nemoclaw/";
        headers["x-openrouter-title"] = "NVIDIA NemoClaw";
      }
      // lgtm[js/file-access-to-http] The per-user onboarding configuration is schema checked;
      // the endpoint is protocol/origin checked and the request path is rebuilt from an exact allowlist.
      const upstream = await fetch(upstreamUrl, {
        method: request.method,
        headers,
        body,
        redirect: "error",
        signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(180_000)]),
      });
      const chunks: Uint8Array[] = [];
      let responseSize = 0;
      if (upstream.body) {
        for await (const chunk of responseChunks(upstream.body)) {
          responseSize += chunk.byteLength;
          if (responseSize > 32 * 1024 * 1024) {
            cancelled.abort();
            fail("the provider response exceeded the broker limit");
          }
          chunks.push(chunk);
        }
      }
      const responseBody = Buffer.concat(chunks, responseSize);
      response.writeHead(upstream.status, {
        "cache-control": "no-store",
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      });
      response.end(responseBody);
    } catch (error) {
      if (response.destroyed) return;
      response.writeHead(502, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : "inference provider request failed",
          },
        }),
      );
    } finally {
      response.removeListener("close", closed);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    fail("the broker did not bind an owned loopback port");
  }
  return { server, port: address.port };
}
