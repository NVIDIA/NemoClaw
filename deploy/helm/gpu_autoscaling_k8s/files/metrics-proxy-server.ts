#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// GPU metrics-proxy pod: health + Prometheus metrics + OpenAI-compatible proxy to a local
// GPU inference runtime (Ollama, vLLM, or NVIDIA NIM — selected by INFERENCE_RUNTIME).

import { timingSafeEqual } from "node:crypto";
import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { llmMetricsLines, recordLlmLatency } from "./metrics-proxy-metrics.ts";

const PORT = Number(process.env.PORT || 8081);
const BASE_URL = (process.env.INFERENCE_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
// Root of the runtime's own API (no /v1) — used only for the readiness check below. Ollama's
// native API lives here (/api/tags); vLLM/NIM expose their OpenAI-compatible list under
// <root>/v1/models, so RUNTIME_ROOT doubles as the prefix for that call too.
const RUNTIME = process.env.INFERENCE_RUNTIME || "ollama";
const RUNTIME_ROOT = (process.env.INFERENCE_RUNTIME_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.INFERENCE_MODEL || "";
const AUTH_REQUIRED = process.env.INFERENCE_AUTH_REQUIRED !== "false";
const API_KEY = process.env.INFERENCE_API_KEY || "";
if (AUTH_REQUIRED && !API_KEY) {
  throw new Error("INFERENCE_API_KEY is required when inference authentication is enabled");
}
// Bound the authenticated proxy request path: cap buffered body size and time-to-complete
// so a large or never-ending request body cannot exhaust pod memory or hold connections open.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 2 * 1024 * 1024);
const REQUEST_BODY_TIMEOUT_MS = Number(process.env.REQUEST_BODY_TIMEOUT_MS || 30_000);

class PayloadTooLargeError extends Error {}
class RequestBodyTimeoutError extends Error {}

function credentialMatches(suppliedValue, expectedValue) {
  const supplied = Buffer.from(suppliedValue, "utf8");
  const expected = Buffer.from(expectedValue, "utf8");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function authorized(req) {
  if (!AUTH_REQUIRED) return true;
  // Bearer remains the OpenShell/Service contract. X-Api-Key is accepted so external
  // clients can satisfy Envoy Gateway Basic auth (Authorization: Basic ...) and still
  // present the inference credential without colliding on the Authorization header.
  const apiKeyHeader = req.headers["x-api-key"];
  if (typeof apiKeyHeader === "string" && credentialMatches(apiKeyHeader, API_KEY)) {
    return true;
  }
  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return false;
  return credentialMatches(authorization.slice("Bearer ".length), API_KEY);
}

function requireAuthorization(req, res) {
  if (authorized(req)) return true;
  res.writeHead(401, {
    "content-type": "application/json",
    "www-authenticate": 'Bearer realm="nemoclaw-onprem-inference"',
  });
  res.end(JSON.stringify({ error: "authentication required" }));
  return false;
}

let inflight = 0;
let totalRequests = 0;
let inferenceReachable = 0;
let inferenceCache = { ok: false, at: 0 };
const INFERENCE_CACHE_MS = Number(process.env.INFERENCE_READY_CACHE_MS || 15_000);
let inferenceReadyEver = false;
let inferenceFailStreak = 0;
const INFERENCE_FAIL_MAX = Number(process.env.INFERENCE_FAIL_MAX || 8);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const onData = (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        finish(reject, new PayloadTooLargeError("request body too large"));
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => finish(resolve, Buffer.concat(chunks).toString("utf8"));
    const onError = (err) => finish(reject, err);
    const timer = setTimeout(() => {
      finish(reject, new RequestBodyTimeoutError("request body timeout"));
    }, REQUEST_BODY_TIMEOUT_MS);
    function finish(fn, arg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      // Stop reading further bytes from an oversized/stalled request, but leave the
      // socket itself open so the caller below can still write a clean HTTP response
      // (destroying it here would reset the connection before the response flushes).
      req.pause();
      fn(arg);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

async function proxyChatCompletions(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err instanceof PayloadTooLargeError) {
      res.writeHead(413, { "content-type": "text/plain", Connection: "close" });
      res.end("payload too large\n", () => req.destroy());
    } else if (err instanceof RequestBodyTimeoutError) {
      res.writeHead(408, { "content-type": "text/plain", Connection: "close" });
      res.end("request timeout\n", () => req.destroy());
    } else {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request\n");
    }
    return;
  }
  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("invalid json\n");
    return;
  }
  body.model = MODEL;
  const llmStart = performance.now();
  let llmOk = false;
  try {
    const hubRes = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(300_000),
    });
    llmOk = hubRes.ok;
    // Pipe the upstream body straight through (don't buffer with .text()) so
    // "stream": true chat-completions reach the client incrementally, and forward
    // its real content-type instead of forcing application/json on SSE responses.
    const contentType = hubRes.headers.get("content-type") || "application/json";
    res.writeHead(hubRes.status, { "content-type": contentType });
    if (hubRes.body) {
      await pipeline(Readable.fromWeb(hubRes.body), res);
    } else {
      res.end();
    }
  } catch (err) {
    // Log the full error server-side only; the client gets a generic message so
    // internal details (upstream host/port, stack trace) never leave the pod.
    console.error("chat completion proxy error:", err);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream inference request failed" }));
    } else {
      res.destroy();
    }
  } finally {
    recordLlmLatency(performance.now() - llmStart, llmOk);
  }
}

// Ollama's /api/tags lists pulled models as {name|model: "llama3.2:3b", ...}; a bare tag-less
// MODEL should still match a tagged pull. vLLM/NIM's OpenAI-compatible /v1/models lists exactly
// one served model as {id: "..."}; those runtimes report the served-model id verbatim so we
// require an exact match there instead of the tag-prefix fallback Ollama needs.
function readinessUrl() {
  return RUNTIME === "ollama" ? `${RUNTIME_ROOT}/api/tags` : `${RUNTIME_ROOT}/v1/models`;
}

function modelNamesFrom(data) {
  if (RUNTIME === "ollama") return (data.models || []).map((m) => m.name || m.model || "");
  return (data.data || []).map((m) => m.id || "");
}

function modelMatches(names) {
  if (!MODEL) return names.length > 0;
  if (RUNTIME !== "ollama") return names.includes(MODEL);
  return names.some((name) => name === MODEL || (!MODEL.includes(":") && name.startsWith(`${MODEL}:`)));
}

async function checkInference() {
  const now = Date.now();
  if (now - inferenceCache.at < INFERENCE_CACHE_MS) return inferenceCache.ok;
  try {
    const res = await fetch(readinessUrl(), {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      inferenceCache = { ok: false, at: now };
      return false;
    }
    const data = await res.json();
    const ok = modelMatches(modelNamesFrom(data));
    if (ok) {
      inferenceReadyEver = true;
      inferenceFailStreak = 0;
      inferenceCache = { ok: true, at: now };
      return true;
    }
    inferenceFailStreak += 1;
    if (inferenceReadyEver && (inflight > 0 || inferenceFailStreak < INFERENCE_FAIL_MAX)) {
      inferenceCache = { ok: true, at: now };
      return true;
    }
    inferenceCache = { ok: false, at: now };
    return false;
  } catch {
    inferenceFailStreak += 1;
    if (inferenceReadyEver && (inflight > 0 || inferenceFailStreak < INFERENCE_FAIL_MAX)) {
      inferenceCache = { ok: true, at: now };
      return true;
    }
    inferenceCache = { ok: false, at: now };
    return false;
  }
}

function metricsText() {
  return [
    "# HELP nemoclaw_http_requests_total Total HTTP requests to metrics-proxy pod",
    "# TYPE nemoclaw_http_requests_total counter",
    `nemoclaw_http_requests_total ${totalRequests}`,
    "# HELP nemoclaw_http_inflight_requests In-flight HTTP requests",
    "# TYPE nemoclaw_http_inflight_requests gauge",
    `nemoclaw_http_inflight_requests ${inflight}`,
    "# HELP nemoclaw_inference_reachable 1 if the local inference runtime's model is ready",
    "# TYPE nemoclaw_inference_reachable gauge",
    `nemoclaw_inference_reachable ${inferenceReachable}`,
    ...llmMetricsLines(),
    "",
  ].join("\n");
}

// Defense-in-depth against slow/never-ending requests, independent of the per-request
// body cap enforced in readBody(). headersTimeout must stay <= requestTimeout (Node requires it).
const REQUEST_TIMEOUT_MS = REQUEST_BODY_TIMEOUT_MS + 5_000;
const HEADERS_TIMEOUT_MS = Math.min(10_000, REQUEST_TIMEOUT_MS);

const server = http.createServer(
  {
    requestTimeout: REQUEST_TIMEOUT_MS,
    headersTimeout: HEADERS_TIMEOUT_MS,
  },
  async (req, res) => {
    totalRequests += 1;
    inflight += 1;
    try {
      if (req.url === "/healthz" || req.url === "/health") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok\n");
        return;
      }
      if (req.url === "/readyz" || req.url === "/ready") {
        const ok = await checkInference();
        inferenceReachable = ok ? 1 : 0;
        res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" });
        res.end(ok ? "ready\n" : `${RUNTIME} model not ready\n`);
        return;
      }
      if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(metricsText());
        return;
      }
      const pathOnly = (req.url || "").split("?")[0];
      if (pathOnly === "/v1/models" && req.method === "GET") {
        if (!requireAuthorization(req, res)) return;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [{ id: MODEL, object: "model", created: 0, owned_by: "on-prem" }],
          }),
        );
        return;
      }
      if (
        (pathOnly === "/v1/chat/completions" || pathOnly === "/chat/completions") &&
        req.method === "POST"
      ) {
        if (!requireAuthorization(req, res)) return;
        await proxyChatCompletions(req, res);
        return;
      }
      if (req.url === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            service: "nemoclaw-gpu-metrics-proxy",
            runtime: RUNTIME,
            model: MODEL,
            inferenceBaseUrl: BASE_URL,
            runtimeBaseUrl: RUNTIME_ROOT,
            endpoints: [
              "/healthz",
              "/readyz",
              "/metrics",
              "GET /v1/models",
              "POST /v1/chat/completions",
            ],
            inferenceAuthentication: AUTH_REQUIRED ? "Bearer" : "disabled",
            note: `Local ${RUNTIME} on GPU; scale replicas with kubectl or HPA (one pod per GPU)`,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end("not found\n");
    } finally {
      inflight -= 1;
    }
  },
);

server.listen(PORT, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  console.log(`nemoclaw-gpu-metrics-proxy listening on :${listeningPort} model=${MODEL}`);
});
