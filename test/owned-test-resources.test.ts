// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { OwnedTestResources } from "./helpers/owned-test-resources";

function listen(server: net.Server, port = 0): Promise<number> {
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      expect(address).not.toBeNull();
      expect(typeof address).toBe("object");
      resolve((address as net.AddressInfo).port);
    });
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

describe("owned test resources", () => {
  it("owns a temporary HOME, bin directory, and child environment", async ({ onTestFinished }) => {
    const resources = new OwnedTestResources();
    onTestFinished(() => resources.cleanup());
    const testHome = resources.home("nemoclaw-owned-home-");
    const environment = testHome.environment({ FIXTURE_VALUE: "owned" });

    expect(fs.statSync(testHome.home).isDirectory()).toBe(true);
    expect(fs.statSync(testHome.bin).isDirectory()).toBe(true);
    expect(environment).toMatchObject({
      FIXTURE_VALUE: "owned",
      HOME: testHome.home,
    });
    expect(environment.PATH?.split(path.delimiter)[0]).toBe(testHome.bin);

    await resources.cleanup();
    expect(fs.existsSync(testHome.home)).toBe(false);
    await expect(resources.cleanup()).resolves.toBeUndefined();
  });

  it("waits for owned servers and child processes to exit during cleanup", async ({
    onTestFinished,
  }) => {
    const resources = new OwnedTestResources();
    onTestFinished(() => resources.cleanup());
    const server = resources.ownServer(net.createServer());
    const port = await listen(server);
    const child = resources.ownChild(
      spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 50)); process.stdout.write('ready'); setInterval(() => {}, 1000);",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      ),
    );
    await once(child.stdout!, "data");

    await resources.cleanup();

    expect(server.listening).toBe(false);
    expect(child.exitCode).toBe(0);
    const replacement = net.createServer();
    await listen(replacement, port);
    await close(replacement);
  });

  it("waits for an owned server whose shutdown is already in progress", async ({
    onTestFinished,
  }) => {
    const resources = new OwnedTestResources();
    onTestFinished(() => resources.cleanup());
    let acceptConnection!: (socket: net.Socket) => void;
    const accepted = new Promise<net.Socket>((resolve) => {
      acceptConnection = resolve;
    });
    const server = resources.ownServer(net.createServer((socket) => acceptConnection(socket)));
    const port = await listen(server);
    const client = net.createConnection({ host: "127.0.0.1", port });
    onTestFinished(() => {
      client.destroy();
    });
    await once(client, "connect");
    const serverSocket = await accepted;
    onTestFinished(() => {
      serverSocket.destroy();
    });

    let serverClosed = false;
    server.close(() => {
      serverClosed = true;
    });
    expect(server.listening).toBe(false);
    let cleanupFinished = false;
    const cleanup = resources.cleanup().then(() => {
      cleanupFinished = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(cleanupFinished).toBe(false);
    expect(serverClosed).toBe(false);
    client.destroy();
    await cleanup;
    expect(serverClosed).toBe(true);
  });

  it("escalates a SIGTERM-ignoring child and waits for piped stdio to close", async ({
    onTestFinished,
  }) => {
    const resources = new OwnedTestResources();
    onTestFinished(() => resources.cleanup());
    const child = resources.ownChild(
      spawn(
        process.execPath,
        [
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000);",
        ],
        { stdio: ["ignore", "pipe", "ignore"] },
      ),
    );
    await once(child.stdout!, "data");

    await resources.cleanup();

    expect(child.signalCode).toBe("SIGKILL");
    expect(child.stdout?.destroyed).toBe(true);
  });
});
