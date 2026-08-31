// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import net from "node:net";

const target = process.env.NEMOCLAW_FAKE_API_PROXY_TARGET ?? "";
const portList = process.env.NEMOCLAW_FAKE_API_PROXY_PORTS ?? "";
if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(target)) {
  throw new Error("NEMOCLAW_FAKE_API_PROXY_TARGET must be a Docker container name");
}
const ports = portList === "8080" ? [8080] : portList === "8080,8081" ? [8080, 8081] : undefined;
if (!ports) throw new Error("NEMOCLAW_FAKE_API_PROXY_PORTS must be 8080 or 8080,8081");

for (const port of ports) {
  const server = net.createServer((client) => {
    const upstream = net.createConnection({ host: target, port });
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.once("error", (error) => {
    process.stderr.write(`fake API proxy listener ${port} failed: ${error.message}\n`);
    process.exit(1);
  });
  server.listen(port, "0.0.0.0");
}
