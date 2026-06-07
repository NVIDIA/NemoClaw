// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildSubprocessEnv } from "../dist/lib/subprocess-env";

function runCurl(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { env });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on("data", (c) => stdoutChunks.push(c));
    child.stderr.on("data", (c) => stderrChunks.push(c));
    child.on("error", reject);
    child.on("close", (status) => {
      resolve({
        status,
        stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
        stderr: Buffer.concat(stderrChunks).toString("utf-8"),
      });
    });
  });
}

function curlAvailable(): boolean {
  try {
    execFileSync("curl", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const curlOk = curlAvailable();
if (!curlOk && process.env.CI === "true") {
  throw new Error(
    "[host-proxy-inference-local-e2e] CI=true but curl unavailable. " +
      "This test must not silently skip in CI — install curl on the runner.",
  );
}

// Boundary: this E2E proves that the env produced by `buildSubprocessEnv()`
// causes a host-side `curl` to reach `inference.local` directly when a host
// HTTP proxy is set, exercising the seed list `withLocalNoProxy()` injects.
// The test is run against a deliberately unreachable proxy (127.0.0.1:1)
// so that the negative control case fails fast when the bypass is absent,
// and the positive case proves that `no_proxy` (lowercase, the form curl
// honours for plain http:// URLs) is responsible for routing the request
// directly to the local listener.
//
// The full sandbox path on macOS + Colima (where OpenShell's L7 proxy
// chains through the host HTTP_PROXY and must bypass for `inference.local`)
// requires a macOS + Colima runner and is not covered here.
describe("inference.local bypass via host NO_PROXY seed", () => {
  const saved: Record<string, string | undefined> = {};
  let server: http.Server;
  let port: number;
  let received: { url: string | undefined; host: string | undefined }[];

  const curlArgs = () => [
    "-sS",
    "--max-time",
    "5",
    "--resolve",
    `inference.local:${port}:127.0.0.1`,
    `http://inference.local:${port}/v1/chat/completions`,
  ];

  const stripInferenceLocal = (env: Record<string, string | undefined>) => {
    for (const key of ["NO_PROXY", "no_proxy"] as const) {
      const cur = env[key] ?? "";
      env[key] = cur
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p && p !== "inference.local")
        .join(",");
    }
  };

  beforeEach(async () => {
    received = [];
    server = http.createServer((req, res) => {
      received.push({ url: req.url, host: req.headers.host });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("inference-local-direct");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const addr = server.address() as AddressInfo | null;
    if (!addr) throw new Error("listener address unavailable");
    port = addr.port;

    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "NO_PROXY",
      "http_proxy",
      "https_proxy",
      "no_proxy",
    ]) {
      saved[key] = process.env[key];
    }
    // Set both cases — curl honours lowercase `http_proxy` for http:// URLs
    // and uppercase HTTPS_PROXY for https:// URLs. Pointing both at a
    // deliberately unreachable address (127.0.0.1:1, refused) ensures a
    // proxied request fails fast.
    process.env.HTTP_PROXY = "http://127.0.0.1:1";
    process.env.HTTPS_PROXY = "http://127.0.0.1:1";
    process.env.http_proxy = "http://127.0.0.1:1";
    process.env.https_proxy = "http://127.0.0.1:1";
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  });

  afterEach(async () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it.skipIf(!curlOk)(
    "negative control: without inference.local in no_proxy, curl is routed through the broken proxy and the listener never sees the request",
    async () => {
      const env = buildSubprocessEnv();
      stripInferenceLocal(env);
      expect(env.NO_PROXY?.split(",")).not.toContain("inference.local");
      expect(env.no_proxy?.split(",")).not.toContain("inference.local");

      const result = await runCurl(curlArgs(), env);

      expect(
        result.status,
        `curl should fail when routed through the broken proxy; stderr: ${result.stderr}`,
      ).not.toBe(0);
      expect(received).toHaveLength(0);
    },
  );

  it.skipIf(!curlOk)(
    "positive: subprocess env carries inference.local in no_proxy so curl bypasses the broken proxy and reaches the listener",
    async () => {
      const env = buildSubprocessEnv();
      expect(env.NO_PROXY?.split(",")).toContain("inference.local");
      expect(env.no_proxy?.split(",")).toContain("inference.local");

      const result = await runCurl(curlArgs(), env);

      expect(result.status, `curl exit ${result.status}, stderr: ${result.stderr}`).toBe(0);
      expect(result.stdout).toBe("inference-local-direct");
      expect(received).toHaveLength(1);
      expect(received[0]?.url).toBe("/v1/chat/completions");
      expect(received[0]?.host).toBe(`inference.local:${port}`);
    },
  );
});
