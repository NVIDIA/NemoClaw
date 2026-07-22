// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { isDockerDriverGatewayHttpReady, isGatewayHttpReady } from "./gateway-http-readiness";

const servers: http.Server[] = [];

function closeServer(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      error ? reject(error) : resolve();
    });
  });
}

interface ListeningServer {
  address: AddressInfo;
  url: string;
}

function listen(server: http.Server): Promise<ListeningServer> {
  servers.push(server);
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      Promise.resolve(server.address())
        .then((address) => {
          const listeningAddress = address as AddressInfo;
          return {
            address: listeningAddress,
            url: `http://127.0.0.1:${listeningAddress.port}/`,
          };
        })
        .then(resolve, reject);
    });
  });
}

describe("isGatewayHttpReady abort handling", () => {
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it("returns false without opening a request when the signal is already aborted", async () => {
    let requests = 0;
    const { address, url } = await listen(
      http.createServer((_req, res) => {
        requests += 1;
        res.writeHead(200).end();
      }),
    );
    const controller = new AbortController();
    controller.abort();

    expect(address).toEqual(expect.objectContaining({ port: expect.any(Number) }));
    await expect(isGatewayHttpReady(10_000, url, "GET", controller.signal)).resolves.toBe(false);

    expect(requests).toBe(0);
  });

  it("returns false when an in-flight request is aborted", async () => {
    let resolveRequestSeen: () => void = () => undefined;
    const requestSeen = new Promise<void>((resolve) => {
      resolveRequestSeen = resolve;
    });
    const { address, url } = await listen(
      http.createServer(() => {
        resolveRequestSeen();
      }),
    );
    const controller = new AbortController();

    expect(address).toEqual(expect.objectContaining({ port: expect.any(Number) }));
    const probe = isGatewayHttpReady(10_000, url, "GET", controller.signal);
    await requestSeen;
    controller.abort();

    await expect(probe).resolves.toBe(false);
  });
});

describe("isDockerDriverGatewayHttpReady TLS env", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the supplied gateway env when loading Docker-driver mTLS client files", async () => {
    const tlsDir = path.join("/tmp", "nemoclaw-probe-tls");
    const readPaths: string[] = [];
    const readFileSync = vi.spyOn(fs, "readFileSync").mockImplementation((filePath) => {
      readPaths.push(String(filePath));
      throw new Error("missing test TLS material");
    });

    await expect(
      isDockerDriverGatewayHttpReady(1, "https://127.0.0.1:1/openshell.v1.OpenShell/Health", {
        OPENSHELL_LOCAL_TLS_DIR: tlsDir,
      }),
    ).resolves.toBe(false);

    expect(readFileSync).toHaveBeenCalled();
    expect(readPaths[0]).toBe(path.join(tlsDir, "ca.crt"));
  });

  it("omits IP literals from TLS SNI while retaining the direct gRPC health probe", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(Buffer.from("test TLS material") as never);
    const stream = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      end: vi.fn(),
    });
    const session = Object.assign(new EventEmitter(), {
      close: vi.fn(),
      request: vi.fn(() => stream),
    });
    const connect = vi.spyOn(http2, "connect").mockReturnValue(session as never);

    const probe = isDockerDriverGatewayHttpReady(
      1_000,
      "https://127.0.0.1:8080/openshell.v1.OpenShell/Health",
      { OPENSHELL_LOCAL_TLS_DIR: "/tmp/nemoclaw-probe-tls" },
    );
    stream.emit("response", { ":status": 200, "content-type": "application/grpc" });
    stream.emit("trailers", { "grpc-status": "0" });
    stream.emit("end");

    await expect(probe).resolves.toBe(true);
    expect(connect).toHaveBeenCalledWith(
      "https://127.0.0.1:8080",
      expect.not.objectContaining({ servername: expect.anything() }),
    );
  });
});
