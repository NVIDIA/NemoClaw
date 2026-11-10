// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import net, { type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("../../packaging/windows/runtime/native-ui-file-owner.mts", () => ({
  openNativeUiFileOwner: mocks.open,
}));
import { startFileTcpRelay } from "../../packaging/windows/runtime/native-ui-relay.mts";

const TOKEN = "owned-transport-control";

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function until(condition: () => boolean, label: string) {
  await vi.waitFor(() => expect(condition(), label).toBe(true), { timeout: 3000, interval: 10 });
}

class FileOwnerFixture {
  readonly files = new Map<string, Buffer>([["ready", Buffer.from(TOKEN)]]);
  readonly directories: string[] = [];
  readonly released = new Set<string>();
  readonly removed = new Set<string>();
  closed = false;
  mkdirGate: Promise<void> = Promise.resolve();
  async mkdir(name: string) {
    this.directories.push(name);
    await this.mkdirGate;
  }
  async read(name: string) {
    return this.files.get(name) ?? null;
  }
  async write(name: string, value: string | Buffer) {
    this.files.set(name, Buffer.from(value));
  }
  async list(name: string) {
    return [...this.files.keys()]
      .filter((file) => file.startsWith(`${name}/`))
      .map((file) => file.slice(name.length + 1));
  }
  async unlink(name: string) {
    this.files.delete(name);
    this.removed.add(name);
  }
  async release(name: string) {
    this.released.add(name);
  }
  async close() {
    this.closed = true;
  }
  publish(directory: string, body: Buffer) {
    for (let offset = 0, index = 0; offset < body.length; offset += 1024 * 1024, index++)
      this.files.set(
        `${directory}/sandbox-${String(index).padStart(10, "0")}.bin`,
        body.subarray(offset, offset + 1024 * 1024),
      );
  }
  end(directory: string) {
    this.files.set(`${directory}/sandbox-close`, Buffer.alloc(0));
  }
}

async function session(
  action: (value: {
    owner: FileOwnerFixture;
    relay: Awaited<ReturnType<typeof startFileTcpRelay>>;
    connect: (allowHalfOpen?: boolean) => Promise<Socket>;
  }) => Promise<void>,
) {
  const owner = new FileOwnerFixture();
  mocks.open.mockResolvedValue(owner);
  const relay = await startFileTcpRelay("owned-relay", TOKEN, "owned-launcher");
  const clients: Socket[] = [];
  const connect = async (allowHalfOpen = false) => {
    const client = net.createConnection({
      host: "127.0.0.1",
      port: relay.browserPort,
      allowHalfOpen,
    });
    clients.push(client);
    client.on("error", () => {});
    await bounded(
      new Promise<void>((resolve) => client.once("connect", resolve)),
      "browser connection",
    );
    return client;
  };
  try {
    await bounded(relay.ready, "relay readiness");
    await action({ owner, relay, connect });
  } finally {
    for (const client of clients) client.destroy();
    await bounded(relay.close(), "relay cleanup");
    await bounded(
      relay.dispose().catch(() => {}),
      "file-owner cleanup",
    );
    expect(owner.closed).toBe(true);
  }
}

describe("native UI relay TCP delivery and lifetime", () => {
  it.each([1, 2, 3])(
    "delivers a complete 32 MiB response before backend EOF, run %i",
    async () => {
      await session(async ({ owner, connect }) => {
        const client = await connect();
        const hash = createHash("sha256");
        let received = 0;
        client.on("data", (bytes: Buffer) => {
          received += bytes.length;
          hash.update(bytes);
        });
        const ended = new Promise<void>((resolve) => client.once("end", resolve));
        await until(() => owner.directories.length === 1, "stream creation");
        const directory = owner.directories[0];
        const body = Buffer.alloc(32 * 1024 * 1024, 0x6b);
        owner.publish(directory, body);
        owner.end(directory);
        await bounded(ended, "complete response", 15_000);
        expect(received).toBe(body.length);
        expect(hash.digest("hex")).toBe(createHash("sha256").update(body).digest("hex"));
        await until(() => owner.released.has(directory), "completed stream release");
      });
    },
    20_000,
  );

  it.each([false, true])(
    "Stop still owns an unread browser socket after backend EOF (half-open=%s)",
    async (allowHalfOpen) => {
      await session(async ({ owner, relay, connect }) => {
        await connect(allowHalfOpen);
        await until(() => owner.directories.length === 1, "stream creation");
        const directory = owner.directories[0];
        owner.publish(directory, Buffer.alloc(32 * 1024, 0x61));
        owner.end(directory);
        await until(() => owner.released.has(directory), "backend EOF");
        await bounded(Promise.all([relay.close(), relay.close()]), "Stop after backend EOF");
        expect(owner.files.get("shutdown")?.toString()).toBe(TOKEN);
      });
    },
  );

  it("records browser close and releases the stream after the backend acknowledges EOF", async () => {
    await session(async ({ owner, connect }) => {
      const client = await connect();
      await until(() => owner.directories.length === 1, "stream creation");
      const directory = owner.directories[0];
      await until(() => owner.files.has(`${directory}/open`), "stream handshake");
      client.destroy();
      await until(() => owner.files.has(`${directory}/host-close`), "browser close marker");
      owner.end(directory);
      await until(() => owner.released.has(directory), "browser stream release");
    });
  });

  it("Stop interrupts backpressure when the browser does not read a large response", async () => {
    await session(async ({ owner, relay, connect }) => {
      await connect();
      await until(() => owner.directories.length === 1, "stream creation");
      owner.publish(owner.directories[0], Buffer.alloc(32 * 1024 * 1024, 0x62));
      await until(() => owner.removed.size > 0, "response delivery start");
      await bounded(relay.close(), "Stop during backpressure");
    });
  });

  it("file-owner failure reaches the session and teardown completes", async () => {
    await session(async ({ owner, relay, connect }) => {
      const client = await connect();
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      await until(() => owner.directories.length === 1, "stream creation");
      const failure = new Error("owned file-owner failure");
      vi.spyOn(owner, "read").mockRejectedValue(failure);
      await expect(bounded(relay.failure, "session failure")).rejects.toBe(failure);
      await bounded(closed, "failed browser close");
      await bounded(relay.close(), "failed relay shutdown");
      await expect(bounded(relay.dispose(), "failed file-owner disposal")).rejects.toBe(failure);
      expect(owner.closed).toBe(true);
    });
  });

  it("file-owner failure also closes a socket whose stream has not finished opening", async () => {
    await session(async ({ owner, relay, connect }) => {
      let rejectOpening!: (error: Error) => void;
      owner.mkdirGate = new Promise<void>((_resolve, reject) => {
        rejectOpening = reject;
      });
      const client = await connect();
      const closed = new Promise<void>((resolve) => client.once("close", () => resolve()));
      await until(() => owner.directories.length === 1, "pending stream creation");
      const failure = new Error("owned stream-opening failure");
      rejectOpening(failure);
      await expect(bounded(relay.failure, "opening failure")).rejects.toBe(failure);
      await bounded(closed, "socket close before stream setup");
      await bounded(relay.close(), "opening failure shutdown");
    });
  });
});
