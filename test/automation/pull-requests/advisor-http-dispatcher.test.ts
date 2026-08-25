// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

const servers: http.Server[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
  }
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("advisor HTTP dispatcher", () => {
  it("routes embedded SDK fetch through the environment proxy", async () => {
    const connectTargets: string[] = [];
    const proxy = http.createServer();
    proxy.on("connect", (request, socket) => {
      connectTargets.push(request.url ?? "");
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    servers.push(proxy);
    const address = proxy.address() as AddressInfo;

    const moduleUrl = new URL("../../../tools/advisors/http-dispatcher.mts", import.meta.url).href;
    const script = `
      import { getGlobalDispatcher } from "undici";
      import { configureAdvisorHttpDispatcher } from ${JSON.stringify(moduleUrl)};
      const originalFetch = globalThis.fetch;
      configureAdvisorHttpDispatcher();
      if (globalThis.fetch === originalFetch) {
        throw new Error("advisor transport did not install npm Undici fetch");
      }
      let fetchRejected = false;
      try {
        await fetch("https://advisor-transport.invalid/v1");
      } catch {
        fetchRejected = true;
      }
      if (!fetchRejected) {
        throw new Error("advisor transport swallowed a failed fetch");
      }
      getGlobalDispatcher().emit("error", new Error("unpaired-dispatcher-failure"));
    `;
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", script],
      {
        env: {
          ...process.env,
          HTTP_PROXY: `http://127.0.0.1:${address.port}`,
          HTTPS_PROXY: `http://127.0.0.1:${address.port}`,
          ALL_PROXY: "",
          NO_PROXY: "",
          NODE_USE_ENV_PROXY: "",
          all_proxy: "",
          http_proxy: `http://127.0.0.1:${address.port}`,
          https_proxy: `http://127.0.0.1:${address.port}`,
          no_proxy: "",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    children.push(child);
    const stderr: Buffer[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
    timeout.unref();
    const [exitCode] = (await once(child, "exit")) as [number | null];
    clearTimeout(timeout);

    expect(exitCode, Buffer.concat(stderr).toString("utf8")).toBe(0);
    expect(connectTargets).toContain("advisor-transport.invalid:443");
    expect(Buffer.concat(stderr).toString("utf8")).toContain(
      "Advisor HTTP dispatcher error: Error: unpaired-dispatcher-failure",
    );
  });
});
