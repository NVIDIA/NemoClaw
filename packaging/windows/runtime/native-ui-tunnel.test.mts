// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createRelayMeasurements } from "./native-broker-relay-protocol.mts";
import { claimNativeUiTunnelFrame, startNativeUiTunnel } from "./native-ui-tunnel.mts";
import { nativeLocalPipeName } from "./native-local-pipe.mts";

test("native UI tunnel claims a frame before delivering it", () => {
  const removed: string[] = [];
  assert.deepEqual(
    claimNativeUiTunnelFrame(
      "C:\\relay\\stream-1\\host-0000000007.bin",
      {
        startedMs: 10,
        attempts: 2,
      },
      {
        platform: "win32",
        unlink: (file) => {
          removed.push(file);
        },
      },
    ),
    { claimed: true },
  );
  assert.deepEqual(removed, ["C:\\relay\\stream-1\\host-0000000007.bin"]);
});

test("native UI tunnel retries only transient Windows sharing denials", () => {
  for (const code of ["EACCES", "EBUSY", "EPERM"]) {
    let attempts = 0;
    assert.deepEqual(
      claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
        platform: "win32",
        now: () => 100,
        unlink: () => {
          attempts++;
          throw Object.assign(new Error("transient sharing denial"), { code });
        },
      }),
      { claimed: false, retry: { startedMs: 100, attempts: 1 } },
    );
    assert.equal(attempts, 1);
  }
  for (const [platform, code] of [
    ["linux", "EBUSY"],
    ["win32", "EIO"],
  ] as const)
    assert.throws(() =>
      claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
        platform,
        unlink: () => {
          throw Object.assign(new Error("non-retryable unlink failure"), { code });
        },
      }),
    );
});

test("native UI tunnel sharing retries are bounded", () => {
  const unlink = () => {
    throw Object.assign(new Error("persistent sharing denial"), { code: "EBUSY" });
  };
  const first = claimNativeUiTunnelFrame("C:\\relay\\stream-1\\host-0000000007.bin", undefined, {
    platform: "win32",
    now: () => 100,
    unlink,
  });
  assert.equal(first.claimed, false);
  assert.throws(
    () =>
      claimNativeUiTunnelFrame(
        "C:\\relay\\stream-1\\host-0000000007.bin",
        first.claimed ? undefined : first.retry,
        { platform: "win32", now: () => 350, unlink },
      ),
    /remained locked after 2 bounded attempts/u,
  );
});

for (const pipe of process.platform === "win32" ? [false, true] : [false])
  for (const ending of ["overflow", "shutdown", "abort"] as const)
    test(`native UI tunnel bounds discovery and closes owned resources on ${ending} (${pipe ? "pipe" : "tcp"})`, async (t) => {
      const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-stream-limit-"));
      const sockets = new Set<Socket>();
      const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.resume();
      });
      const stop = new AbortController();
      const connect = t.mock.method(net, "createConnection");
      const openDirectory = t.mock.method(fs, "opendirSync");
      const measurements = createRelayMeasurements();
      const measured = t.mock.method(measurements, "finish");
      let tunnel: Promise<unknown> | undefined;
      const waitUntil = async (condition: () => boolean) => {
        const deadline = performance.now() + 5000;
        while (!condition() && performance.now() < deadline) await delay(10);
        assert(condition(), "The owned relay operation must settle within five seconds.");
      };
      try {
        const pipePort = 20000 + (process.pid % 40000);
        await new Promise<void>((resolve) =>
          pipe
            ? server.listen(nativeLocalPipeName(pipePort), resolve)
            : server.listen(0, "127.0.0.1", resolve),
        );
        const relayToken = "owned-stream-limit-control";
        // The host retains closed directories after releasing their pinned handles.
        // Discovery must reach new streams without scanning all history in one poll.
        for (let index = 1000; index < 1300; index++) {
          const root = path.join(relayRoot, `stream-${index.toString(16).padStart(16, "0")}`);
          fs.mkdirSync(root);
          fs.writeFileSync(path.join(root, "sandbox-close"), "");
        }
        tunnel = startNativeUiTunnel({
          relayRoot,
          relayToken,
          uiPort: pipe ? pipePort : (server.address() as AddressInfo).port,
          pipe,
          signal: stop.signal,
          measurements,
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await waitUntil(() => fs.existsSync(path.join(relayRoot, "ready")));
        const addStream = (index: number) => {
          const root = path.join(relayRoot, `stream-${index.toString(16).padStart(16, "0")}`);
          fs.mkdirSync(root);
          fs.writeFileSync(path.join(root, "open"), relayToken);
        };
        for (let index = 0; index < 128; index++) addStream(index);
        await waitUntil(() => connect.mock.callCount() === 129);
        if (ending === "overflow") addStream(128);
        else if (ending === "shutdown")
          fs.writeFileSync(path.join(relayRoot, "shutdown"), relayToken);
        else stop.abort(new Error("Owned abort control"));
        const result = await Promise.race([tunnel, delay(2000, "no settlement", { ref: false })]);
        if (ending === "shutdown") assert.equal(result, null);
        else {
          assert(result instanceof Error, "Overflow and cancellation must reject the tunnel.");
          if (ending === "overflow")
            assert.match(result.message, /native UI relay active-stream limit/u);
          else assert.equal(result, stop.signal.reason);
        }
        assert.equal(
          connect.mock.callCount(),
          129,
          "Only readiness and 128 stream sockets may open.",
        );
        const listings = measured.mock.calls.filter((call) => call.arguments[0] === "list");
        assert(listings.some((call) => call.arguments[4] === 128));
        assert(listings.every((call) => (call.arguments[4] ?? 0) <= 128));
        assert(openDirectory.mock.callCount() > 0);
        for (const call of openDirectory.mock.calls) {
          const directory = call.result;
          assert(directory);
          assert.throws(() => directory.readSync(), { code: "ERR_DIR_CLOSED" });
        }
        for (const call of connect.mock.calls) {
          assert(call.result);
          assert.equal(call.result.destroyed, true);
        }
        await waitUntil(() => sockets.size === 0);
      } finally {
        stop.abort();
        await tunnel;
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(relayRoot, { recursive: true, force: true });
      }
    });
