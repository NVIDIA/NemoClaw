// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it } from "vitest";

import {
  hermesDiscordHttpProxyWebSocketUrl,
  hermesDiscordNodeHttpProbeSource,
} from "../live/hermes-discord-proxy.ts";

describe("Hermes Discord proxy request", () => {
  it("uses HTTP absolute-form for the native WebSocket upgrade through OpenShell", () => {
    const gateway = new URL(hermesDiscordHttpProxyWebSocketUrl("host.docker.internal", 32_768));

    expect(gateway.protocol).toBe("http:");
    expect(gateway.host).toBe("host.docker.internal:32768");
    expect(gateway.pathname).toBe("/gateway");
  });

  it("reports the policy response that distinguishes denial from a probe defect", async () => {
    const server = http.createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end('{"error":"policy_denied"}');
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const address = server.address() as AddressInfo;

      const child = spawn(
        process.execPath,
        ["-e", hermesDiscordNodeHttpProbeSource(`http://127.0.0.1:${address.port}/probe`)],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      const [exitCode] = (await once(child, "close")) as [number];

      expect(exitCode).toBe(3);
      expect(stderr).toBe("");
      expect(stdout.trim()).toBe('response 403 {"error":"policy_denied"}');
    } finally {
      server.close();
      await once(server, "close");
    }
  });
});
