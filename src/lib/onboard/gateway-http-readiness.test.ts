// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import http2 from "node:http2";
import type { AddressInfo } from "node:net";
import os from "node:os";
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
});

describe("isDockerDriverGatewayHttpReady TLS servername", () => {
  const tlsDirs: string[] = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    for (const dir of tlsDirs.splice(0)) {
      fs.rmSync(dir, { force: true, recursive: true });
    }
  });

  function writeLocalTlsDir(): string {
    const tlsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gateway-tls-"));
    tlsDirs.push(tlsDir);
    fs.writeFileSync(path.join(tlsDir, "ca.crt"), "ca");
    fs.mkdirSync(path.join(tlsDir, "client"));
    fs.writeFileSync(path.join(tlsDir, "client", "tls.crt"), "cert");
    fs.writeFileSync(path.join(tlsDir, "client", "tls.key"), "key");
    return tlsDir;
  }

  function healthySessionStub(): http2.ClientHttp2Session {
    const stream = new EventEmitter() as EventEmitter & {
      close: () => void;
      end: (payload?: Buffer) => void;
    };
    stream.close = () => undefined;
    stream.end = () => {
      setImmediate(() => {
        stream.emit("response", {
          [http2.constants.HTTP2_HEADER_STATUS]: 200,
          [http2.constants.HTTP2_HEADER_CONTENT_TYPE]: "application/grpc",
          "grpc-status": "0",
        });
        stream.emit("end");
      });
    };
    const client = new EventEmitter() as EventEmitter & {
      close: () => void;
      request: () => typeof stream;
    };
    client.close = () => undefined;
    client.request = () => stream;
    return client as unknown as http2.ClientHttp2Session;
  }

  function spyOnHttp2Connect() {
    return vi.spyOn(http2, "connect").mockImplementation(() => healthySessionStub());
  }

  function connectOptionsFrom(
    connect: ReturnType<typeof spyOnHttp2Connect>,
  ): Record<string, unknown> {
    expect(connect).toHaveBeenCalledTimes(1);
    return connect.mock.calls[0]?.[1] as Record<string, unknown>;
  }

  it("omits servername for an IP-literal gateway host, which Node 25 rejects as a TLS ServerName (#7527)", async () => {
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", writeLocalTlsDir());
    const connect = spyOnHttp2Connect();

    await expect(
      isDockerDriverGatewayHttpReady(1_000, "https://127.0.0.1:8080/openshell.v1.OpenShell/Health"),
    ).resolves.toBe(true);

    expect(connectOptionsFrom(connect)).not.toHaveProperty("servername");
  });

  it("omits servername for a bracketed IPv6 gateway host (#7527)", async () => {
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", writeLocalTlsDir());
    const connect = spyOnHttp2Connect();

    await expect(
      isDockerDriverGatewayHttpReady(1_000, "https://[::1]:8080/openshell.v1.OpenShell/Health"),
    ).resolves.toBe(true);

    expect(connectOptionsFrom(connect)).not.toHaveProperty("servername");
  });

  it("keeps servername for a DNS gateway hostname (#7527)", async () => {
    vi.stubEnv("OPENSHELL_LOCAL_TLS_DIR", writeLocalTlsDir());
    const connect = spyOnHttp2Connect();

    await expect(
      isDockerDriverGatewayHttpReady(
        1_000,
        "https://host.openshell.internal:8080/openshell.v1.OpenShell/Health",
      ),
    ).resolves.toBe(true);

    expect(connectOptionsFrom(connect).servername).toBe("host.openshell.internal");
  });
});
