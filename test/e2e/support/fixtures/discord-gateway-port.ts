// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";

export async function waitForDiscordGatewayPort(portFile: string): Promise<number> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      const contents = fs.readFileSync(portFile, "utf8");
      const port = Number(contents);
      if (Number.isInteger(port) && port > 0 && port <= 65535 && contents === `${port}\n`) {
        return port;
      }
    } catch {
      // The gateway may still be creating its port file.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("fake Discord Gateway did not write a port file");
}
