// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import dgram from "node:dgram";
import net from "node:net";

const MAX_DNS_BYTES = 8192;

/** Read one bounded DNS frame, including fragmented TCP deliveries. */
export function readDnsTcpFrame(client: net.Socket): Promise<Buffer> {
  return new Promise((accept, reject) => {
    let bytes = Buffer.alloc(0);
    const finish = (error: Error | null, payload?: Buffer) => {
      client.off("data", receive);
      client.off("error", failed);
      client.off("end", ended);
      client.off("close", ended);
      if (error) reject(error);
      else accept(payload!);
    };
    const failed = (error: Error) => finish(error);
    const ended = () => finish(new Error("DNS connection ended before a complete frame"));
    const receive = (chunk: Buffer) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length < 2) return;
      const length = bytes.readUInt16BE(0);
      if (length < 12 || length > MAX_DNS_BYTES || bytes.length > length + 2) {
        finish(new Error("Invalid DNS frame"));
      } else if (bytes.length === length + 2) {
        client.pause();
        finish(null, bytes.subarray(2));
      }
    };
    client.on("data", receive);
    client.once("error", failed);
    client.once("end", ended);
    client.once("close", ended);
  });
}

/** Override one IPv4 fixture answer; preserve the question and return no AAAA answer. */
export function reboundDnsAnswer(query: Buffer, hostname: string, address: string): Buffer | null {
  if (query.length < 17 || query.length > MAX_DNS_BYTES || query.readUInt16BE(4) !== 1) return null;
  const labels: string[] = [];
  let offset = 12;
  while (offset < query.length && query[offset] !== 0) {
    const length = query[offset++]!;
    if (length > 63 || offset + length >= query.length) return null;
    const label = query.subarray(offset, offset + length).toString("utf8");
    if (!/^[a-z0-9-]+$/iu.test(label)) return null;
    labels.push(label);
    offset += length;
  }
  offset += 1;
  if (offset + 4 > query.length || labels.join(".").toLowerCase() !== hostname) return null;
  const type = query.readUInt16BE(offset);
  if ((type !== 1 && type !== 28) || query.readUInt16BE(offset + 2) !== 1) return null;
  if (net.isIP(address) !== 4) throw new Error("DNS rebinding requires an IPv4 fixture address");
  const reply = Buffer.from(query.subarray(0, offset + 4));
  reply.writeUInt16BE(0x8080 | (query.readUInt16BE(2) & 0x0100), 2);
  reply.writeUInt16BE(type === 1 ? 1 : 0, 6);
  reply.writeUInt32BE(0, 8);
  // The answer points to the unchanged question name and has TTL zero.
  return type === 28
    ? reply
    : Buffer.concat([
        reply,
        Buffer.from([192, 12, 0, 1, 0, 1, 0, 0, 0, 0, 0, 4, ...address.split(".").map(Number)]),
      ]);
}

export async function startRebindingDnsServer(
  hostname: string,
  upstream: string,
  upstreamPort = 53,
) {
  const family = net.isIP(upstream);
  if (
    !family ||
    hostname.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]+$/u.test(hostname)
  ) {
    throw new Error("DNS fixture requires one literal upstream and a canonical hostname");
  }
  const socketType = family === 4 ? "udp4" : "udp6";
  const loopback = family === 4 ? "127.0.0.1" : "::1";
  let address: string | null = null;
  let answerCount = 0;
  let closed = false;
  const pending = new Set<dgram.Socket>();
  const clients = new Set<net.Socket>();
  const resolve = async (query: Buffer, tcpQuery = false): Promise<Buffer> => {
    const answer = address ? reboundDnsAnswer(query, hostname, address) : null;
    if (answer) {
      if (answer.readUInt16BE(6) === 1) answerCount += 1;
      return answer;
    }
    if (query.length < 12 || query.length > MAX_DNS_BYTES || pending.size >= 32) {
      throw new Error("DNS fixture query limit exceeded");
    }
    if (tcpQuery) {
      return await new Promise<Buffer>((accept, reject) => {
        const client = net.createConnection({ host: upstream, port: upstreamPort });
        clients.add(client);
        client.on("close", () => clients.delete(client));
        client.once("error", reject);
        client.setTimeout(3000, () => client.destroy(new Error("DNS upstream timed out")));
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(query.length);
        client.on("connect", () => client.write(Buffer.concat([prefix, query])));
        void readDnsTcpFrame(client).then(
          (response) => {
            if (response.readUInt16BE(0) === query.readUInt16BE(0)) accept(response);
            else reject(new Error("Upstream DNS response identity changed"));
            client.destroy();
          },
          (error: Error) => {
            reject(error);
            client.destroy();
          },
        );
      });
    }
    return await new Promise<Buffer>((accept, reject) => {
      const socket = dgram.createSocket(socketType);
      pending.add(socket);
      const timer = setTimeout(() => finish(new Error("DNS upstream timed out")), 3000);
      const finish = (error: Error | null, response?: Buffer) => {
        if (!pending.delete(socket)) return;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else accept(response!);
      };
      socket.once("error", (error) => finish(error));
      socket.on("message", (response) => {
        if (
          response.length >= 12 &&
          response.length <= MAX_DNS_BYTES &&
          response.readUInt16BE(0) === query.readUInt16BE(0)
        ) {
          finish(null, response);
        }
      });
      socket.connect(upstreamPort, upstream, () => socket.send(query));
    });
  };
  const udp = dgram.createSocket(socketType);
  udp.on("message", (query, peer) => {
    void resolve(query)
      .then((reply) => udp.send(reply, peer.port, peer.address))
      .catch(() => {});
  });
  await new Promise<void>((accept, reject) => {
    udp.once("error", reject);
    udp.bind(0, loopback, accept);
  });
  const port = udp.address().port;
  const tcp = net.createServer((client) => {
    if (clients.size >= 32) {
      client.destroy();
      return;
    }
    clients.add(client);
    client.on("close", () => clients.delete(client));
    client.on("error", () => client.destroy());
    client.setTimeout(3000, () => client.destroy());
    void readDnsTcpFrame(client)
      .then((query) => resolve(query, true))
      .then((reply) => {
        const prefix = Buffer.alloc(2);
        prefix.writeUInt16BE(reply.length);
        client.end(Buffer.concat([prefix, reply]));
      })
      .catch(() => client.destroy());
  });
  try {
    await new Promise<void>((accept, reject) => {
      tcp.once("error", reject);
      tcp.listen(port, loopback, accept);
    });
  } catch (error) {
    udp.close();
    throw error;
  }
  return {
    port,
    family,
    answers: () => answerCount,
    setAddress(value: string) {
      if (net.isIP(value) !== 4) throw new Error("DNS rebinding requires an IPv4 fixture address");
      address = value;
      answerCount = 0;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const client of clients) client.destroy(new Error("DNS fixture stopped"));
      for (const socket of pending) socket.emit("error", new Error("DNS fixture stopped"));
      udp.close();
      await new Promise<void>((accept, reject) =>
        tcp.close((error) => (error ? reject(error) : accept())),
      );
    },
  };
}
