#!/usr/bin/env node
// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
//
// Drive GPU utilization for HPA: chat completions directly to each metrics-proxy pod IP.
// Each Running metrics-proxy pod gets PER_POD_PEAK × compensation concurrent requests.
// Compensation = HPA currentReplicas / loadTargetCount so cold pods at 0% GPU
// do not drag the average to ~42% while a new replica is starting.

import fs from "node:fs";
import https from "node:https";
import { setTimeout as sleep } from "node:timers/promises";

const DURATION_SEC = Number(process.env.DURATION_SEC || 720);
const TARGET_PODS = Number(process.env.TARGET_PODS || 4);
const HPA_TARGET_GPU = Number(process.env.HPA_TARGET_GPU || 40);
const JOB_PARALLELISM = Number(process.env.JOB_PARALLELISM || 1);
const METRICS_PROXY_PORT = Number(process.env.METRICS_PROXY_PORT || 8081);
const INFLIGHT_PER_GPU = Number(process.env.INFLIGHT_PER_GPU || 384);
const LOAD_MULTIPLIER = Number(process.env.LOAD_MULTIPLIER || 1);
const PER_POD_PEAK = INFLIGHT_PER_GPU * LOAD_MULTIPLIER;
const RAMP_SEC = Number(process.env.RAMP_SEC || 60);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 300_000);
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 512);
const LOG_EVERY_SEC = Number(process.env.LOG_EVERY_SEC || 15);
const TARGET_POLL_SEC = Number(process.env.TARGET_POLL_SEC || 1);
const K8S_NAMESPACE = process.env.K8S_NAMESPACE || "nemoclaw-gpu";
const METRICS_PROXY_SERVICE = process.env.METRICS_PROXY_SERVICE || "nemoclaw-gpu-metrics-proxy";
const HPA_NAME = process.env.HPA_NAME || METRICS_PROXY_SERVICE;
const METRICS_PROXY_LABEL_SELECTOR =
  process.env.METRICS_PROXY_LABEL_SELECTOR || "app.kubernetes.io/name=nemoclaw-gpu,component=gpu-metrics-proxy";
const ESCALATE_INTERVAL_SEC = Number(process.env.ESCALATE_INTERVAL_SEC || 10);
const ESCALATE_FACTOR = Number(process.env.ESCALATE_FACTOR || 0.5);
const ESCALATE_MAX_MULT = Number(process.env.ESCALATE_MAX_MULT || 3);
const REQUEST_RETRIES = Number(process.env.REQUEST_RETRIES || 2);
const LOAD_COMPENSATION_SAFETY = Number(process.env.LOAD_COMPENSATION_SAFETY || 3);
const MAX_COMPENSATION = Number(process.env.MAX_COMPENSATION || 16);
const NEW_POD_RAMP_SEC = Number(process.env.NEW_POD_RAMP_SEC || 0);
const MAX_INFLIGHT_PER_POD = Number(process.env.MAX_INFLIGHT_PER_POD || 6144);
const WARMUP_SEC = Number(process.env.WARMUP_SEC || 45);
const ERROR_BACKOFF_FACTOR = Number(process.env.ERROR_BACKOFF_FACTOR || 0.92);
const ERROR_BACKOFF_MIN = Number(process.env.ERROR_BACKOFF_MIN || 0.4);
const ERROR_BACKOFF_RECOVERY = Number(process.env.ERROR_BACKOFF_RECOVERY || 1.15);
const BOOTSTRAP_INFLIGHT = Number(process.env.BOOTSTRAP_INFLIGHT || 4);
const NEW_POD_WARMUP_PARALLEL = Number(process.env.NEW_POD_WARMUP_PARALLEL || 8);
const NEW_POD_WARMUP_MAX_SEC = Number(process.env.NEW_POD_WARMUP_MAX_SEC || 120);
const CIRCUIT_BREAKER_BACKOFF = Number(process.env.CIRCUIT_BREAKER_BACKOFF || 0.15);
const MIN_INFLIGHT_FLOOR = Number(process.env.MIN_INFLIGHT_FLOOR || 8);
const MIN_RECOVERY_INFLIGHT = Number(process.env.MIN_RECOVERY_INFLIGHT || 4);
const READYZ_GRACE_SEC = Number(process.env.READYZ_GRACE_SEC || 45);
// After HPA has held max replicas (and Ready load targets) for this long, stop
// creating new load so scale-down can begin — applies to GPU util, latency, etc.
const MAX_REPLICAS_HOLD_SEC = Number(process.env.MAX_REPLICAS_HOLD_SEC || 15);
const REQUIRE_CHAT_PROBE =
  process.env.REQUIRE_CHAT_PROBE === "1" || process.env.REQUIRE_CHAT_PROBE === "true";
const PROBE_CHAT_TIMEOUT_MS = Number(process.env.PROBE_CHAT_TIMEOUT_MS || 30_000);
const INFERENCE_API_KEY = process.env.INFERENCE_API_KEY || "";
if (!INFERENCE_API_KEY) {
  throw new Error("INFERENCE_API_KEY is required for the authenticated inference service");
}

function inferenceHeaders() {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${INFERENCE_API_KEY}`,
  };
}

let podTargets = [];
let podCandidates = [];
let hpaReplicas = 1;
let hpaDesired = 1;
let loadCompensation = 1;
let lastTargetPoll = 0;
let forceStopLoad = false;
const podFirstSeen = new Map();
const targetBackoff = new Map();
const targetChatOk = new Set();
const warmInFlight = new Set();
const readyzLastOk = new Map();

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
  return [
    "Explain Kubernetes HPA and GPU autoscaling in detail with examples.",
    "Write a long summary of transformer inference on NVIDIA GPUs.",
    "Describe how Ollama serves models and batches concurrent chat requests.",
  ];
}

function k8sGet(path) {
  const tokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token";
  const caPath = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
  if (!fs.existsSync(tokenPath) || !process.env.KUBERNETES_SERVICE_HOST) {
    return Promise.resolve(null);
  }
  // Standard in-cluster Kubernetes auth: the projected service-account token/CA are
  // not attacker-controllable, and sending them to the API server is the intended use.
  const token = fs.readFileSync(tokenPath, "utf8");
  const ca = fs.readFileSync(caPath);
  return new Promise((resolve) => {
    // codeql[js/file-access-to-http] -- in-cluster K8s API auth: token/ca come from the
    // kubelet-projected service-account files and are sent only to KUBERNETES_SERVICE_HOST.
    const req = https.request(
      {
        hostname: process.env.KUBERNETES_SERVICE_HOST,
        port: process.env.KUBERNETES_SERVICE_PORT || 443,
        path,
        method: "GET",
        headers: { Authorization: `Bearer ${token}` },
        ca,
        rejectUnauthorized: true,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => {
          data += chunk;
        });
        res.on("end", () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}

function ipsFromEndpointSliceList(list) {
  const ips = new Set();
  for (const slice of list?.items || []) {
    for (const ep of slice.endpoints || []) {
      if (ep.conditions?.ready === false) continue;
      for (const addr of ep.addresses || []) {
        if (addr) ips.add(addr);
      }
    }
  }
  return ips;
}

function ipsFromRunningPods(list) {
  const ips = new Set();
  for (const pod of list?.items || []) {
    if (pod.status?.phase !== "Running") continue;
    const ip = pod.status?.podIP;
    if (ip) ips.add(ip);
  }
  return ips;
}

async function pollHpaReplicas() {
  const hpa = await k8sGet(
    `/apis/autoscaling/v2/namespaces/${K8S_NAMESPACE}/horizontalpodautoscalers/${HPA_NAME}`,
  );
  if (hpa?.status?.currentReplicas >= 1) {
    hpaReplicas = hpa.status.currentReplicas;
  }
  if (hpa?.status?.desiredReplicas >= 1) {
    hpaDesired = hpa.status.desiredReplicas;
  }
  return hpaReplicas;
}

async function probeInferenceReady(target) {
  const ip = podIpFromTarget(target);
  try {
    const res = await fetch(`${target}/readyz`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      readyzLastOk.set(ip, Date.now());
      return true;
    }
  } catch {
    /* grace below */
  }
  const last = readyzLastOk.get(ip);
  if (last && (Date.now() - last) / 1000 < READYZ_GRACE_SEC) return true;
  return false;
}

async function pollMetricsProxyPodTargets() {
  const now = Date.now();
  if (now - lastTargetPoll < TARGET_POLL_SEC * 1000) {
    return podTargets;
  }
  lastTargetPoll = now;

  await pollHpaReplicas();

  const ips = new Set();

  const sliceList = await k8sGet(
    `/apis/discovery.k8s.io/v1/namespaces/${K8S_NAMESPACE}/endpointslices?labelSelector=${encodeURIComponent(`kubernetes.io/service-name=${METRICS_PROXY_SERVICE}`)}`,
  );
  for (const ip of ipsFromEndpointSliceList(sliceList)) ips.add(ip);

  const podList = await k8sGet(
    `/api/v1/namespaces/${K8S_NAMESPACE}/pods?labelSelector=${encodeURIComponent(METRICS_PROXY_LABEL_SELECTOR)}`,
  );
  for (const ip of ipsFromRunningPods(podList)) ips.add(ip);

  if (ips.size) {
    const nowMs = Date.now();
    for (const ip of ips) {
      if (!podFirstSeen.has(ip)) {
        podFirstSeen.set(ip, nowMs);
        console.log(JSON.stringify({ event: "newPodDiscovered", ip }));
      }
    }
    const candidates = [...ips].map((ip) => `http://${ip}:${METRICS_PROXY_PORT}`);
    podCandidates = candidates;
    const ready = [];
    await Promise.all(
      candidates.map(async (target) => {
        if (await probeInferenceReady(target)) ready.push(target);
      }),
    );
    podTargets = ready;
    for (const target of podCandidates) scheduleWarmTarget(target);
  } else {
    podCandidates = [];
    podTargets = [];
  }

  // Compensate for the target pods not yet represented by candidate IPs.
  const readyCount = Math.max(1, podCandidates.length);
  const hpaCount = Math.max(hpaReplicas, hpaDesired, readyCount, 1);
  if (readyCount >= TARGET_PODS) {
    loadCompensation = 1;
  } else if (readyCount >= hpaCount) {
    // Spread the target-pod load across the candidates that are already available.
    loadCompensation = Math.min(MAX_COMPENSATION, TARGET_PODS / readyCount);
  } else {
    // Add a safety multiplier while HPA replicas are still missing candidate IPs.
    loadCompensation = Math.min(
      MAX_COMPENSATION,
      Math.max(1, (TARGET_PODS / readyCount) * LOAD_COMPENSATION_SAFETY),
    );
  }

  return podTargets;
}

function podIpFromTarget(target) {
  return target.match(/^http:\/\/([^:/]+)/)?.[1] || target;
}

function newPodRampMultiplier(ip) {
  if (NEW_POD_RAMP_SEC <= 0) return 1;
  const seenAt = podFirstSeen.get(ip);
  if (!seenAt) return 1;
  const ageSec = (Date.now() - seenAt) / 1000;
  if (ageSec >= NEW_POD_RAMP_SEC) return 1;
  return 0.75 + 0.25 * (ageSec / NEW_POD_RAMP_SEC);
}

function getTargetBackoff(ip) {
  return targetBackoff.get(ip) ?? 1;
}

function noteTargetResult(ip, ok) {
  const cur = targetBackoff.get(ip) ?? 1;
  if (!ok) {
    targetBackoff.set(ip, Math.max(ERROR_BACKOFF_MIN, cur * ERROR_BACKOFF_FACTOR));
  } else if (cur < 1) {
    targetBackoff.set(ip, Math.min(1, cur * ERROR_BACKOFF_RECOVERY));
  }
}

function activeReplicaCount() {
  return Math.max(hpaReplicas, hpaDesired, podCandidates.length, podTargets.length, 1);
}

function strugglingTargetCount() {
  let n = 0;
  for (const ip of podFirstSeen.keys()) {
    if (getTargetBackoff(ip) <= CIRCUIT_BREAKER_BACKOFF) n += 1;
  }
  return n;
}

function healthyBoostMultiplier(ip) {
  const n = activeReplicaCount();
  if (n < 2) return 1;
  const backoff = getTargetBackoff(ip);
  if (backoff <= CIRCUIT_BREAKER_BACKOFF) return 1;
  const struggling = strugglingTargetCount();
  if (struggling <= 0) return 1;
  return Math.min(2, 1 + struggling / Math.max(1, targetChatOk.size));
}

async function probeChatWorks(target) {
  try {
    const res = await fetch(`${target}/v1/chat/completions`, {
      method: "POST",
      headers: inferenceHeaders(),
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say OK." }],
        max_tokens: 8,
        stream: false,
      }),
      signal: AbortSignal.timeout(PROBE_CHAT_TIMEOUT_MS),
    });
    if (!res.ok) return false;
    await res.json();
    return true;
  } catch {
    return false;
  }
}

async function requirePodTargets(deadlineMs) {
  while (Date.now() < deadlineMs) {
    await pollMetricsProxyPodTargets();
    const targets = podCandidates.length ? podCandidates : podTargets;
    if (targets.length === 0) {
      await sleep(1000);
      continue;
    }
    if (!REQUIRE_CHAT_PROBE) {
      console.log(
        JSON.stringify({
          event: "targetsReady",
          loadTargets: targets,
          readyzOk: podTargets.length,
        }),
      );
      return targets;
    }
    for (const target of podTargets.length ? podTargets : targets) {
      if (await probeChatWorks(target)) {
        targetChatOk.add(target);
        console.log(JSON.stringify({ event: "chatProbeOk", target }));
        console.log(JSON.stringify({ event: "targetsReady", loadTargets: podTargets }));
        return podTargets;
      }
    }
    console.log(JSON.stringify({ event: "waitingForChatProbe", loadTargets: podTargets }));
    await sleep(3000);
  }
  console.error(
    REQUIRE_CHAT_PROBE
      ? "FATAL: metrics-proxy pod(s) found but chat probe never succeeded — wait for Ollama model pull"
      : "FATAL: no ready metrics-proxy pod IPs — check RBAC (pods/endpointslices) and metrics-proxy pods",
  );
  process.exit(1);
}

function inflightFloor(multiReplica) {
  if (multiReplica) return Math.max(MIN_INFLIGHT_FLOOR, 12);
  return Math.max(MIN_INFLIGHT_FLOOR, MIN_RECOVERY_INFLIGHT);
}

function escalationCap() {
  let cap = ESCALATE_MAX_MULT;
  const hpaN = Math.max(hpaReplicas, hpaDesired);
  if (hpaN >= 2 && targetChatOk.size < hpaN) {
    cap = Math.min(cap, 1.25);
  }
  return cap;
}

function rampMultiplier(elapsedSec) {
  const cap = escalationCap();
  if (RAMP_SEC <= 0) {
    const steps = Math.floor(elapsedSec / ESCALATE_INTERVAL_SEC);
    return Math.min(cap, 1 + steps * ESCALATE_FACTOR);
  }
  if (elapsedSec < RAMP_SEC) {
    const progress = elapsedSec / RAMP_SEC;
    return Math.min(cap, 0.75 + 0.25 * progress);
  }
  const steps = Math.floor((elapsedSec - RAMP_SEC) / ESCALATE_INTERVAL_SEC);
  return Math.min(cap, 1 + steps * ESCALATE_FACTOR);
}

function warmupCompensationScale(startedAt) {
  const elapsed = (Date.now() - startedAt) / 1000;
  if (WARMUP_SEC <= 0 || elapsed >= WARMUP_SEC) return 1;
  return 0.35 + 0.65 * (elapsed / WARMUP_SEC);
}

function effectiveCompensation(startedAt) {
  const warm = warmupCompensationScale(startedAt);
  return 1 + (loadCompensation - 1) * warm;
}

function baseInflightPerPodPerGenerator(startedAt, stats) {
  const mult = rampMultiplier((Date.now() - startedAt) / 1000);
  const comp = effectiveCompensation(startedAt);
  let raw = Math.ceil((PER_POD_PEAK * mult * comp) / JOB_PARALLELISM);
  const total = (stats?.chat ?? 0) + (stats?.fail ?? 0);
  if (total >= 40) {
    const failRate = (stats?.fail ?? 0) / total;
    if (failRate > 0.6) raw = Math.ceil(raw * 0.25);
    else if (failRate > 0.3) raw = Math.ceil(raw * 0.5);
    else if (failRate > 0.15) raw = Math.ceil(raw * 0.75);
  }
  const cap = Math.max(2, Math.ceil(MAX_INFLIGHT_PER_POD / JOB_PARALLELISM));
  const floor = inflightFloor(activeReplicaCount() >= 2);
  return Math.max(floor, Math.min(raw, cap));
}

function inflightForTarget(target, startedAt, inferenceReady = true, stats = null) {
  const ip = podIpFromTarget(target);
  const backoff = getTargetBackoff(ip);
  const multiReplica = activeReplicaCount() >= 2;
  const floor = inflightFloor(multiReplica || targetChatOk.has(target));

  if (backoff <= CIRCUIT_BREAKER_BACKOFF) {
    return Math.max(floor, MIN_RECOVERY_INFLIGHT);
  }
  if (!inferenceReady) {
    return Math.max(floor, BOOTSTRAP_INFLIGHT);
  }
  if (!targetChatOk.has(target)) {
    const ageSec = (Date.now() - (podFirstSeen.get(ip) || Date.now())) / 1000;
    if (ageSec > NEW_POD_WARMUP_MAX_SEC) {
      return Math.max(
        floor,
        BOOTSTRAP_INFLIGHT,
        Math.ceil(baseInflightPerPodPerGenerator(startedAt, stats) * 0.25),
      );
    }
    return Math.max(floor, BOOTSTRAP_INFLIGHT);
  }
  const base = baseInflightPerPodPerGenerator(startedAt, stats);
  let limit = Math.ceil(base * newPodRampMultiplier(ip) * backoff * healthyBoostMultiplier(ip));
  return Math.max(floor, limit);
}

async function warmTarget(target) {
  if (targetChatOk.has(target)) return true;
  const probes = [];
  for (let i = 0; i < NEW_POD_WARMUP_PARALLEL; i++) {
    probes.push(probeChatWorks(target));
  }
  const ok = (await Promise.all(probes)).some(Boolean);
  if (ok) {
    targetChatOk.add(target);
    console.log(JSON.stringify({ event: "podWarmed", target }));
  }
  return ok;
}

function scheduleWarmTarget(target) {
  if (targetChatOk.has(target) || warmInFlight.has(target)) return;
  warmInFlight.add(target);
  warmTarget(target)
    .catch(() => false)
    .finally(() => warmInFlight.delete(target));
}

async function ask(target, questions, stats) {
  const ip = podIpFromTarget(target);
  // `questions` comes from the bundled sample file (or QUESTIONS_FILE override) — this
  // is the load generator's synthetic workload payload by design, not attacker input.
  const q = questions[Math.floor(Math.random() * questions.length)];
  let lastErr;
  for (let attempt = 0; attempt <= REQUEST_RETRIES; attempt++) {
    try {
      // codeql[js/file-access-to-http] -- `q` is the synthetic sample-question payload
      // this load generator bundles/reads by design, not attacker-controlled file data.
      const res = await fetch(`${target}/v1/chat/completions`, {
        method: "POST",
        headers: inferenceHeaders(),
        body: JSON.stringify({
          messages: [{ role: "user", content: q }],
          max_tokens: MAX_TOKENS,
          stream: false,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`chat HTTP ${res.status}`);
      await res.json();
      stats.chat += 1;
      targetChatOk.add(target);
      noteTargetResult(ip, true);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < REQUEST_RETRIES) await sleep(100 * (attempt + 1));
    }
  }
  noteTargetResult(ip, false);
  throw lastErr;
}

const targetWorkers = new Map();
const workerPromises = new Map();

async function runTargetWorker(target, questions, endAt, stats) {
  const state = { limit: 2, tasks: new Set() };
  targetWorkers.set(target, state);

  while (Date.now() < endAt && !forceStopLoad) {
    while (state.tasks.size < state.limit && Date.now() < endAt && !forceStopLoad) {
      const p = ask(target, questions, stats)
        .catch((err) => {
          stats.fail += 1;
          if (stats.fail <= 10 || stats.fail % 100 === 0) {
            console.error(`[gpu-load] ${target} ${err.message}`);
          }
        })
        .finally(() => state.tasks.delete(p));
      state.tasks.add(p);
    }
    if (state.tasks.size > 0) await Promise.race(state.tasks);
    else await sleep(20);
  }
  await Promise.all(state.tasks);
  targetWorkers.delete(target);
}

function syncTargetWorkers(targets, startedAt, stats) {
  const readySet = new Set(podTargets);
  const active = new Set(targets);
  for (const target of active) {
    scheduleWarmTarget(target);
    const inferenceReady = readySet.has(target);
    const limit = forceStopLoad
      ? 0
      : inflightForTarget(target, startedAt, inferenceReady, stats);
    const worker = targetWorkers.get(target);
    if (worker) worker.limit = limit;
  }
  for (const target of [...targetWorkers.keys()]) {
    if (!active.has(target)) {
      const worker = targetWorkers.get(target);
      if (worker) worker.limit = 0;
    }
  }
}

async function main() {
  const questions = loadQuestions();
  const startedAt = Date.now();
  const endAt = startedAt + DURATION_SEC * 1000;
  const stats = { chat: 0, fail: 0 };
  let lastLog = startedAt;
  let lastUnevenLog = 0;
  let atMaxSince = null;

  console.log(
    JSON.stringify({
      targetPods: TARGET_PODS,
      hpaTargetGpu: HPA_TARGET_GPU,
      jobParallelism: JOB_PARALLELISM,
      perPodPeak: PER_POD_PEAK,
      loadMultiplier: LOAD_MULTIPLIER,
      loadCompensationSafety: LOAD_COMPENSATION_SAFETY,
      maxTokens: MAX_TOKENS,
      rampSec: RAMP_SEC,
      durationSec: DURATION_SEC,
      maxReplicasHoldSec: MAX_REPLICAS_HOLD_SEC,
      loadModel: "direct-pod-IP saturation (multi-replica floor, per-target backoff, no full idle)",
      maxInflightPerPod: MAX_INFLIGHT_PER_POD,
      escalateMaxMult: ESCALATE_MAX_MULT,
    }),
  );

  await requirePodTargets(startedAt + 90_000);

  while (Date.now() < endAt) {
    await pollMetricsProxyPodTargets();
    const targets = podCandidates.length ? podCandidates : podTargets;
    if (!targets.length) {
      await sleep(1000);
      continue;
    }

    const atMax =
      hpaReplicas >= TARGET_PODS &&
      hpaDesired >= TARGET_PODS &&
      podTargets.length >= TARGET_PODS;
    if (atMax) {
      if (atMaxSince == null) atMaxSince = Date.now();
      const heldSec = (Date.now() - atMaxSince) / 1000;
      if (heldSec >= MAX_REPLICAS_HOLD_SEC) {
        console.log(
          JSON.stringify({
            event: "stopAtMaxReplicas",
            hpaReplicas,
            hpaDesired,
            readyLoadTargets: podTargets.length,
            targetPods: TARGET_PODS,
            heldSec: Math.round(heldSec),
            maxReplicasHoldSec: MAX_REPLICAS_HOLD_SEC,
            message: "max replicas held — stopping new load so HPA can scale down",
          }),
        );
        forceStopLoad = true;
        for (const worker of targetWorkers.values()) worker.limit = 0;
        break;
      }
    } else {
      atMaxSince = null;
    }

    if (hpaReplicas > podTargets.length && Date.now() - lastUnevenLog >= 30_000) {
      console.log(
        JSON.stringify({
          event: "unevenReplicas",
          hpaReplicas,
          hpaDesired,
          readyLoadTargets: podTargets.length,
          candidatePods: targets.length,
          warmedPods: targetChatOk.size,
          message: "HPA has more replicas than warmed GPUs — bootstrapping new pods",
        }),
      );
      lastUnevenLog = Date.now();
    }

    for (const target of targets) {
      if (!workerPromises.has(target)) {
        workerPromises.set(target, runTargetWorker(target, questions, endAt, stats));
      }
    }
    syncTargetWorkers(targets, startedAt, stats);

    if (Date.now() - lastLog >= LOG_EVERY_SEC * 1000) {
      const sampleTarget = podTargets[0] || targets[0];
      const sampleLimit = sampleTarget
        ? inflightForTarget(sampleTarget, startedAt, podTargets.includes(sampleTarget), stats)
        : 0;
      console.log(
        JSON.stringify({
          event: "progress",
          hpaReplicas,
          hpaDesired,
          loadTargets: podTargets.length,
          candidatePods: targets.length,
          warmedPods: targetChatOk.size,
          loadCompensation,
          effectiveCompensation: effectiveCompensation(startedAt),
          inflightPerPodPerGenerator: sampleLimit,
          perPodClusterInflight: sampleLimit * JOB_PARALLELISM,
          sampleTarget,
          chat: stats.chat,
          fail: stats.fail,
          elapsedSec: Math.round((Date.now() - startedAt) / 1000),
          atMaxReplicasHoldSec: atMaxSince == null ? 0 : Math.round((Date.now() - atMaxSince) / 1000),
        }),
      );
      lastLog = Date.now();
    }

    await sleep(1000);
  }

  forceStopLoad = true;
  for (const worker of targetWorkers.values()) worker.limit = 0;
  await Promise.all([...workerPromises.values()]);

  console.log(`done chat=${stats.chat} fail=${stats.fail} lastPodCount=${podTargets.length}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
