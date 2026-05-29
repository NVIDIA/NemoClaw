#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Minimal CPU agent pod: health + Prometheus metrics for HPA tuning.
// Inference runs on NVIDIA Inference Hub (no local GPU).

import http from "node:http";
import { Worker } from "node:worker_threads";

const PORT = Number(process.env.PORT || 8080);
const BASE_URL = (process.env.INFERENCE_BASE_URL || "").replace(/\/$/, "");
const MODEL = process.env.INFERENCE_MODEL || "";
const API_KEY = process.env.NVIDIA_INFERENCE_HUB_API_KEY || "";
/** Optional per-request CPU spin (ms) so HPA sees pod CPU rise under load. */
const LOAD_TEST_CPU_SPIN_MS = Number(process.env.LOAD_TEST_CPU_SPIN_MS || 0);

let inflight = 0;
let totalRequests = 0;
let inferenceReachable = 0;
/** Cache /readyz Hub check so probes do not compete with load-test chat traffic. */
let inferenceCache = { ok: false, at: 0 };
const INFERENCE_CACHE_MS = Number(process.env.INFERENCE_READY_CACHE_MS || 30_000);

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Spin in worker threads so /healthz and /readyz stay responsive under load. */
function cpuSpinWorkers(ms, threads = 1) {
  if (!ms || ms <= 0) return Promise.resolve();
  const n = Math.max(1, Math.min(Number(threads) || 1, 2));
  const eachMs = Math.ceil(ms / n);
  return Promise.all(
    Array.from({ length: n }, () =>
      new Promise((resolve, reject) => {
        const w = new Worker(new URL("./cpu-spin-worker.mjs", import.meta.url), {
          workerData: { ms: eachMs },
        });
        w.once("message", () => {
          w.terminate().catch(() => {});
          resolve();
        });
        w.once("error", reject);
        w.once("exit", (code) => {
          if (code !== 0) reject(new Error(`cpu-spin-worker exited ${code}`));
        });
      }),
    ),
  );
}

async function proxyChatCompletions(req, res) {
  if (!BASE_URL || !API_KEY) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "inference not configured" }));
    return;
  }
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
  const spinHeader = Number(req.headers["x-nemoclaw-load-spin-ms"]);
  const spinMs = Number.isFinite(spinHeader) && spinHeader > 0 ? spinHeader : LOAD_TEST_CPU_SPIN_MS;
  await cpuSpinWorkers(spinMs, 1);
  try {
    const hubRes = await fetch(`${BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
    });
    const text = await hubRes.text();
    res.writeHead(hubRes.status, { "content-type": "application/json" });
    res.end(text);
  } catch (err) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: String(err) }));
  }
}

async function checkInference() {
  if (!BASE_URL || !API_KEY) return false;
  const now = Date.now();
  if (now - inferenceCache.at < INFERENCE_CACHE_MS) return inferenceCache.ok;
  try {
    const res = await fetch(`${BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
      signal: AbortSignal.timeout(10_000),
    });
    inferenceCache = { ok: res.ok, at: now };
    return res.ok;
  } catch {
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
    "# HELP nemoclaw_inference_hub_reachable 1 if Inference Hub /models OK",
    "# TYPE nemoclaw_inference_hub_reachable gauge",
    `nemoclaw_inference_hub_reachable ${inferenceReachable}`,
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
      res.end(ok ? "ready\n" : "inference not reachable\n");
      return;
    }
    if (req.url === "/metrics") {
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(metricsText());
      return;
    }
    const pathOnly = (req.url || "").split("?")[0];
    if (pathOnly === "/bench" && (req.method === "POST" || req.method === "GET")) {
      const parsed = new URL(req.url || "/bench", "http://127.0.0.1");
      const headerSpin = Number(req.headers["x-nemoclaw-load-spin-ms"]);
      const qMs = Number(parsed.searchParams.get("ms"));
      const qThreads = Number(parsed.searchParams.get("threads"));
      const spinMs =
        (Number.isFinite(qMs) && qMs > 0 ? qMs : 0) ||
        (Number.isFinite(headerSpin) && headerSpin > 0 ? headerSpin : 0) ||
        LOAD_TEST_CPU_SPIN_MS ||
        100;
      const threads =
        Number.isFinite(qThreads) && qThreads > 0
          ? qThreads
          : Number(process.env.LOAD_TEST_BENCH_THREADS || 2);
      await cpuSpinWorkers(spinMs, threads);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`ok spin=${spinMs} threads=${threads}\n`);
      return;
    }
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
          service: "nemoclaw-cpu-agent",
          model: MODEL,
          inferenceBaseUrl: BASE_URL,
          loadTestCpuSpinMs: LOAD_TEST_CPU_SPIN_MS,
          endpoints: ["/healthz", "/readyz", "/metrics", "POST /bench", "POST /v1/chat/completions"],
          note: "Remote Nemotron Ultra via Inference Hub; scale replicas with kubectl or HPA",
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
  console.log(`nemoclaw-cpu-agent listening on :${PORT} model=${MODEL}`);
});
