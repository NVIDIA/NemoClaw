// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dgram from "node:dgram";
import net from "node:net";
import { Resolver } from "node:dns/promises";
import { expect, it } from "vitest";
import {
  readDnsTcpFrame,
  reboundDnsAnswer,
  startRebindingDnsServer,
} from "../fixtures/dns-rebinding-server.ts";

const HOST = "fixture.example.test";
function query(host: string, type = 1): Buffer {
  const header = Buffer.from([0, 123, 1, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([
    header,
    ...host
      .split(".")
      .map((part) => Buffer.concat([Buffer.from([part.length]), Buffer.from(part)])),
    Buffer.from([0, 0, type, 0, 1]),
  ]);
}

it("overrides A and suppresses AAAA only for the selected hostname", () => {
  const answer = reboundDnsAnswer(query(HOST), HOST, "192.0.2.1")!;
  expect(answer.subarray(-4)).toEqual(Buffer.from([192, 0, 2, 1]));
  expect(answer.readUInt16BE(0)).toBe(123);
  expect(answer.readUInt16BE(6)).toBe(1);
  expect(reboundDnsAnswer(query(HOST, 28), HOST, "192.0.2.1")!.readUInt16BE(6)).toBe(0);
  expect(reboundDnsAnswer(query("other.example.test"), HOST, "192.0.2.1")).toBeNull();
  expect(reboundDnsAnswer(query(HOST).subarray(0, 14), HOST, "192.0.2.1")).toBeNull();
});

it("forwards UDP and TCP controls, changes real DNS answers, and closes twice", async () => {
  const udp = dgram.createSocket("udp4");
  const answer = (bytes: Buffer) =>
    reboundDnsAnswer(bytes, HOST, "203.0.113.8") ??
    reboundDnsAnswer(bytes, "other.example.test", "203.0.113.8")!;
  udp.on("message", (bytes, peer) => udp.send(answer(bytes), peer.port, peer.address));
  await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
  let tcpQueries = 0;
  const tcp = net.createServer((client) => {
    void readDnsTcpFrame(client)
      .then((bytes) => {
        tcpQueries += 1;
        const response = answer(bytes);
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(response.length);
        client.end(Buffer.concat([prefix, response]));
      })
      .catch(() => client.destroy());
  });
  await new Promise<void>((resolve) => tcp.listen(udp.address().port, "127.0.0.1", resolve));
  const server = await startRebindingDnsServer(HOST, "127.0.0.1", udp.address().port);
  const resolver = new Resolver();
  resolver.setServers([`127.0.0.1:${server.port}`]);
  try {
    expect(await resolver.resolve4(HOST)).toEqual(["203.0.113.8"]);
    const tcpResponse = await new Promise<Buffer>((resolve, reject) => {
      const client = net.createConnection({ host: "127.0.0.1", port: server.port });
      const payload = query(HOST);
      const prefix = Buffer.alloc(2);
      prefix.writeUInt16BE(payload.length);
      let bytes = Buffer.alloc(0);
      client.on("error", reject);
      client.setTimeout(3000, () => client.destroy(new Error("test DNS timeout")));
      client.on("connect", () => {
        client.write(prefix);
        client.write(payload);
      });
      client.on("data", (chunk) => {
        bytes = Buffer.concat([bytes, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      });
      client.on("end", () => resolve(bytes));
    });
    expect(tcpQueries).toBe(1);
    expect(tcpResponse.subarray(-4)).toEqual(Buffer.from([203, 0, 113, 8]));
    server.setAddress("192.0.2.1");
    expect(await resolver.resolve4(HOST)).toEqual(["192.0.2.1"]);
    await expect(resolver.resolve6(HOST)).rejects.toMatchObject({ code: "ENODATA" });
    expect(await resolver.resolve4("other.example.test")).toEqual(["203.0.113.8"]);
    expect(server.answers()).toBe(1);
    server.setAddress("10.20.30.40");
    expect(server.answers()).toBe(0);
    expect(await resolver.resolve4(HOST)).toEqual(["10.20.30.40"]);
  } finally {
    await server.close();
    await server.close();
    udp.close();
    await new Promise<void>((resolve) => tcp.close(() => resolve()));
  }
});
