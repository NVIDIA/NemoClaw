// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";

import {
  closeServer,
  listenServer as listenOnRandomPort,
  readRequestBody,
  writeJsonResponse,
} from "../fixtures/http-protocol.ts";
import type { StartedHttpServer } from "./mcp-bridge-servers.ts";

export interface RuntimeIdentityTokenRequest {
  readonly method: string;
  readonly path: string;
  readonly grantTypeOk: boolean;
  readonly clientIdOk: boolean;
  readonly refreshTokenOk: boolean;
  readonly clientSecretOk: boolean;
  readonly issuedVersion: number | null;
}

export interface RuntimeIdentityResourceRequest {
  readonly method: string;
  readonly path: string;
  readonly auth: "ok" | "missing" | "invalid";
  readonly accessTokenVersion: number | null;
}

export interface RuntimeIdentityOAuthServer extends StartedHttpServer {
  tokenRequests(): readonly RuntimeIdentityTokenRequest[];
  resourceRequests(): readonly RuntimeIdentityResourceRequest[];
  secretValues(): readonly string[];
}

function requireTcpPort(server: https.Server): number {
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("runtime identity OAuth fixture did not bind to a TCP port");
  }
  return address.port;
}

function generateEphemeralTlsMaterial(): {
  dir: string;
  cert: Buffer;
  key: Buffer;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-runtime-identity-tls-"));
  const keyPath = path.join(dir, "server.key");
  const certPath = path.join(dir, "server.crt");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=nemoclaw-runtime-identity-e2e",
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ],
    { killSignal: "SIGKILL", stdio: "ignore", timeout: 15_000 },
  );
  return {
    dir,
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

/**
 * Standards-shaped OAuth refresh issuer plus protected resource.
 *
 * The public side is supplied by the existing trycloudflare.com tunnel helper,
 * so OpenShell performs a real DNS lookup, validates a public TLS chain, sends
 * the refresh-token form, persists the rotated refresh token, and later
 * substitutes the minted bearer token into a sandbox request.
 */
export async function startRuntimeIdentityOAuthServer(options: {
  clientId: string;
  clientSecret: string;
  initialRefreshToken: string;
}): Promise<RuntimeIdentityOAuthServer> {
  const tls = generateEphemeralTlsMaterial();
  const tokenRequests: RuntimeIdentityTokenRequest[] = [];
  const resourceRequests: RuntimeIdentityResourceRequest[] = [];
  const accessTokens = [
    "e2e-runtime-identity-access-token-v1",
    "e2e-runtime-identity-access-token-v2",
  ];
  const refreshTokens = [
    options.initialRefreshToken,
    "e2e-runtime-identity-rotated-refresh-token-v2",
    "e2e-runtime-identity-rotated-refresh-token-v3",
  ];
  let currentRefreshToken = refreshTokens[0];
  let currentAccessToken: string | undefined;
  let issueCount = 0;

  const server = https.createServer({ cert: tls.cert, key: tls.key }, async (req, res) => {
    const requestPath = new URL(req.url ?? "/", "https://runtime-identity.local").pathname;

    // The public-tunnel readiness probe must not count as protected-resource
    // evidence and intentionally receives the same unauthenticated response a
    // real resource would return.
    if (req.method === "HEAD" && requestPath === "/resource") {
      writeJsonResponse(res, 401, { error: "missing bearer credential" });
      return;
    }

    if (req.method === "POST" && requestPath === "/oauth/token") {
      const body = new URLSearchParams(await readRequestBody(req));
      const grantTypeOk = body.get("grant_type") === "refresh_token";
      const clientIdOk = body.get("client_id") === options.clientId;
      const refreshTokenOk = body.get("refresh_token") === currentRefreshToken;
      const clientSecretOk = body.get("client_secret") === options.clientSecret;
      const accepted = grantTypeOk && clientIdOk && refreshTokenOk && clientSecretOk;
      const nextVersion = accepted && issueCount < accessTokens.length ? issueCount + 1 : null;
      tokenRequests.push({
        method: req.method,
        path: requestPath,
        grantTypeOk,
        clientIdOk,
        refreshTokenOk,
        clientSecretOk,
        issuedVersion: nextVersion,
      });
      if (nextVersion === null) {
        writeJsonResponse(res, 400, { error: "invalid_grant" });
        return;
      }

      currentAccessToken = accessTokens[issueCount];
      issueCount += 1;
      currentRefreshToken = refreshTokens[issueCount];
      writeJsonResponse(res, 200, {
        access_token: currentAccessToken,
        token_type: "Bearer",
        expires_in: 600,
        refresh_token: currentRefreshToken,
      });
      return;
    }

    if (req.method === "GET" && requestPath === "/resource") {
      const authorization = req.headers.authorization;
      const token =
        typeof authorization === "string" && authorization.startsWith("Bearer ")
          ? authorization.slice("Bearer ".length)
          : undefined;
      const accessTokenVersion = token
        ? accessTokens.findIndex((candidate) => candidate === token) + 1
        : null;
      const auth: RuntimeIdentityResourceRequest["auth"] =
        token === currentAccessToken ? "ok" : token ? "invalid" : "missing";
      resourceRequests.push({
        method: req.method,
        path: requestPath,
        auth,
        accessTokenVersion:
          accessTokenVersion && accessTokenVersion > 0 ? accessTokenVersion : null,
      });
      if (auth !== "ok") {
        writeJsonResponse(res, 401, { error: "invalid bearer credential" });
        return;
      }
      writeJsonResponse(res, 200, {
        authenticated: true,
        access_token_version: accessTokenVersion,
      });
      return;
    }

    writeJsonResponse(res, 404, { error: "not found" });
  });

  await listenOnRandomPort(server);
  return {
    port: requireTcpPort(server),
    tokenRequests: () => tokenRequests,
    resourceRequests: () => resourceRequests,
    secretValues: () => [options.clientId, options.clientSecret, ...accessTokens, ...refreshTokens],
    close: async () => {
      await closeServer(server);
      fs.rmSync(tls.dir, { recursive: true, force: true });
    },
  };
}
