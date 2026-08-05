// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import YAML from "yaml";

export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID =
  "llama-cpp-dgx-spark-qualification" as const;
export const LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH =
  "ci/llama-cpp-dgx-spark-qualification-v1.yaml" as const;
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
export const LLAMA_CPP_DGX_SPARK_MINIMUM_DRIVER_VERSION = "580.65.06" as const;

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
  readonly probes: readonly ["health", "completion"];
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
  readonly recipe: {
    readonly id: typeof LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE;
    readonly model: {
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
      readonly probes: {
        readonly health: true;
        readonly metrics: true;
        readonly models: true;
        readonly properties: true;
      };
      readonly timeoutSeconds: number;
    };
    readonly runtime: {
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
        readonly maxCompletionTokens: number;
        readonly maxPromptTokens: number;
        readonly maxRequestBodyBytes: number;
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

export type LlamaCppDgxSparkQualificationReceipt = {
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
    readonly completion: {
      readonly httpStatus: 200;
      readonly model: typeof LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID;
      readonly ok: true;
    };
    readonly health: {
      readonly httpStatus: 200;
      readonly ok: true;
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
  const document = YAML.parseDocument(source, { strict: true, uniqueKeys: true });
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
): { environment: string | null; hostPath: string | null; runner: string | null } {
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
    JSON.stringify(plan.probes) !== JSON.stringify(["health", "completion"])
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
    probes: ["health", "completion"],
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
    ["contractVersion", "imageBuild", "recipe"],
    "compiled llama.cpp DGX Spark qualification plan",
  );
  if (plan.contractVersion !== 1) {
    throw new Error("compiled llama.cpp DGX Spark qualification plan version is invalid");
  }

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
    ["id", "model", "policy", "readiness", "runtime", "serve", "server", "surfaces"],
    "compiled llama.cpp DGX Spark qualification recipe",
  );
  const model = record(recipe.model, "compiled qualification recipe model");
  requireExactKeys(
    model,
    ["file", "id", "revision", "servedName"],
    "compiled qualification recipe model",
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
    ["contractRef", "expectedModel", "probes", "timeoutSeconds"],
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
    ["cuda", "gpu", "resources"],
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
    1024,
    1024 * 1024,
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
  requireExactKeys(
    limits,
    ["maxCompletionTokens", "maxPromptTokens", "maxRequestBodyBytes", "requestTimeoutSeconds"],
    "compiled qualification request limits",
  );
  const maxPromptTokens = boundedInteger(
    limits.maxPromptTokens,
    "compiled qualification prompt token limit",
    1,
    contextSize,
  );
  const maxCompletionTokens = boundedInteger(
    limits.maxCompletionTokens,
    "compiled qualification completion token limit",
    1,
    contextSize,
  );
  const maxRequestBodyBytes = boundedInteger(
    limits.maxRequestBodyBytes,
    "compiled qualification request body limit",
    1024,
    64 * 1024 ** 2,
  );
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
    !allowedKvTypes.has(kvCache.value) ||
    maxPromptTokens + maxCompletionTokens > contextSize
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
    recipe: {
      id: LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
      model: {
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
        probes: { models: true, health: true, properties: true, metrics: true },
      },
      runtime: {
        cuda: {
          baseImage: LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
          minimumDriverVersion: recipeCuda.minimumDriverVersion,
        },
        gpu: { vendor: "nvidia", count: 1, offload: "full", cpuFallback: "reject" },
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
          maxRequestBodyBytes,
          maxPromptTokens,
          maxCompletionTokens,
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
): LlamaCppDgxSparkQualificationReceipt {
  const expected = parseLlamaCppDgxSparkQualificationEvidenceIdentity(expectedValue);
  const receipt = record(value, "llama.cpp DGX Spark qualification receipt");
  requireExactKeys(
    receipt,
    [
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
  requireExactKeys(probes, ["completion", "health"], "receipt probes");
  const health = record(probes.health, "llama.cpp DGX Spark health probe");
  requireExactKeys(health, ["httpStatus", "ok"], "health probe");
  const completion = record(probes.completion, "llama.cpp DGX Spark completion probe");
  requireExactKeys(completion, ["httpStatus", "model", "ok"], "completion probe");
  if (
    health.ok !== true ||
    health.httpStatus !== 200 ||
    completion.ok !== true ||
    completion.httpStatus !== 200 ||
    completion.model !== LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID
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
      completion: {
        httpStatus: 200,
        model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        ok: true,
      },
      health: { httpStatus: 200, ok: true },
    },
    repository: "NVIDIA/NemoClaw",
    run: { attempt: expected.runAttempt, id: expected.runId },
    workflowSha: expected.workflowSha,
  };
}
