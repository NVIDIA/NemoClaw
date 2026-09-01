// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import http from "node:http";

import { describe, expect, it } from "vitest";

import { closeServer, listenServer, writeJsonResponse } from "../fixtures/http-protocol.ts";
import { proveFakeApiPortTraffic } from "../lib/fake-api-port-readiness.mts";

describe("fake API port readiness", () => {
  it("rejects a REST redirect without contacting its target", async () => {
    let targetRequests = 0;
    const target = http.createServer((_request, response) => {
      targetRequests += 1;
      writeJsonResponse(response, 200, { type: "nemoclaw_port_traffic_reply" });
    });
    const targetPort = await listenServer(target, 0, "127.0.0.1");
    const redirect = http.createServer((_request, response) => {
      response
        .writeHead(302, {
          location: `http://127.0.0.1:${targetPort}/__nemoclaw_e2e_port_traffic`,
        })
        .end();
    });
    const redirectPort = await listenServer(redirect, 0, "127.0.0.1");

    try {
      await expect(
        proveFakeApiPortTraffic({ host: "127.0.0.1", restPort: redirectPort }),
      ).rejects.toThrow(/fake API port traffic check failed/u);
      expect(targetRequests).toBe(0);
    } finally {
      await Promise.all([closeServer(redirect), closeServer(target)]);
    }
  }, 15_000);
});
