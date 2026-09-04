// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { isLocalForwardReachable } from "../../actions/sandbox/forward-health";
import { probeLocalForwardListener } from "./local-forward-listener";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

describe("local forward listener probe", () => {
  it("detects a loopback listener within the caller's timeout budget (#10926)", async () => {
    let receivedBytes = 0;
    const server = createServer((socket) => {
      socket.on("data", (chunk) => {
        receivedBytes += chunk.length;
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;

    expect(probeLocalForwardListener(address.port)).toBe(true);
    expect(isLocalForwardReachable(address.port, 0)).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(receivedBytes).toBe(0);
  });

  it("fails closed for a refused or invalid port (#10926)", async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as import("node:net").AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(probeLocalForwardListener(address.port)).toBe(false);
    expect(probeLocalForwardListener(0)).toBe(false);
    expect(probeLocalForwardListener(65_536)).toBe(false);
  });
});
