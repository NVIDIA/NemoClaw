// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { test } from "node:test";
import {
  ownerRecordPath,
  readOwnerRecord,
  writeOwnerRecord,
  type NativeOwnerRecord,
} from "./native-inference-host.mts";
import { verifyNativeUpstreamAuthentication } from "./native-inference.mts";

test(
  "native owner publication survives transient Windows reader locks",
  { skip: process.platform !== "win32" },
  async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-owner-replace-"));
    const previous = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = root;
    t.after(() => {
      if (previous === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = previous;
      fs.rmSync(root, { force: true, recursive: true });
    });
    const credential = "native-owner-replace-test";
    const record: NativeOwnerRecord = {
      schemaVersion: 1,
      instance: randomUUID(),
      localModel: "qwen3.8-27b",
      model: "qwen3.8-27b",
      port: 49152,
      pid: process.pid,
      launcherPid: process.pid,
      status: "starting",
    };
    writeOwnerRecord(record, credential);
    const file = ownerRecordPath();
    const script = [
      "$stream=[IO.File]::Open($env:NEMOCLAW_TEST_OWNER_PATH,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)",
      "[Console]::Out.WriteLine('ready')",
      "[Console]::Out.Flush()",
      "[Threading.Thread]::Sleep(250)",
      "$stream.Dispose()",
    ].join(";");
    const reader = spawn("powershell.exe", ["-NoProfile", "-Command", script], {
      env: { ...process.env, NEMOCLAW_TEST_OWNER_PATH: file },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const closed = once(reader, "close");
    const [ready] = await once(reader.stdout, "data");
    assert.match(ready.toString("utf8"), /ready/u);

    writeOwnerRecord({ ...record, status: "ready" }, credential);

    const [code] = await closed;
    assert.equal(code, 0);
    assert.equal(readOwnerRecord(credential)?.status, "ready");
    assert.deepEqual(
      fs.readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp")),
      [],
    );
  },
);

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
