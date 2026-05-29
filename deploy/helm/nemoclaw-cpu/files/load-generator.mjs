#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Saturate agent pods for CPU HPA: per-target-pod concurrency, parallel /bench + worker threads.

import fs from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

const TARGET = (process.env.TARGET_URL || "http://nemoclaw-nemoclaw-cpu-agent:8080").replace(
  /\/$/,
  "",
);
const DURATION_SEC = Number(process.env.DURATION_SEC || 720);
/** HPA max replicas we want to drive (8-vCPU node ≈ 7 with 400m request/pod). */
const TARGET_PODS = Number(process.env.TARGET_PODS || 7);
/** Steady-state in-flight requests per agent pod (via Service LB). */
const CONCURRENCY_PER_POD = Number(process.env.CONCURRENCY_PER_POD || 40);
const BENCH_MS = Number(process.env.BENCH_MS || process.env.SPIN_MS || 450);
const BENCH_THREADS = Number(process.env.BENCH_THREADS || 2);
const BENCH_RATIO = Number(process.env.BENCH_RATIO || 1);
const RAMP_SEC = Number(process.env.RAMP_SEC || 90);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 90_000);

const PEAK_INFLIGHT = TARGET_PODS * CONCURRENCY_PER_POD;
const WORKER_COUNT = Math.max(8, Math.min(64, Math.ceil(PEAK_INFLIGHT / 12)));

function loadQuestions() {
  try {
    const lines = fs
      .readFileSync(process.env.QUESTIONS_FILE || "/questions/questions.txt", "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length) return lines;
  } catch {
    /* use fallback */
  }
  return ["Briefly explain Kubernetes HPA."];
}

async function bench() {
  const url = `${TARGET}/bench?ms=${BENCH_MS}&threads=${BENCH_THREADS}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "X-NemoClaw-Load-Spin-Ms": String(BENCH_MS) },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`bench HTTP ${res.status}`);
  await res.text();
}

async function ask(questions) {
  const q = questions[Math.floor(Math.random() * questions.length)];
  const res = await fetch(`${TARGET}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: q }],
      max_tokens: 24,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
  await res.json();
}

async function oneShot(questions, stats) {
  if (Math.random() < BENCH_RATIO) {
    await bench();
    stats.bench += 1;
  } else {
    await ask(questions);
    stats.chat += 1;
  }
}

/** Keep exactly `limit` requests in flight (token bucket style). */
async function saturationLoop(limit, questions, endAt, stats, wid) {
  const tasks = new Set();
  while (Date.now() < endAt) {
    while (tasks.size < limit && Date.now() < endAt) {
      const p = oneShot(questions, stats)
        .catch((err) => {
          stats.fail += 1;
          if (stats.fail <= 10 || stats.fail % 200 === 0) {
            console.error(`[sat-${wid}] ${err.message}`);
          }
        })
        .finally(() => tasks.delete(p));
      tasks.add(p);
    }
    if (tasks.size > 0) await Promise.race(tasks);
    else await sleep(20);
  }
  await Promise.all(tasks);
}

async function main() {
  const questions = loadQuestions();
  const endAt = Date.now() + DURATION_SEC * 1000;
  const stats = { bench: 0, chat: 0, fail: 0 };

  console.log(
    JSON.stringify({
      target: TARGET,
      targetPods: TARGET_PODS,
      concurrencyPerPod: CONCURRENCY_PER_POD,
      peakInflight: PEAK_INFLIGHT,
      workerGoroutines: WORKER_COUNT,
      benchMs: BENCH_MS,
      benchThreads: BENCH_THREADS,
      rampSec: RAMP_SEC,
      durationSec: DURATION_SEC,
    }),
  );

  const loops = [];
  for (let w = 0; w < WORKER_COUNT; w += 1) {
    const share = Math.ceil(PEAK_INFLIGHT / WORKER_COUNT);
    loops.push(
      (async () => {
        const rampEnd = Date.now() + RAMP_SEC * 1000;
        let limit = Math.max(2, Math.ceil(share / 4));
        while (Date.now() < endAt) {
          if (Date.now() < rampEnd) {
            const progress = (Date.now() - (rampEnd - RAMP_SEC * 1000)) / (RAMP_SEC * 1000);
            limit = Math.max(2, Math.ceil(share * (0.25 + 0.75 * progress)));
          } else {
            limit = share;
          }
          await saturationLoop(limit, questions, Math.min(endAt, Date.now() + 5000), stats, w);
        }
      })(),
    );
  }

  await Promise.all(loops);
  const ok = stats.bench + stats.chat;
  console.log(`done bench=${stats.bench} chat=${stats.chat} fail=${stats.fail}`);
  process.exit(stats.fail > ok * 3 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
