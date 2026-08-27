// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureCuaServiceRelay,
  resolveCuaServiceRelayBridgeAddress,
  runCuaServiceRelay,
} from "./service-relay";

const servers: net.Server[] = [];
const paths: string[] = [];
let pathSequence = 0;

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
  const file = path.join(
    os.tmpdir(),
    `nemoclaw-cua-relay-${process.pid}-${Date.now()}-${String(pathSequence++)}`,
  );
  paths.push(file);
  return file;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
  paths.splice(0).forEach((file) => fs.rmSync(file, { force: true }));
});

describe("NemoCUA service relay", () => {
  it("selects an IPv4 gateway after an IPv6 IPAM entry (#10289)", () => {
    const capture = vi.fn(() =>
      JSON.stringify([
        { Subnet: "fd00::/64", Gateway: "fd00::1" },
        { Subnet: "172.19.0.0/16", Gateway: "172.19.0.1" },
      ]),
    );

    expect(
      resolveCuaServiceRelayBridgeAddress(
        { OPENSHELL_DOCKER_NETWORK_NAME: "selected-network" },
        capture as never,
      ),
    ).toBe("172.19.0.1");
    expect(capture).toHaveBeenCalledWith(
      ["network", "inspect", "--format", "{{json .IPAM.Config}}", "selected-network"],
      { ignoreError: true, timeout: 5_000 },
    );
  });

  it("rejects an invalid Docker bridge address (#10289)", () => {
    expect(() => resolveCuaServiceRelayBridgeAddress({}, (() => "not-json") as never)).toThrow(
      "could not resolve the OpenShell bridge address",
    );
  });

  it("rejects endpoint changes after relay authority is recorded (#10289)", () => {
    const sandboxName = `authority-${process.pid}-${Date.now()}`;
    const stateDirectory = path.join(os.homedir(), ".local", "state", "nemoclaw", "cua-relays");
    const stateFile = path.join(stateDirectory, `${sandboxName}.json`);
    paths.push(stateFile);
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      stateFile,
      `${JSON.stringify({
        version: 1,
        sandboxName,
        bindHost: "172.19.0.1",
        clientHost: "172.19.0.2",
        pid: 999_999_999,
        endpoints: [
          { role: "browser", targetHost: "127.0.0.1", port: 18001 },
          { role: "computer", targetHost: "127.0.0.1", port: 18002 },
          { role: "terminal", targetHost: "127.0.0.1", port: 18003 },
          { role: "fixture", targetHost: "127.0.0.1", port: 18004 },
        ],
      })}\n`,
      { mode: 0o600 },
    );

    expect(() =>
      ensureCuaServiceRelay(sandboxName, {
        NEMOCLAW_CUA_BROWSER_ENDPOINT: "http://127.0.0.1:19001/",
        NEMOCLAW_CUA_COMPUTER_ENDPOINT: "http://127.0.0.1:18002/",
        NEMOCLAW_CUA_TERMINAL_ENDPOINT: "http://127.0.0.1:18003/",
        NEMOCLAW_CUA_FIXTURE_ENDPOINT: "http://127.0.0.1:18004/fixture",
      }),
    ).toThrow("endpoints differ from the sandbox relay state");
  });

  it("relays a host-facing connection to a loopback-only service (#10289)", async () => {
    const upstream = await listen("::1", 0, (socket) => socket.end("fixture-ok"));
    const upstreamPort = port(upstream);
    const unused = [1, 2, 3].map((offset) => upstreamPort + offset);
    const endpoints = [
      { role: "browser", targetHost: "::1", port: upstreamPort },
      { role: "computer", targetHost: "::1", port: unused[0] as number },
      { role: "terminal", targetHost: "::1", port: unused[1] as number },
      { role: "fixture", targetHost: "::1", port: unused[2] as number },
    ];
    const stateFile = readyPath();
    const listeners = await runCuaServiceRelay("127.0.0.1", endpoints, stateFile, {
      version: 1,
      sandboxName: "test-sandbox",
      bindHost: "127.0.0.1",
      clientHost: "127.0.0.1",
      endpoints,
    });
    servers.push(...listeners);
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8"))).toMatchObject({
      sandboxName: "test-sandbox",
      pid: process.pid,
      endpoints,
    });
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
      runCuaServiceRelay("127.0.0.1", [
        { role: "browser", targetHost: "::1", port: occupiedPort },
        { role: "computer", targetHost: "::1", port: occupiedPort + 1 },
        { role: "terminal", targetHost: "::1", port: occupiedPort + 2 },
        { role: "fixture", targetHost: "::1", port: occupiedPort + 3 },
      ]),
    ).rejects.toThrow(/EADDRINUSE/u);
  });
});
