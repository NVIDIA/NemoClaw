// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import net, { type AddressInfo, type Socket } from "node:net";
import { once } from "node:events";
import { buffer } from "node:stream/consumers";
import test from "node:test";
import { forwardNativeUiFrames } from "./native-ui-relay.mts";

const directory = "stream-0123456789abcdef";
const first = `${directory}/sandbox-0000000000.bin`;
const second = `${directory}/sandbox-0000000001.bin`;
const ending = `${directory}/sandbox-close`;

async function withBrowser(action: (socket: Socket) => Promise<void>) {
  const server = net.createServer();
  let browser: Socket | undefined;
  let sender: Socket | undefined;
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const accepted = once(server, "connection");
    browser = net.createConnection((server.address() as AddressInfo).port, "127.0.0.1");
    [sender] = (await accepted) as [Socket];
    const received = buffer(browser);
    await action(sender);
    sender.end();
    return await received;
  } finally {
    sender?.destroy();
    browser?.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("UI relay observes closure before listing final frames", async () => {
  const files = new Map<string, Buffer>();
  let listed = false;
  const io = {
    async read(name: string) {
      return files.get(name) ?? null;
    },
    async list() {
      const snapshot = [...files.keys()].map((name) => name.slice(directory.length + 1));
      if (!listed) {
        listed = true;
        files.set(first, Buffer.from("complete response"));
        files.set(ending, Buffer.alloc(0));
      }
      return snapshot;
    },
    async unlink(name: string) {
      assert(files.delete(name));
    },
  };
  const received = await withBrowser(async (socket) => {
    assert.equal(await forwardNativeUiFrames(io, directory, socket), false);
    assert(files.has(first), "A frame published after the snapshot remains owned.");
    assert.equal(await forwardNativeUiFrames(io, directory, socket), true);
    assert(!files.has(first));
  });
  assert.equal(received.toString(), "complete response");
});

test("UI relay cannot reorder readable frames around a locked frame or close early", async () => {
  const files = new Map([
    [first, Buffer.from("first")],
    [second, Buffer.from("second")],
    [ending, Buffer.alloc(0)],
  ]);
  let locked = true;
  const reads: string[] = [];
  const io = {
    async read(name: string) {
      reads.push(name);
      return name === first && locked ? null : (files.get(name) ?? null);
    },
    async list() {
      return [...files.keys()].map((name) => name.slice(directory.length + 1)).reverse();
    },
    async unlink(name: string) {
      assert(files.delete(name));
    },
  };
  const received = await withBrowser(async (socket) => {
    assert.equal(await forwardNativeUiFrames(io, directory, socket), false);
    assert(!reads.includes(second));
    assert.equal(files.size, 3);
    locked = false;
    assert.equal(await forwardNativeUiFrames(io, directory, socket), true);
    assert.deepEqual([...files.keys()], [ending]);
  });
  assert.equal(received.toString(), "firstsecond");
});

test("UI relay reports stalled browser output and retains the undelivered frame", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const socket = new net.Socket();
  let written!: () => void;
  const writing = new Promise<void>((resolve) => {
    written = resolve;
  });
  t.mock.method(socket, "write", () => {
    written();
    return false;
  });
  let removed = false;
  const forwarding = forwardNativeUiFrames(
    {
      async read(name) {
        return name === first ? Buffer.from("response") : null;
      },
      async list() {
        return ["sandbox-0000000000.bin"];
      },
      async unlink() {
        removed = true;
      },
    },
    directory,
    socket,
  );
  const rejected = assert.rejects(
    forwarding,
    /browser did not accept UI response data within 30 seconds/u,
  );
  await writing;
  t.mock.timers.tick(29_999);
  assert.equal(socket.destroyed, false);
  assert.equal(removed, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(socket.destroyed, true);
  assert.equal(removed, false);
  for (const event of ["drain", "close", "error"]) assert.equal(socket.listenerCount(event), 0);
});
