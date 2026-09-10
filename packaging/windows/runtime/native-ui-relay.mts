// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import net, { type AddressInfo, type Socket } from "node:net";
import { openNativeUiFileOwner } from "./native-ui-file-owner.mts";
import { measureRelayFiles, type RelayMeasurements } from "./native-broker-relay-protocol.mts";

type Stream = { directory: string; socket: Socket; sequence: number; closing: boolean };

async function writeBrowserFrame(socket: Socket, data: Buffer) {
  if (socket.destroyed || socket.writableEnded || socket.write(data)) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      socket.removeListener("drain", done);
      socket.removeListener("close", done);
      socket.removeListener("error", done);
      resolve();
    };
    const timeout = setTimeout(() => {
      socket.destroy();
      done();
    }, 30_000);
    socket.once("drain", done);
    socket.once("close", done);
    socket.once("error", done);
  });
}

export async function startFileTcpRelay(
  relayRoot: string,
  token: string,
  launcher: string,
  measurements?: RelayMeasurements,
) {
  const owner = await openNativeUiFileOwner(launcher, relayRoot, measurements);
  const files = owner;
  const io = measureRelayFiles(owner, measurements);
  const streams = new Map<string, Stream>();
  const sockets = new Set<Socket>();
  let closed = false;
  let failure: Error | null = null;
  let readyResolve!: () => void;
  let readyReject!: (error: Error) => void;
  let failSession!: (error: Error) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    failSession = reject;
  });
  void failed.catch(() => {});
  const ready = new Promise<void>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  void ready.catch(() => {});
  const recordFailure = (error: unknown) => {
    failure ??= error instanceof Error ? error : new Error("The native agent UI relay failed.");
    readyReject(failure);
    failSession(failure);
    for (const stream of streams.values()) {
      stream.closing = true;
    }
    for (const socket of sockets) socket.destroy();
  };
  const browserServer = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.pause();
    const directory = `stream-${randomBytes(8).toString("hex")}`;
    const stream: Stream = { directory, socket, sequence: 0, closing: false };
    socket.once("error", () => {});
    void (async () => {
      if (closed || failure) {
        socket.destroy();
        return;
      }
      await files.mkdir(directory);
      if (closed || failure) {
        socket.destroy();
        return;
      }
      streams.set(directory, stream);
      await io.write(`${directory}/open`, token);
      socket.on("data", (chunk: Buffer) => {
        if (stream.closing) return;
        socket.pause();
        const file = `${directory}/host-${String(stream.sequence++).padStart(10, "0")}.bin`;
        void io.write(file, chunk).then(() => socket.resume(), recordFailure);
      });
      socket.once("close", () => {
        if (!closed && !stream.closing)
          void io.write(`${directory}/host-close`, Buffer.alloc(0)).catch(recordFailure);
      });
      socket.resume();
    })().catch(recordFailure);
  });
  browserServer.on("error", recordFailure);
  try {
    await new Promise<void>((resolve, reject) => {
      browserServer.once("error", reject);
      browserServer.listen(0, "127.0.0.1", () => {
        browserServer.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    for (const socket of sockets) socket.destroy();
    browserServer.close();
    try {
      await files.close();
    } catch {}
    throw error;
  }
  const browserPort = (browserServer.address() as AddressInfo).port;
  let polling = false;
  let pollTask = Promise.resolve();
  let readyObserved = false;
  const poll = setInterval(() => {
    if (polling || closed || failure) return;
    polling = true;
    const started = measurements?.start();
    let succeeded = false;
    pollTask = (async () => {
      if (!readyObserved) {
        const marker = await io.read("ready");
        if (marker !== null) {
          if (marker.toString("utf8") !== token)
            throw new Error("The native agent UI relay identity does not match.");
          readyObserved = true;
          readyResolve();
        }
      }
      for (const [directory, stream] of streams) {
        if (closed) break;
        measurements?.scan(true);
        for (const name of (await io.list(directory))
          .filter((name) => /^sandbox-[0-9]{10}\.bin$/u.test(name))
          .sort()) {
          const data = await io.read(`${directory}/${name}`);
          if (data === null) continue;
          await writeBrowserFrame(stream.socket, data);
          await io.unlink(`${directory}/${name}`);
        }
        if ((await io.read(`${directory}/sandbox-close`)) !== null) {
          stream.closing = true;
          stream.socket.end();
          stream.socket.resume();
          streams.delete(directory);
          await files.release(directory);
        }
      }
      succeeded = true;
    })()
      .catch(recordFailure)
      .finally(() => {
        if (started !== undefined)
          measurements!.finish("poll", started, succeeded ? "success" : "failure");
        polling = false;
      });
  }, 10);
  let disposal: Promise<void> | undefined;
  let closure: Promise<void> | undefined;
  return {
    browserPort,
    ready,
    failure: failed,
    nativePerformance: owner.nativePerformance,
    async close() {
      closure ??= (async () => {
        closed = true;
        clearInterval(poll);
        if (!readyObserved)
          readyReject(new Error("The native UI session closed before it became ready."));
        for (const stream of streams.values()) stream.closing = true;
        // A completed stream may still have buffered TCP output or a peer that
        // has not closed. Retain socket ownership through its actual close.
        for (const socket of sockets) socket.destroy();
        await pollTask;
        await io.write("shutdown", token).catch(recordFailure);
        await new Promise<void>((resolve) => browserServer.close(() => resolve()));
      })();
      return await closure;
    },
    async dispose() {
      // Keep directory handles pinned through MXC teardown. Call only after
      // sandbox/gateway shutdown and before deleting the temporary share root.
      disposal ??= (async () => {
        await files.close();
        streams.clear();
        if (failure) throw failure;
      })();
      return await disposal;
    },
  };
}
