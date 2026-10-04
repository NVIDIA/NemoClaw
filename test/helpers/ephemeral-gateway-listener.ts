// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import net from "node:net";

const markerPath = process.argv[2];
if (!markerPath) throw new Error("A readiness marker path is required.");

const server = net.createServer((socket) => socket.end());
server.once("error", (error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") {
    process.stderr.write("The gateway fixture did not receive a TCP port.\n");
    process.exit(1);
  }
  fs.writeFileSync(markerPath, `${address.port}\n`, { mode: 0o600 });
});
