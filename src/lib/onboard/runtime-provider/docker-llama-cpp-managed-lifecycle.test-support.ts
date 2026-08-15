// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { LLAMA_CPP_PORT } from "../../inference/llama-cpp/contract";
import type { LlamaCppHostLocalLaunchContract } from "../../inference/llama-cpp/host-local-runtime";

export const MODEL_DIGEST = `sha256:${"a".repeat(64)}`;
export const IMAGE = `ghcr.io/nvidia/nemoclaw/llama-cpp-server@sha256:${"c".repeat(64)}`;
export const PROBE_IMAGE = `quay.io/curl/curl@sha256:${"d".repeat(64)}`;
export const RUNTIME_ID = "e".repeat(64);
export const NETWORK_ID = "7".repeat(64);
export const TRANSACTION_ID = "9".repeat(64);
export const RECEIPT_TARGET_SHA256 = "8".repeat(64);
export const MODEL_CONTENT = Buffer.alloc(64, 0x61);
export const MODEL_FILENAME = "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
export const REVISION = "f".repeat(40);

function canonical(value: unknown): unknown {
  return Array.isArray(value)
    ? value.map(canonical)
    : value !== null && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonical(nested)]),
        )
      : value;
}

export function invariant(condition: unknown, message: string): asserts condition {
  switch (Boolean(condition)) {
    case false:
      throw new Error(message);
  }
}

export function digest(value: unknown): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex")}`;
}

export function rawDigest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
}

export function contract(): LlamaCppHostLocalLaunchContract {
  return {
    model: {
      servedName: "nvidia-nemotron-3-nano-30b-a3b",
      file: {
        digest: MODEL_DIGEST,
        path: MODEL_FILENAME,
        sizeBytes: MODEL_CONTENT.length,
      },
    },
    policy: {
      egress: "disabled",
      modelDownloads: "disabled",
      modelSource: "verified-local",
    },
    runtime: {
      restartPolicy: "unless-stopped",
      gpu: {
        count: 1,
        cpuFallback: "reject",
        offload: "full",
        vendor: "nvidia",
      },
      resources: {
        memoryBytes: 51_539_607_552,
        pidsLimit: 256,
        writableStorageBytes: 1024,
      },
    },
    serve: {
      authentication: "bearer",
      batchSize: 2048,
      chatTemplate: "nemotron-v3-embedded",
      contextSize: 262_144,
      flashAttention: "enabled",
      idleSleepSeconds: -1,
      kvCache: { key: "f16", value: "f16" },
      limits: {
        maxRequestBodyBytes: 1_048_576,
        maxRequestHeaderBytes: 32_768,
        maxOutputTokens: 4_096,
        requestTimeoutSeconds: 900,
        shutdownTimeoutSeconds: 25,
      },
      requestGuard: { upstreamPort: 8_082 },
      microBatchSize: 512,
      port: LLAMA_CPP_PORT,
      protocol: "openai-completions",
      slots: 1,
      speculativeDecoding: "disabled",
    },
    surfaces: {
      agentMode: "disabled",
      mcpProxy: "disabled",
      multimodalProjection: "disabled",
      router: "disabled",
      serverTools: "disabled",
      slotInspection: "disabled",
      ui: "disabled",
    },
  };
}
