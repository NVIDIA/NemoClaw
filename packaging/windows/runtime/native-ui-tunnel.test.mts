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

test("pipe acceptance cannot be enabled for a TCP tunnel", async () => {
  await assert.rejects(
    startNativeUiTunnel({
      relayRoot: "unused",
      relayToken: "unused",
      uiPort: 8123,
      pipeAcceptance: true,
    }),
    /identity is invalid/u,
  );
});

for (const ending of ["invalid", "abort"] as const)
  test(
    `Hermes readiness requires pipe acceptance (${ending})`,
    { skip: process.platform !== "win32" },
    async () => {
      const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-pipe-readiness-"));
      const sockets = new Set<Socket>();
      const prefaces: Buffer[] = [];
      let accepted: Socket | undefined;
      const server = net.createServer((socket) => {
        accepted = socket;
        sockets.add(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        socket.on("data", (chunk: Buffer) => prefaces.push(chunk));
      });
      const stop = new AbortController();
      let tunnel: Promise<unknown> | undefined;
      try {
        const uiPort = 20000 + (process.pid % 40000);
        await new Promise<void>((resolve) => server.listen(nativeLocalPipeName(uiPort), resolve));
        tunnel = startNativeUiTunnel({
          relayRoot,
          relayToken: "readiness-control",
          uiPort,
          pipe: true,
          pipeAcceptance: true,
          signal: stop.signal,
        }).catch((error: unknown) => error);
        const deadline = Date.now() + 5000;
        while (!accepted && Date.now() < deadline) await delay(10);
        assert(accepted);
        await delay(30);
        assert.deepEqual(Buffer.concat(prefaces), Buffer.from([0]));
        assert(!fs.existsSync(path.join(relayRoot, "ready")));
        if (ending === "invalid") accepted.write(Buffer.from([1]));
        else stop.abort();
        const result = await Promise.race([tunnel, delay(2000, "no settlement", { ref: false })]);
        assert(result instanceof Error);
        if (ending === "invalid") assert.match(result.message, /acceptance is invalid/u);
        else assert.equal(result, stop.signal.reason);
        assert(!fs.existsSync(path.join(relayRoot, "ready")));
      } finally {
        stop.abort();
        await tunnel;
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(relayRoot, { recursive: true, force: true });
      }
    },
  );

for (const ending of [
  "echo",
  "invalid",
  "closed",
  "timeout",
  "shutdown",
  "abort",
  "overflow",
] as const)
  test(
    `Hermes pipe admission serializes acceptance and cleans up on ${ending}`,
    { skip: process.platform !== "win32" },
    async (t) => {
      const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-pipe-admission-"));
      const relayToken = "hermes-pipe-admission-control";
      const uiPort = 20000 + (process.pid % 40000);
      const sockets = new Set<Socket>();
      const accepted: Socket[] = [];
      const received: Buffer[] = [];
      const stop = new AbortController();
      const now = performance.now.bind(performance);
      let elapsed = 0;
      t.mock.method(performance, "now", () => now() + elapsed);
      const server = net.createServer((socket) => {
        sockets.add(socket);
        accepted.push(socket);
        socket.once("close", () => sockets.delete(socket));
        socket.on("error", () => {});
        const position = accepted.length;
        let preface = true;
        socket.on("data", (chunk: Buffer) => {
          if (preface) {
            preface = false;
            assert.deepEqual(chunk, Buffer.from([0]));
            // Hold the first real stream to inspect the admission queue.
            if (position !== 2) socket.write(Buffer.from([0]));
            return;
          }
          received.push(chunk);
          socket.write(chunk);
        });
      });
      const connect = t.mock.method(net.Socket.prototype, "connect");
      let tunnel: Promise<unknown> | undefined;
      const waitUntil = async (condition: () => boolean) => {
        const deadline = Date.now() + 5000;
        while (!condition() && Date.now() < deadline) await delay(10);
        assert(condition(), "Pipe admission must settle within five seconds.");
      };
      const addStream = (index: number) => {
        const root = path.join(relayRoot, `stream-${index.toString(16).padStart(16, "0")}`);
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, "host-0000000000.bin"), Buffer.from([index, 0, 255]));
        fs.writeFileSync(path.join(root, "open"), relayToken);
        return root;
      };
      try {
        await new Promise<void>((resolve) => server.listen(nativeLocalPipeName(uiPort), resolve));
        tunnel = startNativeUiTunnel({
          relayRoot,
          relayToken,
          uiPort,
          pipe: true,
          pipeAcceptance: true,
          signal: stop.signal,
        }).then(
          () => null,
          (error: unknown) => error,
        );
        await waitUntil(() => fs.existsSync(path.join(relayRoot, "ready")));
        const roots = Array.from({ length: ending === "overflow" ? 128 : 12 }, (_, index) =>
          addStream(index),
        );
        await waitUntil(() => accepted.length === 2);
        await delay(50);
        assert.equal(
          connect.mock.callCount(),
          2,
          "Only readiness and one unacknowledged connection may open.",
        );
        assert.equal(received.length, 0, "Host bytes must remain queued until acceptance.");
        assert(roots.every((root) => fs.existsSync(path.join(root, "host-0000000000.bin"))));
        if (ending === "echo") {
          // Coalesced post-ack bytes must be forwarded, without leaking the acknowledgment.
          accepted[1].write(Buffer.from([0, 72, 73]));
          await waitUntil(() => received.length === 12);
          const readOutput = () =>
            roots.map((root) =>
              Buffer.concat(
                fs
                  .readdirSync(root)
                  .filter((name) => /^sandbox-[0-9]{10}[.]bin$/u.test(name))
                  .sort()
                  .map((name) => fs.readFileSync(path.join(root, name))),
              ),
            );
          await waitUntil(
            () => readOutput().reduce((length, bytes) => length + bytes.length, 0) === 38,
          );
          const output = readOutput();
          assert.equal(output.filter((bytes) => bytes.length === 5).length, 1);
          for (let index = 0; index < roots.length; index++) {
            const bytes = output[index];
            if (bytes.length === 5) assert.deepEqual(bytes.subarray(0, 2), Buffer.from("HI"));
            assert.deepEqual(bytes.subarray(-3), Buffer.from([index, 0, 255]));
            fs.writeFileSync(path.join(roots[index], "host-close"), "");
          }
          await waitUntil(() =>
            roots.every((root) => fs.existsSync(path.join(root, "sandbox-close"))),
          );
          fs.writeFileSync(path.join(relayRoot, "shutdown"), relayToken);
        } else if (ending === "invalid") accepted[1].write(Buffer.from([1]));
        else if (ending === "closed") accepted[1].end();
        else if (ending === "timeout") elapsed = 30_000;
        else if (ending === "shutdown")
          fs.writeFileSync(path.join(relayRoot, "shutdown"), relayToken);
        else if (ending === "abort") stop.abort(new Error("Owned admission abort"));
        else addStream(128);
        const result = await Promise.race([tunnel, delay(2000, "no settlement", { ref: false })]);
        if (ending === "echo" || ending === "shutdown") assert.equal(result, null);
        else {
          assert(result instanceof Error);
          const expected = {
            invalid: /acceptance is invalid/u,
            closed: /closed before acceptance/u,
            timeout: /acceptance timed out/u,
            abort: /Owned admission abort/u,
            overflow: /active-stream limit/u,
          };
          assert.match(result.message, expected[ending]);
        }
        if (ending !== "echo")
          assert.equal(
            connect.mock.callCount(),
            2,
            "Queued connections must never open after failure or cancellation.",
          );
        for (const call of connect.mock.calls) assert.equal(call.this.destroyed, true);
        await waitUntil(() => sockets.size === 0);
      } finally {
        stop.abort();
        await tunnel;
        for (const socket of sockets) socket.destroy();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(relayRoot, { recursive: true, force: true });
      }
    },
  );

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

test("native UI tunnel reports a failed connection instead of returning an empty page", async () => {
  const relayRoot = fs.mkdtempSync(path.join(os.tmpdir(), "native-ui-connect-failure-"));
  const stop = new AbortController();
  const sockets = new Set<Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    socket.resume();
  });
  let tunnel: Promise<unknown> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    tunnel = startNativeUiTunnel({
      relayRoot,
      relayToken: "connect-failure-control",
      uiPort: port,
      signal: stop.signal,
    }).catch((error: unknown) => error);
    const deadline = performance.now() + 5000;
    while (!fs.existsSync(path.join(relayRoot, "ready")) && performance.now() < deadline)
      await delay(10);
    assert(fs.existsSync(path.join(relayRoot, "ready")));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const stream = path.join(relayRoot, "stream-0123456789abcdef");
    fs.mkdirSync(stream);
    fs.writeFileSync(path.join(stream, "open"), "connect-failure-control");
    const result = await Promise.race([tunnel, delay(5000, "no settlement", { ref: false })]);
    assert(result instanceof Error);
    assert.match(
      result.message,
      /contained native UI connection failed before opening \(ECONNREFUSED\)/u,
    );
    assert.equal(fs.existsSync(path.join(stream, "sandbox-close")), false);
  } finally {
    stop.abort();
    await tunnel;
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(relayRoot, { recursive: true, force: true });
  }
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
