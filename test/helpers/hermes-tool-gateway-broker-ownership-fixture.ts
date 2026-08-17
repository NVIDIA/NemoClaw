// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Support for the broker ownership regression. The branching setup lives here
// so the test bodies stay linear, which `tools/growth-guardrails/test-conditionals.mts`
// requires of every `*.test.ts` file.

import http from "node:http";

/** A listener that answers the broker health probe and serves nothing else. */
export function createUnownedHealthListener(): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, services: [] }));
      return;
    }
    res.writeHead(404).end();
  });
}

export function listenOn(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
}

export function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Wait for a killed broker to release the fixed managed-tool gateway port. */
export async function waitForPortFree(port: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const probe = http.createServer();
    const free = await new Promise<boolean>((resolve) => {
      probe.once("error", () => resolve(false));
      probe.listen(port, "127.0.0.1", () => resolve(true));
    });
    await closeServer(probe);
    if (free) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`port ${port} was still held after the staged broker was killed`);
}

/** Restore a captured environment value, including the previously-unset case. */
export function restoreEnv(key: string, previous: string | undefined): void {
  if (previous === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = previous;
}
