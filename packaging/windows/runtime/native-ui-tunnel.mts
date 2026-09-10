// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net, { type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { RelayMeasurements } from "./native-broker-relay-protocol.mts";

function readRelayFileUnmeasured(file: string, maxBytes: number): Buffer | null {
  let descriptor: number;
  try {
    descriptor = fs.openSync(file, "r");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maxBytes)
      throw new Error("The opened native UI relay marker is invalid.");
    const bytes = Buffer.alloc(stat.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const received = fs.readSync(descriptor, bytes, count, bytes.length - count, null);
      if (received === 0) break;
      count += received;
    }
    if (count !== stat.size) throw new Error("The native UI relay file changed while reading.");
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readRelayFile(file: string, maxBytes: number, measurements?: RelayMeasurements) {
  if (!measurements) return readRelayFileUnmeasured(file, maxBytes);
  const started = measurements.start();
  try {
    const bytes = readRelayFileUnmeasured(file, maxBytes);
    measurements.finish("read", started, bytes === null ? "miss" : "success", bytes?.length ?? 0);
    return bytes;
  } catch (error) {
    measurements.finish("read", started, "failure");
    throw error;
  }
}

export function readNativeUiTunnelMarker(
  file: string,
  measurements?: RelayMeasurements,
): string | null {
  return readRelayFile(file, 4096, measurements)?.toString("utf8") ?? null;
}

export async function startNativeUiTunnel({
  relayRoot,
  relayToken,
  uiPort,
  signal,
  measurements,
}: {
  relayRoot: string;
  relayToken: string;
  uiPort: number;
  signal?: AbortSignal;
  measurements?: RelayMeasurements;
}): Promise<void> {
  if (
    typeof relayRoot !== "string" ||
    typeof relayToken !== "string" ||
    !Number.isInteger(uiPort) ||
    uiPort < 1 ||
    uiPort > 65535
  )
    throw new Error("The contained native UI tunnel identity is invalid.");
  signal?.throwIfAborted();
  const waitForUi = async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const connected = await new Promise((resolvePromise) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: uiPort, signal });
        socket.once("connect", () => {
          socket.destroy();
          resolvePromise(true);
        });
        socket.once("error", () => {
          socket.destroy();
          resolvePromise(false);
        });
        socket.setTimeout(500, () => {
          socket.destroy();
          resolvePromise(false);
        });
      });
      signal?.throwIfAborted();
      if (connected) return;
      await delay(250, undefined, { signal });
    }
    throw new Error("The agent Web UI did not become ready inside MXC");
  };
  const writeRelayFile = (file: string, content: string | Buffer) => {
    // The host's pinned-directory boundary prevents rename-through-parent.
    // Exclusive creation keeps every frame unique. Its native reader refuses
    // write-sharing, so an open writer is unavailable until this complete flush/close.
    const started = measurements?.start();
    let succeeded = false;
    try {
      fs.writeFileSync(file, content, { flag: "wx", flush: true });
      succeeded = true;
    } finally {
      if (started !== undefined)
        measurements!.finish(
          "flushedWrite",
          started,
          succeeded ? "success" : "failure",
          succeeded ? Buffer.byteLength(content) : 0,
        );
    }
  };
  const readDirectory = (directory: string) => {
    if (!measurements) return fs.readdirSync(directory);
    const started = measurements.start();
    try {
      const names = fs.readdirSync(directory);
      measurements.finish("list", started, "success", 0, names.length);
      return names;
    } catch (error) {
      measurements.finish("list", started, "failure");
      throw error;
    }
  };
  const startFileTunnel = async () => {
    await waitForUi();
    signal?.throwIfAborted();
    if (!fs.statSync(relayRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("MXC UI relay directory is unavailable");
    }
    const streams = new Map<
      string,
      {
        root: string;
        sequence: number;
        socket: Socket;
        pendingFrames: number;
        blocked: boolean;
        hostEnded: boolean;
      }
    >();
    writeRelayFile(join(relayRoot, "ready"), relayToken);
    return new Promise<void>((resolvePromise, reject) => {
      let finished = false;
      let poll: ReturnType<typeof setInterval> | undefined;
      const finish = (error?: unknown) => {
        if (finished) return;
        finished = true;
        clearInterval(poll);
        signal?.removeEventListener("abort", onAbort);
        for (const stream of streams.values()) stream.socket.destroy();
        streams.clear();
        if (error !== undefined) reject(error);
        else resolvePromise();
      };
      const onAbort = () =>
        finish(signal?.reason ?? new Error("The native UI tunnel was stopped."));
      const pollRelay = () => {
        const shutdown = join(relayRoot, "shutdown");
        const shutdownToken = readNativeUiTunnelMarker(shutdown, measurements);
        if (shutdownToken !== null) {
          if (shutdownToken !== relayToken) return;
          finish();
          return;
        }
        for (const entry of readDirectory(relayRoot).filter((name) =>
          /^stream-[a-f0-9]{16}$/u.test(name),
        )) {
          measurements?.scan(streams.has(entry));
          if (streams.has(entry)) continue;
          const streamRoot = join(relayRoot, entry);
          const open = join(streamRoot, "open");
          if (fs.existsSync(join(streamRoot, "sandbox-close"))) continue;
          if (readNativeUiTunnelMarker(open, measurements) !== relayToken) continue;
          const socket = net.createConnection({ host: "127.0.0.1", port: uiPort });
          const state = {
            root: streamRoot,
            sequence: 0,
            socket,
            pendingFrames: 0,
            blocked: false,
            hostEnded: false,
          };
          streams.set(entry, state);
          socket.on("drain", () => {
            state.blocked = false;
          });
          socket.on("data", (chunk) => {
            if (finished) return;
            try {
              writeRelayFile(
                join(streamRoot, "sandbox-" + String(state.sequence++).padStart(10, "0") + ".bin"),
                chunk,
              );
              if (++state.pendingFrames >= 64) socket.pause();
            } catch (error: unknown) {
              finish(error);
            }
          });
          socket.once("error", () => {});
          socket.once("close", () => {
            streams.delete(entry);
            if (finished) return;
            try {
              writeRelayFile(join(streamRoot, "sandbox-close"), Buffer.alloc(0));
            } catch {}
          });
        }
        for (const stream of streams.values()) {
          const entries = readDirectory(stream.root);
          stream.pendingFrames = entries.filter((name) =>
            /^sandbox-[0-9]{10}[.]bin$/u.test(name),
          ).length;
          if (stream.pendingFrames < 32) stream.socket.resume();
          const incoming = entries.filter((name) => /^host-[0-9]{10}[.]bin$/u.test(name)).sort();
          let delivered = 0;
          for (const entry of incoming) {
            if (stream.blocked || stream.hostEnded) break;
            const chunk = join(stream.root, entry);
            const bytes = readRelayFile(chunk, 1024 * 1024, measurements);
            if (bytes === null) throw new Error("A native UI relay frame disappeared.");
            stream.blocked = !stream.socket.write(bytes);
            fs.unlinkSync(chunk);
            delivered++;
          }
          if (
            !stream.hostEnded &&
            delivered === incoming.length &&
            entries.includes("host-close")
          ) {
            stream.hostEnded = true;
            stream.socket.end();
          }
        }
      };
      poll = setInterval(() => {
        if (finished) return;
        const started = measurements?.start();
        let succeeded = false;
        try {
          pollRelay();
          succeeded = true;
        } catch (error: unknown) {
          finish(error);
        } finally {
          if (started !== undefined)
            measurements!.finish("poll", started, succeeded ? "success" : "failure");
        }
      }, 10);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
  };
  return await startFileTunnel();
}
