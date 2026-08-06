#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// GPU agent pod: health + Prometheus metrics + OpenAI-compatible proxy to local Ollama.

import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { llmMetricsLines, recordLlmLatency } from "./agent-metrics.ts";

const PORT = Number(process.env.PORT || 8081);
const BASE_URL = (process.env.INFERENCE_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.INFERENCE_MODEL || "";
// Bound the unauthenticated proxy request path: cap buffered body size and time-to-complete
// so a large or never-ending request body cannot exhaust pod memory or hold connections open.
const MAX_BODY_BYTES = Number(process.env.MAX_BODY_BYTES || 2 * 1024 * 1024);
const REQUEST_BODY_TIMEOUT_MS = Number(process.env.REQUEST_BODY_TIMEOUT_MS || 30_000);

class PayloadTooLargeError extends Error {}
class RequestBodyTimeoutError extends Error {}

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
  if (!body.model) body.model = MODEL;
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

async function checkInference() {
  const now = Date.now();
  if (now - inferenceCache.at < INFERENCE_CACHE_MS) return inferenceCache.ok;
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      inferenceCache = { ok: false, at: now };
      return false;
    }
    const data = await res.json();
    const names = (data.models || []).map((m) => m.name || m.model || "");
    const ok = MODEL
      ? names.some(
          (name) =>
            name === MODEL ||
            (!MODEL.includes(":") && name.startsWith(`${MODEL}:`)),
        )
      : names.length > 0;
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
    "# HELP nemoclaw_http_requests_total Total HTTP requests to agent pod",
    "# TYPE nemoclaw_http_requests_total counter",
    `nemoclaw_http_requests_total ${totalRequests}`,
    "# HELP nemoclaw_http_inflight_requests In-flight HTTP requests",
    "# TYPE nemoclaw_http_inflight_requests gauge",
    `nemoclaw_http_inflight_requests ${inflight}`,
    "# HELP nemoclaw_inference_reachable 1 if local Ollama model is ready",
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
        res.end(ok ? "ready\n" : "ollama model not ready\n");
        return;
      }
      if (req.url === "/metrics") {
        res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
        res.end(metricsText());
        return;
      }
      const pathOnly = (req.url || "").split("?")[0];
      if (
        (pathOnly === "/v1/chat/completions" || pathOnly === "/chat/completions") &&
        req.method === "POST"
      ) {
        await proxyChatCompletions(req, res);
        return;
      }
      if (req.url === "/" && req.method === "GET") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            service: "nemoclaw-gpu-agent",
            model: MODEL,
            inferenceBaseUrl: BASE_URL,
            ollamaBaseUrl: OLLAMA_BASE,
            endpoints: ["/healthz", "/readyz", "/metrics", "POST /v1/chat/completions"],
            note: "Local Ollama on GPU; scale replicas with kubectl or HPA (one pod per GPU)",
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
  console.log(`nemoclaw-gpu-agent listening on :${PORT} model=${MODEL}`);
});
