// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCuaServiceRelay } from "./service-relay";

const servers: net.Server[] = [];
const paths: string[] = [];

function listen(
  host: string,
  port = 0,
  handler?: (socket: net.Socket) => void,
): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer(handler);
    server.once("error", reject);
    server.listen(port, host, () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function port(server: net.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function readyPath(): string {
  const file = path.join(os.tmpdir(), `nemoclaw-cua-relay-${process.pid}-${Date.now()}`);
  paths.push(file);
  return file;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  paths.splice(0).forEach((file) => fs.rmSync(file, { force: true }));
});

describe("NemoCUA service relay", () => {
  it("relays a host-facing connection to a loopback-only service (#10289)", async () => {
    const upstream = await listen("::1", 0, (socket) => socket.end("fixture-ok"));
    const upstreamPort = port(upstream);
    const unused = [1, 2, 3].map((offset) => upstreamPort + offset);
    const listeners = await runCuaServiceRelay(
      "127.0.0.1",
      [
        { role: "browser", targetHost: "::1", port: upstreamPort },
        { role: "computer", targetHost: "::1", port: unused[0] as number },
        { role: "terminal", targetHost: "::1", port: unused[1] as number },
        { role: "fixture", targetHost: "::1", port: unused[2] as number },
      ],
      readyPath(),
    );
    servers.push(...listeners);
    const body = await new Promise<string>((resolve, reject) => {
      let output = "";
      const socket = net.connect(upstreamPort, "127.0.0.1");
      socket.on("data", (chunk) => (output += chunk.toString()));
      socket.on("end", () => resolve(output));
      socket.on("error", reject);
    });
    expect(body).toBe("fixture-ok");
  });

  it("fails cleanly when a projected listener port is already owned (#10289)", async () => {
    const occupied = await listen("127.0.0.1");
    const occupiedPort = port(occupied);
    await expect(
      runCuaServiceRelay(
        "127.0.0.1",
        [
          { role: "browser", targetHost: "::1", port: occupiedPort },
          { role: "computer", targetHost: "::1", port: occupiedPort + 1 },
          { role: "terminal", targetHost: "::1", port: occupiedPort + 2 },
          { role: "fixture", targetHost: "::1", port: occupiedPort + 3 },
        ],
        readyPath(),
      ),
    ).rejects.toThrow(/EADDRINUSE/u);
  });
});
