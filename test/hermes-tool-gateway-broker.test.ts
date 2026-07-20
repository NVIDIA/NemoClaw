// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
/* global fetch */

import { type ChildProcess, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import net from "node:net";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, test as it } from "./helpers/owned-test-resources";
import { testTimeout } from "./helpers/timeouts";

const SCRIPT = path.join(
  import.meta.dirname,
  "..",
  "agents",
  "hermes",
  "host",
  "tool-gateway-broker.ts",
);
const require = createRequire(import.meta.url);
const BROKER_WRAPPER = path.join(
  import.meta.dirname,
  "..",
  "src",
  "lib",
  "hermes-tool-gateway-broker.ts",
);

const BROKER_READINESS_TIMEOUT_MS = 15_000;
const BROKER_TEST_TIMEOUT_MS = testTimeout(45_000);

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function jwtWithClaims(claims: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.sig`;
}

function invokeJwt(seconds = 3600): string {
  return jwtWithClaims({
    exp: Math.floor(Date.now() / 1000) + seconds,
    scope: "inference:invoke inference:mint_agent_key",
  });
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

function brokerDiagnostics(child: ChildProcess, output: () => string): string {
  const captured = output().trim() || "<no broker output>";
  return [
    `exit=${child.exitCode ?? "pending"}, signal=${child.signalCode ?? "none"}`,
    `captured output:\n${captured}`,
  ].join("; ");
}

async function waitForBrokerCondition(
  description: string,
  child: ChildProcess,
  output: () => string,
  predicate: () => boolean | Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + BROKER_READINESS_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${description}: broker exited early; ${brokerDiagnostics(child, output)}`);
    }
    try {
      if (await predicate()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const lastErrorDetail = lastError instanceof Error ? `; last error: ${lastError.message}` : "";
  throw new Error(
    `${description}: condition was not met within ${BROKER_READINESS_TIMEOUT_MS}ms; ` +
      `${brokerDiagnostics(child, output)}${lastErrorDetail}`,
  );
}

describe("Hermes managed-tool gateway broker", () => {
  it("only auto-recovers for Hermes sandboxes with selected managed tools", () => {
    delete require.cache[require.resolve(BROKER_WRAPPER)];
    const broker = require(BROKER_WRAPPER);

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

  it("refreshes via header, registers invoke JWTs, normalizes responses, and rotates OpenShell storage", {
    timeout: BROKER_TEST_TIMEOUT_MS,
  }, async ({ resources }) => {
    const tmp = resources.temporaryDirectory("nemoclaw-hermes-tool-broker-");
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

    const accessToken = invokeJwt();
    const tokenRequests: Array<{ body: string; refreshHeader?: string }> = [];
    const agentKeyRequests: Array<{ body: string; authorization?: string }> = [];
    const portal = resources.ownServer(
      http.createServer((req, res) => {
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
              access_token: accessToken,
              refresh_token: "refresh-2",
              expires_in: 900,
              token_type: "Bearer",
            }),
          );
        });
      }),
    );
    const portalPort = await listen(portal);

    const upstreamRequests: Array<{
      url?: string;
      authorization?: string;
      browserUseApiKey?: string;
      apiKey?: string;
      acceptEncoding?: string;
    }> = [];
    const upstream = resources.ownServer(
      http.createServer((req, res) => {
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
      }),
    );
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

    const child = resources.ownChild(
      spawn(process.execPath, ["--experimental-strip-types", SCRIPT], {
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
      }),
    );

    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });

    await waitForBrokerCondition(
      "broker health",
      child,
      () => output,
      async () => {
        const response = await fetch(`http://127.0.0.1:${brokerPort}/health`, {
          signal: AbortSignal.timeout(1_000),
        });
        return response.status === 200;
      },
    );
    await waitForBrokerCondition(
      "inference provider refresh",
      child,
      () => output,
      () => {
        try {
          return fs.readFileSync(openshellLog, "utf8").includes("provider update hermes-provider");
        } catch {
          return false;
        }
      },
    );

    const unknown = await fetch(`http://127.0.0.1:${brokerPort}/unknown`);
    expect(unknown.status).toBe(404);

    const denied = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape`, {
      headers: { Authorization: "Bearer wrong-broker-token" },
    });
    expect(denied.status).toBe(401);

    const firecrawl = await fetch(`http://127.0.0.1:${brokerPort}/firecrawl/v1/scrape?debug=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": "refresh-2",
      },
      body: JSON.stringify({ url: "https://example.com" }),
    });
    const firecrawlBody = await firecrawl.text();
    expect(firecrawl.status, `${firecrawlBody}\n${output}`).toBe(200);
    expect(firecrawl.headers.get("content-encoding")).toBeNull();
    expect(firecrawl.headers.get("content-length")).toBeNull();
    expect(firecrawl.headers.get("content-md5")).toBeNull();
    expect(firecrawl.headers.get("set-cookie")).toBeNull();
    expect(JSON.parse(firecrawlBody)).toEqual({ ok: true, path: "/v1/scrape?debug=1" });
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.refreshHeader).toBe("refresh-1");
    expect(new URLSearchParams(tokenRequests[0]?.body).get("refresh_token")).toBeNull();
    expect(new URLSearchParams(tokenRequests[0]?.body).get("grant_type")).toBe("refresh_token");
    expect(agentKeyRequests).toHaveLength(0);
    expect(upstreamRequests[0]).toMatchObject({
      url: "/v1/scrape?debug=1",
      authorization: `Bearer ${accessToken}`,
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
    expect(openshellOutput).toContain(`openai=${accessToken}`);
    expect(rotatedState.inference_provider_name).toBe("hermes-provider");
    expect(rotatedState.inference_credential_env).toBe("OPENAI_API_KEY");
    expect(rotatedState.inference_auth_path).toBe("invoke_jwt");
    expect(rotatedState.inference_credential_expires_at).toBeTruthy();
    expect(rotatedState.inference_agent_key_expires_at).toBeNull();

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
      browserUseApiKey: accessToken,
    });
    expect(upstreamRequests[1]?.authorization).toBeUndefined();
    expect(upstreamRequests[2]).toMatchObject({
      url: "/fal-ai/test",
      authorization: `Key ${accessToken}`,
    });
    expect(upstreamRequests[3]).toMatchObject({
      url: "/v1/audio/speech",
      authorization: `Bearer ${accessToken}`,
    });
    expect(upstreamRequests[4]).toMatchObject({
      url: "/sandboxes",
      authorization: `Bearer ${accessToken}`,
    });
    expect(tokenRequests).toHaveLength(1);
    expect(agentKeyRequests).toHaveLength(0);
    expect(output).not.toContain("refresh-1");
    expect(output).not.toContain("refresh-2");
    expect(output).not.toContain(accessToken);
    expect(output).not.toContain("sandbox-secret");
    expect(output).not.toContain("agent-key-2");
  });

  it("falls back to one legacy agent key when refresh returns an unusable invoke token", {
    timeout: BROKER_TEST_TIMEOUT_MS,
  }, async ({ resources }) => {
    const tmp = resources.temporaryDirectory("nemoclaw-hermes-tool-broker-fallback-");
    const stateDir = path.join(tmp, "state");
    const binDir = path.join(tmp, "bin");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(binDir, { recursive: true });

    const oldRefreshToken = "old-refresh-secret";
    const newRefreshToken = "new-refresh-secret";
    const rejectedAccessToken = jwtWithClaims({
      exp: Number.MAX_SAFE_INTEGER,
      scope: "inference:invoke inference:mint_agent_key",
    });
    const brokerToken = "broker-secret";
    const agentKey = "agent-key-secret";
    const trustedInferenceBaseUrl = "https://inference-api.nousresearch.com/v1";

    const openshellLog = path.join(tmp, "openshell.log");
    const openshellBin = path.join(binDir, "openshell");
    fs.writeFileSync(
      openshellBin,
      [
        "#!/bin/sh",
        `printf '%s\\n' "$*" >> "${openshellLog}"`,
        `printf 'refresh=%s\\n' "$NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN" >> "${openshellLog}"`,
        `printf 'openai=%s\\n' "$OPENAI_API_KEY" >> "${openshellLog}"`,
        'printf \'fixture stdout: %s %s %s %s %s\\n\' "$TEST_OLD_REFRESH_TOKEN" "$TEST_NEW_REFRESH_TOKEN" "$TEST_REJECTED_ACCESS_TOKEN" "$TEST_BROKER_TOKEN" "$TEST_AGENT_KEY"',
        'printf \'fixture stderr: %s %s %s %s %s\\n\' "$TEST_OLD_REFRESH_TOKEN" "$TEST_NEW_REFRESH_TOKEN" "$TEST_REJECTED_ACCESS_TOKEN" "$TEST_BROKER_TOKEN" "$TEST_AGENT_KEY" >&2',
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
          broker_token: brokerToken,
          broker_token_sha256: sha256(brokerToken),
          refresh_token_sha256: sha256(oldRefreshToken),
          client_id: "hermes-cli",
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const tokenRequests: Array<{ body: string; refreshHeader?: string }> = [];
    const agentKeyRequests: Array<{ body: string; authorization?: string }> = [];
    const portalResponses: Record<
      string,
      (body: string, req: http.IncomingMessage) => Record<string, unknown>
    > = {
      "/api/oauth/token": (body, req) => {
        tokenRequests.push({
          body,
          refreshHeader: req.headers["x-nous-refresh-token"] as string | undefined,
        });
        return {
          access_token: rejectedAccessToken,
          refresh_token: newRefreshToken,
          expires_in: 900,
          token_type: "Bearer",
        };
      },
      "/api/oauth/agent-key": (body, req) => {
        agentKeyRequests.push({ body, authorization: req.headers.authorization });
        return {
          api_key: agentKey,
          expires_in: 1800,
          inference_base_url: "https://untrusted.example/v1",
        };
      },
    };
    const portal = resources.ownServer(
      http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(portalResponses[req.url || ""]?.(body, req) ?? {}));
        });
      }),
    );
    const portalPort = await listen(portal);

    const matrixPath = path.join(tmp, "matrix.json");
    fs.writeFileSync(matrixPath, "{}");
    const brokerPort = await freePort();
    const child = resources.ownChild(
      spawn(process.execPath, ["--experimental-strip-types", SCRIPT], {
        env: {
          ...process.env,
          HERMES_TOOL_GATEWAY_PORT: String(brokerPort),
          HERMES_TOOL_GATEWAY_STATE_DIR: stateDir,
          HERMES_TOOL_GATEWAY_MATRIX_PATH: matrixPath,
          NOUS_PORTAL_BASE_URL: `http://127.0.0.1:${portalPort}`,
          NEMOCLAW_OPENSHELL_BIN: openshellBin,
          NEMOCLAW_HERMES_TOOL_GATEWAY_REFRESH_TOKEN: oldRefreshToken,
          TEST_OLD_REFRESH_TOKEN: oldRefreshToken,
          TEST_NEW_REFRESH_TOKEN: newRefreshToken,
          TEST_REJECTED_ACCESS_TOKEN: rejectedAccessToken,
          TEST_BROKER_TOKEN: brokerToken,
          TEST_AGENT_KEY: agentKey,
        },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    const output = () => `${stdout}\n${stderr}`;

    await waitForBrokerCondition("legacy inference provider fallback", child, output, () => {
      try {
        const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
        return state.inference_auth_path === "legacy_agent_key";
      } catch {
        return false;
      }
    });

    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]?.refreshHeader).toBe(oldRefreshToken);
    expect(new URLSearchParams(tokenRequests[0]?.body).get("refresh_token")).toBeNull();
    expect(agentKeyRequests).toHaveLength(1);
    expect(agentKeyRequests[0]?.authorization).toBe(`Bearer ${rejectedAccessToken}`);
    expect(JSON.parse(agentKeyRequests[0]?.body || "{}")).toEqual({
      min_ttl_seconds: 1800,
    });

    const rotatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    expect(rotatedState).toMatchObject({
      refresh_token_sha256: sha256(newRefreshToken),
      inference_provider_name: "hermes-provider",
      inference_credential_env: "OPENAI_API_KEY",
      inference_base_url: trustedInferenceBaseUrl,
      inference_auth_path: "legacy_agent_key",
    });
    expect(rotatedState.inference_credential_expires_at).toBeTruthy();
    expect(rotatedState.inference_agent_key_expires_at).toBe(
      rotatedState.inference_credential_expires_at,
    );

    const openshellOutput = fs.readFileSync(openshellLog, "utf8");
    expect(openshellOutput).toContain(
      `provider update hermes-provider --credential OPENAI_API_KEY --config OPENAI_BASE_URL=${trustedInferenceBaseUrl}`,
    );
    expect(openshellOutput).toContain(`openai=${agentKey}`);

    for (const stream of [stdout, stderr]) {
      expect(stream).not.toContain(oldRefreshToken);
      expect(stream).not.toContain(newRefreshToken);
      expect(stream).not.toContain(rejectedAccessToken);
      expect(stream).not.toContain(brokerToken);
      expect(stream).not.toContain(agentKey);
    }
  });
});
