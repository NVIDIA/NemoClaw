// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net, { type Socket } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { pipeline } from "node:stream/promises";
import {
  TOKEN,
  sleep,
  until,
  listen,
  closeServer,
  request,
  destroySockets,
  openPortableBrokerSession,
  pauseFirstOffer,
  openResetCloseRace,
} from "../support/windows-native-broker-relay-fixtures.ts";
import { createBrokerRelayPeer } from "../../packaging/windows/runtime/native-broker-relay-protocol.mts";
import { containedBrokerRelayFiles } from "../../packaging/windows/runtime/native-broker-tunnel.mts";
import { startNativeInferenceBroker } from "../../packaging/windows/runtime/native-inference-broker.mts";

const BROKER_TOKEN = "harmless-broker-token";
const HOST_KEY = "harmless-host-provider-key";
async function session<T>(
  brokerPort: number,
  action: (value: Awaited<ReturnType<typeof openPortableBrokerSession>>) => Promise<T>,
): Promise<T> {
  const value = await openPortableBrokerSession(brokerPort);
  try {
    return await action(value);
  } finally {
    await value.close();
    expect(value.tunnel.diagnostics().activeConnections).toBe(0);
    expect(value.host.diagnostics().activeConnections).toBe(0);
    value.remove();
  }
}

describe("guarded file broker transport", () => {
  it("preserves real broker authentication and one-use bootstrap across more than 32 HTTP connections", async () => {
    const authorizations: string[] = [];
    const upstream = http.createServer(async (incoming, response) => {
      authorizations.push(incoming.headers.authorization ?? "");
      const body = await buffer(incoming);
      const turn = JSON.parse(body.toString("utf8")) as { turn: number };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ turn: turn.turn, reply: `response-${turn.turn}` }));
    });
    const upstreamPort = await listen(upstream);
    const broker = await startNativeInferenceBroker(
      { endpoint: `http://127.0.0.1:${upstreamPort}/v1`, inference: "local" },
      HOST_KEY,
      BROKER_TOKEN,
      { options: {}, environment: { TAVILY_API_KEY: "harmless-service-canary" } },
    );
    try {
      await session(broker.port, async ({ host, tunnel, root }) => {
        expect((await request(tunnel.port, "/native/bootstrap")).status).toBe(403);
        const bootstrap = await request(
          tunnel.port,
          "/native/bootstrap",
          Buffer.alloc(0),
          `Bearer ${BROKER_TOKEN}`,
        );
        expect(bootstrap.status).toBe(200);
        expect(JSON.parse(bootstrap.body.toString()).environment.TAVILY_API_KEY).toBe(
          "harmless-service-canary",
        );
        expect(bootstrap.body.toString()).not.toContain(HOST_KEY);
        expect(
          (
            await request(
              tunnel.port,
              "/native/bootstrap",
              Buffer.alloc(0),
              `Bearer ${BROKER_TOKEN}`,
            )
          ).status,
        ).toBe(403);
        let turn = 0;
        // One ordered conversation must cross the slot-reuse boundary.
        while (turn < 64) {
          const received = await request(
            tunnel.port,
            "/v1/chat/completions",
            Buffer.from(JSON.stringify({ turn })),
            `Bearer ${BROKER_TOKEN}`,
          );
          expect(received.status).toBe(200);
          expect(JSON.parse(received.body.toString())).toEqual({ turn, reply: `response-${turn}` });
          turn++;
        }
        await until(
          () =>
            host.diagnostics().completedConnections === 67 &&
            tunnel.diagnostics().completedConnections === 67,
        );
        expect(authorizations).toEqual(Array.from({ length: 64 }, () => `Bearer ${HOST_KEY}`));
        expect(fs.readdirSync(root).filter((name) => name.startsWith("stream-"))).toHaveLength(32);
        expect(JSON.stringify(host.diagnostics())).not.toContain(TOKEN);
        expect(JSON.stringify(tunnel.diagnostics())).not.toContain(HOST_KEY);
      });
    } finally {
      await closeServer(broker.server);
      await closeServer(upstream);
    }
  }, 40_000);

  it("streams unmodified HTTP bytes in both directions beyond the former 8 MiB limit", async () => {
    const payload = Buffer.alloc(10 * 1024 * 1024, 0x67);
    const receivedHash = createHash("sha256");
    let received = 0;
    let firstDelivered!: () => void;
    const first = new Promise<void>((resolve) => {
      firstDelivered = resolve;
    });
    const server = http.createServer(async (incoming, response) => {
      const body = await buffer(incoming);
      receivedHash.update(body);
      received += body.length;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("data: first\n\n");
      await first;
      const chunks = Array.from({ length: Math.ceil(payload.length / (64 * 1024)) }, (_, index) =>
        payload.subarray(index * 64 * 1024, (index + 1) * 64 * 1024),
      );
      await pipeline(Readable.from(chunks), response);
    });
    const port = await listen(server);
    try {
      await session(port, async ({ tunnel, host }) => {
        const output = await new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const outgoing = http.request(
            {
              host: "127.0.0.1",
              port: tunnel.port,
              path: "/stream",
              method: "POST",
              agent: false,
              headers: { "content-length": String(payload.length) },
            },
            (response) => {
              response.on("data", (bytes: Buffer) => {
                chunks.push(bytes);
                firstDelivered();
              });
              response.once("error", reject);
              response.once("end", () => resolve(Buffer.concat(chunks)));
            },
          );
          outgoing.once("error", reject);
          outgoing.end(payload);
        });
        expect(output.equals(Buffer.concat([Buffer.from("data: first\n\n"), payload]))).toBe(true);
        expect(received).toBe(payload.length);
        expect(receivedHash.digest("hex")).toBe(createHash("sha256").update(payload).digest("hex"));
        expect(host.diagnostics().maximumOutstandingFramesPerConnection).toBeLessThanOrEqual(8);
        expect(tunnel.diagnostics().maximumQueuedBytesPerConnection).toBeLessThanOrEqual(
          1024 * 1024,
        );
      });
    } finally {
      firstDelivered();
      await closeServer(server);
    }
  }, 60_000);

  it("delivers a response after the client half-closes its request", async () => {
    const sockets = new Set<Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
      sockets.add(socket);
      const chunks: Buffer[] = [];
      socket.on("data", (bytes: Buffer) => chunks.push(bytes));
      socket.once("end", () => socket.end(Buffer.concat([Buffer.from("ack:"), ...chunks])));
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => {});
    });
    const port = await listen(server);
    try {
      await session(port, async ({ tunnel }) => {
        const result = await new Promise<Buffer>((resolve, reject) => {
          const socket = net.createConnection({
            host: "127.0.0.1",
            port: tunnel.port,
            allowHalfOpen: true,
          });
          const chunks: Buffer[] = [];
          socket.once("connect", () => socket.end("half-close"));
          socket.on("data", (bytes: Buffer) => chunks.push(bytes));
          socket.once("error", reject);
          socket.once("end", () => {
            socket.destroy();
            resolve(Buffer.concat(chunks));
          });
        });
        expect(result.toString()).toBe("ack:half-close");
      });
    } finally {
      destroySockets(sockets);
      await closeServer(server);
    }
  });

  it("rejects a previous generation instead of reusing it for a new live stream", async () => {
    const server = http.createServer((_request, response) => response.end("done"));
    const port = await listen(server);
    try {
      await session(port, async ({ root, slots, tunnel, host }) => {
        const original = JSON.parse(fs.readFileSync(path.join(root, slots[0], "open"), "utf8")) as {
          generation: string;
        };
        expect((await request(tunnel.port, "/")).status).toBe(200);
        await until(
          () =>
            host.diagnostics().completedConnections === 1 &&
            tunnel.diagnostics().completedConnections === 1,
        );
        fs.writeFileSync(
          path.join(root, slots[0], "sandbox-0000000000.bin"),
          JSON.stringify({ ...original, kind: "open", sequence: 1, aborted: false, token: TOKEN }),
          { flag: "wx" },
        );
        await expect(host.failure).rejects.toThrow(/invalid frame|lifecycle/u);
      });
    } finally {
      await closeServer(server);
    }
  });

  it("isolates a cancelled request and accepts another request afterward", async () => {
    let requestBytes = 0;
    let aborted = false;
    const server = http.createServer((incoming, response) => {
      incoming.on("data", (bytes: Buffer) => {
        requestBytes += bytes.length;
      });
      incoming.once("aborted", () => {
        aborted = true;
      });
      incoming.on("error", () => {});
      incoming.once("end", () => response.end("next-request"));
    });
    const port = await listen(server);
    try {
      await session(port, async ({ tunnel, host }) => {
        const client = net.createConnection({ host: "127.0.0.1", port: tunnel.port });
        client.on("error", () => {});
        client.write(
          "POST /cancel HTTP/1.1\r\nHost: localhost\r\nContent-Length: 1048576\r\n\r\npartial",
        );
        await until(() => requestBytes > 0);
        client.destroy();
        await until(
          () =>
            aborted &&
            host.diagnostics().completedConnections === 1 &&
            tunnel.diagnostics().completedConnections === 1,
        );
        expect((await request(tunnel.port, "/next")).body.toString()).toBe("next-request");
      });
    } finally {
      await closeServer(server);
    }
  });

  it("limits active connections to 32 and Stop closes every socket", async () => {
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
    });
    const port = await listen(server);
    try {
      await session(port, async ({ tunnel, host }) => {
        const clients = Array.from({ length: 32 }, () => {
          const socket = net.createConnection({ host: "127.0.0.1", port: tunnel.port });
          socket.on("error", () => {});
          return socket;
        });
        try {
          await until(() => host.diagnostics().activeConnections === 32 && sockets.size === 32);
          const extra = net.createConnection({ host: "127.0.0.1", port: tunnel.port });
          extra.on("error", () => {});
          await new Promise<void>((resolve) => extra.once("close", resolve));
          expect(tunnel.diagnostics().rejectedConnections).toBe(1);
          expect(host.diagnostics().activeConnections).toBe(32);
          await Promise.all([host.close(), tunnel.close()]);
          await until(() => sockets.size === 0);
          await expect(request(tunnel.port, "/")).rejects.toMatchObject({ code: "ECONNREFUSED" });
        } finally {
          destroySockets(clients);
        }
      });
    } finally {
      destroySockets(sockets);
      await closeServer(server);
    }
  });

  it("does not open a listener after abort while reading initial slot offers", async () => {
    const server = http.createServer((_request, response) => response.end("unused"));
    const port = await listen(server);
    try {
      await session(port, async ({ root, slots }) => {
        const files = containedBrokerRelayFiles(root);
        const controller = new AbortController();
        const gate = pauseFirstOffer(files);
        const pending = createBrokerRelayPeer({
          files: gate.files,
          token: TOKEN,
          slots,
          side: "sandbox",
          signal: controller.signal,
        });
        await until(gate.entered);
        controller.abort();
        gate.release();
        await expect(pending).rejects.toThrow(/stopped during startup/u);
      });
    } finally {
      await closeServer(server);
    }
  });

  it("keeps FIN available until both reset peers acknowledge the final sequence", async () => {
    const race = await openResetCloseRace();
    try {
      await until(
        () =>
          race.paused() &&
          race.host.diagnostics().completedConnections === 1 &&
          race.sandbox.diagnostics().completedConnections === 1,
        3000,
      );
      expect(race.retiredBeforeFinRead()).toBe(false);
      expect(race.host.diagnostics().activeConnections).toBe(0);
      expect(race.sandbox.diagnostics().activeConnections).toBe(0);
    } finally {
      await race.close();
    }
  });

  it("bounds unread response frames and closes the stalled peer and listener on Stop", async () => {
    const sockets = new Set<Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      socket.write(Buffer.alloc(32 * 1024 * 1024, 0x5a));
    });
    const port = await listen(server);
    try {
      await session(port, async ({ root, tunnel, host }) => {
        const client = net.createConnection({ host: "127.0.0.1", port: tunnel.port });
        client.on("error", () => {});
        client.pause();
        try {
          await until(() => host.diagnostics().maximumOutstandingFramesPerConnection === 8, 10_000);
          await sleep(100);
          const frames = fs
            .readdirSync(root)
            .filter((name) => name.startsWith("stream-"))
            .flatMap((name) =>
              fs
                .readdirSync(path.join(root, name))
                .filter((leaf) => /^(?:host|sandbox)-[0-9]{10}\.bin$/u.test(leaf)),
            );
          expect(frames.length).toBeLessThanOrEqual(18);
          expect(host.diagnostics().maximumQueuedBytesPerConnection).toBeLessThanOrEqual(
            1024 * 1024,
          );
          await expect(host.failure).rejects.toThrow(/stopped acknowledging/u);
          await tunnel.close();
          await until(() => sockets.size === 0);
          await expect(request(tunnel.port, "/")).rejects.toMatchObject({ code: "ECONNREFUSED" });
        } finally {
          client.destroy();
        }
      });
    } finally {
      destroySockets(sockets);
      await closeServer(server);
    }
  }, 50_000);
});
