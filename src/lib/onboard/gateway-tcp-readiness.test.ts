// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Behavioural tests for isGatewayTcpReady — the Docker-driver gateway's
// TCP liveness probe. Co-located with the module per the pattern
// established by gateway-http-readiness and other src/lib/onboard/*
// modules.
//
// See: https://github.com/NVIDIA/NemoClaw/issues/3111

import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import { GATEWAY_PORT } from "../core/ports";
import { isGatewayTcpReady } from "./gateway-tcp-readiness";

// ── Helpers ─────────────────────────────────────────────────────────────────

function startDummyServer(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((socket) => socket.end());
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("failed to resolve server address"));
        return;
      }
      resolve({
        port: addr.port,
        close: () =>
          new Promise<void>((res, rej) => server.close((err) => (err ? rej(err) : res()))),
      });
    });
  });
}

async function getLikelyClosedPort(): Promise<number> {
  const { port, close } = await startDummyServer();
  await close();
  return port;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("isGatewayTcpReady (#3111)", () => {
  let teardown: (() => Promise<void>) | null = null;

  afterEach(async () => {
    if (teardown) {
      await teardown();
      teardown = null;
    }
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("resolves true when something is accepting connections", async () => {
    const { port, close } = await startDummyServer();
    teardown = close;
    await expect(isGatewayTcpReady(port, 500)).resolves.toBe(true);
  });

  it("resolves false when nothing is listening (Connection refused)", async () => {
    const port = await getLikelyClosedPort();
    await expect(isGatewayTcpReady(port, 500)).resolves.toBe(false);
  });

  it("resolves false on timeout (non-routable host)", async () => {
    // 10.255.255.1 is a non-routable RFC 1918 address that SYN-drops on most
    // CI runners, forcing the timeout path rather than immediate ECONNREFUSED.
    const started = Date.now();
    await expect(isGatewayTcpReady(9, 200, "10.255.255.1")).resolves.toBe(false);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(2000);
  });

  it("enforces a minimum timeout of 50ms even when caller passes 0", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const socket = {
      destroy: vi.fn(),
      once: vi.fn((event: string, callback: () => void) => {
        listeners.set(event, callback);
        return socket;
      }),
      setTimeout: vi.fn((timeoutMs: number) => {
        setTimeout(() => listeners.get("timeout")?.(), timeoutMs);
        return socket;
      }),
    };
    vi.spyOn(net, "createConnection").mockReturnValue(socket as unknown as net.Socket);

    const ready = isGatewayTcpReady(9, 0, "10.255.255.1");
    let settled = false;
    ready.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    expect(socket.setTimeout).toHaveBeenCalledWith(50);

    await vi.advanceTimersByTimeAsync(1);
    await expect(ready).resolves.toBe(false);
  });

  it("never throws — always resolves with a boolean", async () => {
    await expect(isGatewayTcpReady(0, 100)).resolves.toBeTypeOf("boolean");
    await expect(isGatewayTcpReady(65535, 100)).resolves.toBe(false);
  });

  it("defaults to GATEWAY_PORT when no port is supplied", async () => {
    // The host running this test may already have something listening on the
    // default gateway port, so assert the probed argument instead of the result.
    const createConnection = vi.spyOn(net, "createConnection");
    await expect(isGatewayTcpReady(undefined, 200)).resolves.toBeTypeOf("boolean");
    expect(createConnection).toHaveBeenCalledWith(expect.objectContaining({ port: GATEWAY_PORT }));
  });
});
