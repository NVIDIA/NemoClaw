// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { isGatewayHttpReady } from "./gateway-http-readiness";

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
