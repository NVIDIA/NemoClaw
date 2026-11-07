// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";
import type { startNativeInferenceBroker } from "./native-inference-broker.mts";

test("catalog broker authenticates discovery, fixes its upstream and never sends the API key to metadata", async () => {
  const requests: { url: URL; inference: string; options: { headers: Record<string, string> } }[] =
    [];
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./native-inference-broker.mts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    plugins: [
      {
        name: "provider-response-fixture",
        setup(builder) {
          builder.onLoad({ filter: /native-inference-endpoint\.mts$/ }, () => ({
            contents: "export const requestNativeInference = globalThis.fixtureRequest;",
            loader: "js",
          }));
        },
      },
    ],
  });
  const module = {
    exports: {} as { startNativeInferenceBroker: typeof startNativeInferenceBroker },
  };
  runInNewContext(bundled.outputFiles[0]!.text, {
    module,
    exports: module.exports,
    require: createRequire(import.meta.url),
    URL,
    Buffer,
    AbortController,
    AbortSignal,
    process,
    fixtureRequest: async (
      url: URL,
      inference: string,
      options: { headers: Record<string, string> },
    ) => {
      requests.push({ url, inference, options });
      return Object.assign(Readable.from([Buffer.from('{"data":[{"id":"fixture"}]}')]), {
        statusCode: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  for (const inference of ["nvidia", "openrouter", "compatible", "local"]) {
    const broker = await module.exports.startNativeInferenceBroker(
      { inference, endpoint: "https://selected.invalid/v1" },
      "host-only-key",
      "guest-token",
      { options: {}, environment: {} },
    );
    const base = `http://127.0.0.1:${broker.port}`;
    try {
      const headers = { authorization: "Bearer guest-token" };
      const before = requests.length;
      assert.equal((await fetch(base + "/v1/models")).status, 401);
      assert.equal(
        (await fetch(base + "/native/nvidia-featured-models")).status,
        inference === "nvidia" ? 401 : 404,
      );
      for (const target of [
        "/v1/models?url=https://other.invalid",
        "/native/nvidia-featured-models?url=https://other.invalid",
        "/v1/responses",
      ])
        assert.equal((await fetch(base + target, { headers })).status, 404);
      assert.equal(requests.length, before);
      assert.equal((await fetch(base + "/v1/models", { headers })).status, 200);
      assert.equal(requests.at(-1)!.url.href, "https://selected.invalid/v1/models");
      assert.equal(requests.at(-1)!.options.headers.authorization, "Bearer host-only-key");
      const featured = await fetch(base + "/native/nvidia-featured-models", { headers });
      assert.equal(featured.status, inference === "nvidia" ? 200 : 404);
      if (inference === "nvidia") {
        assert.equal(
          requests.at(-1)!.url.href,
          "https://assets.ngc.nvidia.com/products/api-catalog/featured-models.json",
        );
        assert.equal(requests.at(-1)!.options.headers.authorization, undefined);
      }
      assert(!JSON.stringify(requests).includes("guest-token"));
    } finally {
      broker.server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        broker.server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }
});
