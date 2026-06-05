// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global fetch */

import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

const SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "host",
  "tool-gateway-broker.ts",
);
const require = createRequire(import.meta.url);
const DIST_WRAPPER = path.join(
  import.meta.dirname,
  "..",
  "dist",
  "lib",
  "hermes-tool-gateway-broker.js",
);

let children: ChildProcess[] = [];

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("no port")));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

async function waitForHealth(port: number): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/health`);
      if (resp.status === 200) return;
    } catch {
      // keep polling
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("broker did not become healthy");
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("condition was not met");
}

afterEach(() => {
  for (const child of children) child.kill("SIGTERM");
  children = [];
});

describe("Hermes managed-tool gateway broker", () => {
  it("only auto-recovers for Hermes sandboxes with selected managed tools", () => {
    delete require.cache[require.resolve(DIST_WRAPPER)];
    const broker = require(DIST_WRAPPER);

    expect(
      broker.isHermesManagedToolGatewayEntry({
        agent: "openclaw",
        hermesToolGateways: ["nous-web"],
      }),
    ).toBe(false);
    expect(
      broker.ensureHermesToolGatewayBrokerForSandboxEntry({
        agent: "openclaw",
        hermesToolGateways: ["nous-web"],
      }),
    ).toBe(false);
    expect(
      broker.isHermesManagedToolGatewayEntry({
        agent: "hermes",
        hermesToolGateways: [],
      }),
    ).toBe(false);
    expect(
      broker.isHermesManagedToolGatewayEntry({
        agent: "hermes",
        hermesToolGateways: ["nous-web"],
      }),
    ).toBe(true);
  });

  it("refreshes via header, replaces upstream auth, normalizes responses, and rotates OpenShell storage", async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-hermes-tool-broker-"));
    const stateDir = path.join(tmp, "state");
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir, { recursive: true });
    const openshellLog = path.join(tmp, "openshell.log");
    const openshellBin = path.join(binDir, "openshell");
    fs.writeFileSync(
      openshellBin,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${openshellLog}"`,
        `printf 'refresh=%s\\n' "$NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN" >> "${openshellLog}"`,
        `printf 'openai=%s\\n' "$OPENAI_API_KEY" >> "${openshellLog}"`,
        "exit 0",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    const statePath = path.join(stateDir, "sandbox.json");
    fs.writeFileSync(
      statePath,
      JSON.stringify(
        {
          version: 1,
          sandbox: "sandbox",
          provider_name: "sandbox-hermes-tool-gateway",
          credential_env: "NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
          broker_token: "broker-1",
          broker_token_sha256: sha256("broker-1"),
          refresh_token_sha256: sha256("refresh-1"),
          client_id: "hermes-cli",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const tokenRequests: Array<{ body: string; refreshHeader?: string }> = [];
    const agentKeyRequests: Array<{ body: string; authorization?: string }> = [];
    const portal = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "Content-Type": "application/json" });
        if (req.url === "/api/oauth/agent-key") {
          agentKeyRequests.push({
            body,
            authorization: req.headers.authorization,
          });
          res.end(
            JSON.stringify({
              api_key: "agent-key-2",
              expires_in: 1800,
              inference_base_url: "https://inference-api.nousresearch.com/v1",
            }),
          );
          return;
        }
        tokenRequests.push({
          body,
          refreshHeader: req.headers["x-nous-refresh-token"] as string | undefined,
        });
        res.end(
          JSON.stringify({
            access_token: "access-2",
            refresh_token: "refresh-2",
            expires_in: 900,
            token_type: "Bearer",
          }),
        );
      });
    });
    const portalPort = await listen(portal);

    const upstreamRequests: Array<{
      url?: string;
      authorization?: string;
      browserUseApiKey?: string;
      apiKey?: string;
      acceptEncoding?: string;
    }> = [];
    const upstream = http.createServer((req, res) => {
      upstreamRequests.push({
        url: req.url,
        authorization: req.headers.authorization,
        browserUseApiKey: req.headers["x-browser-use-api-key"] as string | undefined,
        apiKey: req.headers["x-api-key"] as string | undefined,
        acceptEncoding: req.headers["accept-encoding"] as string | undefined,
      });
      const body = zlib.gzipSync(JSON.stringify({ ok: true, path: req.url }));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Encoding": "gzip",
        "Content-Length": String(body.length),
        "Content-MD5": "not-a-real-digest",
        "Set-Cookie": "fixture_session=1; HttpOnly; Secure; SameSite=Strict",
      });
      res.end(body);
    });
    const upstreamPort = await listen(upstream);
    const matrixPath = path.join(tmp, "matrix.json");
    const upstreamBase = `http://127.0.0.1:${upstreamPort}`;
    fs.writeFileSync(
      matrixPath,
      JSON.stringify({
        "nous-web": { service: "firecrawl", upstream: upstreamBase },
        "nous-image": { service: "fal-queue", upstream: upstreamBase },
        "nous-audio": { service: "openai-audio", upstream: upstreamBase },
        "nous-browser": { service: "browser-use", upstream: upstreamBase },
        "nous-code": { service: "modal", upstream: upstreamBase },
      }),
    );
    const brokerPort = await freePort();

    const child = spawn(process.execPath, ["--experimental-strip-types", SCRIPT], {
      env: {
        ...process.env,
        HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
        HERMES_TOOL_GATEWAY_STATE_DIR: stateDir,
        HERMES_TOOL_GATEWAY_MATRIX_PATH: matrixPath,
        NOUS_PORTAL_BASE_URL: `http://127.0.0.1:${portalPort}`,
        NEMOCLAW_OPENSHELL_BIN: openshellBin,
        NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: "refresh-1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    try {
      await waitForHealth(brokerPort);
      await waitUntil(() => {
        try {
          return fs.readFileSync(openshellLog, "utf8").includes("provider update hermes-provider");
        } catch {
          return false;
        }
      });

      const unknown = await fetch(`http://127.0.0.1:${brokerPort}/unknown`);
      expect(unknown.status).toBe(404);

      const denied = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape`, {
        headers: { Authorization: "Bearer wrong-broker-token" },
      });
      expect(denied.status).toBe(401);

      const firecrawl = await fetch(
        `http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape?debug=1`,
        {
          method: "POST",
          headers: {
            Authorization: "Bearer broker-1",
            "Content-Type": "application/json",
            "x-api-key": "sandbox-secret",
          },
          body: JSON.stringify({ url: "https://example.com" }),
        },
      );
      expect(firecrawl.status).toBe(200);
      expect(firecrawl.headers.get("content-encoding")).toBeNull();
      expect(firecrawl.headers.get("content-length")).toBeNull();
      expect(firecrawl.headers.get("content-md5")).toBeNull();
      expect(firecrawl.headers.get("set-cookie")).toBeNull();
      expect(await firecrawl.json()).toEqual({ ok: true, path: "/v1/scrape?debug=1" });
      expect(tokenRequests).toHaveLength(1);
      expect(tokenRequests[0]?.refreshHeader).toBe("refresh-1");
      expect(new URLSearchParams(tokenRequests[0]?.body).get("refresh_token")).toBeNull();
      expect(new URLSearchParams(tokenRequests[0]?.body).get("grant_type")).toBe("refresh_token");
      expect(agentKeyRequests).toHaveLength(1);
      expect(agentKeyRequests[0]?.authorization).toBe("Bearer access-2");
      expect(JSON.parse(agentKeyRequests[0]?.body || "{}")).toEqual({
        min_ttl_seconds: 1800,
      });
      expect(upstreamRequests[0]).toMatchObject({
        url: "/v1/scrape?debug=1",
        authorization: "Bearer access-2",
        acceptEncoding: "identity",
      });
      expect(upstreamRequests[0]?.apiKey).toBeUndefined();

      const rotatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      expect(rotatedState.refresh_token_sha256).toBe(sha256("refresh-2"));
      const openshellOutput = fs.readFileSync(openshellLog, "utf8");
      expect(openshellOutput).toContain(
        "provider update sandbox-hermes-tool-gateway --credential NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN",
      );
      expect(openshellOutput).toContain("refresh=refresh-2");
      expect(openshellOutput).toContain(
        "provider update hermes-provider --credential OPENAI_API_KEY --config OPENAI_BASE_URL=https://inference-api.nousresearch.com/v1",
      );
      expect(openshellOutput).toContain("openai=agent-key-2");
      expect(rotatedState.inference_provider_name).toBe("hermes-provider");
      expect(rotatedState.inference_credential_env).toBe("OPENAI_API_KEY");
      expect(rotatedState.inference_agent_key_expires_at).toBeTruthy();

      const checks = [
        ["/browser-use/browsers", { "X-Browser-Use-API-Key": "broker-1" }, "browser"],
        ["/fal-queue/fal-ai/test", { Authorization: "Key broker-1" }, "fal"],
        ["/openai-audio/v1/audio/speech", { "openai-api-key": "broker-1" }, "audio"],
        ["/modal/sandboxes", { Authorization: "Bearer broker-1" }, "modal"],
      ] as const;
      for (const [route, headers] of checks) {
        const resp = await fetch(`http://127.0.0.1:${brokerPort}${route}`, {
          method: "POST",
          headers,
          body: "{}",
        });
        expect(resp.status).toBe(200);
      }
      expect(upstreamRequests[1]).toMatchObject({
        url: "/browsers",
        browserUseApiKey: "access-2",
      });
      expect(upstreamRequests[1]?.authorization).toBeUndefined();
      expect(upstreamRequests[2]).toMatchObject({
        url: "/fal-ai/test",
        authorization: "Key access-2",
      });
      expect(upstreamRequests[3]).toMatchObject({
        url: "/v1/audio/speech",
        authorization: "Bearer access-2",
      });
      expect(upstreamRequests[4]).toMatchObject({
        url: "/sandboxes",
        authorization: "Bearer access-2",
      });
      expect(tokenRequests).toHaveLength(1);
      expect(agentKeyRequests).toHaveLength(1);
      expect(output).not.toContain("refresh-1");
      expect(output).not.toContain("refresh-2");
      expect(output).not.toContain("access-2");
      expect(output).not.toContain("sandbox-secret");
      expect(output).not.toContain("agent-key-2");
    } finally {
      await close(portal);
      await close(upstream);
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
