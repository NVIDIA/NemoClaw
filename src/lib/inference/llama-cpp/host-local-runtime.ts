// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { type BigIntStats, lstatSync, realpathSync } from "node:fs";
import path from "node:path";

import { isSafeLlamaCppServedModelAlias } from "./contract";

export const LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH =
  "/run/secrets/llama-cpp-api-key" as const;
export const LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH =
  "/usr/local/bin/nemoclaw-llama-cpp-request-guard" as const;
export const LLAMA_CPP_HOST_LOCAL_SERVER_PATH = "/usr/local/bin/llama-server" as const;

const SAFE_HOST_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const SAFE_LABEL_NAME = /^[a-z0-9][a-z0-9.-]{0,127}$/u;
const SAFE_LABEL_VALUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const IMAGE_DIGEST =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]+)?\/)?(?:[a-z0-9]+(?:[._-][a-z0-9]+)*\/)*[a-z0-9]+(?:[._-][a-z0-9]+)*@sha256:[0-9a-f]{64}$/u;
const GGUF_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}\.gguf$/u;
const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const CONTAINER_CHAT_TEMPLATE_FILE =
  /^\/usr\/local\/share\/nemoclaw\/llama-cpp\/chat-templates\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.jinja$/u;
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
    readonly restartPolicy: "unless-stopped";
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
    readonly chatTemplate: "nemotron-v3-embedded" | "container-jinja-file" | "model-embedded-jinja";
    readonly chatTemplateFile?: string;
    readonly chatTemplateArguments?: {
      readonly reasoningStrength: "low" | "medium" | "high" | "xhigh";
    };
    readonly reasoning?: {
      readonly format: "deepseek";
      readonly mode: "auto";
    };
    readonly contextSize: number;
    readonly flashAttention: "enabled";
    readonly idleSleepSeconds: -1;
    readonly kvCache: {
      readonly key: "f16" | "q8_0" | "q4_0";
      readonly value: "f16" | "q8_0" | "q4_0";
    };
    readonly limits: {
      readonly maxRequestBodyBytes: number;
      readonly maxRequestHeaderBytes: number;
      readonly maxOutputTokens: number;
      readonly requestTimeoutSeconds: number;
      readonly shutdownTimeoutSeconds: number;
    };
    readonly requestGuard: {
      readonly upstreamPort: number;
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
  /** Fixed host bridge port for product installs; omitted only by isolated qualification. */
  readonly hostPort?: number;
  readonly model: VerifiedLocalModelArtifact;
  /** The caller must create this named Docker network with `--internal` before launch. */
  readonly network: {
    readonly isolation: "docker-internal";
    readonly name: string;
  };
  readonly ownerLabel: { readonly name: string; readonly value: string };
  readonly identityLabels?: readonly { readonly name: string; readonly value: string }[];
  readonly runtimeGid: number;
  readonly runtimeUid: number;
}

export interface VerifiedLocalModelArtifact {
  readonly digest: string;
  /** Executor-only identity captured from the descriptor that verified this file. */
  readonly filesystemIdentity: {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mtimeNs: bigint;
    readonly size: bigint;
  };
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
    contract.runtime.restartPolicy !== "unless-stopped" ||
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
  positiveInteger(
    contract.serve.limits.maxRequestBodyBytes,
    "llama.cpp maximum request body bytes",
    64 * 1_024 * 1_024,
  );
  positiveInteger(
    contract.serve.limits.maxRequestHeaderBytes,
    "llama.cpp maximum request header bytes",
    1_024 * 1_024,
  );
  positiveInteger(
    contract.serve.limits.maxOutputTokens,
    "llama.cpp maximum output tokens",
    1_024 * 1_024,
  );
  positiveInteger(contract.serve.limits.requestTimeoutSeconds, "llama.cpp request timeout", 86_400);
  positiveInteger(
    contract.serve.limits.shutdownTimeoutSeconds,
    "llama.cpp shutdown timeout",
    86_400,
  );
  positiveInteger(contract.serve.requestGuard.upstreamPort, "llama.cpp upstream port", 65_535);
  if (
    contract.serve.limits.maxOutputTokens > contract.serve.contextSize ||
    contract.serve.requestGuard.upstreamPort === contract.serve.port
  ) {
    throw new Error("llama.cpp request-guard limits or ports are invalid");
  }
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
  const { chatTemplate, chatTemplateFile, chatTemplateArguments, reasoning } = contract.serve;
  const reasoningStrength = chatTemplateArguments?.reasoningStrength;
  const chatTemplateArgumentsAreExact =
    chatTemplateArguments !== undefined &&
    chatTemplateArguments !== null &&
    typeof chatTemplateArguments === "object" &&
    Object.keys(chatTemplateArguments).length === 1 &&
    ["low", "medium", "high", "xhigh"].includes(reasoningStrength ?? "");
  if (
    (chatTemplate === "nemotron-v3-embedded" &&
      (chatTemplateFile !== undefined ||
        chatTemplateArguments !== undefined ||
        reasoning !== undefined)) ||
    (chatTemplate === "container-jinja-file" &&
      (chatTemplateFile === undefined ||
        chatTemplateArguments !== undefined ||
        !CONTAINER_CHAT_TEMPLATE_FILE.test(chatTemplateFile) ||
        path.posix.normalize(chatTemplateFile) !== chatTemplateFile)) ||
    (chatTemplate === "model-embedded-jinja" &&
      (chatTemplateFile !== undefined ||
        reasoning !== undefined ||
        chatTemplateArguments === undefined ||
        !chatTemplateArgumentsAreExact)) ||
    (chatTemplate !== "nemotron-v3-embedded" &&
      chatTemplate !== "container-jinja-file" &&
      chatTemplate !== "model-embedded-jinja") ||
    (reasoning !== undefined && (reasoning.format !== "deepseek" || reasoning.mode !== "auto"))
  ) {
    throw new Error("llama.cpp chat-template or reasoning contract is invalid");
  }
}

/** Re-prove executor-only filesystem identity before a container-engine mutation. */
export function assertLlamaCppVerifiedLocalModelArtifact(
  contract: LlamaCppHostLocalLaunchContract,
  model: VerifiedLocalModelArtifact,
): void {
  safeHostPath(model.hostPath, "llama.cpp model path");
  if (
    model.digest !== contract.model.file.digest ||
    model.sizeBytes !== contract.model.file.sizeBytes
  ) {
    throw new Error(
      "llama.cpp verified model artifact does not match the declarative GGUF identity",
    );
  }
  let canonicalModelPath: string;
  let modelStatus: BigIntStats;
  try {
    canonicalModelPath = realpathSync(model.hostPath);
    modelStatus = lstatSync(model.hostPath, { bigint: true });
  } catch {
    throw new Error("llama.cpp verified model artifact is unavailable");
  }
  const identity = model.filesystemIdentity;
  if (
    !identity ||
    typeof identity.dev !== "bigint" ||
    typeof identity.ino !== "bigint" ||
    typeof identity.size !== "bigint" ||
    typeof identity.mtimeNs !== "bigint" ||
    typeof identity.ctimeNs !== "bigint" ||
    canonicalModelPath !== model.hostPath ||
    !modelStatus.isFile() ||
    modelStatus.dev !== identity.dev ||
    modelStatus.ino !== identity.ino ||
    modelStatus.size !== identity.size ||
    modelStatus.mtimeNs !== identity.mtimeNs ||
    modelStatus.ctimeNs !== identity.ctimeNs ||
    modelStatus.size !== BigInt(model.sizeBytes)
  ) {
    throw new Error(
      "llama.cpp verified model artifact does not match its verified filesystem identity",
    );
  }
}

function validateBindings(
  contract: LlamaCppHostLocalLaunchContract,
  bindings: LlamaCppHostLocalRuntimeBindings,
): void {
  assertLlamaCppVerifiedLocalModelArtifact(contract, bindings.model);
  safeHostPath(bindings.apiKeyHostPath, "llama.cpp API-key path");
  if (
    !SAFE_NAME.test(bindings.containerName) ||
    bindings.network.isolation !== "docker-internal" ||
    !SAFE_NAME.test(bindings.network.name) ||
    DOCKER_BUILTIN_NETWORKS.has(bindings.network.name) ||
    !SAFE_LABEL_NAME.test(bindings.ownerLabel.name) ||
    !SAFE_LABEL_VALUE.test(bindings.ownerLabel.value) ||
    bindings.identityLabels?.some(
      ({ name, value }) =>
        name === bindings.ownerLabel.name ||
        !SAFE_LABEL_NAME.test(name) ||
        !SAFE_LABEL_VALUE.test(value),
    ) ||
    new Set(bindings.identityLabels?.map(({ name }) => name)).size !==
      (bindings.identityLabels?.length ?? 0) ||
    !IMAGE_DIGEST.test(bindings.imageReference)
  ) {
    throw new Error("llama.cpp host-local runtime binding is invalid");
  }
  positiveInteger(bindings.runtimeUid, "llama.cpp runtime uid", 2_147_483_647);
  positiveInteger(bindings.runtimeGid, "llama.cpp runtime gid", 2_147_483_647);
  if (bindings.hostPort !== undefined) {
    positiveInteger(bindings.hostPort, "llama.cpp host port", 65_535);
  }
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
  return [
    ...buildLlamaCppHostLocalDockerRunArgv(contract, bindings),
    bindings.imageReference,
    ...buildLlamaCppHostLocalServerArgv(contract),
  ];
}

const dockerLoopbackPublishAuthorityBrand = Symbol("DockerLoopbackPublishAuthority");
const issuedDockerLoopbackPublishAuthorities = new WeakSet<object>();
const consumedDockerLoopbackPublishAuthorities = new WeakSet<object>();
const MINIMUM_SECURE_DOCKER_LOOPBACK_PUBLISH_VERSION = [28, 3, 3] as const;

export interface DockerLoopbackPublishAuthority {
  readonly serverVersion: string;
  readonly [dockerLoopbackPublishAuthorityBrand]: true;
}

/**
 * Admit Docker loopback publishing only after querying the live server through the launch endpoint.
 * The trusted qualification host must retain Docker's default protected NAT and firewall behavior.
 */
export function qualifyDockerLoopbackPublishAuthority(
  serverVersionOutput: string,
): DockerLoopbackPublishAuthority {
  const serverVersion = serverVersionOutput.trim();
  const match = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:\+[0-9A-Za-z.-]+)?$/u.exec(
    serverVersion,
  );
  const version = match?.slice(1, 4).map(Number);
  const meetsMinimum =
    version !== undefined &&
    (version[0]! > MINIMUM_SECURE_DOCKER_LOOPBACK_PUBLISH_VERSION[0] ||
      (version[0] === MINIMUM_SECURE_DOCKER_LOOPBACK_PUBLISH_VERSION[0] &&
        (version[1]! > MINIMUM_SECURE_DOCKER_LOOPBACK_PUBLISH_VERSION[1] ||
          (version[1] === MINIMUM_SECURE_DOCKER_LOOPBACK_PUBLISH_VERSION[1] &&
            version[2]! >= MINIMUM_SECURE_DOCKER_LOOPBACK_PUBLISH_VERSION[2]))));
  if (
    !version ||
    version.length !== 3 ||
    version.some((part) => !Number.isSafeInteger(part)) ||
    !meetsMinimum
  ) {
    throw new Error(
      "llama.cpp qualification requires Docker Engine 28.3.3 or newer for loopback publishing.",
    );
  }
  const authority = Object.freeze({
    serverVersion,
    [dockerLoopbackPublishAuthorityBrand]: true as const,
  });
  issuedDockerLoopbackPublishAuthorities.add(authority);
  return authority;
}

/** Consume a single-use authority immediately before one Docker loopback publication. */
export function consumeDockerLoopbackPublishAuthority(
  authority: DockerLoopbackPublishAuthority,
): void {
  if (
    typeof authority !== "object" ||
    authority === null ||
    authority[dockerLoopbackPublishAuthorityBrand] !== true ||
    !issuedDockerLoopbackPublishAuthorities.has(authority)
  ) {
    throw new Error("llama.cpp Docker loopback publishing authority is invalid.");
  }
  if (consumedDockerLoopbackPublishAuthorities.has(authority)) {
    throw new Error("llama.cpp Docker loopback publishing authority was already consumed.");
  }
  consumedDockerLoopbackPublishAuthorities.add(authority);
}

/** Activate the request guard only for an image that declares the owned guard artifact. */
export function buildLlamaCppRequestGuardDockerArgv(
  contract: LlamaCppHostLocalLaunchContract,
  bindings: LlamaCppHostLocalRuntimeBindings,
): string[] {
  validateContract(contract);
  validateBindings(contract, bindings);
  return [
    ...buildLlamaCppHostLocalDockerRunArgv(contract, bindings),
    "--entrypoint",
    LLAMA_CPP_HOST_LOCAL_REQUEST_GUARD_PATH,
    bindings.imageReference,
    ...buildLlamaCppRequestGuardCommandArgv(contract),
  ];
}

/** Reconstruct the immutable request-guard command for lifecycle inspection. */
export function buildLlamaCppRequestGuardCommandArgv(
  contract: LlamaCppHostLocalLaunchContract,
): readonly string[] {
  validateContract(contract);
  const { limits } = contract.serve;
  return Object.freeze([
    "--listen-host",
    "0.0.0.0",
    "--listen-port",
    String(contract.serve.port),
    "--upstream-host",
    "127.0.0.1",
    "--upstream-port",
    String(contract.serve.requestGuard.upstreamPort),
    "--max-request-body-bytes",
    String(limits.maxRequestBodyBytes),
    "--max-request-header-bytes",
    String(limits.maxRequestHeaderBytes),
    "--max-output-tokens",
    String(limits.maxOutputTokens),
    "--request-timeout-seconds",
    String(limits.requestTimeoutSeconds),
    "--shutdown-timeout-seconds",
    String(limits.shutdownTimeoutSeconds),
    "--",
    LLAMA_CPP_HOST_LOCAL_SERVER_PATH,
    ...buildLlamaCppHostLocalServerArgvForAddress(contract, {
      host: "127.0.0.1",
      maxOutputTokens: limits.maxOutputTokens,
      port: contract.serve.requestGuard.upstreamPort,
    }),
  ]);
}

function buildLlamaCppHostLocalDockerRunArgv(
  contract: LlamaCppHostLocalLaunchContract,
  bindings: LlamaCppHostLocalRuntimeBindings,
): string[] {
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
    ...(bindings.identityLabels ?? []).flatMap(({ name, value }) => [
      "--label",
      `${name}=${value}`,
    ]),
    "--network",
    bindings.network.name,
    "--restart",
    contract.runtime.restartPolicy,
    "--user",
    runtimeIdentity,
    "--read-only",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges=true",
    "--no-healthcheck",
    "--memory",
    `${String(resources.memoryBytes)}b`,
    "--memory-swap",
    `${String(resources.memoryBytes)}b`,
    "--pids-limit",
    String(resources.pidsLimit),
    "--gpus",
    "driver=nvidia,count=1",
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${String(resources.writableStorageBytes)},uid=${String(bindings.runtimeUid)},gid=${String(bindings.runtimeGid)},mode=1777`,
    "--mount",
    `type=bind,source=${bindings.model.hostPath},target=${containerModelPath},readonly`,
    "--mount",
    `type=bind,source=${bindings.apiKeyHostPath},target=${LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH},readonly`,
  ];
}

/** Reconstruct the immutable in-container server command without host filesystem state. */
export function buildLlamaCppHostLocalServerArgv(
  contract: LlamaCppHostLocalLaunchContract,
): readonly string[] {
  return buildLlamaCppHostLocalServerArgvForAddress(contract, {
    host: "0.0.0.0",
    port: contract.serve.port,
  });
}

function buildLlamaCppHostLocalServerArgvForAddress(
  contract: LlamaCppHostLocalLaunchContract,
  address: {
    readonly host: "0.0.0.0" | "127.0.0.1";
    readonly maxOutputTokens?: number;
    readonly port: number;
  },
): readonly string[] {
  validateContract(contract);
  positiveInteger(address.port, "llama.cpp command port", 65_535);
  const { serve } = contract;
  const containerModelPath = `/models/${contract.model.file.path}`;
  return Object.freeze([
    "--model",
    containerModelPath,
    "--alias",
    contract.model.servedName,
    "--host",
    address.host,
    "--port",
    String(address.port),
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
    ...(serve.chatTemplate === "container-jinja-file"
      ? ["--jinja", "--chat-template-file", serve.chatTemplateFile!]
      : serve.chatTemplate === "model-embedded-jinja"
        ? [
            "--jinja",
            "--chat-template-kwargs",
            JSON.stringify({ reasoning_strength: serve.chatTemplateArguments!.reasoningStrength }),
          ]
        : []),
    ...(serve.reasoning
      ? ["--reasoning-format", serve.reasoning.format, "--reasoning", serve.reasoning.mode]
      : []),
    ...(address.maxOutputTokens === undefined
      ? []
      : ["--n-predict", String(address.maxOutputTokens)]),
    "--api-key-file",
    LLAMA_CPP_HOST_LOCAL_CONTAINER_API_KEY_PATH,
    "--metrics",
    "--no-ui",
    "--no-slots",
    "--no-mmproj",
    "--no-agent",
  ]);
}
