// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomInt } from "node:crypto";
import { buffer } from "node:stream/consumers";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createBrokerRelayPeer, createRelayMeasurements } from "./native-broker-relay-protocol.mts";
import { containedBrokerRelayFiles } from "./native-broker-tunnel.mts";
import { nativeLocalPipeName } from "./native-local-pipe.mts";

test("broker pipe rejects host-side and invalid-port selection before I/O", async () => {
  const options = { files: containedBrokerRelayFiles("unused"), token: "a".repeat(32), slots: [] };
  await assert.rejects(
    createBrokerRelayPeer({ ...options, side: "host", sandboxPipePort: 18790 }),
    /invalid frame/,
  );
  for (const port of [0, -1, 65536, 1.5])
    await assert.rejects(
      createBrokerRelayPeer({ ...options, side: "sandbox", sandboxPipePort: port }),
    );
});

test(
  "Windows broker pipe relays multi-frame HTTP, reuses slots and closes its listener",
  { skip: process.platform !== "win32", timeout: 30000 },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-broker-pipe-"));
    const slots = Array.from({ length: 32 }, () => `stream-${randomBytes(8).toString("hex")}`);
    for (const slot of slots) fs.mkdirSync(path.join(root, slot));
    const token = randomBytes(32).toString("base64url");
    const pipePort = randomInt(20000, 60000);
    const socketPath = nativeLocalPipeName(pipePort);
    const server = http.createServer(async (request, response) =>
      response.end(await buffer(request)),
    );
    let host: Awaited<ReturnType<typeof createBrokerRelayPeer>> | undefined;
    let sandbox: typeof host;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const brokerPort = (server.address() as { port: number }).port;
      // Both sides use owned files here; this does not qualify native host file authority.
      const options = { files: containedBrokerRelayFiles(root), token, slots };
      const measurements = createRelayMeasurements();
      host = await createBrokerRelayPeer({ ...options, side: "host", brokerPort, measurements });
      sandbox = await createBrokerRelayPeer({
        ...options,
        side: "sandbox",
        sandboxPipePort: pipePort,
      });
      assert.equal(sandbox.port, pipePort);
      const initialPolls = measurements.snapshot().operations.poll.calls;
      await delay(250);
      const idlePolls = measurements.snapshot().operations.poll.calls - initialPolls;
      assert.ok(idlePolls > 0 && idlePolls <= 3, `Unexpected idle poll count: ${idlePolls}`);
      const request = (payload: Buffer) =>
        new Promise<Buffer>((resolve, reject) => {
          const req = http.request(
            { socketPath, path: "/echo", method: "POST", agent: false, timeout: 3000 },
            (response) => buffer(response).then(resolve, reject),
          );
          req.once("error", reject);
          req.once("timeout", () => req.destroy(new Error("Broker pipe request timed out")));
          req.end(payload);
        });
      const payload = randomBytes(96 * 1024);
      for (let turn = 0; turn < 36; turn++) assert.deepEqual(await request(payload), payload);
      const deadline = performance.now() + 5000;
      while (sandbox.diagnostics().completedConnections < 36 && performance.now() < deadline)
        await delay(10);
      assert.equal(sandbox.diagnostics().completedConnections, 36);
      await sandbox.close();
      await host.close();
      assert.equal(sandbox.diagnostics().activeConnections, 0);
      assert.equal(host.diagnostics().activeConnections, 0);
      await assert.rejects(request(Buffer.from("closed")), { code: "ENOENT" });
    } finally {
      try {
        await sandbox?.close();
      } finally {
        try {
          await host?.close();
        } finally {
          server.closeAllConnections();
          await new Promise<void>((resolve) => server.close(() => resolve()));
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
);
