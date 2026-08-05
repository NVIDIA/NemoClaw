// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { isSafeLlamaCppServedModelAlias } from "./contract";

export const LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH =
  "/run/secrets/llama-cpp-api-key" as const;

const SAFE_HOST_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_LABEL_NAME = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const SAFE_LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const IMAGE_DIGEST =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;
const GGUF_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.gguf$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const DOCKER_BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);

export interface LlamaCppHostLocalLaunchContract {
  readonly model: {
    readonly servedName: string;
    readonly file: {
      readonly digest: string;
      readonly path: string;
      readonly sizeBytes: number;
    };
  };
  readonly policy: {
    readonly egress: "disabled";
    readonly modelDownloads: "disabled";
    readonly modelSource: "verified-local";
  };
  readonly runtime: {
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
    readonly port: number;
    readonly protocol: "openai-completions";
    readonly slots: 1;
    readonly speculativeDecoding: "disabled";
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
}

export interface LlamaCppHostLocalRuntimeBindings {
  readonly apiKeyHostPath: string;
  readonly containerName: string;
  readonly imageReference: string;
  readonly model: VerifiedLocalModelArtifact;
  /** The caller must create this named Docker network with `--internal` before launch. */
  readonly network: {
    readonly isolation: "docker-internal";
    readonly name: string;
  };
  readonly ownerLabel: { readonly name: string; readonly value: string };
  readonly runtimeGid: number;
  readonly runtimeUid: number;
}

export interface VerifiedLocalModelArtifact {
  readonly digest: string;
  readonly hostPath: string;
  readonly sizeBytes: number;
}

function positiveInteger(value: number, label: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function safeHostPath(value: string, label: string): string {
  if (!SAFE_HOST_PATH.test(value) || path.posix.normalize(value) !== value) {
    throw new Error(`${label} must be a normalized absolute host path`);
  }
  return value;
}

function validateContract(contract: LlamaCppHostLocalLaunchContract): void {
  if (
    !GGUF_FILE.test(contract.model.file.path) ||
    !SHA256_DIGEST.test(contract.model.file.digest) ||
    !Number.isSafeInteger(contract.model.file.sizeBytes) ||
    contract.model.file.sizeBytes < 1
  ) {
    throw new Error("llama.cpp model file must be one safe GGUF filename");
  }
  if (
    !isSafeLlamaCppServedModelAlias(contract.model.servedName) ||
    contract.policy.egress !== "disabled" ||
    contract.policy.modelDownloads !== "disabled" ||
    contract.policy.modelSource !== "verified-local"
  ) {
    throw new Error("llama.cpp host-local model or offline policy is invalid");
  }
  if (
    contract.runtime.gpu.vendor !== "nvidia" ||
    contract.runtime.gpu.count !== 1 ||
    contract.runtime.gpu.offload !== "full" ||
    contract.runtime.gpu.cpuFallback !== "reject"
  ) {
    throw new Error("llama.cpp host-local runtime must require one fully offloaded NVIDIA GPU");
  }
  positiveInteger(contract.runtime.resources.memoryBytes, "llama.cpp memory limit");
  positiveInteger(
    contract.runtime.resources.writableStorageBytes,
    "llama.cpp writable storage limit",
  );
  positiveInteger(contract.runtime.resources.pidsLimit, "llama.cpp PID limit", 4_096);
  positiveInteger(contract.serve.port, "llama.cpp server port", 65_535);
  positiveInteger(contract.serve.contextSize, "llama.cpp context size");
  positiveInteger(contract.serve.batchSize, "llama.cpp batch size");
  positiveInteger(contract.serve.microBatchSize, "llama.cpp micro-batch size");
  positiveInteger(contract.serve.limits.requestTimeoutSeconds, "llama.cpp request timeout", 86_400);
  if (contract.serve.microBatchSize > contract.serve.batchSize) {
    throw new Error("llama.cpp micro-batch size exceeds the batch size");
  }
  if (
    contract.serve.authentication !== "bearer" ||
    contract.serve.protocol !== "openai-completions" ||
    contract.serve.slots !== 1 ||
    contract.serve.idleSleepSeconds !== -1 ||
    contract.serve.flashAttention !== "enabled" ||
    contract.serve.speculativeDecoding !== "disabled" ||
    Object.values(contract.surfaces).some((state) => state !== "disabled")
  ) {
    throw new Error("llama.cpp host-local serving or disabled-surface contract is invalid");
  }
}

function validateBindings(
  contract: LlamaCppHostLocalLaunchContract,
  bindings: LlamaCppHostLocalRuntimeBindings,
): void {
  safeHostPath(bindings.model.hostPath, "llama.cpp model path");
  safeHostPath(bindings.apiKeyHostPath, "llama.cpp API-key path");
  if (
    bindings.model.digest !== contract.model.file.digest ||
    bindings.model.sizeBytes !== contract.model.file.sizeBytes
  ) {
    throw new Error(
      "llama.cpp verified model artifact does not match the declarative GGUF identity",
    );
  }
  if (
    !SAFE_NAME.test(bindings.containerName) ||
    bindings.network.isolation !== "docker-internal" ||
    !SAFE_NAME.test(bindings.network.name) ||
    DOCKER_BUILTIN_NETWORKS.has(bindings.network.name) ||
    !SAFE_LABEL_NAME.test(bindings.ownerLabel.name) ||
    !SAFE_LABEL_VALUE.test(bindings.ownerLabel.value) ||
    !IMAGE_DIGEST.test(bindings.imageReference)
  ) {
    throw new Error("llama.cpp host-local runtime binding is invalid");
  }
  positiveInteger(bindings.runtimeUid, "llama.cpp runtime uid", 2_147_483_647);
  positiveInteger(bindings.runtimeGid, "llama.cpp runtime gid", 2_147_483_647);
}

/**
 * Materialize the declarative llama.cpp contract around an already verified
 * local GGUF. Artifact acquisition is deliberately outside this adapter.
 */
export function buildLlamaCppHostLocalDockerArgv(
  contract: LlamaCppHostLocalLaunchContract,
  bindings: LlamaCppHostLocalRuntimeBindings,
): string[] {
  validateContract(contract);
  validateBindings(contract, bindings);
  const { resources } = contract.runtime;
  const { serve } = contract;
  const containerModelPath = `/models/${contract.model.file.path}`;
  const runtimeIdentity = `${String(bindings.runtimeUid)}:${String(bindings.runtimeGid)}`;
  return [
    "run",
    "--detach",
    "--name",
    bindings.containerName,
    "--label",
    `${bindings.ownerLabel.name}=${bindings.ownerLabel.value}`,
    "--network",
    bindings.network.name,
    "--user",
    runtimeIdentity,
    "--publish",
    `127.0.0.1::${String(serve.port)}`,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--memory",
    `${String(resources.memoryBytes)}b`,
    "--memory-swap",
    `${String(resources.memoryBytes)}b`,
    "--pids-limit",
    String(resources.pidsLimit),
    "--gpus",
    "1",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${String(resources.writableStorageBytes)},uid=${String(bindings.runtimeUid)},gid=${String(bindings.runtimeGid)},mode=1777`,
    "--mount",
    `type=bind,source=${bindings.model.hostPath},target=${containerModelPath},readonly`,
    "--mount",
    `type=bind,source=${bindings.apiKeyHostPath},target=${LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH},readonly`,
    bindings.imageReference,
    "--model",
    containerModelPath,
    "--alias",
    contract.model.servedName,
    "--host",
    "0.0.0.0",
    "--port",
    String(serve.port),
    "--gpu-layers",
    "all",
    "--ctx-size",
    String(serve.contextSize),
    "--parallel",
    String(serve.slots),
    "--sleep-idle-seconds",
    String(serve.idleSleepSeconds),
    "--batch-size",
    String(serve.batchSize),
    "--ubatch-size",
    String(serve.microBatchSize),
    "--cache-type-k",
    serve.kvCache.key,
    "--cache-type-v",
    serve.kvCache.value,
    "--flash-attn",
    "on",
    "--timeout",
    String(serve.limits.requestTimeoutSeconds),
    "--api-key-file",
    LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH,
    "--metrics",
    "--no-ui",
    "--no-slots",
    "--no-mmproj",
    "--no-agent",
  ];
}
