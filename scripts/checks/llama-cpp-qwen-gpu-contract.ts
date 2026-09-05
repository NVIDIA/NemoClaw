// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import type { LlamaCppOpenClawAgentQualificationPlan } from "./llama-cpp-openclaw-agent-qualification.mts";

export const QWEN_GPU_SHA_PATTERN = /^[a-f0-9]{40}$/u;
export const QWEN_GPU_MAX_COMMAND_BYTES = 16 * 1024 * 1024;
export const QWEN_GPU_GATEWAY_NETWORK_PATTERN = /^nemoclaw-managed-pr-[1-9][0-9]*-[a-z0-9]+$/u;
export const QWEN_GPU_RECIPE_ID = "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1";
const QWEN_GPU_MAX_DIAGNOSTIC_BYTES = 4 * 1024;
const OPENCLAW_IMAGE_PATTERN =
  /^ghcr\.io\/nvidia\/nemoclaw\/openclaw-sandbox@sha256:[a-f0-9]{64}$/u;
export const QWEN_GPU_SANDBOX_NAME = "nmc-lcpp-qwen-rtx";

export function qwenGpuRecipeBinding(recipeRef: unknown): typeof QWEN_GPU_RECIPE_ID {
  if (recipeRef !== QWEN_GPU_RECIPE_ID) {
    throw new Error("N1x WSL Qwen preset does not bind the expected llama.cpp recipe");
  }
  return QWEN_GPU_RECIPE_ID;
}

export function qwenGpuProbeDiagnostic(
  label: string,
  result: { readonly status: number | null; readonly stdout: string; readonly stderr: string },
  forbiddenValues: readonly string[],
): {
  readonly label: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
} {
  const redact = (value: string): string => {
    let redacted = value;
    for (const forbidden of [...forbiddenValues].sort(
      (left, right) => right.length - left.length,
    )) {
      if (forbidden) redacted = redacted.replaceAll(forbidden, "<REDACTED>");
    }
    return redacted
      .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer <REDACTED>")
      .replace(/\b([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD))=([^\s]*)/giu, "$1=<REDACTED>")
      .slice(-QWEN_GPU_MAX_DIAGNOSTIC_BYTES);
  };
  return {
    label,
    status: result.status,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
  };
}

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
      maxStreamEvents: 2048,
      maxTokens: 1024,
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
    sandbox: { gpuAccess: "disabled", name: QWEN_GPU_SANDBOX_NAME },
    sessions: {
      normal: "llama-cpp-qwen-openclaw-normal",
      tool: "llama-cpp-qwen-openclaw-tool",
    },
    tool: { name: "read" },
  } satisfies LlamaCppOpenClawAgentQualificationPlan);
}

export function validateQwenGpuProcessEvidence(
  containerProcesses: string,
  computeApplications: string,
  modelSizeBytes: number,
): {
  readonly processName: string;
  readonly usedGpuMemoryMiB: number;
  readonly minimumFullOffloadMemoryMiB: number;
} {
  if (!Number.isSafeInteger(modelSizeBytes) || modelSizeBytes < 1) {
    throw new Error("Qwen GGUF size is invalid");
  }
  const llamaProcesses = containerProcesses
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/u))
    .filter(([, processName]) => processName === "llama-server");
  if (llamaProcesses.length !== 1) {
    throw new Error("Qwen container does not expose one exact llama-server process");
  }
  const llamaPid = Number(llamaProcesses[0]?.[0]);
  if (!Number.isSafeInteger(llamaPid) || llamaPid < 1) {
    throw new Error("Qwen llama-server process identity is invalid");
  }
  const matchingApplications = computeApplications
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(",").map((value) => value.trim()))
    .filter(
      ([pid, processName]) => Number(pid) === llamaPid && /llama-server$/u.test(processName ?? ""),
    );
  if (matchingApplications.length !== 1) {
    throw new Error("Qwen llama-server is not the exact NVIDIA compute process");
  }
  const processName = matchingApplications[0]?.[1] ?? "";
  const usedGpuMemoryMiB = Number(matchingApplications[0]?.[2]);
  const minimumFullOffloadMemoryMiB = Math.floor((modelSizeBytes / 1024 ** 2) * 0.75);
  if (!Number.isSafeInteger(usedGpuMemoryMiB) || usedGpuMemoryMiB < minimumFullOffloadMemoryMiB) {
    throw new Error("Qwen llama-server GPU memory is below the full-offload threshold");
  }
  return { processName, usedGpuMemoryMiB, minimumFullOffloadMemoryMiB };
}
