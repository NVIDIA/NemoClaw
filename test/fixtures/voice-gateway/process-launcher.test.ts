// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { describe, expect, test } from "../../helpers/owned-test-resources";
import { requestSession, stopGateway } from "./process-launcher";

describe("voice gateway process fixture containment", () => {
  test.skipIf(process.platform === "win32")(
    "escalates from SIGTERM when the gateway child refuses to exit",
    async ({ resources }) => {
      const child = resources.ownChild(
        spawn(
          process.execPath,
          [
            "-e",
            'process.on("SIGTERM", () => {}); process.stdout.write("ready\\n"); setInterval(() => {}, 1_000);',
          ],
          { stdio: ["ignore", "pipe", "ignore"] },
        ),
      );
      await once(child.stdout!, "data");

      await stopGateway(child);

      expect(child.signalCode).toBe("SIGKILL");
    },
  );

  test("bounds a stalled loopback session request and omits credentials from its error", async ({
    resources,
  }) => {
    const server = resources.ownServer(http.createServer(() => undefined));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    expect(address).not.toBeNull();
    expect(typeof address).not.toBe("string");
    const bearer = "fixture-bearer-must-not-leak";

    let failure: Error | null = null;
    try {
      await requestSession((address as AddressInfo).port, bearer, 50);
    } catch (error) {
      failure = error as Error;
    } finally {
      server.closeAllConnections();
    }

    expect(failure?.message).toContain("voice gateway session request timed out after 50 ms");
    expect(failure?.message).not.toContain(bearer);
  });
});
