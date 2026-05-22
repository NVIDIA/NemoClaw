// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

const net = require("node:net");

const listenPort = Number(process.argv[2] || "3128");
const upstreamHost = process.argv[3] || "10.200.0.1";
const upstreamPort = Number(process.argv[4] || "3128");

function validPort(value) {
  return Number.isInteger(value) && value > 0 && value <= 65535;
}

if (!validPort(listenPort) || !validPort(upstreamPort)) {
  console.error("[discord-loopback-proxy] invalid port");
  process.exit(1);
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: upstreamHost, port: upstreamPort });
  client.on("error", () => {});
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});

server.on("error", (error) => {
  console.error(`[discord-loopback-proxy] ${error.message}`);
  process.exit(1);
});

server.listen(listenPort, "127.0.0.1", () => {
  console.error(
    `[discord-loopback-proxy] listening on 127.0.0.1:${listenPort} -> ${upstreamHost}:${upstreamPort}`,
  );
});
