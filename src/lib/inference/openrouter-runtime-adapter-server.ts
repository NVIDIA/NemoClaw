// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import crypto from "node:crypto";
import http from "node:http";

import { OPENROUTER_RUNTIME_ADAPTER_PORT } from "../core/ports";
import { compactText } from "../core/url-utils";
import {
  OPENROUTER_DEFAULT_HEADERS,
  OPENROUTER_ENDPOINT_URL,
  OPENROUTER_RUNTIME_ADAPTER_BIND_HOST,
  OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
} from "./openrouter";
import {
  ADAPTER_NAME,
  LOG_PATH,
  OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH_ENV,
  adapterAuthorizationHash,
  adapterConfigHash,
  defaultAdapterLogger,
  logAdapterEvent,
  normalizeAuthorizationHash,
  sendJson,
  type AdapterLogger,
} from "./openrouter-runtime-adapter-common";
import {
  forwardOpenRouterRequest,
  getBearerAuthorizationToken,
} from "./openrouter-runtime-adapter-forward";

const ALLOWED_POST_PATHS = new Set(["/v1/chat/completions"]);

function isAllowedRequest(method: string | undefined, pathname: string): boolean {
  return method === "POST" && ALLOWED_POST_PATHS.has(pathname);
}

function timingSafeHashEqual(actualHash: string, expectedHash: string): boolean {
  const actual = Buffer.from(actualHash, "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return crypto.timingSafeEqual(actual, expected);
}

function requireAuthorizationHash(value: unknown): string {
  const normalized = normalizeAuthorizationHash(value);
  if (!normalized) {
    throw new Error("OpenRouter Runtime adapter authorization hash is required");
  }
  return normalized;
}

function isExpectedBearerAuthorization(
  actual: string | string[] | undefined,
  expectedAuthorizationHash: string,
): boolean {
  const token = getBearerAuthorizationToken(actual) ?? "";
  return timingSafeHashEqual(adapterAuthorizationHash(token), expectedAuthorizationHash);
}

export function createOpenRouterRuntimeAdapterServer(
  options: {
    upstreamBaseUrl?: string;
    logger?: AdapterLogger;
    upstreamTimeoutMs?: number;
    authorizationHash?: string | null;
  } = {},
): http.Server {
  const upstreamBaseUrl = options.upstreamBaseUrl || OPENROUTER_ENDPOINT_URL;
  const configHash = adapterConfigHash(upstreamBaseUrl);
  const logger = options.logger || defaultAdapterLogger;
  const authorizationHash = requireAuthorizationHash(options.authorizationHash);
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          adapter: ADAPTER_NAME,
          configHash,
          authorizationHash,
          headerNames: OPENROUTER_DEFAULT_HEADERS.map(([name]) => name),
        });
        return;
      }
      if (!isExpectedBearerAuthorization(req.headers.authorization, authorizationHash)) {
        sendJson(res, 401, {
          error: { message: "Unauthorized", type: "unauthorized", code: "unauthorized" },
        });
        logAdapterEvent(logger, "request_rejected", {
          method: req.method || "unknown",
          path: url.pathname,
          status: 401,
          reason: "unauthorized",
          durationMs: Date.now() - started,
        });
        return;
      }
      if (!isAllowedRequest(req.method, url.pathname)) {
        sendJson(res, 404, {
          error: { message: "Not found", type: "not_found", code: "not_found" },
        });
        logAdapterEvent(logger, "request_rejected", {
          method: req.method || "unknown",
          path: url.pathname,
          status: 404,
          reason: "not_found",
          durationMs: Date.now() - started,
        });
        return;
      }

      const status = await forwardOpenRouterRequest({
        req,
        res,
        upstreamBaseUrl,
        upstreamTimeoutMs: options.upstreamTimeoutMs,
      });
      logAdapterEvent(logger, "request_completed", {
        method: req.method || "unknown",
        path: url.pathname,
        status,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      logAdapterEvent(logger, "request_failed", {
        method: req.method || "unknown",
        path: url.pathname,
        status: 502,
        durationMs: Date.now() - started,
      });
      if (!res.headersSent) {
        sendJson(res, 502, {
          error: {
            message: compactText("OpenRouter request failed."),
            type: "openrouter_runtime_error",
            code: "openrouter_runtime_error",
          },
        });
      } else {
        res.end();
      }
    }
  });
}

export function startOpenRouterRuntimeAdapterFromEnv(): http.Server {
  const port = Number(
    process.env.NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT || OPENROUTER_RUNTIME_ADAPTER_PORT,
  );
  const authorizationHash = normalizeAuthorizationHash(
    process.env[OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH_ENV],
  );
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT must be a valid port");
  }
  if (!authorizationHash) {
    throw new Error(`${OPENROUTER_RUNTIME_ADAPTER_AUTHORIZATION_HASH_ENV} is required`);
  }

  const server = createOpenRouterRuntimeAdapterServer({ authorizationHash });
  server.listen(port, OPENROUTER_RUNTIME_ADAPTER_BIND_HOST, () => {
    defaultAdapterLogger("adapter_ready", {
      bindHost: OPENROUTER_RUNTIME_ADAPTER_BIND_HOST,
      port,
      sandboxRoute: OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL,
      logPath: LOG_PATH,
    });
    console.log(
      `OpenRouter Runtime adapter listening on ${OPENROUTER_RUNTIME_ADAPTER_BIND_HOST}:${port}; sandbox route ${OPENROUTER_RUNTIME_ADAPTER_OPENAI_BASE_URL}; log ${LOG_PATH}`,
    );
  });
  return server;
}
