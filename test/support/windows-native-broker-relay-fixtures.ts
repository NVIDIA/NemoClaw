// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import {
  BROKER_CONNECTION_LIMIT,
  createBrokerRelayPeer,
  type BrokerRelayFiles,
} from "../../packaging/windows/runtime/native-broker-relay-protocol.mts";
import {
  containedBrokerRelayFiles,
  startNativeBrokerTunnel,
} from "../../packaging/windows/runtime/native-broker-tunnel.mts";

export const TOKEN = "owned-broker-relay-canary-token-000000000000";
export const sleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
export async function until(predicate: () => boolean, timeout = 5000) {
  const deadline = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() >= deadline)
      throw new Error("The owned transport condition did not complete.");
    await sleep(10);
  }
}
export async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The owned listener did not bind.");
  return address.port;
}
export async function closeServer(server: net.Server) {
  if (server instanceof http.Server) server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
export function destroySockets(sockets: Iterable<Socket>) {
  for (const socket of sockets) socket.destroy();
}
export function request(
  port: number,
  route: string,
  body = Buffer.alloc(0),
  authorization?: string,
) {
  return new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
    const response: Buffer[] = [];
    const outgoing = http.request(
      {
        host: "127.0.0.1",
        port,
        path: route,
        method: "POST",
        agent: false,
        headers: {
          "content-length": String(body.length),
          "content-type": "application/json",
          ...(authorization ? { authorization } : {}),
        },
      },
      (incoming) => {
        incoming.on("data", (bytes: Buffer) => response.push(bytes));
        incoming.once("error", reject);
        incoming.once("end", () =>
          resolve({ status: incoming.statusCode ?? 0, body: Buffer.concat(response) }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.setTimeout(20_000, () =>
      outgoing.destroy(new Error("The owned HTTP request stalled.")),
    );
    outgoing.end(body);
  });
}
export async function openPortableBrokerSession(brokerPort: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-broker-relay-"));
  const slots = Array.from(
    { length: BROKER_CONNECTION_LIMIT },
    () => `stream-${randomBytes(8).toString("hex")}`,
  );
  for (const slot of slots) fs.mkdirSync(path.join(root, slot));
  const files = containedBrokerRelayFiles(root);
  // Real files and sockets exercise the transport. Windows owner authority
  // remains separate live evidence, never supplied by this portable adapter.
  const host = await createBrokerRelayPeer({
    files,
    token: TOKEN,
    slots,
    side: "host",
    brokerPort,
  });
  await files.write(
    "ready",
    JSON.stringify({ schemaVersion: 1, transport: "guarded-file-tcp", token: TOKEN, slots }),
  );
  const tunnel = await startNativeBrokerTunnel({ relayRoot: root, relayToken: TOKEN });
  return {
    root,
    slots,
    host,
    tunnel,
    async close() {
      await tunnel.close().catch(() => {});
      await host.close().catch(() => {});
    },
    remove() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
export function pauseFirstOffer(files: BrokerRelayFiles) {
  let entered = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered: () => entered,
    release,
    files: {
      ...files,
      async read(name: string) {
        if (!entered && name.endsWith("/open")) {
          entered = true;
          await gate;
        }
        return await files.read(name);
      },
    },
  };
}

// Real reset sockets and delayed ownership operations expose the FIN ordering
// available to independent Windows processes, without fabricating assertions.
export async function openResetCloseRace() {
  const memory = new Map<string, Buffer>();
  const slots = Array.from(
    { length: 32 },
    (_, index) => `stream-${index.toString(16).padStart(16, "0")}`,
  );
  const slot = slots[0];
  let releaseFin!: () => void;
  const finPermission = new Promise<void>((resolve) => {
    releaseFin = resolve;
  });
  let missedFin = false;
  let finReleased = false;
  let closedUnlinked = false;
  let paused = false;
  let retiredBeforeFinRead = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  let host: Awaited<ReturnType<typeof createBrokerRelayPeer>> | undefined;
  let sandbox: Awaited<ReturnType<typeof createBrokerRelayPeer>> | undefined;
  const files = (side: "host" | "sandbox"): BrokerRelayFiles => ({
    async read(name) {
      if (side === "sandbox" && name === `${slot}/host-close`) {
        if (!memory.has(name)) missedFin = true;
        if (closedUnlinked && !paused) {
          paused = true;
          await sleep(150);
          retiredBeforeFinRead = (host?.diagnostics().completedConnections ?? 0) > 0;
        }
      }
      const bytes = memory.get(name);
      return bytes ? Buffer.from(bytes) : null;
    },
    async write(name, content) {
      if (side === "host" && name === `${slot}/host-close`) await finPermission;
      memory.set(name, Buffer.from(content));
    },
    async unlink(name) {
      if (side === "sandbox" && name === `${slot}/host-0000000000.bin`) {
        const bytes = memory.get(name);
        if (bytes && JSON.parse(bytes.toString()).kind === "closed") closedUnlinked = true;
      }
      memory.delete(name);
    },
    async list(name) {
      if (side === "sandbox" && name === slot && missedFin && !finReleased) {
        finReleased = true;
        releaseTimer = setTimeout(releaseFin, 100);
      }
      return [...memory.keys()]
        .filter((entry) => entry.startsWith(`${name}/`))
        .map((entry) => entry.slice(name.length + 1));
    },
  });
  const backend = net.createServer((socket) => {
    socket.on("error", () => {});
    socket.resetAndDestroy();
  });
  const port = await listen(backend);
  let client: Socket | undefined;
  const close = async () => {
    clearTimeout(releaseTimer);
    releaseFin();
    client?.destroy();
    await Promise.allSettled([host?.close(), sandbox?.close()]);
    await closeServer(backend);
  };
  try {
    host = await createBrokerRelayPeer({
      files: files("host"),
      token: TOKEN,
      slots,
      side: "host",
      brokerPort: port,
    });
    sandbox = await createBrokerRelayPeer({
      files: files("sandbox"),
      token: TOKEN,
      slots,
      side: "sandbox",
    });
    client = net.createConnection({ host: "127.0.0.1", port: sandbox.port! });
    client.on("error", () => {});
    await new Promise<void>((resolve) =>
      client!.once("connect", () => {
        client!.resetAndDestroy();
        resolve();
      }),
    );
    return {
      host,
      sandbox,
      paused: () => paused,
      retiredBeforeFinRead: () => retiredBeforeFinRead,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
