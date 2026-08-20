// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { nodeOptionsWithoutSourceLoader } from "./helpers/source-loader-options";

const BROKER_SCRIPT = path.resolve("agents/hermes/host/tool-gateway-broker.ts");
const REFRESH_TOKEN = "test-only-hermes-refresh-token";
const REDIRECT_TARGET = "https://redirect-probe.invalid/collect";

const servers: http.Server[] = [];
const children: ChildProcess[] = [];
const directories: string[] = [];

afterEach(async () => {
  children.splice(0).forEach((child) => child.kill("SIGKILL"));
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.closeAllConnections();
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
  directories.splice(0).forEach((dir) => fs.rmSync(dir, { force: true, recursive: true }));
});

async function listenOnLoopback(server: http.Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return (server.address() as AddressInfo).port;
}

/** Reserve a loopback port, then release it so the broker can bind it itself. */
async function reserveLoopbackPort(): Promise<number> {
  const placeholder = http.createServer();
  placeholder.listen(0, "127.0.0.1");
  await once(placeholder, "listening");
  const { port } = placeholder.address() as AddressInfo;
  placeholder.close();
  await once(placeholder, "close");
  return port;
}

/**
 * Run the real broker against a fake Nous portal and a fake managed-tool
 * upstream, and return the response one proxied sandbox request receives.
 */
async function proxyThroughBroker(
  upstreamHandler: http.RequestListener,
  upstreamPaths: string[],
): Promise<Response> {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-broker-redirect-"));
  directories.push(stateDir);

  // The broker refreshes host-side OAuth before proxying. Returning the same
  // refresh token keeps the credential unrotated, so no OpenShell provider
  // update is attempted.
  const portal = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        access_token: "test-only-access-token",
        expires_in: 900,
        refresh_token: REFRESH_TOKEN,
      }),
    );
  });
  const portalPort = await listenOnLoopback(portal);

  const upstream = http.createServer((request, response) => {
    upstreamPaths.push(request.url ?? "");
    upstreamHandler(request, response);
  });
  const upstreamPort = await listenOnLoopback(upstream);

  fs.writeFileSync(
    path.join(stateDir, "probe.json"),
    JSON.stringify({
      sandbox: "probe",
      provider_name: "hermes-tool-gateway",
      refresh_token_sha256: createHash("sha256").update(REFRESH_TOKEN).digest("hex"),
      // Far-future expiry keeps the background agent-key mint off this path.
      inference_agent_key_expires_at: "2099-01-01T00:00:00.000Z",
    }),
  );
  const matrixPath = path.join(stateDir, "matrix.json");
  fs.writeFileSync(
    matrixPath,
    JSON.stringify({
      probe: { service: "probe", upstream: `http://127.0.0.1:${upstreamPort}` },
    }),
  );

  const brokerPort = await reserveLoopbackPort();
  const broker = spawn(process.execPath, ["--experimental-strip-types", BROKER_SCRIPT], {
    env: {
      ...process.env,
      NODE_OPTIONS: nodeOptionsWithoutSourceLoader(process.env.NODE_OPTIONS),
      HERMES_TOOL_GATEWAY_STATE_DIR: stateDir,
      HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
      HERMES_TOOL_GATEWAY_MATRIX_PATH: matrixPath,
      NOUS_PORTAL_BASE_URL: `http://127.0.0.1:${portalPort}`,
      NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.push(broker);

  await new Promise<void>((resolve, reject) => {
    broker.stderr?.setEncoding("utf8");
    broker.stderr?.on("data", (chunk: string) =>
      chunk.includes("gateway broker listening on") ? resolve() : undefined,
    );
    broker.once("exit", (code) => reject(new Error(`broker exited early with ${code}`)));
    setTimeout(() => reject(new Error("broker never reported a listening socket")), 10_000);
  });

  return await fetch(`http://127.0.0.1:${brokerPort}/probe/v1/models`, {
    headers: { authorization: `Bearer ${REFRESH_TOKEN}` },
    redirect: "manual",
  });
}

describe("Hermes tool-gateway broker redirect handling", () => {
  it("fails closed instead of relaying an upstream redirect to the sandbox", async () => {
    const upstreamPaths: string[] = [];
    const response = await proxyThroughBroker((_request, upstreamResponse) => {
      upstreamResponse.writeHead(302, {
        Location: REDIRECT_TARGET,
        "Content-Type": "text/plain",
      });
      upstreamResponse.end("moved");
    }, upstreamPaths);
    const body = await response.text();

    // The upstream really was reached and really did answer 3xx.
    expect(upstreamPaths).toEqual(["/v1/models"]);
    // The sandbox must never receive the redirect, nor the Location that would
    // send its credential-bearing client to another origin.
    expect(response.status).toBe(502);
    expect(response.headers.get("location")).toBeNull();
    expect(body).toContain("redirect");
    expect(body).not.toContain(REDIRECT_TARGET);
  });

  it("still relays a non-redirect upstream response unchanged", async () => {
    const upstreamPaths: string[] = [];
    const response = await proxyThroughBroker((_request, upstreamResponse) => {
      upstreamResponse.writeHead(200, { "Content-Type": "application/json" });
      upstreamResponse.end(JSON.stringify({ data: [] }));
    }, upstreamPaths);

    expect(upstreamPaths).toEqual(["/v1/models"]);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.text()).toBe('{"data":[]}');
  });
});
