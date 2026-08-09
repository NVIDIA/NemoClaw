// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import YAML from "yaml";

export {
  LLAMA_CPP_DGX_SPARK_AGENT_QUALIFICATION_PATH,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
} from "./llama-cpp-dgx-spark-qualification-paths.mts";

export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID =
  "llama-cpp-dgx-spark-qualification" as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND =
  "nemoclaw-llama-cpp-dgx-spark-qualification-v1" as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE = "dgx-spark-gb10-single" as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM = "linux/arm64" as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE =
  "llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1" as const;
export const LLAMA_CPP_DGX_SPARK_MODEL_ID = "unsloth/Nemotron-3-Nano-30B-A3B-GGUF" as const;
export const LLAMA_CPP_DGX_SPARK_MODEL_DIGEST =
  "sha256:627f5b04aedc97f967332f331bd75b7a4ed2f33ca83e6ee74b44235cc1887890" as const;
export const LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID = "nvidia-nemotron-3-nano-30b-a3b" as const;
export const LLAMA_CPP_DGX_SPARK_SOURCE_REVISION =
  "22dc605c4ead20e36f447cc67b55ef87e523bd55" as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY =
  "localhost:5000/nemoclaw-llama-cpp-dgx-spark/llama-cpp-server" as const;
export const LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY =
  "ghcr.io/nvidia/nemoclaw/llama-cpp-server" as const;
export const LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY =
  "https://github.com/ggml-org/llama.cpp" as const;
export const LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256 =
  "sha256:975f70723e053785e894f4e1d9cf770f2f1a7bc762fd3af174ff5635014108b6" as const;
export const LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE =
  "docker.io/nvidia/cuda@sha256:ef2203909e80b8b976cfc672f7e2ae2b00bc0e25c404ee86d89e10a3802f1c52" as const;
export const LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE =
  "docker.io/nvidia/cuda@sha256:789e629e49401647e22b7054ae9c6c4f6427dba68010ba428deb4cc6b063676e" as const;
export const LLAMA_CPP_DGX_SPARK_TOOL_IMAGE =
  "nvcr.io/nvidia/vllm@sha256:94e21552f644e0c1627464ba89d2f7a4ce7442e196f72afa0bb5d7fba23cbb03" as const;
export const LLAMA_CPP_DGX_SPARK_MINIMUM_DRIVER_VERSION = "580.65.06" as const;
export const LLAMA_CPP_DGX_SPARK_PROTOCOL_PROBES = [
  "health",
  "models",
  "properties",
  "metrics",
  "disabled-surfaces",
  "synchronous-chat",
  "streaming-chat",
  "usage",
  "structured-output",
  "tool-call",
  "tool-result-continuation",
  "context-window",
  "authentication",
  "malformed-request",
  "cancellation",
  "client-timeout",
] as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES = [
  ...LLAMA_CPP_DGX_SPARK_PROTOCOL_PROBES,
  "log-redaction",
] as const;
export const LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES = [
  "llamacpp:prompt_tokens_total",
  "llamacpp:prompt_seconds_total",
  "llamacpp:prompt_tokens_seconds",
  "llamacpp:tokens_predicted_total",
  "llamacpp:tokens_predicted_seconds_total",
  "llamacpp:predicted_tokens_seconds",
  "llamacpp:requests_processing",
  "llamacpp:requests_deferred",
  "llamacpp:n_tokens_max",
  "llamacpp:n_decode_total",
  "llamacpp:n_busy_slots_per_decode",
] as const;
export const LLAMA_CPP_DGX_SPARK_AGENT_PROBES = [
  "synchronous-chat",
  "streaming-chat",
  "agent-normal-turn",
  "agent-tool-call",
  "agent-tool-result-continuation",
  "agent-multi-turn",
] as const;
export const LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE =
  "ghcr.io/nvidia/nemoclaw/openclaw-sandbox@sha256:3648441718cdd6c2bc4c8fe39fa0d04d3931656b2063af34215cc51841cd0d5e" as const;
export const LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION =
  "eb1d2f5700393892f227ac9fd56f485fc6718bce" as const;
export const LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX = "nmc-lcpp-oc" as const;
export const LLAMA_CPP_DGX_SPARK_OPENCLAW_NORMAL_PROMPT =
  "Reply with exactly one word: PONG" as const;
export const LLAMA_CPP_DGX_SPARK_OPENCLAW_TOOL_PROMPT =
  "Use the read tool to read /tmp/nemoclaw-llama-cpp-tool.txt. Reply with exactly the file contents: LLAMA_CPP_OPENCLAW_TOOL_OK" as const;
export const LLAMA_CPP_DGX_SPARK_OPENCLAW_CONTINUATION_PROMPT =
  "Repeat the exact value LLAMA_CPP_OPENCLAW_TOOL_OK from the file you read in the prior turn." as const;

const LLAMA_CPP_DGX_SPARK_CLIENT_TIMEOUT_RANGE = {
  maximum: 10_000,
  minimum: 10,
} as const;
const LLAMA_CPP_DGX_SPARK_CONTEXT_SIZE_RANGE = {
  maximum: 1024 * 1024,
  minimum: 1024,
} as const;

export const LLAMA_CPP_DGX_SPARK_SHA_PATTERN = /^[a-f0-9]{40}$/u;
export const LLAMA_CPP_DGX_SPARK_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
export const LLAMA_CPP_DGX_SPARK_RUNNER_PATTERN =
  /^linux-arm64-gpu-dgx-spark-gb10-[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
export const LLAMA_CPP_DGX_SPARK_ENVIRONMENT_PATTERN =
  /^approve-dgx-spark-[a-z0-9](?:[a-z0-9-]{0,109}[a-z0-9])?$/u;
export const LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN =
  /^\/(?:[A-Za-z0-9._-]+\/)*Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL\.gguf$/u;
export const LLAMA_CPP_DGX_SPARK_GPU_PATTERN = /^NVIDIA GB10$/u;
export const LLAMA_CPP_DGX_SPARK_DRIVER_PATTERN = /^[0-9]{3,4}\.[0-9]{1,3}\.[0-9]{1,3}$/u;

export type LlamaCppDgxSparkQualificationActivation = {
  readonly contractVersion: 1;
  readonly jobId: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID;
  readonly platform: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM;
  readonly profile: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE;
};

export type LlamaCppDgxSparkQualificationPlan = {
  readonly environment: string | null;
  readonly execution: "disabled" | "enabled";
  readonly gpu: {
    readonly cpuFallback: "reject";
    readonly fullOffload: true;
    readonly vendor: "nvidia";
  };
  readonly model: {
    readonly digest: typeof LLAMA_CPP_DGX_SPARK_MODEL_DIGEST;
    readonly hostPath: string | null;
    readonly id: typeof LLAMA_CPP_DGX_SPARK_MODEL_ID;
  };
  readonly platform: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM;
  readonly probeBounds: {
    readonly cancellationMaxTokens: number;
    readonly clientTimeoutMilliseconds: number;
    readonly maxResponseBytes: number;
    readonly maxStreamEvents: number;
    readonly maxTokens: {
      readonly streamingChat: number;
      readonly structuredOutput: number;
      readonly synchronousChat: number;
      readonly toolCall: number;
      readonly toolResultContinuation: number;
    };
  };
  readonly probes: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES;
  readonly profile: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE;
  readonly recipeRef: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE;
  readonly required: true;
  readonly runner: string | null;
};

export type LlamaCppDgxSparkQualificationEvidenceIdentity = {
  readonly baseSha: string;
  readonly headSha: string;
  readonly runAttempt: number;
  readonly runId: number;
  readonly workflowSha: string;
};

export type LlamaCppDgxSparkExecutionPlan = {
  readonly contractVersion: 1;
  readonly imageBuild: {
    readonly backendDirectory: "/opt/llama.cpp/lib";
    readonly compiler: {
      readonly c: "gcc-14";
      readonly cudaHostCxx: "g++-14";
      readonly cxx: "g++-14";
    };
    readonly cuda: {
      readonly developmentBase: typeof LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE;
      readonly runtimeBase: typeof LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE;
    };
    readonly platform: {
      readonly cudaArchitectures: "121a-real";
      readonly platform: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM;
    };
    readonly repository: typeof LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY;
    readonly runtime: {
      readonly gid: number;
      readonly port: 8081;
      readonly uid: number;
    };
    readonly source: {
      readonly archiveSha256: typeof LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256;
      readonly repository: typeof LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY;
      readonly revision: typeof LLAMA_CPP_DGX_SPARK_SOURCE_REVISION;
    };
  };
  readonly qualification: {
    readonly agentQualification: LlamaCppDgxSparkAgentQualificationPlan;
    readonly probeBounds: LlamaCppDgxSparkQualificationPlan["probeBounds"];
    readonly probes: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES;
  };
  readonly recipe: {
    readonly capabilities: {
      readonly agents: readonly [];
      readonly embeddings: false;
      readonly multimodal: false;
      readonly parallelToolCalls: false;
      readonly protocols: readonly ["openai-completions"];
      readonly reranking: false;
      readonly responsesApi: false;
      readonly streaming: true;
      readonly structuredOutputs: true;
      readonly toolCalls: true;
    };
    readonly id: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE;
    readonly model: {
      readonly acquisition: {
        readonly downloaderImage: typeof LLAMA_CPP_DGX_SPARK_TOOL_IMAGE;
      };
      readonly file: {
        readonly digest: typeof LLAMA_CPP_DGX_SPARK_MODEL_DIGEST;
        readonly format: "gguf";
        readonly license: "NVIDIA-Open-Model-License";
        readonly path: "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
        readonly quantization: "UD-Q4_K_XL";
        readonly sizeBytes: number;
      };
      readonly id: typeof LLAMA_CPP_DGX_SPARK_MODEL_ID;
      readonly revision: "9ad8b366c308f931b2a96b9306f0b41aef9cd405";
      readonly servedName: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
    };
    readonly policy: {
      readonly egress: "disabled";
      readonly modelDownloads: "disabled";
      readonly modelSource: "verified-local";
    };
    readonly readiness: {
      readonly contractRef: "llama-cpp.server-readiness/v1";
      readonly expectedModel: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly probeImage: typeof LLAMA_CPP_DGX_SPARK_TOOL_IMAGE;
      readonly probes: {
        readonly health: true;
        readonly metrics: true;
        readonly models: true;
        readonly properties: true;
      };
      readonly timeoutSeconds: number;
    };
    readonly runtime: {
      readonly restartPolicy: "unless-stopped";
      readonly cuda: {
        readonly baseImage: typeof LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE;
        readonly minimumDriverVersion: string;
      };
      readonly gpu: {
        readonly count: 1;
        readonly cpuFallback: "reject";
        readonly offload: "full";
        readonly vendor: "nvidia";
      };
      readonly resources: {
        readonly memoryBytes: number;
        readonly pidsLimit: number;
        readonly writableStorageBytes: number;
      };
    };
    readonly serve: {
      readonly authentication: "bearer";
      readonly batchSize: number;
      readonly chatTemplate: "nemotron-v3-embedded";
      readonly contextSize: number;
      readonly flashAttention: "enabled";
      readonly idleSleepSeconds: -1;
      readonly kvCache: {
        readonly key: "f16" | "q8_0" | "q4_0";
        readonly value: "f16" | "q8_0" | "q4_0";
      };
      readonly limits: {
        readonly requestTimeoutSeconds: number;
      };
      readonly microBatchSize: number;
      readonly port: 8081;
      readonly protocol: "openai-completions";
      readonly slots: 1;
      readonly speculativeDecoding: "disabled";
    };
    readonly server: {
      readonly source: {
        readonly repository: "ggml-org/llama.cpp";
        readonly revision: typeof LLAMA_CPP_DGX_SPARK_SOURCE_REVISION;
      };
      readonly technology: "llama.cpp";
    };
    readonly surfaces: {
      readonly agentMode: "disabled";
      readonly mcpProxy: "disabled";
      readonly multimodalProjection: "disabled";
      readonly router: "disabled";
      readonly serverTools: "disabled";
      readonly slotInspection: "disabled";
      readonly ui: "disabled";
    };
  };
};

export type LlamaCppDgxSparkAgentQualificationPlan = {
  readonly agent: "openclaw";
  readonly bounds: {
    readonly commandTimeoutSeconds: number;
    readonly maxResponseBytes: number;
    readonly maxStreamEvents: number;
    readonly maxTokens: number;
  };
  readonly execution: "disabled" | "enabled";
  readonly fixture: {
    readonly path: "/tmp/nemoclaw-llama-cpp-tool.txt";
    readonly value: "LLAMA_CPP_OPENCLAW_TOOL_OK";
  };
  readonly image: {
    readonly reference: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE;
    readonly sourceRevision: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION;
  };
  readonly expectations: {
    readonly normal: "PONG";
  };
  readonly probes: typeof LLAMA_CPP_DGX_SPARK_AGENT_PROBES;
  readonly prompts: {
    readonly continuation: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_CONTINUATION_PROMPT;
    readonly normal: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_NORMAL_PROMPT;
    readonly tool: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_TOOL_PROMPT;
  };
  readonly route: {
    readonly api: "openai-completions";
    readonly provider: "llama-cpp-local";
    readonly routedBaseUrl: "https://inference.local/v1";
    readonly upstreamBaseUrl: "http://host.openshell.internal:8081/v1";
  };
  readonly runtimeProvider: "docker";
  readonly sandbox: {
    readonly gpuAccess: "disabled";
    readonly name: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX;
  };
  readonly sessions: {
    readonly normal: "llama-cpp-openclaw-normal";
    readonly tool: "llama-cpp-openclaw-tool";
  };
  readonly tool: {
    readonly name: "read";
  };
};

export type LlamaCppDgxSparkQualificationReceipt = {
  readonly agentQualification:
    | { readonly execution: "disabled" }
    | {
        readonly agent: "openclaw";
        readonly cleanup: {
          readonly gatewayRemoved: true;
          readonly networkRemoved: true;
          readonly sandboxRemoved: true;
          readonly stateRemoved: true;
        };
        readonly execution: "enabled";
        readonly image: {
          readonly reference: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE;
          readonly sourceRevision: typeof LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION;
        };
        readonly model: {
          readonly chatTemplate: "nemotron-v3-embedded";
          readonly id: typeof LLAMA_CPP_DGX_SPARK_MODEL_ID;
          readonly quantization: "UD-Q4_K_XL";
          readonly servedName: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
        };
        readonly platform: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM;
        readonly probes: {
          readonly agentMultiTurn: true;
          readonly agentNormalTurn: true;
          readonly agentToolCall: {
            readonly argumentsValid: true;
            readonly name: "read";
          };
          readonly agentToolResultContinuation: true;
          readonly streamingChat: {
            readonly done: true;
            readonly events: number;
          };
          readonly synchronousChat: true;
        };
        readonly route: {
          readonly api: "openai-completions";
          readonly provider: "llama-cpp-local";
          readonly routedBaseUrl: "https://inference.local/v1";
          readonly upstreamBaseUrl: "http://host.openshell.internal:8081/v1";
        };
        readonly runtimeProvider: "docker";
      };
  readonly baseSha: string;
  readonly cleanup: {
    readonly containerRemoved: true;
    readonly credentialsRemoved: true;
    readonly listenerClosed: true;
    readonly registryRemoved: true;
  };
  readonly execution: {
    readonly cpuFallback: false;
    readonly cpuWarning: false;
    readonly fullOffload: true;
    readonly offloadedLayers: number;
    readonly totalLayers: number;
  };
  readonly headSha: string;
  readonly host: {
    readonly architecture: "arm64";
    readonly driverVersion: string;
    readonly gpuName: "NVIDIA GB10";
    readonly profile: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE;
  };
  readonly image: {
    readonly digest: string;
    readonly platform: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM;
    readonly reference: string;
    readonly sourceRevision: typeof LLAMA_CPP_DGX_SPARK_SOURCE_REVISION;
  };
  readonly kind: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND;
  readonly model: {
    readonly digest: typeof LLAMA_CPP_DGX_SPARK_MODEL_DIGEST;
    readonly id: typeof LLAMA_CPP_DGX_SPARK_MODEL_ID;
  };
  readonly probes: {
    readonly authentication: {
      readonly httpStatus: 401;
      readonly ok: true;
    };
    readonly cancellation: {
      readonly aborted: true;
      readonly ok: true;
      readonly recovered: true;
    };
    readonly contextWindow: {
      readonly contextSize: number;
      readonly ok: true;
      readonly slots: 1;
    };
    readonly disabledSurfaces: {
      readonly corsProxyHttpStatus: 403;
      readonly multimodal: false;
      readonly ok: true;
      readonly propertiesMutationHttpStatus: 501;
      readonly routerHttpStatus: 404;
      readonly slotsHttpStatus: 501;
      readonly toolsHttpStatus: 403;
      readonly uiHttpStatus: 404;
    };
    readonly health: {
      readonly httpStatus: 200;
      readonly ok: true;
    };
    readonly logRedaction: {
      readonly ok: true;
    };
    readonly malformedRequest: {
      readonly httpStatus: 400;
      readonly ok: true;
    };
    readonly models: {
      readonly httpStatus: 200;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly ok: true;
    };
    readonly metrics: {
      readonly httpStatus: 200;
      readonly ok: true;
      readonly requiredSeries: number;
      readonly unauthenticatedHttpStatus: 401;
    };
    readonly properties: {
      readonly httpStatus: 200;
      readonly metrics: true;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly modelPath: "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
      readonly ok: true;
    };
    readonly clientTimeout: {
      readonly aborted: true;
      readonly limitMilliseconds: number;
      readonly ok: true;
      readonly recovered: true;
    };
    readonly streamingChat: {
      readonly done: true;
      readonly events: number;
      readonly httpStatus: 200;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly ok: true;
    };
    readonly structuredOutput: {
      readonly httpStatus: 200;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly ok: true;
      readonly schemaMatched: true;
    };
    readonly synchronousChat: {
      readonly httpStatus: 200;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly ok: true;
    };
    readonly toolCall: {
      readonly argumentsValid: true;
      readonly httpStatus: 200;
      readonly name: "get_current_weather";
      readonly ok: true;
    };
    readonly toolResultContinuation: {
      readonly httpStatus: 200;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly ok: true;
    };
    readonly usage: {
      readonly completionTokens: number;
      readonly ok: true;
      readonly promptTokens: number;
      readonly totalTokens: number;
    };
  };
  readonly repository: "NVIDIA/NemoClaw";
  readonly run: {
    readonly attempt: number;
    readonly id: number;
  };
  readonly workflowSha: string;
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function requireExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function parseActivationYaml(source: string): unknown {
  if (
    source.length === 0 ||
    source.length > 4096 ||
    /[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(source)
  ) {
    throw new Error(
      "llama.cpp DGX Spark activation YAML is empty, exceeds 4096 bytes, or contains control characters",
    );
  }
  const document = YAML.parseDocument(source, {
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.warnings.length > 0) {
    throw new Error("llama.cpp DGX Spark activation YAML is invalid");
  }
  try {
    return document.toJS({ maxAliasCount: 0 });
  } catch {
    throw new Error("llama.cpp DGX Spark activation YAML is invalid");
  }
}

function safeInteger(value: unknown, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function boundedInteger(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return Number(value);
}

function parseProtocolProbeBounds(
  value: unknown,
): LlamaCppDgxSparkQualificationPlan["probeBounds"] {
  const probeBounds = record(value, "llama.cpp DGX Spark qualification probe bounds");
  requireExactKeys(
    probeBounds,
    [
      "cancellationMaxTokens",
      "clientTimeoutMilliseconds",
      "maxResponseBytes",
      "maxStreamEvents",
      "maxTokens",
    ],
    "qualification probe bounds",
  );
  const maxTokens = record(probeBounds.maxTokens, "qualification probe token bounds");
  requireExactKeys(
    maxTokens,
    ["streamingChat", "structuredOutput", "synchronousChat", "toolCall", "toolResultContinuation"],
    "qualification probe token bounds",
  );
  return {
    cancellationMaxTokens: boundedInteger(
      probeBounds.cancellationMaxTokens,
      "qualification cancellation token bound",
      128,
      32_768,
    ),
    clientTimeoutMilliseconds: boundedInteger(
      probeBounds.clientTimeoutMilliseconds,
      "qualification client timeout",
      LLAMA_CPP_DGX_SPARK_CLIENT_TIMEOUT_RANGE.minimum,
      LLAMA_CPP_DGX_SPARK_CLIENT_TIMEOUT_RANGE.maximum,
    ),
    maxResponseBytes: boundedInteger(
      probeBounds.maxResponseBytes,
      "qualification response byte bound",
      64 * 1024,
      64 * 1024 * 1024,
    ),
    maxStreamEvents: boundedInteger(
      probeBounds.maxStreamEvents,
      "qualification stream event bound",
      8,
      4096,
    ),
    maxTokens: {
      streamingChat: boundedInteger(
        maxTokens.streamingChat,
        "qualification streaming token bound",
        1,
        512,
      ),
      structuredOutput: boundedInteger(
        maxTokens.structuredOutput,
        "qualification structured-output token bound",
        1,
        512,
      ),
      synchronousChat: boundedInteger(
        maxTokens.synchronousChat,
        "qualification synchronous token bound",
        1,
        256,
      ),
      toolCall: boundedInteger(maxTokens.toolCall, "qualification tool-call token bound", 1, 1024),
      toolResultContinuation: boundedInteger(
        maxTokens.toolResultContinuation,
        "qualification tool-result token bound",
        1,
        512,
      ),
    },
  };
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function parseAgentQualification(value: unknown): LlamaCppDgxSparkAgentQualificationPlan {
  const qualification = record(value, "llama.cpp DGX Spark agent qualification");
  requireExactKeys(
    qualification,
    [
      "agent",
      "bounds",
      "execution",
      "expectations",
      "fixture",
      "image",
      "probes",
      "prompts",
      "route",
      "runtimeProvider",
      "sandbox",
      "sessions",
      "tool",
    ],
    "llama.cpp DGX Spark agent qualification",
  );
  const bounds = record(qualification.bounds, "agent qualification bounds");
  requireExactKeys(
    bounds,
    ["commandTimeoutSeconds", "maxResponseBytes", "maxStreamEvents", "maxTokens"],
    "agent qualification bounds",
  );
  const fixture = record(qualification.fixture, "agent qualification fixture");
  requireExactKeys(fixture, ["path", "value"], "agent qualification fixture");
  const expectations = record(qualification.expectations, "agent qualification expectations");
  requireExactKeys(expectations, ["normal"], "agent qualification expectations");
  const image = record(qualification.image, "agent qualification image");
  requireExactKeys(image, ["reference", "sourceRevision"], "agent qualification image");
  const prompts = record(qualification.prompts, "agent qualification prompts");
  requireExactKeys(prompts, ["continuation", "normal", "tool"], "agent qualification prompts");
  const route = record(qualification.route, "agent qualification route");
  requireExactKeys(
    route,
    ["api", "provider", "routedBaseUrl", "upstreamBaseUrl"],
    "agent qualification route",
  );
  const sandbox = record(qualification.sandbox, "agent qualification sandbox");
  requireExactKeys(sandbox, ["gpuAccess", "name"], "agent qualification sandbox");
  const sessions = record(qualification.sessions, "agent qualification sessions");
  requireExactKeys(sessions, ["normal", "tool"], "agent qualification sessions");
  const tool = record(qualification.tool, "agent qualification tool");
  requireExactKeys(tool, ["name"], "agent qualification tool");

  const execution = qualification.execution;
  const normalPrompt = boundedText(prompts.normal, "agent qualification normal prompt", 512);
  const toolPrompt = boundedText(prompts.tool, "agent qualification tool prompt", 1024);
  const continuationPrompt = boundedText(
    prompts.continuation,
    "agent qualification continuation prompt",
    512,
  );
  if (
    (execution !== "disabled" && execution !== "enabled") ||
    qualification.agent !== "openclaw" ||
    qualification.runtimeProvider !== "docker" ||
    image.reference !== LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE ||
    image.sourceRevision !== LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION ||
    JSON.stringify(qualification.probes) !== JSON.stringify(LLAMA_CPP_DGX_SPARK_AGENT_PROBES) ||
    fixture.path !== "/tmp/nemoclaw-llama-cpp-tool.txt" ||
    fixture.value !== "LLAMA_CPP_OPENCLAW_TOOL_OK" ||
    expectations.normal !== "PONG" ||
    tool.name !== "read" ||
    route.provider !== "llama-cpp-local" ||
    route.api !== "openai-completions" ||
    route.routedBaseUrl !== "https://inference.local/v1" ||
    route.upstreamBaseUrl !== "http://host.openshell.internal:8081/v1" ||
    sandbox.name !== LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX ||
    sandbox.gpuAccess !== "disabled" ||
    sessions.normal !== "llama-cpp-openclaw-normal" ||
    sessions.tool !== "llama-cpp-openclaw-tool" ||
    normalPrompt !== LLAMA_CPP_DGX_SPARK_OPENCLAW_NORMAL_PROMPT ||
    toolPrompt !== LLAMA_CPP_DGX_SPARK_OPENCLAW_TOOL_PROMPT ||
    continuationPrompt !== LLAMA_CPP_DGX_SPARK_OPENCLAW_CONTINUATION_PROMPT
  ) {
    throw new Error("compiled llama.cpp DGX Spark agent qualification is invalid");
  }
  return {
    agent: "openclaw",
    bounds: {
      commandTimeoutSeconds: boundedInteger(
        bounds.commandTimeoutSeconds,
        "agent qualification command timeout",
        30,
        900,
      ),
      maxResponseBytes: boundedInteger(
        bounds.maxResponseBytes,
        "agent qualification response bound",
        64 * 1024,
        64 * 1024 * 1024,
      ),
      maxStreamEvents: boundedInteger(
        bounds.maxStreamEvents,
        "agent qualification stream event bound",
        8,
        4096,
      ),
      maxTokens: boundedInteger(bounds.maxTokens, "agent qualification token bound", 1, 512),
    },
    execution,
    expectations: { normal: "PONG" },
    fixture: {
      path: "/tmp/nemoclaw-llama-cpp-tool.txt",
      value: "LLAMA_CPP_OPENCLAW_TOOL_OK",
    },
    image: {
      reference: LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE,
      sourceRevision: LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION,
    },
    probes: LLAMA_CPP_DGX_SPARK_AGENT_PROBES,
    prompts: {
      continuation: LLAMA_CPP_DGX_SPARK_OPENCLAW_CONTINUATION_PROMPT,
      normal: LLAMA_CPP_DGX_SPARK_OPENCLAW_NORMAL_PROMPT,
      tool: LLAMA_CPP_DGX_SPARK_OPENCLAW_TOOL_PROMPT,
    },
    route: {
      api: "openai-completions",
      provider: "llama-cpp-local",
      routedBaseUrl: "https://inference.local/v1",
      upstreamBaseUrl: "http://host.openshell.internal:8081/v1",
    },
    runtimeProvider: "docker",
    sandbox: { gpuAccess: "disabled", name: LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX },
    sessions: {
      normal: "llama-cpp-openclaw-normal",
      tool: "llama-cpp-openclaw-tool",
    },
    tool: { name: "read" },
  };
}

function requiredSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function requiredDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !LLAMA_CPP_DGX_SPARK_DIGEST_PATTERN.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function driverVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split(".").map(Number);
  const minimumParts = minimum.split(".").map(Number);
  for (let index = 0; index < minimumParts.length; index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function parseInfrastructure(
  value: Record<string, unknown>,
  execution: "disabled" | "enabled",
): {
  environment: string | null;
  hostPath: string | null;
  runner: string | null;
} {
  const environment = value.environment;
  const runner = value.runner;
  const model = record(value.model, "llama.cpp DGX Spark qualification model");
  const hostPath = model.hostPath;
  const unset = environment === null && runner === null && hostPath === null;
  const complete =
    typeof environment === "string" &&
    LLAMA_CPP_DGX_SPARK_ENVIRONMENT_PATTERN.test(environment) &&
    typeof runner === "string" &&
    LLAMA_CPP_DGX_SPARK_RUNNER_PATTERN.test(runner) &&
    typeof hostPath === "string" &&
    LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN.test(hostPath) &&
    !hostPath.split("/").some((segment) => segment === "." || segment === "..");
  if ((!unset && !complete) || (execution === "enabled" && !complete)) {
    throw new Error("llama.cpp DGX Spark qualification infrastructure is incomplete");
  }
  return {
    environment: environment as string | null,
    hostPath: hostPath as string | null,
    runner: runner as string | null,
  };
}

export function parseLlamaCppDgxSparkQualificationActivation(
  value: unknown,
): LlamaCppDgxSparkQualificationActivation {
  const activation = record(
    typeof value === "string" ? parseActivationYaml(value) : value,
    "llama.cpp DGX Spark activation",
  );
  requireExactKeys(
    activation,
    ["contractVersion", "jobId", "platform", "profile"],
    "llama.cpp DGX Spark activation",
  );
  if (
    activation.contractVersion !== 1 ||
    activation.jobId !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID ||
    activation.platform !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM ||
    activation.profile !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE
  ) {
    throw new Error("llama.cpp DGX Spark activation contract is invalid");
  }
  return {
    contractVersion: 1,
    jobId: LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
    profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
  };
}

export function parseLlamaCppDgxSparkQualificationPlan(
  value: unknown,
): LlamaCppDgxSparkQualificationPlan {
  const plan = record(value, "llama.cpp DGX Spark qualification plan");
  requireExactKeys(
    plan,
    [
      "environment",
      "execution",
      "gpu",
      "model",
      "platform",
      "probeBounds",
      "probes",
      "profile",
      "recipeRef",
      "required",
      "runner",
    ],
    "llama.cpp DGX Spark qualification plan",
  );
  if (plan.execution !== "disabled" && plan.execution !== "enabled") {
    throw new Error("llama.cpp DGX Spark qualification execution is invalid");
  }
  const infrastructure = parseInfrastructure(plan, plan.execution);
  const gpu = record(plan.gpu, "llama.cpp DGX Spark qualification GPU");
  requireExactKeys(gpu, ["cpuFallback", "fullOffload", "vendor"], "qualification GPU");
  const model = record(plan.model, "llama.cpp DGX Spark qualification model");
  requireExactKeys(model, ["digest", "hostPath", "id"], "qualification model");
  const parsedProbeBounds = parseProtocolProbeBounds(plan.probeBounds);
  if (
    plan.required !== true ||
    plan.profile !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE ||
    plan.recipeRef !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE ||
    plan.platform !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM ||
    gpu.vendor !== "nvidia" ||
    gpu.fullOffload !== true ||
    gpu.cpuFallback !== "reject" ||
    model.id !== LLAMA_CPP_DGX_SPARK_MODEL_ID ||
    model.digest !== LLAMA_CPP_DGX_SPARK_MODEL_DIGEST ||
    JSON.stringify(plan.probes) !== JSON.stringify(LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES)
  ) {
    throw new Error("llama.cpp DGX Spark qualification plan is invalid");
  }
  return {
    environment: infrastructure.environment,
    execution: plan.execution,
    gpu: { cpuFallback: "reject", fullOffload: true, vendor: "nvidia" },
    model: {
      digest: LLAMA_CPP_DGX_SPARK_MODEL_DIGEST,
      hostPath: infrastructure.hostPath,
      id: LLAMA_CPP_DGX_SPARK_MODEL_ID,
    },
    platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
    probeBounds: parsedProbeBounds,
    probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
    profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
    recipeRef: LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
    required: true,
    runner: infrastructure.runner,
  };
}

export function parseLlamaCppDgxSparkExecutionPlan(
  value: unknown,
  expectedSha256?: unknown,
): LlamaCppDgxSparkExecutionPlan {
  const plan = record(value, "compiled llama.cpp DGX Spark qualification plan");
  requireExactKeys(
    plan,
    ["contractVersion", "imageBuild", "qualification", "recipe"],
    "compiled llama.cpp DGX Spark qualification plan",
  );
  if (plan.contractVersion !== 1) {
    throw new Error("compiled llama.cpp DGX Spark qualification plan version is invalid");
  }

  const qualification = record(plan.qualification, "compiled protocol qualification");
  requireExactKeys(
    qualification,
    ["agentQualification", "probeBounds", "probes"],
    "compiled protocol qualification",
  );
  if (
    JSON.stringify(qualification.probes) !==
    JSON.stringify(LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES)
  ) {
    throw new Error("compiled llama.cpp DGX Spark protocol probes are invalid");
  }
  const protocolProbeBounds = parseProtocolProbeBounds(qualification.probeBounds);
  const agentQualification = parseAgentQualification(qualification.agentQualification);

  const imageBuild = record(plan.imageBuild, "compiled qualification image build");
  requireExactKeys(
    imageBuild,
    ["backendDirectory", "compiler", "cuda", "platform", "repository", "runtime", "source"],
    "compiled qualification image build",
  );
  const compiler = record(imageBuild.compiler, "compiled qualification compiler");
  requireExactKeys(compiler, ["c", "cudaHostCxx", "cxx"], "compiled qualification compiler");
  const imageCuda = record(imageBuild.cuda, "compiled qualification image CUDA");
  requireExactKeys(
    imageCuda,
    ["developmentBase", "runtimeBase"],
    "compiled qualification image CUDA",
  );
  const platform = record(imageBuild.platform, "compiled qualification image platform");
  requireExactKeys(
    platform,
    ["cudaArchitectures", "platform"],
    "compiled qualification image platform",
  );
  const imageRuntime = record(imageBuild.runtime, "compiled qualification image runtime");
  requireExactKeys(imageRuntime, ["gid", "port", "uid"], "compiled qualification image runtime");
  const imageSource = record(imageBuild.source, "compiled qualification image source");
  requireExactKeys(
    imageSource,
    ["archiveSha256", "repository", "revision"],
    "compiled qualification image source",
  );
  const uid = boundedInteger(imageRuntime.uid, "compiled qualification runtime UID", 1, 65_535);
  const gid = boundedInteger(imageRuntime.gid, "compiled qualification runtime GID", 1, 65_535);
  if (
    imageBuild.backendDirectory !== "/opt/llama.cpp/lib" ||
    imageBuild.repository !== LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY ||
    compiler.c !== "gcc-14" ||
    compiler.cudaHostCxx !== "g++-14" ||
    compiler.cxx !== "g++-14" ||
    imageCuda.developmentBase !== LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE ||
    imageCuda.runtimeBase !== LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE ||
    platform.platform !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM ||
    platform.cudaArchitectures !== "121a-real" ||
    imageRuntime.port !== 8081 ||
    imageSource.repository !== LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY ||
    imageSource.revision !== LLAMA_CPP_DGX_SPARK_SOURCE_REVISION ||
    imageSource.archiveSha256 !== LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256
  ) {
    throw new Error("compiled llama.cpp DGX Spark image build identity is invalid");
  }

  const recipe = record(plan.recipe, "compiled llama.cpp DGX Spark qualification recipe");
  requireExactKeys(
    recipe,
    [
      "capabilities",
      "id",
      "model",
      "policy",
      "readiness",
      "runtime",
      "serve",
      "server",
      "surfaces",
    ],
    "compiled llama.cpp DGX Spark qualification recipe",
  );
  const capabilities = record(recipe.capabilities, "compiled qualification capabilities");
  requireExactKeys(
    capabilities,
    [
      "agents",
      "embeddings",
      "multimodal",
      "parallelToolCalls",
      "protocols",
      "reranking",
      "responsesApi",
      "streaming",
      "structuredOutputs",
      "toolCalls",
    ],
    "compiled qualification capabilities",
  );
  if (
    JSON.stringify(capabilities.agents) !== "[]" ||
    JSON.stringify(capabilities.protocols) !== JSON.stringify(["openai-completions"]) ||
    capabilities.streaming !== true ||
    capabilities.toolCalls !== true ||
    capabilities.structuredOutputs !== true ||
    capabilities.parallelToolCalls !== false ||
    capabilities.responsesApi !== false ||
    capabilities.embeddings !== false ||
    capabilities.reranking !== false ||
    capabilities.multimodal !== false
  ) {
    throw new Error("compiled llama.cpp DGX Spark capability claims are invalid");
  }
  const model = record(recipe.model, "compiled qualification recipe model");
  requireExactKeys(
    model,
    ["acquisition", "file", "id", "revision", "servedName"],
    "compiled qualification recipe model",
  );
  const modelAcquisition = record(
    model.acquisition,
    "compiled qualification recipe model acquisition",
  );
  requireExactKeys(
    modelAcquisition,
    ["downloaderImage"],
    "compiled qualification recipe model acquisition",
  );
  const modelFile = record(model.file, "compiled qualification recipe model file");
  requireExactKeys(
    modelFile,
    ["digest", "format", "license", "path", "quantization", "sizeBytes"],
    "compiled qualification recipe model file",
  );
  const modelSizeBytes = safeInteger(
    modelFile.sizeBytes,
    "compiled qualification model size",
    128 * 1024 ** 3,
  );
  if (
    recipe.id !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE ||
    modelAcquisition.downloaderImage !== LLAMA_CPP_DGX_SPARK_TOOL_IMAGE ||
    model.id !== LLAMA_CPP_DGX_SPARK_MODEL_ID ||
    model.revision !== "9ad8b366c308f931b2a96b9306f0b41aef9cd405" ||
    model.servedName !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    modelFile.path !== "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf" ||
    modelFile.digest !== LLAMA_CPP_DGX_SPARK_MODEL_DIGEST ||
    modelFile.format !== "gguf" ||
    modelFile.quantization !== "UD-Q4_K_XL" ||
    modelFile.license !== "NVIDIA-Open-Model-License"
  ) {
    throw new Error("compiled llama.cpp DGX Spark model identity is invalid");
  }

  const policy = record(recipe.policy, "compiled qualification recipe policy");
  requireExactKeys(
    policy,
    ["egress", "modelDownloads", "modelSource"],
    "compiled qualification recipe policy",
  );
  if (
    policy.egress !== "disabled" ||
    policy.modelDownloads !== "disabled" ||
    policy.modelSource !== "verified-local"
  ) {
    throw new Error("compiled llama.cpp DGX Spark policy is invalid");
  }

  const readiness = record(recipe.readiness, "compiled qualification recipe readiness");
  requireExactKeys(
    readiness,
    ["contractRef", "expectedModel", "probeImage", "probes", "timeoutSeconds"],
    "compiled qualification recipe readiness",
  );
  const readinessProbes = record(readiness.probes, "compiled qualification readiness probes");
  requireExactKeys(
    readinessProbes,
    ["health", "metrics", "models", "properties"],
    "compiled qualification readiness probes",
  );
  const readinessTimeout = boundedInteger(
    readiness.timeoutSeconds,
    "compiled qualification readiness timeout",
    1,
    3600,
  );
  if (
    readiness.contractRef !== "llama-cpp.server-readiness/v1" ||
    readiness.expectedModel !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    readiness.probeImage !== LLAMA_CPP_DGX_SPARK_TOOL_IMAGE ||
    readinessProbes.health !== true ||
    readinessProbes.metrics !== true ||
    readinessProbes.models !== true ||
    readinessProbes.properties !== true
  ) {
    throw new Error("compiled llama.cpp DGX Spark readiness contract is invalid");
  }

  const recipeRuntime = record(recipe.runtime, "compiled qualification recipe runtime");
  requireExactKeys(
    recipeRuntime,
    ["cuda", "gpu", "resources", "restartPolicy"],
    "compiled qualification recipe runtime",
  );
  const recipeCuda = record(recipeRuntime.cuda, "compiled qualification recipe CUDA");
  requireExactKeys(
    recipeCuda,
    ["baseImage", "minimumDriverVersion"],
    "compiled qualification recipe CUDA",
  );
  const gpu = record(recipeRuntime.gpu, "compiled qualification recipe GPU");
  requireExactKeys(
    gpu,
    ["count", "cpuFallback", "offload", "vendor"],
    "compiled qualification recipe GPU",
  );
  const resources = record(recipeRuntime.resources, "compiled qualification recipe resources");
  requireExactKeys(
    resources,
    ["memoryBytes", "pidsLimit", "writableStorageBytes"],
    "compiled qualification recipe resources",
  );
  const memoryBytes = boundedInteger(
    resources.memoryBytes,
    "compiled qualification memory limit",
    modelSizeBytes,
    128 * 1024 ** 3,
  );
  const writableStorageBytes = boundedInteger(
    resources.writableStorageBytes,
    "compiled qualification writable storage limit",
    64 * 1024 ** 2,
    128 * 1024 ** 3,
  );
  const pidsLimit = boundedInteger(
    resources.pidsLimit,
    "compiled qualification PID limit",
    16,
    4096,
  );
  if (
    recipeRuntime.restartPolicy !== "unless-stopped" ||
    recipeCuda.baseImage !== LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE ||
    typeof recipeCuda.minimumDriverVersion !== "string" ||
    !LLAMA_CPP_DGX_SPARK_DRIVER_PATTERN.test(recipeCuda.minimumDriverVersion) ||
    !driverVersionAtLeast(
      recipeCuda.minimumDriverVersion,
      LLAMA_CPP_DGX_SPARK_MINIMUM_DRIVER_VERSION,
    ) ||
    gpu.vendor !== "nvidia" ||
    gpu.count !== 1 ||
    gpu.offload !== "full" ||
    gpu.cpuFallback !== "reject"
  ) {
    throw new Error("compiled llama.cpp DGX Spark runtime contract is invalid");
  }

  const serve = record(recipe.serve, "compiled qualification recipe serve contract");
  requireExactKeys(
    serve,
    [
      "authentication",
      "batchSize",
      "chatTemplate",
      "contextSize",
      "flashAttention",
      "idleSleepSeconds",
      "kvCache",
      "limits",
      "microBatchSize",
      "port",
      "protocol",
      "slots",
      "speculativeDecoding",
    ],
    "compiled qualification recipe serve contract",
  );
  const contextSize = boundedInteger(
    serve.contextSize,
    "compiled qualification context size",
    LLAMA_CPP_DGX_SPARK_CONTEXT_SIZE_RANGE.minimum,
    LLAMA_CPP_DGX_SPARK_CONTEXT_SIZE_RANGE.maximum,
  );
  const batchSize = boundedInteger(serve.batchSize, "compiled qualification batch size", 1, 8192);
  const microBatchSize = boundedInteger(
    serve.microBatchSize,
    "compiled qualification micro-batch size",
    1,
    batchSize,
  );
  const kvCache = record(serve.kvCache, "compiled qualification KV cache");
  requireExactKeys(kvCache, ["key", "value"], "compiled qualification KV cache");
  const allowedKvTypes = new Set(["f16", "q8_0", "q4_0"]);
  const limits = record(serve.limits, "compiled qualification request limits");
  requireExactKeys(limits, ["requestTimeoutSeconds"], "compiled qualification request limits");
  const requestTimeoutSeconds = boundedInteger(
    limits.requestTimeoutSeconds,
    "compiled qualification request timeout",
    1,
    3600,
  );
  if (
    serve.protocol !== "openai-completions" ||
    serve.authentication !== "bearer" ||
    serve.port !== 8081 ||
    serve.chatTemplate !== "nemotron-v3-embedded" ||
    serve.slots !== 1 ||
    serve.idleSleepSeconds !== -1 ||
    serve.flashAttention !== "enabled" ||
    serve.speculativeDecoding !== "disabled" ||
    typeof kvCache.key !== "string" ||
    !allowedKvTypes.has(kvCache.key) ||
    typeof kvCache.value !== "string" ||
    !allowedKvTypes.has(kvCache.value)
  ) {
    throw new Error("compiled llama.cpp DGX Spark serve contract is invalid");
  }

  const server = record(recipe.server, "compiled qualification recipe server");
  requireExactKeys(server, ["source", "technology"], "compiled qualification recipe server");
  const serverSource = record(server.source, "compiled qualification recipe server source");
  requireExactKeys(
    serverSource,
    ["repository", "revision"],
    "compiled qualification recipe server source",
  );
  if (
    server.technology !== "llama.cpp" ||
    serverSource.repository !== "ggml-org/llama.cpp" ||
    serverSource.revision !== LLAMA_CPP_DGX_SPARK_SOURCE_REVISION
  ) {
    throw new Error("compiled llama.cpp DGX Spark server identity is invalid");
  }

  const surfaces = record(recipe.surfaces, "compiled qualification recipe surfaces");
  const surfaceNames = [
    "agentMode",
    "mcpProxy",
    "multimodalProjection",
    "router",
    "serverTools",
    "slotInspection",
    "ui",
  ] as const;
  requireExactKeys(surfaces, surfaceNames, "compiled qualification recipe surfaces");
  if (surfaceNames.some((name) => surfaces[name] !== "disabled")) {
    throw new Error("compiled llama.cpp DGX Spark server surfaces are not disabled");
  }

  const parsed: LlamaCppDgxSparkExecutionPlan = {
    contractVersion: 1,
    imageBuild: {
      backendDirectory: "/opt/llama.cpp/lib",
      compiler: { c: "gcc-14", cudaHostCxx: "g++-14", cxx: "g++-14" },
      cuda: {
        developmentBase: LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE,
        runtimeBase: LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
      },
      platform: {
        cudaArchitectures: "121a-real",
        platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
      },
      repository: LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY,
      runtime: { gid, port: 8081, uid },
      source: {
        archiveSha256: LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256,
        repository: LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY,
        revision: LLAMA_CPP_DGX_SPARK_SOURCE_REVISION,
      },
    },
    qualification: {
      agentQualification,
      probeBounds: protocolProbeBounds,
      probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
    },
    recipe: {
      capabilities: {
        agents: [],
        protocols: ["openai-completions"],
        streaming: true,
        toolCalls: true,
        structuredOutputs: true,
        parallelToolCalls: false,
        responsesApi: false,
        embeddings: false,
        reranking: false,
        multimodal: false,
      },
      id: LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
      model: {
        acquisition: { downloaderImage: LLAMA_CPP_DGX_SPARK_TOOL_IMAGE },
        file: {
          path: "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
          digest: LLAMA_CPP_DGX_SPARK_MODEL_DIGEST,
          sizeBytes: modelSizeBytes,
          format: "gguf",
          quantization: "UD-Q4_K_XL",
          license: "NVIDIA-Open-Model-License",
        },
        id: LLAMA_CPP_DGX_SPARK_MODEL_ID,
        revision: "9ad8b366c308f931b2a96b9306f0b41aef9cd405",
        servedName: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
      },
      policy: {
        egress: "disabled",
        modelSource: "verified-local",
        modelDownloads: "disabled",
      },
      readiness: {
        contractRef: "llama-cpp.server-readiness/v1",
        timeoutSeconds: readinessTimeout,
        expectedModel: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        probeImage: LLAMA_CPP_DGX_SPARK_TOOL_IMAGE,
        probes: { models: true, health: true, properties: true, metrics: true },
      },
      runtime: {
        restartPolicy: "unless-stopped",
        cuda: {
          baseImage: LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
          minimumDriverVersion: recipeCuda.minimumDriverVersion,
        },
        gpu: {
          vendor: "nvidia",
          count: 1,
          offload: "full",
          cpuFallback: "reject",
        },
        resources: { memoryBytes, writableStorageBytes, pidsLimit },
      },
      serve: {
        protocol: "openai-completions",
        authentication: "bearer",
        port: 8081,
        chatTemplate: "nemotron-v3-embedded",
        contextSize,
        slots: 1,
        idleSleepSeconds: -1,
        batchSize,
        microBatchSize,
        flashAttention: "enabled",
        kvCache: {
          key: kvCache.key as "f16" | "q8_0" | "q4_0",
          value: kvCache.value as "f16" | "q8_0" | "q4_0",
        },
        speculativeDecoding: "disabled",
        limits: {
          requestTimeoutSeconds,
        },
      },
      server: {
        technology: "llama.cpp",
        source: {
          repository: "ggml-org/llama.cpp",
          revision: LLAMA_CPP_DGX_SPARK_SOURCE_REVISION,
        },
      },
      surfaces: {
        ui: "disabled",
        slotInspection: "disabled",
        router: "disabled",
        mcpProxy: "disabled",
        serverTools: "disabled",
        agentMode: "disabled",
        multimodalProjection: "disabled",
      },
    },
  };
  if (expectedSha256 !== undefined) {
    const expected = requiredDigest(
      expectedSha256,
      "compiled llama.cpp DGX Spark qualification plan digest",
    );
    const actual = `sha256:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
    if (actual !== expected) {
      throw new Error("compiled llama.cpp DGX Spark qualification plan digest does not match");
    }
  }
  return parsed;
}

export function llamaCppDgxSparkExecutionPlanSha256(value: unknown): string {
  const plan = parseLlamaCppDgxSparkExecutionPlan(value);
  return `sha256:${createHash("sha256").update(JSON.stringify(plan)).digest("hex")}`;
}

export function verifyLlamaCppDgxSparkExecutionPlanSha256(
  value: unknown,
  expectedDigest: unknown,
): LlamaCppDgxSparkExecutionPlan {
  return parseLlamaCppDgxSparkExecutionPlan(value, expectedDigest);
}

export function parseLlamaCppDgxSparkQualificationEvidenceIdentity(
  value: unknown,
): LlamaCppDgxSparkQualificationEvidenceIdentity {
  const identity = record(value, "llama.cpp DGX Spark evidence identity");
  requireExactKeys(
    identity,
    ["baseSha", "headSha", "runAttempt", "runId", "workflowSha"],
    "llama.cpp DGX Spark evidence identity",
  );
  return {
    baseSha: requiredSha(identity.baseSha, "llama.cpp DGX Spark base SHA"),
    headSha: requiredSha(identity.headSha, "llama.cpp DGX Spark head SHA"),
    runAttempt: safeInteger(identity.runAttempt, "llama.cpp DGX Spark run attempt", 1_000_000),
    runId: safeInteger(identity.runId, "llama.cpp DGX Spark run id", Number.MAX_SAFE_INTEGER),
    workflowSha: requiredSha(identity.workflowSha, "llama.cpp DGX Spark workflow SHA"),
  };
}

export function parseLlamaCppDgxSparkQualificationReceipt(
  value: unknown,
  expectedValue: unknown,
  expectedPlanValue: unknown,
): LlamaCppDgxSparkQualificationReceipt {
  const expected = parseLlamaCppDgxSparkQualificationEvidenceIdentity(expectedValue);
  const expectedPlan = parseLlamaCppDgxSparkExecutionPlan(expectedPlanValue);
  const receipt = record(value, "llama.cpp DGX Spark qualification receipt");
  requireExactKeys(
    receipt,
    [
      "agentQualification",
      "baseSha",
      "cleanup",
      "execution",
      "headSha",
      "host",
      "image",
      "kind",
      "model",
      "probes",
      "repository",
      "run",
      "workflowSha",
    ],
    "llama.cpp DGX Spark qualification receipt",
  );
  if (
    receipt.kind !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND ||
    receipt.repository !== "NVIDIA/NemoClaw" ||
    receipt.baseSha !== expected.baseSha ||
    receipt.headSha !== expected.headSha ||
    receipt.workflowSha !== expected.workflowSha ||
    !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(String(receipt.baseSha)) ||
    !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(String(receipt.headSha)) ||
    !LLAMA_CPP_DGX_SPARK_SHA_PATTERN.test(String(receipt.workflowSha))
  ) {
    throw new Error("llama.cpp DGX Spark qualification receipt identity is invalid");
  }

  const agentQualification = record(
    receipt.agentQualification,
    "llama.cpp DGX Spark agent qualification receipt",
  );
  let parsedAgentQualification: LlamaCppDgxSparkQualificationReceipt["agentQualification"];
  if (expectedPlan.qualification.agentQualification.execution === "disabled") {
    if (agentQualification.execution !== "disabled") {
      throw new Error("llama.cpp DGX Spark agent qualification ran without declarative activation");
    }
    requireExactKeys(agentQualification, ["execution"], "agent qualification receipt");
    parsedAgentQualification = { execution: "disabled" };
  } else {
    requireExactKeys(
      agentQualification,
      [
        "agent",
        "cleanup",
        "execution",
        "image",
        "model",
        "platform",
        "probes",
        "route",
        "runtimeProvider",
      ],
      "agent qualification receipt",
    );
    const agentImage = record(agentQualification.image, "agent qualification receipt image");
    requireExactKeys(agentImage, ["reference", "sourceRevision"], "agent receipt image");
    const agentModel = record(agentQualification.model, "agent qualification receipt model");
    requireExactKeys(
      agentModel,
      ["chatTemplate", "id", "quantization", "servedName"],
      "agent receipt model",
    );
    const agentRoute = record(agentQualification.route, "agent qualification receipt route");
    requireExactKeys(
      agentRoute,
      ["api", "provider", "routedBaseUrl", "upstreamBaseUrl"],
      "agent receipt route",
    );
    const agentProbes = record(agentQualification.probes, "agent qualification receipt probes");
    requireExactKeys(
      agentProbes,
      [
        "agentMultiTurn",
        "agentNormalTurn",
        "agentToolCall",
        "agentToolResultContinuation",
        "streamingChat",
        "synchronousChat",
      ],
      "agent receipt probes",
    );
    const agentToolCall = record(agentProbes.agentToolCall, "agent tool-call probe");
    requireExactKeys(agentToolCall, ["argumentsValid", "name"], "agent tool-call probe");
    const agentStreaming = record(agentProbes.streamingChat, "agent streaming probe");
    requireExactKeys(agentStreaming, ["done", "events"], "agent streaming probe");
    const agentStreamingEvents = boundedInteger(
      agentStreaming.events,
      "agent streaming event count",
      2,
      expectedPlan.qualification.agentQualification.bounds.maxStreamEvents,
    );
    const agentCleanup = record(agentQualification.cleanup, "agent qualification cleanup");
    requireExactKeys(
      agentCleanup,
      ["gatewayRemoved", "networkRemoved", "sandboxRemoved", "stateRemoved"],
      "agent qualification cleanup",
    );
    const configured = expectedPlan.qualification.agentQualification;
    if (
      agentQualification.execution !== "enabled" ||
      agentQualification.agent !== configured.agent ||
      agentQualification.runtimeProvider !== configured.runtimeProvider ||
      agentQualification.platform !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM ||
      agentImage.reference !== configured.image.reference ||
      agentImage.sourceRevision !== configured.image.sourceRevision ||
      agentModel.id !== expectedPlan.recipe.model.id ||
      agentModel.servedName !== expectedPlan.recipe.model.servedName ||
      agentModel.quantization !== expectedPlan.recipe.model.file.quantization ||
      agentModel.chatTemplate !== expectedPlan.recipe.serve.chatTemplate ||
      agentRoute.provider !== configured.route.provider ||
      agentRoute.api !== configured.route.api ||
      agentRoute.routedBaseUrl !== configured.route.routedBaseUrl ||
      agentRoute.upstreamBaseUrl !== configured.route.upstreamBaseUrl ||
      agentProbes.synchronousChat !== true ||
      agentProbes.agentNormalTurn !== true ||
      agentProbes.agentMultiTurn !== true ||
      agentProbes.agentToolResultContinuation !== true ||
      agentStreaming.done !== true ||
      agentToolCall.name !== configured.tool.name ||
      agentToolCall.argumentsValid !== true ||
      Object.values(agentCleanup).some((entry) => entry !== true)
    ) {
      throw new Error("llama.cpp DGX Spark agent qualification evidence is invalid");
    }
    parsedAgentQualification = {
      agent: "openclaw",
      cleanup: {
        gatewayRemoved: true,
        networkRemoved: true,
        sandboxRemoved: true,
        stateRemoved: true,
      },
      execution: "enabled",
      image: {
        reference: LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE,
        sourceRevision: LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION,
      },
      model: {
        chatTemplate: "nemotron-v3-embedded",
        id: LLAMA_CPP_DGX_SPARK_MODEL_ID,
        quantization: "UD-Q4_K_XL",
        servedName: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
      },
      platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
      probes: {
        agentMultiTurn: true,
        agentNormalTurn: true,
        agentToolCall: { argumentsValid: true, name: "read" },
        agentToolResultContinuation: true,
        streamingChat: { done: true, events: agentStreamingEvents },
        synchronousChat: true,
      },
      route: {
        api: "openai-completions",
        provider: "llama-cpp-local",
        routedBaseUrl: "https://inference.local/v1",
        upstreamBaseUrl: "http://host.openshell.internal:8081/v1",
      },
      runtimeProvider: "docker",
    };
  }

  const run = record(receipt.run, "llama.cpp DGX Spark qualification receipt run");
  requireExactKeys(run, ["attempt", "id"], "qualification receipt run");
  if (
    run.id !== expected.runId ||
    run.attempt !== expected.runAttempt ||
    !Number.isSafeInteger(run.id) ||
    !Number.isSafeInteger(run.attempt)
  ) {
    throw new Error("llama.cpp DGX Spark qualification receipt run is invalid");
  }

  const image = record(receipt.image, "llama.cpp DGX Spark qualification receipt image");
  requireExactKeys(image, ["digest", "platform", "reference", "sourceRevision"], "receipt image");
  const imageDigest = requiredDigest(image.digest, "llama.cpp DGX Spark image digest");
  if (
    image.platform !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM ||
    image.sourceRevision !== LLAMA_CPP_DGX_SPARK_SOURCE_REVISION ||
    image.reference !== `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY}@${imageDigest}`
  ) {
    throw new Error("llama.cpp DGX Spark qualification image identity is invalid");
  }

  const model = record(receipt.model, "llama.cpp DGX Spark qualification receipt model");
  requireExactKeys(model, ["digest", "id"], "receipt model");
  if (
    model.id !== LLAMA_CPP_DGX_SPARK_MODEL_ID ||
    model.digest !== LLAMA_CPP_DGX_SPARK_MODEL_DIGEST
  ) {
    throw new Error("llama.cpp DGX Spark qualification model identity is invalid");
  }

  const host = record(receipt.host, "llama.cpp DGX Spark qualification receipt host");
  requireExactKeys(host, ["architecture", "driverVersion", "gpuName", "profile"], "receipt host");
  if (
    host.architecture !== "arm64" ||
    host.profile !== LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE ||
    typeof host.gpuName !== "string" ||
    !LLAMA_CPP_DGX_SPARK_GPU_PATTERN.test(host.gpuName) ||
    typeof host.driverVersion !== "string" ||
    !LLAMA_CPP_DGX_SPARK_DRIVER_PATTERN.test(host.driverVersion) ||
    !driverVersionAtLeast(host.driverVersion, LLAMA_CPP_DGX_SPARK_MINIMUM_DRIVER_VERSION)
  ) {
    throw new Error("llama.cpp DGX Spark qualification host identity is invalid");
  }

  const execution = record(
    receipt.execution,
    "llama.cpp DGX Spark qualification receipt execution",
  );
  requireExactKeys(
    execution,
    ["cpuFallback", "cpuWarning", "fullOffload", "offloadedLayers", "totalLayers"],
    "receipt execution",
  );
  const offloadedLayers = safeInteger(execution.offloadedLayers, "offloaded layer count", 100_000);
  const totalLayers = safeInteger(execution.totalLayers, "total layer count", 100_000);
  if (
    execution.cpuFallback !== false ||
    execution.cpuWarning !== false ||
    execution.fullOffload !== true ||
    offloadedLayers !== totalLayers
  ) {
    throw new Error("llama.cpp DGX Spark qualification did not prove full GPU offload");
  }

  const probes = record(receipt.probes, "llama.cpp DGX Spark qualification receipt probes");
  requireExactKeys(
    probes,
    [
      "authentication",
      "cancellation",
      "contextWindow",
      "disabledSurfaces",
      "health",
      "logRedaction",
      "malformedRequest",
      "metrics",
      "models",
      "properties",
      "clientTimeout",
      "streamingChat",
      "structuredOutput",
      "synchronousChat",
      "toolCall",
      "toolResultContinuation",
      "usage",
    ],
    "receipt probes",
  );
  const health = record(probes.health, "llama.cpp DGX Spark health probe");
  requireExactKeys(health, ["httpStatus", "ok"], "health probe");
  const logRedaction = record(probes.logRedaction, "llama.cpp DGX Spark log-redaction probe");
  requireExactKeys(logRedaction, ["ok"], "log-redaction probe");
  const models = record(probes.models, "llama.cpp DGX Spark models probe");
  requireExactKeys(models, ["httpStatus", "model", "ok"], "models probe");
  const metrics = record(probes.metrics, "llama.cpp DGX Spark metrics probe");
  requireExactKeys(
    metrics,
    ["httpStatus", "ok", "requiredSeries", "unauthenticatedHttpStatus"],
    "metrics probe",
  );
  const requiredSeries = safeInteger(
    metrics.requiredSeries,
    "required metrics series count",
    LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES.length,
  );
  const properties = record(probes.properties, "llama.cpp DGX Spark properties probe");
  requireExactKeys(
    properties,
    ["httpStatus", "metrics", "model", "modelPath", "ok"],
    "properties probe",
  );
  const disabledSurfaces = record(
    probes.disabledSurfaces,
    "llama.cpp DGX Spark disabled-surfaces probe",
  );
  requireExactKeys(
    disabledSurfaces,
    [
      "corsProxyHttpStatus",
      "multimodal",
      "ok",
      "propertiesMutationHttpStatus",
      "routerHttpStatus",
      "slotsHttpStatus",
      "toolsHttpStatus",
      "uiHttpStatus",
    ],
    "disabled-surfaces probe",
  );
  const synchronousChat = record(probes.synchronousChat, "synchronous chat probe");
  requireExactKeys(synchronousChat, ["httpStatus", "model", "ok"], "synchronous chat probe");
  const streamingChat = record(probes.streamingChat, "streaming chat probe");
  requireExactKeys(
    streamingChat,
    ["done", "events", "httpStatus", "model", "ok"],
    "streaming chat probe",
  );
  const streamingEvents = boundedInteger(
    streamingChat.events,
    "streaming chat event count",
    1,
    4096,
  );
  const usage = record(probes.usage, "chat usage probe");
  requireExactKeys(
    usage,
    ["completionTokens", "ok", "promptTokens", "totalTokens"],
    "chat usage probe",
  );
  const promptTokens = safeInteger(usage.promptTokens, "prompt token count", 1024 * 1024);
  const completionTokens = safeInteger(
    usage.completionTokens,
    "completion token count",
    1024 * 1024,
  );
  const totalTokens = safeInteger(usage.totalTokens, "total token count", 2 * 1024 * 1024);
  const structuredOutput = record(probes.structuredOutput, "structured-output probe");
  requireExactKeys(
    structuredOutput,
    ["httpStatus", "model", "ok", "schemaMatched"],
    "structured-output probe",
  );
  const toolCall = record(probes.toolCall, "tool-call probe");
  requireExactKeys(toolCall, ["argumentsValid", "httpStatus", "name", "ok"], "tool-call probe");
  const toolResultContinuation = record(
    probes.toolResultContinuation,
    "tool-result continuation probe",
  );
  requireExactKeys(
    toolResultContinuation,
    ["httpStatus", "model", "ok"],
    "tool-result continuation probe",
  );
  const contextWindow = record(probes.contextWindow, "context-window probe");
  requireExactKeys(contextWindow, ["contextSize", "ok", "slots"], "context-window probe");
  const contextSize = boundedInteger(
    contextWindow.contextSize,
    "qualified context size",
    LLAMA_CPP_DGX_SPARK_CONTEXT_SIZE_RANGE.minimum,
    LLAMA_CPP_DGX_SPARK_CONTEXT_SIZE_RANGE.maximum,
  );
  const authentication = record(probes.authentication, "authentication probe");
  requireExactKeys(authentication, ["httpStatus", "ok"], "authentication probe");
  const malformedRequest = record(probes.malformedRequest, "malformed-request probe");
  requireExactKeys(malformedRequest, ["httpStatus", "ok"], "malformed-request probe");
  const cancellation = record(probes.cancellation, "cancellation probe");
  requireExactKeys(cancellation, ["aborted", "ok", "recovered"], "cancellation probe");
  const clientTimeout = record(probes.clientTimeout, "client-timeout probe");
  requireExactKeys(
    clientTimeout,
    ["aborted", "limitMilliseconds", "ok", "recovered"],
    "client-timeout probe",
  );
  const clientTimeoutMilliseconds = boundedInteger(
    clientTimeout.limitMilliseconds,
    "qualification client timeout",
    LLAMA_CPP_DGX_SPARK_CLIENT_TIMEOUT_RANGE.minimum,
    LLAMA_CPP_DGX_SPARK_CLIENT_TIMEOUT_RANGE.maximum,
  );
  if (
    health.ok !== true ||
    health.httpStatus !== 200 ||
    logRedaction.ok !== true ||
    models.ok !== true ||
    models.httpStatus !== 200 ||
    models.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    metrics.ok !== true ||
    metrics.httpStatus !== 200 ||
    metrics.unauthenticatedHttpStatus !== 401 ||
    requiredSeries !== LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES.length ||
    properties.ok !== true ||
    properties.httpStatus !== 200 ||
    properties.metrics !== true ||
    properties.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    properties.modelPath !== "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf" ||
    disabledSurfaces.ok !== true ||
    disabledSurfaces.corsProxyHttpStatus !== 403 ||
    disabledSurfaces.multimodal !== false ||
    disabledSurfaces.propertiesMutationHttpStatus !== 501 ||
    disabledSurfaces.routerHttpStatus !== 404 ||
    disabledSurfaces.slotsHttpStatus !== 501 ||
    disabledSurfaces.toolsHttpStatus !== 403 ||
    disabledSurfaces.uiHttpStatus !== 404 ||
    synchronousChat.ok !== true ||
    synchronousChat.httpStatus !== 200 ||
    synchronousChat.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    streamingChat.ok !== true ||
    streamingChat.httpStatus !== 200 ||
    streamingChat.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    streamingChat.done !== true ||
    usage.ok !== true ||
    totalTokens !== promptTokens + completionTokens ||
    structuredOutput.ok !== true ||
    structuredOutput.httpStatus !== 200 ||
    structuredOutput.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    structuredOutput.schemaMatched !== true ||
    toolCall.ok !== true ||
    toolCall.httpStatus !== 200 ||
    toolCall.name !== "get_current_weather" ||
    toolCall.argumentsValid !== true ||
    toolResultContinuation.ok !== true ||
    toolResultContinuation.httpStatus !== 200 ||
    toolResultContinuation.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID ||
    contextWindow.ok !== true ||
    contextWindow.slots !== 1 ||
    authentication.ok !== true ||
    authentication.httpStatus !== 401 ||
    malformedRequest.ok !== true ||
    malformedRequest.httpStatus !== 400 ||
    cancellation.ok !== true ||
    cancellation.aborted !== true ||
    cancellation.recovered !== true ||
    clientTimeout.ok !== true ||
    clientTimeout.aborted !== true ||
    clientTimeout.recovered !== true
  ) {
    throw new Error("llama.cpp DGX Spark qualification probes did not pass");
  }

  const cleanup = record(receipt.cleanup, "llama.cpp DGX Spark qualification receipt cleanup");
  requireExactKeys(
    cleanup,
    ["containerRemoved", "credentialsRemoved", "listenerClosed", "registryRemoved"],
    "receipt cleanup",
  );
  if (
    cleanup.containerRemoved !== true ||
    cleanup.credentialsRemoved !== true ||
    cleanup.listenerClosed !== true ||
    cleanup.registryRemoved !== true
  ) {
    throw new Error("llama.cpp DGX Spark qualification cleanup is incomplete");
  }

  return {
    agentQualification: parsedAgentQualification,
    baseSha: expected.baseSha,
    cleanup: {
      containerRemoved: true,
      credentialsRemoved: true,
      listenerClosed: true,
      registryRemoved: true,
    },
    execution: {
      cpuFallback: false,
      cpuWarning: false,
      fullOffload: true,
      offloadedLayers,
      totalLayers,
    },
    headSha: expected.headSha,
    host: {
      architecture: "arm64",
      driverVersion: host.driverVersion,
      gpuName: "NVIDIA GB10",
      profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
    },
    image: {
      digest: imageDigest,
      platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
      reference: image.reference as string,
      sourceRevision: LLAMA_CPP_DGX_SPARK_SOURCE_REVISION,
    },
    kind: LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND,
    model: {
      digest: LLAMA_CPP_DGX_SPARK_MODEL_DIGEST,
      id: LLAMA_CPP_DGX_SPARK_MODEL_ID,
    },
    probes: {
      authentication: { httpStatus: 401, ok: true },
      cancellation: { aborted: true, ok: true, recovered: true },
      contextWindow: { contextSize, ok: true, slots: 1 },
      disabledSurfaces: {
        corsProxyHttpStatus: 403,
        multimodal: false,
        ok: true,
        propertiesMutationHttpStatus: 501,
        routerHttpStatus: 404,
        slotsHttpStatus: 501,
        toolsHttpStatus: 403,
        uiHttpStatus: 404,
      },
      health: { httpStatus: 200, ok: true },
      logRedaction: { ok: true },
      malformedRequest: { httpStatus: 400, ok: true },
      metrics: {
        httpStatus: 200,
        ok: true,
        requiredSeries: LLAMA_CPP_DGX_SPARK_REQUIRED_METRIC_SERIES.length,
        unauthenticatedHttpStatus: 401,
      },
      models: {
        httpStatus: 200,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        ok: true,
      },
      properties: {
        httpStatus: 200,
        metrics: true,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        modelPath: "Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf",
        ok: true,
      },
      clientTimeout: {
        aborted: true,
        limitMilliseconds: clientTimeoutMilliseconds,
        ok: true,
        recovered: true,
      },
      streamingChat: {
        done: true,
        events: streamingEvents,
        httpStatus: 200,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        ok: true,
      },
      structuredOutput: {
        httpStatus: 200,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        ok: true,
        schemaMatched: true,
      },
      synchronousChat: {
        httpStatus: 200,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        ok: true,
      },
      toolCall: {
        argumentsValid: true,
        httpStatus: 200,
        name: "get_current_weather",
        ok: true,
      },
      toolResultContinuation: {
        httpStatus: 200,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        ok: true,
      },
      usage: { completionTokens, ok: true, promptTokens, totalTokens },
    },
    repository: "NVIDIA/NemoClaw",
    run: { attempt: expected.runAttempt, id: expected.runId },
    workflowSha: expected.workflowSha,
  };
}
