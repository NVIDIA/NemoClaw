// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

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
  adapterConfigHash,
  defaultAdapterLogger,
  logAdapterEvent,
  sendJson,
  type AdapterLogger,
} from "./openrouter-runtime-adapter-common";
import {
  forwardOpenRouterRequest,
  hasBearerAuthorization,
} from "./openrouter-runtime-adapter-forward";

const ALLOWED_POST_PATHS = new Set(["/v1/chat/completions"]);

function isAllowedRequest(method: string | undefined, pathname: string): boolean {
  return method === "POST" && ALLOWED_POST_PATHS.has(pathname);
}

export function createOpenRouterRuntimeAdapterServer(
  options: { upstreamBaseUrl?: string; logger?: AdapterLogger; upstreamTimeoutMs?: number } = {},
): http.Server {
  const upstreamBaseUrl = options.upstreamBaseUrl || OPENROUTER_ENDPOINT_URL;
  const configHash = adapterConfigHash(upstreamBaseUrl);
  const logger = options.logger || defaultAdapterLogger;
  return http.createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url || "/", "http://127.0.0.1");
    try {
      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          adapter: ADAPTER_NAME,
          configHash,
          headerNames: OPENROUTER_DEFAULT_HEADERS.map(([name]) => name),
        });
        return;
      }
      if (!hasBearerAuthorization(req.headers.authorization)) {
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
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("NEMOCLAW_OPENROUTER_RUNTIME_ADAPTER_PORT must be a valid port");
  }

  const server = createOpenRouterRuntimeAdapterServer();
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
