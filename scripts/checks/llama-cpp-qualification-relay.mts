// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";
import { isMainThread, Worker, parentPort, workerData } from "node:worker_threads";

export async function startQualificationLoopbackRelay(
  address: string,
  targetPort: number,
  timeoutSeconds: number,
  hostPort = 0,
): Promise<{ port: number; close: () => Promise<void> }> {
  if (net.isIP(address) !== 4)
    throw new Error("qualification relay requires a container IPv4 address");
  const bounds: [string, number, number, number][] = [
    ["request guard port", targetPort, 1, 65535],
    ["relay timeout", timeoutSeconds, 1, 86400],
    ["loopback port", hostPort, 0, 65535],
  ];
  for (const [name, value, min, max] of bounds) {
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`invalid ${name}`);
  }
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { address, targetPort, hostPort, timeoutMs: timeoutSeconds * 1000 },
  });
  try {
    const port = await new Promise<number>((resolve, reject) => {
      worker.once("error", reject);
      worker.once("exit", () => reject(new Error("qualification relay exited before listening")));
      worker.once("message", (message) => {
        if (message.error || !message.port)
          reject(new Error("qualification loopback relay could not listen"));
        else resolve(message.port);
      });
    });
    return {
      port,
      close: async () => {
        await worker.terminate();
      },
    };
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

if (!isMainThread) {
  const parent = parentPort;
  if (!parent) throw new Error("qualification relay requires a parent worker channel");
  // Qualification runs synchronous child commands, so forwarding needs its own event loop.
  const server = net.createServer((client) => {
    const upstream = net.createConnection({
      host: workerData.address,
      port: workerData.targetPort,
    });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      socket.setTimeout(workerData.timeoutMs, close);
      socket.on("error", close);
      socket.on("close", close);
    }
    client.pipe(upstream).pipe(client);
  });
  server.maxConnections = 64;
  server.on("error", () => {
    parent.postMessage({ error: "qualification loopback relay could not listen" });
    server.close();
  });
  server.listen({ host: "127.0.0.1", port: workerData.hostPort }, () => {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("qualification relay did not bind TCP");
    parent.postMessage({ port: address.port });
  });
}
