// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { verifyNativeUpstreamAuthentication } from "./native-inference.mts";

test("native authentication qualification probes a protected llama.cpp route", async (t) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"data":[]}');
      return;
    }
    assert.equal(request.url, "/props");
    assert.equal(request.headers.authorization, "Bearer invalid-native-qualification-key");
    response.writeHead(401, { "content-type": "application/json" });
    response.end('{"error":{"message":"Invalid API Key"}}');
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");

  await verifyNativeUpstreamAuthentication(address.port);
  assert.deepEqual(requests, ["/props"]);
});

test("native authentication qualification rejects an unprotected upstream", async (t) => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  t.after(() => server.close());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address !== "string");

  await assert.rejects(
    verifyNativeUpstreamAuthentication(address.port),
    /did not reject an incorrect credential/u,
  );
});
