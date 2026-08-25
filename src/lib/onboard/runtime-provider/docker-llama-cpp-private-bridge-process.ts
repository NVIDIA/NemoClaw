// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";

const SHA256 = /^[a-f0-9]{64}$/u;
const API_KEY_FILE_DESCRIPTOR = 3;
const AUTH_MODE = "api-key-fd3";
const UPSTREAM_CONTINUE_TIMEOUT_MS = 30_000;
const UNAUTHORIZED_BODY = `${JSON.stringify({
  error: {
    code: "unauthorized",
    message: "Authentication is required.",
    type: "authentication_error",
  },
})}\n`;

export interface LlamaCppPrivateBridgeArguments {
  readonly transactionId: string;
  readonly targetHost: string;
  readonly targetPort: number;
  readonly listenPort: number;
  readonly bindAddresses: readonly ["127.0.0.1", string];
}

function exactPort(value: string, label: string): number {
  const port = /^[0-9]{1,5}$/u.test(value) ? Number(value) : -1;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} is invalid`);
  }
  return port;
}

function isPrivateIpv4(value: string): boolean {
  if (!net.isIPv4(value)) return false;
  const [first, second] = value.split(".").map(Number);
  return (
    first === 10 ||
    (first === 172 && second! >= 16 && second! <= 31) ||
    (first === 192 && second === 168)
  );
}

export function parseLlamaCppPrivateBridgeArguments(
  argv: readonly string[],
): LlamaCppPrivateBridgeArguments {
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error("private bridge arguments must be exact key/value pairs");
    }
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const one = (key: string): string => {
    const candidates = values.get(key);
    if (!candidates || candidates.length !== 1) throw new Error(`${key} must be provided once`);
    return candidates[0]!;
  };
  const transactionId = one("--transaction");
  const targetHost = one("--target-host");
  const bindAddresses = values.get("--bind-address") ?? [];
  const supported = new Set([
    "--transaction",
    "--auth-mode",
    "--target-host",
    "--target-port",
    "--listen-port",
    "--bind-address",
  ]);
  if ([...values.keys()].some((key) => !supported.has(key))) {
    throw new Error("private bridge received an unsupported argument");
  }
  if (
    !SHA256.test(transactionId) ||
    one("--auth-mode") !== AUTH_MODE ||
    !isPrivateIpv4(targetHost) ||
    bindAddresses.length !== 2 ||
    bindAddresses[0] !== "127.0.0.1" ||
    !isPrivateIpv4(bindAddresses[1]!) ||
    bindAddresses[1] === targetHost
  ) {
    throw new Error("private bridge authority is invalid");
  }
  return Object.freeze({
    transactionId,
    targetHost,
    targetPort: exactPort(one("--target-port"), "target port"),
    listenPort: exactPort(one("--listen-port"), "listen port"),
    bindAddresses: Object.freeze(["127.0.0.1", bindAddresses[1]!]) as readonly [
      "127.0.0.1",
      string,
    ],
  });
}

function readPrivateBridgeApiKey(): string {
  let value: string;
  try {
    value = fs.readFileSync(API_KEY_FILE_DESCRIPTOR, "utf8").trim();
  } catch {
    throw new Error("private bridge credential is unavailable");
  } finally {
    try {
      fs.closeSync(API_KEY_FILE_DESCRIPTOR);
    } catch {
      // The inherited descriptor can already be closed after a failed read.
    }
  }
  if (!SHA256.test(value)) {
    throw new Error("private bridge credential is invalid");
  }
  return value;
}

function authorizationValues(request: http.IncomingMessage): readonly string[] {
  const values: string[] = [];
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]?.toLowerCase() === "authorization") {
      values.push(request.rawHeaders[index + 1] ?? "");
    }
  }
  return values;
}

function hasValidBearerCredential(request: http.IncomingMessage, apiKey: string): boolean {
  const values = authorizationValues(request);
  if (values.length !== 1) return false;
  const value = values[0]!;
  if (value.length !== 7 + apiKey.length || value.slice(0, 7).toLowerCase() !== "bearer ") {
    return false;
  }
  const supplied = Buffer.from(value.slice(7), "utf8");
  const expected = Buffer.from(apiKey, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function isUnauthenticatedHealthProbe(request: http.IncomingMessage): boolean {
  return request.method === "GET" && request.url === "/health";
}

function writeUnauthorized(response: http.ServerResponse): void {
  response.writeHead(401, {
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(UNAUTHORIZED_BODY),
    "Content-Type": "application/json",
    "WWW-Authenticate": "Bearer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(UNAUTHORIZED_BODY);
}

function writeUpstreamUnavailable(
  response: http.ServerResponse,
  options: { closeConnection?: boolean } = {},
): void {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.destroy();
    return;
  }
  const body = `${JSON.stringify({
    error: {
      code: "upstream_unavailable",
      message: "The managed inference server is unavailable.",
      type: "server_error",
    },
  })}\n`;
  response.writeHead(502, {
    "Cache-Control": "no-store",
    ...(options.closeConnection ? { Connection: "close" } : {}),
    "Content-Length": Buffer.byteLength(body),
    "Content-Type": "application/json",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function createLlamaCppPrivateBridgeRequestHandler(
  authority: Pick<LlamaCppPrivateBridgeArguments, "targetHost" | "targetPort">,
  apiKey: string,
): http.RequestListener {
  if (
    !SHA256.test(apiKey) ||
    (!isPrivateIpv4(authority.targetHost) && authority.targetHost !== "127.0.0.1")
  ) {
    throw new Error("private bridge HTTP authority is invalid");
  }
  const targetPort = exactPort(String(authority.targetPort), "target port");
  const canonicalAuthorization = `Bearer ${apiKey}`;

  return (request, response) => {
    const healthProbe = isUnauthenticatedHealthProbe(request);
    if (!healthProbe && !hasValidBearerCredential(request, apiKey)) {
      request.resume();
      writeUnauthorized(response);
      return;
    }

    const headers: http.OutgoingHttpHeaders = { ...request.headers };
    headers.host = `${authority.targetHost}:${String(targetPort)}`;
    if (!healthProbe) headers.authorization = canonicalAuthorization;
    delete headers.forwarded;
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-host"];
    delete headers["x-forwarded-proto"];

    const expectsContinue = request.headers.expect?.toLowerCase() === "100-continue";
    let upstreamResponded = false;
    let forwardingRequestBody = false;
    let continueTimer: ReturnType<typeof setTimeout> | undefined;
    const clearContinueTimer = () => {
      if (continueTimer === undefined) return;
      clearTimeout(continueTimer);
      continueTimer = undefined;
    };
    const upstream = http.request(
      {
        headers,
        host: authority.targetHost,
        method: request.method,
        path: request.url,
        port: targetPort,
      },
      (upstreamResponse) => {
        clearContinueTimer();
        upstreamResponded = true;
        request.unpipe(upstream);
        request.resume();
        response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
        upstreamResponse.once("error", () => response.destroy());
        upstreamResponse.pipe(response);
        upstreamResponse.once("end", () => {
          if (!upstream.writableEnded) upstream.destroy();
        });
      },
    );
    const forwardRequestBody = () => {
      if (forwardingRequestBody || upstreamResponded) return;
      forwardingRequestBody = true;
      request.pipe(upstream);
    };
    upstream.once("continue", () => {
      clearContinueTimer();
      if (!response.destroyed && !response.writableEnded) response.writeContinue();
      forwardRequestBody();
    });
    upstream.once("error", () => {
      clearContinueTimer();
      if (!upstreamResponded) writeUpstreamUnavailable(response);
    });
    request.once("close", () => {
      if (!request.complete && !upstreamResponded) {
        clearContinueTimer();
        upstream.destroy();
      }
    });
    request.once("error", () => {
      if (!upstreamResponded) {
        clearContinueTimer();
        upstream.destroy();
      }
    });
    response.once("close", () => {
      if (!response.writableEnded) {
        clearContinueTimer();
        upstream.destroy();
      }
    });
    if (expectsContinue) {
      continueTimer = setTimeout(() => {
        continueTimer = undefined;
        request.unpipe(upstream);
        request.pause();
        upstream.destroy();
        response.once("finish", () => request.destroy());
        writeUpstreamUnavailable(response, { closeConnection: true });
      }, UPSTREAM_CONTINUE_TIMEOUT_MS);
      continueTimer.unref();
      upstream.flushHeaders();
    } else {
      forwardRequestBody();
    }
  };
}

export function createLlamaCppPrivateBridgeServer(
  authority: Pick<LlamaCppPrivateBridgeArguments, "targetHost" | "targetPort">,
  apiKey: string,
): http.Server {
  const handler = createLlamaCppPrivateBridgeRequestHandler(authority, apiKey);
  const server = http.createServer();
  server.on("checkContinue", handler);
  server.on("request", handler);
  return server;
}

export async function runLlamaCppPrivateBridge(
  authority: LlamaCppPrivateBridgeArguments,
  apiKey: string,
): Promise<void> {
  const servers = authority.bindAddresses.map(() =>
    createLlamaCppPrivateBridgeServer(authority, apiKey),
  );

  const close = () => {
    for (const server of servers) {
      server.close();
      server.closeAllConnections();
    }
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);

  await Promise.all(
    servers.map(
      (server, index) =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(
            { host: authority.bindAddresses[index]!, port: authority.listenPort, exclusive: true },
            () => resolve(),
          );
        }),
    ),
  );
  await new Promise<void>((_resolve, reject) => {
    for (const server of servers) server.once("error", reject);
  });
}

if (require.main === module) {
  Promise.resolve()
    .then(() =>
      runLlamaCppPrivateBridge(
        parseLlamaCppPrivateBridgeArguments(process.argv.slice(2)),
        readPrivateBridgeApiKey(),
      ),
    )
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
