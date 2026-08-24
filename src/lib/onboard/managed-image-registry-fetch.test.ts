// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { PEM } from "./__test-helpers__/corporate-ca-fixtures";
import {
  createManagedImageRegistryFetchSession,
  resolveManagedImageRegistryDispatcherOptions,
} from "./managed-image/registry-fetch";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe("managed image registry transport", () => {
  it("forwards a plain HTTP registry fetch through the configured host proxy", async () => {
    const requests: Array<{ host: string | undefined; method: string | undefined; url: string }> =
      [];
    const proxy = createServer((request, response) => {
      requests.push({
        host: request.headers.host,
        method: request.method,
        url: request.url ?? "",
      });
      response.end("proxied");
    });
    proxy.on("connect", (_request, socket) => {
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    const proxyPort = await listen(proxy);
    const session = createManagedImageRegistryFetchSession({
      environment: {
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        NEMOCLAW_CORPORATE_CA_IMPORT: "0",
      },
    });

    try {
      const response = await session.fetchImpl("http://registry.invalid/v2/");
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("proxied");
      expect(requests).toEqual([
        {
          host: "registry.invalid",
          method: "GET",
          url: "http://registry.invalid/v2/",
        },
      ]);
    } finally {
      await session.close();
    }
  });

  it("cancels an HTTPS registry fetch after the proxy tunnel is established", async () => {
    const tunnels: string[] = [];
    const abortController = new AbortController();
    let destroyTunnel: (() => void) | undefined;

    const proxy = createServer();
    proxy.on("connect", (request, socket) => {
      tunnels.push(request.url ?? "");
      destroyTunnel = () => socket.destroy();
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n", () => {
        abortController.abort();
      });
    });
    const proxyPort = await listen(proxy);
    const session = createManagedImageRegistryFetchSession({
      environment: {
        HTTP_PROXY: `http://127.0.0.1:${proxyPort}`,
        NEMOCLAW_CORPORATE_CA_IMPORT: "0",
      },
    });

    try {
      await expect(
        session.fetchImpl("https://registry.invalid/v2/", { signal: abortController.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
      expect(tunnels).toEqual(["registry.invalid:443"]);
    } finally {
      destroyTunnel?.();
      await session.close();
    }
  });

  it("honors normalized NO_PROXY without mutating the global dispatcher", async () => {
    let proxyTunnels = 0;
    const proxy = createServer();
    proxy.on("connect", (_request, socket) => {
      proxyTunnels += 1;
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    const proxyPort = await listen(proxy);
    const targetPort = await listen(
      createServer((_request, response) => {
        response.end("direct");
      }),
    );
    const session = createManagedImageRegistryFetchSession({
      environment: {
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "127.0.0.1",
        NEMOCLAW_CORPORATE_CA_IMPORT: "0",
      },
    });

    try {
      const response = await session.fetchImpl(`http://127.0.0.1:${targetPort}/health`);
      expect(await response.text()).toBe("direct");
      expect(proxyTunnels).toBe(0);
    } finally {
      await session.close();
    }
  });

  it.each([
    { scenario: "direct connection" },
    { scenario: "request TLS" },
    { scenario: "proxy TLS" },
  ])(
    "adds the validated corporate CA to direct, request, and proxy TLS trust [$scenario]",
    ({ scenario }) => {
      const options = resolveManagedImageRegistryDispatcherOptions({
        environment: {},
        corporateCaOverride: {
          pem: PEM,
          sourceEnv: "fixture",
          sourcePath: "/fixture/corporate-ca.pem",
        },
      });

      const tls = (
        {
          "direct connection": options.connect,
          "request TLS": options.requestTls,
          "proxy TLS": options.proxyTls,
        } as const
      )[scenario]!;
      expect((tls as { ca?: readonly string[] }).ca).toContain(PEM);
    },
  );

  it("gives lowercase proxy variables precedence and rejects unsupported proxy URLs", () => {
    expect(
      resolveManagedImageRegistryDispatcherOptions({
        environment: {
          HTTP_PROXY: "http://ignored.example:8080",
          http_proxy: "http://selected.example:8081",
          NEMOCLAW_CORPORATE_CA_IMPORT: "0",
        },
      }).httpProxy,
    ).toBe("http://selected.example:8081/");

    expect(() =>
      resolveManagedImageRegistryDispatcherOptions({
        environment: {
          HTTPS_PROXY: "file:///tmp/not-a-proxy",
          NEMOCLAW_CORPORATE_CA_IMPORT: "0",
        },
      }),
    ).toThrow("not a supported HTTP(S) proxy URL");
  });

  it("preserves uppercase-only NO_PROXY exclusions in the normalized transport", () => {
    const options = resolveManagedImageRegistryDispatcherOptions({
      environment: {
        HTTPS_PROXY: "http://proxy.example:8080",
        NO_PROXY: "corp.internal",
        NEMOCLAW_CORPORATE_CA_IMPORT: "0",
      },
    });

    expect(options.noProxy?.split(",")).toContain("corp.internal");
  });
});
