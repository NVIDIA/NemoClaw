#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// GPU agent pod: health + Prometheus metrics + OpenAI-compatible proxy to local Ollama.

import http from "node:http";
import { llmMetricsLines, recordLlmLatency } from "./agent-metrics.mjs";

const PORT = Number(process.env.PORT || 8081);
const BASE_URL = (process.env.INFERENCE_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/$/, "");
const OLLAMA_BASE = (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const MODEL = process.env.INFERENCE_MODEL || "";

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
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function proxyChatCompletions(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("bad request\n");
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
    const text = await hubRes.text();
    res.writeHead(hubRes.status, { "content-type": "application/json" });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
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
    const want = MODEL.split(":")[0];
    const ok =
      names.some((n) => n === MODEL || n.startsWith(`${want}:`) || n.includes(MODEL)) ||
      names.length > 0;
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

const server = http.createServer(async (req, res) => {
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
});

server.listen(PORT, () => {
  console.log(`nemoclaw-gpu-agent listening on :${PORT} model=${MODEL}`);
});
