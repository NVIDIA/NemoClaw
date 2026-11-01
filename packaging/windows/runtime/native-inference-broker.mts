// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type IncomingMessage } from "node:http";
import { compose } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { createNativeServiceBootstrap, type NativeOptions } from "./native-options.mts";
import { brokerOperationForRequest, resolveBrokerUpstreamUrl } from "./native-security.mts";
import { requestNativeInference } from "./native-inference-endpoint.mts";
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

function providerResponseBody(response: IncomingMessage) {
  const encoding = response.headers["content-encoding"]?.toLowerCase().trim();
  if (!encoding || encoding === "identity") return response;
  const decoder =
    encoding === "gzip" || encoding === "x-gzip"
      ? createGunzip()
      : encoding === "deflate"
        ? createInflate()
        : encoding === "br"
          ? createBrotliDecompress()
          : null;
  if (!decoder) {
    response.destroy();
    fail("the provider response encoding is unsupported");
  }
  // Retain fetch's decoded response semantics and apply the limit after decoding.
  // Composition propagates decompression errors and cancellation to the socket.
  return compose(response, decoder);
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
      const featured =
        configuration.inference === "nvidia" &&
        request.method === "GET" &&
        request.url === "/native/nvidia-featured-models";
      if (operation === null && !featured) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "not found" } }));
        return;
      }
      if (request.headers.authorization !== `Bearer ${brokerToken}`) {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "unauthorized" } }));
        return;
      }
      const upstreamUrl = featured
        ? new URL("https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json")
        : resolveBrokerUpstreamUrl(configuration.endpoint, operation!);
      const body =
        request.method === "GET" || request.method === "HEAD"
          ? undefined
          : await readBrokerRequest(request);
      const headers: Record<string, string> = {
        accept: request.headers.accept ?? "application/json",
      };
      if (request.headers["content-type"])
        headers["content-type"] = request.headers["content-type"];
      if (credential && !featured) headers.authorization = `Bearer ${credential}`;
      if (configuration.inference === "openrouter") {
        headers["http-referer"] = "https://www.nvidia.com/nemoclaw/";
        headers["x-openrouter-title"] = "NVIDIA NemoClaw";
      }
      const upstream = await requestNativeInference(new URL(upstreamUrl), configuration.inference, {
        method: request.method!,
        headers,
        body,
        signal: AbortSignal.any([cancelled.signal, AbortSignal.timeout(180_000)]),
      });
      const chunks: Uint8Array[] = [];
      let responseSize = 0;
      for await (const chunk of providerResponseBody(upstream)) {
        responseSize += chunk.byteLength;
        if (responseSize > 32 * 1024 * 1024) {
          cancelled.abort();
          fail("the provider response exceeded the broker limit");
        }
        chunks.push(chunk);
      }
      const responseBody = Buffer.concat(chunks, responseSize);
      response.statusCode = upstream.statusCode!;
      response.setHeader("cache-control", "no-store");
      response.setHeader("content-type", upstream.headers["content-type"] ?? "application/json");
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
