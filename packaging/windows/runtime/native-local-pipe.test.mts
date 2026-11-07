// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { nativeLocalPipeName, readNativeBrokerBootstrap } from "./native-local-pipe.mts";

test("native pipe names reject non-Windows use and invalid ports", () => {
  for (const port of [0, -1, 65536, NaN, Infinity, 1.5])
    assert.throws(() => nativeLocalPipeName(port), /valid declared port/u);
  if (process.platform !== "win32")
    assert.throws(() => nativeLocalPipeName(18790), /requires Windows/u);
  else
    assert.equal(nativeLocalPipeName(18790), String.raw`\\.\pipe\LOCAL\OpenShell-Loopback-18790`);
});

test(
  "native bootstrap uses the declared pipe and rejects redirects, oversized and malformed replies",
  { skip: process.platform !== "win32" },
  async () => {
    const port = 20000 + (process.pid % 40000);
    const token = "fixture-bootstrap-token-0123456789";
    let mode = "ok";
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests++;
      assert.equal(request.method, "POST");
      assert.equal(request.url, "/native/bootstrap");
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      if (mode === "redirect") {
        response.writeHead(302, { location: "http://127.0.0.1:1/private" });
        response.end();
      } else if (mode === "oversized") response.end("x".repeat(1024 * 1024 + 1));
      else if (mode === "malformed") response.end("not-json");
      else response.end(JSON.stringify({ environment: {}, openclaw: {} }));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(nativeLocalPipeName(port), resolve);
    });
    try {
      assert.deepEqual(await readNativeBrokerBootstrap(port, token), {
        environment: {},
        openclaw: {},
      });
      await assert.rejects(readNativeBrokerBootstrap(port, "bad\r\nheader"), /identity/u);
      for (mode of ["redirect", "oversized", "malformed"])
        await assert.rejects(readNativeBrokerBootstrap(port, token));
      assert.equal(requests, 4);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  },
);
