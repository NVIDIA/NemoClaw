// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LlamaCppOpenClawAgentQualificationPlan } from "./llama-cpp-openclaw-agent-qualification.mts";

export const QWEN_GPU_SHA_PATTERN = /^[a-f0-9]{40}$/u;
export const QWEN_GPU_MAX_COMMAND_BYTES = 16 * 1024 * 1024;
const OPENCLAW_IMAGE_PATTERN =
  /^ghcr\.io\/nvidia\/nemoclaw\/openclaw-sandbox@sha256:[a-f0-9]{64}$/u;
const SANDBOX_NAME = "nmc-lcpp-qwen-rtx";

export function qwenGpuAgentPlan(
  imageReference: string,
  sourceRevision: string,
): LlamaCppOpenClawAgentQualificationPlan {
  if (!OPENCLAW_IMAGE_PATTERN.test(imageReference) || !QWEN_GPU_SHA_PATTERN.test(sourceRevision)) {
    throw new Error("managed-image cohort returned an invalid OpenClaw identity");
  }
  return Object.freeze({
    agent: "openclaw",
    bounds: {
      commandTimeoutSeconds: 420,
      maxResponseBytes: QWEN_GPU_MAX_COMMAND_BYTES,
      maxStreamEvents: 512,
      maxTokens: 64,
    },
    execution: "enabled",
    expectations: { normal: "PONG" },
    fixture: {
      path: "/tmp/nemoclaw-llama-cpp-qwen-tool.txt",
      value: "LLAMA_CPP_QWEN_TOOL_OK",
    },
    image: { reference: imageReference, sourceRevision },
    probes: [
      "synchronous-chat",
      "streaming-chat",
      "agent-normal-turn",
      "agent-tool-call",
      "agent-tool-result-continuation",
      "agent-multi-turn",
    ],
    prompts: {
      normal: "Reply with exactly one word: PONG",
      tool: "Use the read tool to read /tmp/nemoclaw-llama-cpp-qwen-tool.txt. Reply with exactly the file contents: LLAMA_CPP_QWEN_TOOL_OK",
      continuation:
        "Repeat the exact value LLAMA_CPP_QWEN_TOOL_OK from the file you read in the prior turn.",
    },
    route: {
      api: "openai-completions",
      provider: "llama-cpp-local",
      routedBaseUrl: "https://inference.local/v1",
      upstreamBaseUrl: "http://host.openshell.internal:8081/v1",
    },
    runtimeProvider: "docker",
    sandbox: { gpuAccess: "disabled", name: SANDBOX_NAME },
    sessions: {
      normal: "llama-cpp-qwen-openclaw-normal",
      tool: "llama-cpp-qwen-openclaw-tool",
    },
    tool: { name: "read" },
  } satisfies LlamaCppOpenClawAgentQualificationPlan);
}

export function validateQwenGpuStartupLog(log: string): {
  readonly offloadedLayers: number;
  readonly totalLayers: number;
} {
  if (Buffer.byteLength(log) < 1 || Buffer.byteLength(log) > QWEN_GPU_MAX_COMMAND_BYTES) {
    throw new Error("Qwen llama.cpp startup evidence is missing or exceeds its bound");
  }
  if (
    /no usable GPU|gpu-layers[^\n]*ignored|compiled without[^\n]*GPU|CPU fallback|fallback to CPU|falling back to CPU/iu.test(
      log,
    )
  ) {
    throw new Error("Qwen llama.cpp startup reports a rejected GPU or CPU fallback");
  }
  const matches = [
    ...log.matchAll(/offloaded\s+([1-9][0-9]*)\/([1-9][0-9]*)\s+layers?\s+to\s+GPU/giu),
  ];
  if (matches.length < 1) throw new Error("Qwen llama.cpp startup is missing GPU offload evidence");
  const counts = matches.map((match) => ({
    offloadedLayers: Number.parseInt(match[1] ?? "0", 10),
    totalLayers: Number.parseInt(match[2] ?? "0", 10),
  }));
  if (counts.some(({ offloadedLayers, totalLayers }) => offloadedLayers !== totalLayers)) {
    throw new Error("Qwen llama.cpp startup reports partial GPU offload");
  }
  const uniqueCounts = new Set(counts.map(({ offloadedLayers }) => offloadedLayers));
  if (uniqueCounts.size !== 1) {
    throw new Error("Qwen llama.cpp startup reports inconsistent GPU offload counts");
  }
  return counts[0] as { offloadedLayers: number; totalLayers: number };
}
