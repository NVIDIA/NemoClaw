// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { buildInstallCompletedEvent } from "../../domain/telemetry/event";
import { postTelemetryEvent, TELEMETRY_DELIVERY_DEADLINE_MS } from "./http";

const servers: http.Server[] = [];

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

async function listen(server: http.Server): Promise<URL> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  return new URL(`http://127.0.0.1:${address.port}/events`);
}

describe("telemetry HTTP delivery", () => {
  it("uses the single five-second production deadline (#10440)", () => {
    expect(TELEMETRY_DELIVERY_DEADLINE_MS).toBe(5_000);
  });

  it.each(["install", "update"] as const)(
    "posts one validated %s event to a local receiver (#10440)",
    async (operation) => {
      const requests: Array<{ method: string | undefined; body: string }> = [];
      const server = http.createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          requests.push({
            method: request.method,
            body: Buffer.concat(chunks).toString("utf8"),
          });
          response.writeHead(204).end();
        });
      });
      const endpoint = await listen(server);

      await expect(
        postTelemetryEvent({ endpoint }, buildInstallCompletedEvent(operation)),
      ).resolves.toBe("delivered");

      expect(requests).toEqual([
        {
          method: "POST",
          body: JSON.stringify({ event: "nemoclaw_install_completed", operation }),
        },
      ]);
    },
  );

  it("does not retry a rejected event (#10440)", async () => {
    let requests = 0;
    const server = http.createServer((request, response) => {
      requests += 1;
      request.resume();
      response.writeHead(503).end();
    });
    const endpoint = await listen(server);

    await expect(
      postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("update")),
    ).resolves.toBe("failed");
    expect(requests).toBe(1);
  });

  it("fails once when the receiver refuses the connection (#10440)", async () => {
    const server = http.createServer();
    const endpoint = await listen(server);
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    servers.splice(servers.indexOf(server), 1);

    await expect(
      postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("install")),
    ).resolves.toBe("failed");
  });

  it("applies one total deadline to a trickling response (#10440)", async () => {
    let requests = 0;
    let resolveRequestReceived: () => void = () => undefined;
    const requestReceived = new Promise<void>((resolve) => {
      resolveRequestReceived = resolve;
    });
    const server = http.createServer((request, response) => {
      requests += 1;
      resolveRequestReceived();
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => response.write(" "), 20);
      response.once("close", () => clearInterval(timer));
    });
    const endpoint = await listen(server);

    const delivery = postTelemetryEvent({ endpoint }, buildInstallCompletedEvent("install"), 1_000);
    await requestReceived;
    await expect(delivery).resolves.toBe("failed");
    expect(requests).toBe(1);
  });

  it("refuses an event with additional free-form data before networking (#10440)", async () => {
    let requests = 0;
    const server = http.createServer((_request, response) => {
      requests += 1;
      response.writeHead(204).end();
    });
    const endpoint = await listen(server);
    const event = {
      event: "nemoclaw_install_completed",
      operation: "install",
      detail: "free-form",
    } as unknown as ReturnType<typeof buildInstallCompletedEvent>;

    await expect(postTelemetryEvent({ endpoint }, event)).resolves.toBe("failed");
    expect(requests).toBe(0);
  });

  it("strips a hidden serialization override from an otherwise valid event (#10440)", async () => {
    const bodies: string[] = [];
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        bodies.push(Buffer.concat(chunks).toString("utf8"));
        response.writeHead(204).end();
      });
    });
    const endpoint = await listen(server);
    const event = { event: "nemoclaw_install_completed", operation: "install" };
    Object.defineProperty(event, "toJSON", {
      enumerable: false,
      value: () => ({ ...event, detail: "free-form" }),
    });

    await expect(
      postTelemetryEvent({ endpoint }, event as ReturnType<typeof buildInstallCompletedEvent>),
    ).resolves.toBe("delivered");
    expect(bodies).toEqual(['{"event":"nemoclaw_install_completed","operation":"install"}']);
  });
});
