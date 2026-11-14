// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { buffer } from "node:stream/consumers";
import {
  createBrokerRelayPeer,
  createRelayMeasurements,
  measureRelayFiles,
} from "../runtime/native-broker-relay-protocol.mts";
import { containedBrokerRelayFiles } from "../runtime/native-broker-tunnel.mts";
import { readNativeUiTunnelMarker } from "../runtime/native-ui-tunnel.mts";
import { openNativeUiFileOwner } from "../runtime/native-ui-file-owner.mts";

const slot = "stream-0123456789abcdef";
async function fixture(action: (root: string) => Promise<void>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-measurement-"));
  try {
    fs.mkdirSync(path.join(root, slot));
    await action(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const enabled of [false, true])
  test(`real file adapter retains byte/flush/error behavior with counters ${enabled ? "on" : "off"}`, async () => {
    await fixture(async (root) => {
      const counters = enabled ? createRelayMeasurements() : undefined;
      const original = containedBrokerRelayFiles(root, counters);
      const files = measureRelayFiles(original, counters);
      if (!enabled) assert.equal(files, original);
      const canary = Buffer.from("NO_PAYLOAD_IN_COUNTERS");
      assert.equal(await files.read(`${slot}/host-0000000001.bin`), null);
      await files.write(`${slot}/host-0000000001.bin`, canary);
      assert.deepEqual(await files.read(`${slot}/host-0000000001.bin`), canary);
      assert.deepEqual(await files.list(slot), ["host-0000000001.bin"]);
      await assert.rejects(files.write(`${slot}/host-0000000001.bin`, canary), { code: "EEXIST" });
      await files.unlink(`${slot}/host-0000000001.bin`);
      if (!counters) return;
      const saved = counters.snapshot();
      assert.equal(saved.operations.read.calls, 2);
      assert.equal(saved.operations.read.successes, 1);
      assert.equal(saved.operations.read.misses, 1);
      assert.equal(saved.operations.read.bytes, canary.length);
      assert.equal(saved.operations.write.successes, 1);
      assert.equal(saved.operations.write.failures, 1);
      assert.equal(saved.operations.write.bytes, canary.length);
      assert.equal(saved.operations.flush.calls, 1);
      assert.equal(saved.operations.flush.successes, 1);
      assert(saved.operations.flush.totalMs >= saved.operations.flush.maxMs);
      assert.equal(saved.operations.list.entries, 1);
      assert(!JSON.stringify(saved).includes(canary.toString()));
      assert(!JSON.stringify(saved).includes(root));
      assert(!JSON.stringify(saved).includes(slot));
    });
  });

test("contained UI marker read counts successes/misses and preserves malformed-file rejection", async () => {
  await fixture(async (root) => {
    const counters = createRelayMeasurements();
    assert.equal(readNativeUiTunnelMarker(path.join(root, "missing"), counters), null);
    fs.writeFileSync(path.join(root, "ready"), "opaque-marker");
    assert.equal(readNativeUiTunnelMarker(path.join(root, "ready"), counters), "opaque-marker");
    fs.writeFileSync(path.join(root, "oversized"), "x".repeat(4097));
    assert.throws(
      () => readNativeUiTunnelMarker(path.join(root, "oversized"), counters),
      /marker is invalid/u,
    );
    const result = counters.snapshot();
    assert.equal(result.operations.read.calls, 3);
    assert.equal(result.operations.read.successes, 1);
    assert.equal(result.operations.read.misses, 1);
    assert.equal(result.operations.read.failures, 1);
    assert(!JSON.stringify(result).includes("opaque-marker"));
  });
});

test("real relay idle scans, HTTP streaming, slot reuse and cleanup remain measured separately", async () => {
  await fixture(async (root) => {
    // Portable transport/I/O control, not a substitute for the native Windows
    // host authority. Both peers use actual files and real localhost sockets.
    const slots = Array.from({ length: 32 }, () => `stream-${randomBytes(8).toString("hex")}`);
    for (const name of slots) fs.mkdirSync(path.join(root, name));
    const token = randomBytes(32).toString("base64url");
    const server = http.createServer(async (req, res) => {
      res.end(await buffer(req));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const hostCounters = createRelayMeasurements(),
      containedCounters = createRelayMeasurements();
    const host = await createBrokerRelayPeer({
      files: containedBrokerRelayFiles(root, hostCounters),
      token,
      slots,
      side: "host",
      brokerPort: port,
      measurements: hostCounters,
    });
    let sandbox: Awaited<ReturnType<typeof createBrokerRelayPeer>> | undefined;
    try {
      sandbox = await createBrokerRelayPeer({
        files: containedBrokerRelayFiles(root, containedCounters),
        token,
        slots,
        side: "sandbox",
        measurements: containedCounters,
      });
      await sleep(65);
      const idle = hostCounters.snapshot();
      assert(idle.scans.idle >= 32);
      assert.equal(idle.scans.active, 0);
      assert(idle.operations.poll.calls > 0);
      assert(idle.operations.read.misses > 0);
      const payload = Buffer.alloc(96 * 1024, 0x6d);
      for (let turn = 0; turn < 36; turn++) {
        const received = await new Promise<Buffer>((resolve, reject) => {
          const req = http.request(
            { host: "127.0.0.1", port: sandbox!.port!, method: "POST", agent: false },
            (res) => {
              buffer(res).then(resolve, reject);
            },
          );
          req.on("error", reject);
          req.end(payload);
        });
        assert(received.equals(payload));
      }
      const deadline = performance.now() + 5000;
      while (sandbox.diagnostics().completedConnections < 36 && performance.now() < deadline)
        await sleep(10);
      assert.equal(sandbox.diagnostics().completedConnections, 36);
      const active = containedCounters.snapshot();
      assert(active.scans.active > 0);
      assert(active.operations.write.bytes > 36 * payload.length);
      assert(active.operations.read.bytes > 36 * payload.length);
      assert(active.operations.flush.calls > 36);
      assert(!JSON.stringify(active).includes(token));
      await sandbox.close();
      await host.close();
      const stopped = hostCounters.snapshot();
      await sleep(35);
      assert.deepEqual(hostCounters.snapshot(), stopped);
      assert.equal(host.diagnostics().activeConnections, 0);
      assert.equal(sandbox.diagnostics().activeConnections, 0);
    } finally {
      await sandbox?.close();
      await host.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

const launcher = process.env.NEMOCLAW_NATIVE_TEST_LAUNCHER;
test(
  "real Windows owner publishes bounded actual native flush counters only when enabled",
  { skip: process.platform !== "win32" || !launcher },
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-relay-measurement-"));
    let owner: Awaited<ReturnType<typeof openNativeUiFileOwner>> | undefined;
    try {
      const counters = createRelayMeasurements();
      owner = await openNativeUiFileOwner(launcher!, path.join(root, "relay"), counters);
      await owner.mkdir(slot);
      await owner.write(`${slot}/host-0000000001.bin`, "native bytes");
      assert.equal((await owner.read(`${slot}/host-0000000001.bin`))?.toString(), "native bytes");
      assert.equal(await owner.read(`${slot}/host-0000000002.bin`), null);
      const native = await owner.nativePerformance();
      assert(native);
      assert.equal(native.counters.flush_calls, 1);
      assert.equal(native.counters.binary_flush_calls, 1);
      assert.equal(native.counters.write_success, 1);
      assert.equal(native.counters.read_success, 1);
      assert.equal(native.counters.read_miss, 1);
      assert(native.counters.flush_ns > 0);
      assert(native.counters.flush_ns >= native.counters.flush_max_ns);
      assert(!JSON.stringify(native).includes(slot));
      await owner.close();
      owner = undefined;
    } finally {
      await owner?.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
