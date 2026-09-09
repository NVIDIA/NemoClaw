// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net, { type Socket } from "node:net";
import { join } from "node:path";

export async function startNativeUiTunnel({
  relayRoot,
  relayToken,
  uiPort,
}: {
  relayRoot: string;
  relayToken: string;
  uiPort: number;
}): Promise<void> {
  if (
    typeof relayRoot !== "string" ||
    typeof relayToken !== "string" ||
    !Number.isInteger(uiPort) ||
    uiPort < 1 ||
    uiPort > 65535
  )
    throw new Error("The contained native UI tunnel identity is invalid.");
  const sleep = (milliseconds: number) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitForUi = async () => {
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const connected = await new Promise((resolvePromise) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: uiPort });
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
      if (connected) return;
      await sleep(250);
    }
    throw new Error("The agent Web UI did not become ready inside MXC");
  };
  const writeRelayFile = (file: string, content: string | Buffer) => {
    // The host's pinned-directory boundary prevents rename-through-parent.
    // Exclusive creation keeps every frame unique. Its native reader refuses
    // write-sharing, so an open writer is unavailable until this complete flush/close.
    fs.writeFileSync(file, content, { flag: "wx", flush: true });
  };
  const startFileTunnel = async () => {
    await waitForUi();
    if (!fs.statSync(relayRoot, { throwIfNoEntry: false })?.isDirectory()) {
      throw new Error("MXC UI relay directory is unavailable");
    }
    const streams = new Map<string, { root: string; sequence: number; socket: Socket }>();
    writeRelayFile(join(relayRoot, "ready"), relayToken);
    return new Promise<void>((resolvePromise) => {
      const poll = setInterval(() => {
        const shutdown = join(relayRoot, "shutdown");
        if (fs.statSync(shutdown, { throwIfNoEntry: false })?.isFile()) {
          if (fs.readFileSync(shutdown, "utf8") !== relayToken) return;
          clearInterval(poll);
          for (const stream of streams.values()) stream.socket.destroy();
          streams.clear();
          resolvePromise();
          return;
        }
        for (const entry of fs
          .readdirSync(relayRoot)
          .filter((name) => name.startsWith("stream-"))) {
          if (streams.has(entry)) continue;
          const streamRoot = join(relayRoot, entry);
          const open = join(streamRoot, "open");
          if (!fs.statSync(open, { throwIfNoEntry: false })?.isFile()) continue;
          if (fs.existsSync(join(streamRoot, "sandbox-close"))) continue;
          if (fs.readFileSync(open, "utf8") !== relayToken) continue;
          const socket = net.createConnection({ host: "127.0.0.1", port: uiPort });
          const state = { root: streamRoot, sequence: 0, socket };
          streams.set(entry, state);
          socket.on("data", (chunk) => {
            writeRelayFile(
              join(streamRoot, "sandbox-" + String(state.sequence++).padStart(10, "0") + ".bin"),
              chunk,
            );
          });
          socket.once("error", () => {});
          socket.once("close", () => {
            streams.delete(entry);
            try {
              writeRelayFile(join(streamRoot, "sandbox-close"), Buffer.alloc(0));
            } catch {}
          });
        }
        for (const stream of streams.values()) {
          for (const entry of fs
            .readdirSync(stream.root)
            .filter((name) => /^host-[0-9]{10}[.]bin$/u.test(name))
            .sort()) {
            const chunk = join(stream.root, entry);
            stream.socket.write(fs.readFileSync(chunk));
            fs.unlinkSync(chunk);
          }
          if (fs.existsSync(join(stream.root, "host-close"))) stream.socket.end();
        }
      }, 10);
    });
  };
  return await startFileTunnel();
}
