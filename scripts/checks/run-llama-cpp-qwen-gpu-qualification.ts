// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  cleanupManagedLlamaCppRuntimeForSandbox,
  type LocalModelRuntimeCleanupResult,
} from "../../src/lib/inference/local-model-profile/cleanup.ts";
import {
  installManagedLlamaCpp,
  MANAGED_LLAMA_CPP_CONTAINER_NAME,
  MANAGED_LLAMA_CPP_NETWORK_NAME,
} from "../../src/lib/inference/llama-cpp/managed-installer.ts";
import { managedLlamaCppStatePaths } from "../../src/lib/inference/llama-cpp/managed-state.ts";
import { isLlamaCppServingRecipe } from "../../src/lib/inference/serving/adapter-registry.ts";
import { managedInferenceDigest } from "../../src/lib/inference/serving/catalog-integrity.ts";
import { loadManagedInferenceCatalog } from "../../src/lib/inference/serving/catalog-loader.ts";
import type { ResolvedLlamaCppInferenceSelection } from "../../src/lib/inference/serving/types.ts";
import { createDockerRuntimeProviderBundle } from "../../src/lib/onboard/runtime-provider/docker.ts";
import { createDockerLlamaCppPrivateBridgeController } from "../../src/lib/onboard/runtime-provider/docker-llama-cpp-private-bridge.ts";
import {
  runLlamaCppOpenClawAgentQualification,
  type LlamaCppOpenClawAgentQualificationPlan,
} from "./llama-cpp-openclaw-agent-qualification.mts";
import { runManagedImageOpenShellE2e } from "./run-managed-image-openshell-e2e.ts";

const TARGET_ID = "llama-cpp-qwen-gpu";
const PRESET_ID = "llama-cpp.n1x-wsl-arm64.single.qwen3-6-35b-a3b";
const RECIPE_ID = "llama-cpp.qwen3-6-35b-a3b.n1x-wsl.v1";
const SANDBOX_NAME = "nmc-lcpp-qwen-rtx";
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const OPENCLAW_IMAGE_PATTERN =
  /^ghcr\.io\/nvidia\/nemoclaw\/openclaw-sandbox@sha256:[a-f0-9]{64}$/u;
const MAX_COMMAND_BYTES = 16 * 1024 * 1024;

export function qwenGpuAgentPlan(
  imageReference: string,
  sourceRevision: string,
): LlamaCppOpenClawAgentQualificationPlan {
  if (!OPENCLAW_IMAGE_PATTERN.test(imageReference) || !SHA_PATTERN.test(sourceRevision)) {
    throw new Error("managed-image cohort returned an invalid OpenClaw identity");
  }
  return Object.freeze({
    agent: "openclaw",
    bounds: {
      commandTimeoutSeconds: 420,
      maxResponseBytes: MAX_COMMAND_BYTES,
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

type QualificationSetting = {
  readonly modelFile: {
    readonly digest: string;
    readonly path: string;
    readonly sizeBytes: number;
  };
  readonly selection: ResolvedLlamaCppInferenceSelection;
};

type CommandResult = {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

type ManagedImageReceipt = {
  readonly cohort: string;
  readonly revision: string;
  readonly runAttempt: number;
  readonly runId: number;
  readonly openClawAmd64: string;
};

function requiredEnvironment(name: string, pattern?: RegExp): string {
  const value = String(process.env[name] ?? "").trim();
  if (!value || (pattern && !pattern.test(value))) {
    throw new Error(`${name} is missing or invalid`);
  }
  return value;
}

function run(command: string, args: readonly string[], timeout = 30_000): CommandResult {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: process.env,
    killSignal: "SIGKILL",
    maxBuffer: MAX_COMMAND_BYTES,
    timeout,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function requireCommand(command: string, args: readonly string[], timeout?: number): string {
  const result = run(command, args, timeout);
  if (result.status !== 0) {
    throw new Error(
      `${command} failed with status ${String(result.status)}: ${result.stderr.slice(-4_000)}`,
    );
  }
  return result.stdout;
}

function loadQwenGpuSetting(): QualificationSetting {
  const catalog = loadManagedInferenceCatalog();
  const preset = catalog.presets.find(({ metadata }) => metadata.id === PRESET_ID);
  const recipe = catalog.recipes.find(({ metadata }) => metadata.id === RECIPE_ID);
  if (!preset) throw new Error("N1x WSL Qwen serving preset is missing");
  if (!recipe || !isLlamaCppServingRecipe(recipe)) {
    throw new Error("N1x WSL Qwen llama.cpp recipe is missing");
  }
  const modelFile = recipe.spec.model.files[0];
  if (!modelFile || !("sizeBytes" in modelFile)) {
    throw new Error("N1x WSL Qwen GGUF identity is incomplete");
  }
  return {
    modelFile,
    selection: {
      outcome: "selected",
      selection: "explicit",
      catalogDigest: catalog.catalogDigest,
      presetDigest: managedInferenceDigest(preset),
      recipeDigest: managedInferenceDigest(recipe),
      preset,
      recipe,
    },
  };
}

function loadManagedImageReceipt(): ManagedImageReceipt {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requiredEnvironment("NEMOCLAW_E2E_MANAGED_IMAGE_COHORT_RECEIPT"));
  } catch {
    throw new Error("managed-image cohort receipt is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("managed-image cohort receipt must be an object");
  }
  const receipt = parsed as Record<string, unknown>;
  const images = receipt.images as Record<string, unknown> | undefined;
  const openClaw = images?.openclaw as Record<string, unknown> | undefined;
  const openClawAmd64 = openClaw?.["linux/amd64"];
  if (
    receipt.kind !== "nemoclaw-managed-image-cohort-receipt-v1" ||
    typeof receipt.cohort !== "string" ||
    typeof receipt.revision !== "string" ||
    !SHA_PATTERN.test(receipt.revision) ||
    !Number.isSafeInteger(receipt.runAttempt) ||
    !Number.isSafeInteger(receipt.runId) ||
    typeof openClawAmd64 !== "string" ||
    !OPENCLAW_IMAGE_PATTERN.test(openClawAmd64)
  ) {
    throw new Error("managed-image cohort receipt does not bind one OpenClaw amd64 image");
  }
  return {
    cohort: receipt.cohort,
    revision: receipt.revision,
    runAttempt: Number(receipt.runAttempt),
    runId: Number(receipt.runId),
    openClawAmd64,
  };
}

function modelCacheEntry(setting: QualificationSetting): string {
  const recipe = setting.selection.recipe;
  return path.join(
    os.homedir(),
    ".cache",
    "huggingface",
    "hub",
    `models--${recipe.spec.model.id.replaceAll("/", "--")}`,
    "snapshots",
    recipe.spec.model.revision,
    setting.modelFile.path,
  );
}

function responseText(source: string): string {
  const body = JSON.parse(source) as {
    choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
  };
  return String(body.choices?.[0]?.message?.content ?? body.choices?.[0]?.text ?? "");
}

export function validateQwenGpuStartupLog(log: string): {
  readonly offloadedLayers: number;
  readonly totalLayers: number;
} {
  if (Buffer.byteLength(log) < 1 || Buffer.byteLength(log) > MAX_COMMAND_BYTES) {
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

function requireCleanup(
  result: LocalModelRuntimeCleanupResult,
): Extract<LocalModelRuntimeCleanupResult, { ok: true }> {
  if (!result.ok) throw new Error(result.reason);
  return result;
}

function writeJson(root: string, name: string, value: unknown): void {
  const target = path.resolve(root, name);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error("artifact path escapes root");
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function runQwenGpuQualification(): Promise<void> {
  const candidateSha = requiredEnvironment(
    "NEMOCLAW_LLAMA_CPP_QUALIFICATION_HEAD_SHA",
    SHA_PATTERN,
  );
  const artifactRoot = path.resolve(requiredEnvironment("E2E_ARTIFACT_DIR"));
  fs.mkdirSync(artifactRoot, { recursive: true, mode: 0o700 });
  const canonicalArtifactRoot = fs.realpathSync(artifactRoot);
  const architecture = requireCommand("uname", ["-m"]).trim();
  if (architecture !== "x86_64") throw new Error("RTX qualification requires Linux amd64");
  const gpuFields = requireCommand("nvidia-smi", [
    "--query-gpu=name,driver_version,memory.total",
    "--format=csv,noheader,nounits",
  ])
    .trim()
    .split("\n")[0]
    ?.split(",")
    .map((value) => value.trim());
  if (!gpuFields || gpuFields.length !== 3 || !gpuFields.every(Boolean)) {
    throw new Error("RTX qualification could not read bounded NVIDIA GPU identity");
  }
  if (!/\bRTX PRO 6000\b/iu.test(gpuFields[0] ?? "")) {
    throw new Error("Qwen GPU qualification requires the RTX PRO 6000 runner");
  }

  const setting = loadQwenGpuSetting();
  const managedImage = loadManagedImageReceipt();
  const agentPlan = qwenGpuAgentPlan(managedImage.openClawAmd64, managedImage.revision);
  const recipe = setting.selection.recipe;
  const statePaths = managedLlamaCppStatePaths(os.homedir());
  const cacheEntry = modelCacheEntry(setting);
  const installLog: string[] = [];
  const credentialName = "NEMOCLAW_LLAMACPP_LOCAL_TOKEN";
  const baseUrlName = "NEMOCLAW_E2E_LOCAL_INFERENCE_BASE_URL";
  const priorCredential = process.env[credentialName];
  const priorBaseUrl = process.env[baseUrlName];
  let apiKey: string | undefined;
  let transactionId: string | undefined;
  let runtimeCleanup: Extract<LocalModelRuntimeCleanupResult, { ok: true }> | undefined;
  let runtimeEvidence:
    | {
        readonly fullGpuOffload: true;
        readonly image: string;
        readonly noDockerPublishedPort: true;
        readonly offloadedLayers: number;
        readonly platform: "linux/amd64";
        readonly totalLayers: number;
      }
    | undefined;
  let qualificationEvidence: Record<string, unknown> | undefined;
  let primaryError: unknown;

  try {
    const agentResult = await runManagedImageOpenShellE2e(
      {
        agent: "openclaw",
        image: agentPlan.image.reference,
        localProvider: "llama-cpp",
        model: recipe.spec.model.servedName,
        sandbox: SANDBOX_NAME,
      },
      (context) => runLlamaCppOpenClawAgentQualification(agentPlan, context),
      {
        async afterGatewayStarted() {
          const installed = await installManagedLlamaCpp(setting.selection, {
            sandboxName: SANDBOX_NAME,
            runtimeProvider: createDockerRuntimeProviderBundle(),
            env: process.env,
            log: (message) => installLog.push(message),
          });
          if (!installed.ok) throw new Error(installed.reason);
          apiKey = installed.apiKey;
          const modelAuthority =
            installed.receipt.runtime.kind === "container"
              ? installed.receipt.runtime.model
              : undefined;
          if (!modelAuthority) throw new Error("managed llama.cpp receipt runtime is incomplete");
          if (
            modelAuthority.recipeId !== RECIPE_ID ||
            modelAuthority.digest !== setting.modelFile.digest ||
            modelAuthority.sizeBytes !== setting.modelFile.sizeBytes
          ) {
            throw new Error(
              "managed llama.cpp receipt does not bind the exact Qwen recipe and GGUF",
            );
          }
          if (
            installed.receipt.inference?.protocol !== "openai-chat-completions" ||
            installed.receipt.inference.model !== recipe.spec.model.servedName ||
            installed.receipt.inference.toolCallingRequired !== true
          ) {
            throw new Error("managed llama.cpp startup did not prove a Qwen tool call");
          }
          transactionId = modelAuthority.generation;

          const container = JSON.parse(
            requireCommand("docker", ["container", "inspect", MANAGED_LLAMA_CPP_CONTAINER_NAME]),
          ) as Array<{
            HostConfig?: { PortBindings?: Record<string, unknown> };
            NetworkSettings?: { Ports?: Record<string, unknown> };
            State?: { Running?: unknown };
          }>;
          if (
            container[0]?.State?.Running !== true ||
            JSON.stringify(container[0]?.HostConfig?.PortBindings) !== "{}" ||
            !Object.values(container[0]?.NetworkSettings?.Ports ?? {}).every(
              (value) => value === null,
            )
          ) {
            throw new Error("managed llama.cpp did not retain its running no-publication boundary");
          }
          const imagePlatform = JSON.parse(
            requireCommand("docker", ["image", "inspect", recipe.spec.runtime.image]),
          ) as Array<{ Architecture?: unknown; Os?: unknown }>;
          if (imagePlatform[0]?.Architecture !== "amd64" || imagePlatform[0]?.Os !== "linux") {
            throw new Error("managed llama.cpp did not select the Linux amd64 runtime image");
          }
          const offload = validateQwenGpuStartupLog(
            requireCommand("docker", ["logs", "--tail", "20000", MANAGED_LLAMA_CPP_CONTAINER_NAME]),
          );
          const unauthorized = requireCommand("curl", [
            "-sS",
            "-o",
            "/dev/null",
            "-w",
            "%{http_code}",
            `http://127.0.0.1:${String(recipe.spec.serve.port)}/props`,
          ]).trim();
          if (unauthorized !== "401") {
            throw new Error("managed llama.cpp accepted an unauthenticated request");
          }
          const hostChat = requireCommand(
            "curl",
            [
              "-fsS",
              "-H",
              `Authorization: Bearer ${apiKey}`,
              "-H",
              "Content-Type: application/json",
              `http://127.0.0.1:${String(recipe.spec.serve.port)}/v1/chat/completions`,
              "--data",
              JSON.stringify({
                model: recipe.spec.model.servedName,
                messages: [{ role: "user", content: agentPlan.prompts.normal }],
                max_tokens: agentPlan.bounds.maxTokens,
              }),
            ],
            5 * 60_000,
          );
          if (!responseText(hostChat).includes(agentPlan.expectations.normal)) {
            throw new Error("managed llama.cpp host inference did not return PONG");
          }
          process.env[credentialName] = apiKey;
          process.env[baseUrlName] = agentPlan.route.upstreamBaseUrl;
          runtimeEvidence = {
            image: recipe.spec.runtime.image,
            platform: "linux/amd64",
            fullGpuOffload: true,
            offloadedLayers: offload.offloadedLayers,
            totalLayers: offload.totalLayers,
            noDockerPublishedPort: true,
          };
        },
        beforeCleanup() {
          if (!apiKey) return;
          runtimeCleanup = requireCleanup(
            cleanupManagedLlamaCppRuntimeForSandbox(SANDBOX_NAME, { env: process.env }),
          );
          if (transactionId) {
            createDockerLlamaCppPrivateBridgeController().assertStopped(transactionId);
          }
        },
      },
    );
    if (!agentResult.probeEvidence || !runtimeEvidence) {
      throw new Error("OpenClaw Qwen qualification returned incomplete evidence");
    }
    qualificationEvidence = {
      candidateSha,
      boundary:
        "RTX validates the exact Qwen llama.cpp recipe; N1x WSL qualification remains pending",
      host: {
        architecture,
        gpuName: gpuFields[0],
        driverVersion: gpuFields[1],
        gpuMemoryMiB: Number(gpuFields[2]),
      },
      managedImage: {
        cohort: managedImage.cohort,
        reference: managedImage.openClawAmd64,
        revision: managedImage.revision,
        runAttempt: managedImage.runAttempt,
        runId: managedImage.runId,
      },
      preset: { id: PRESET_ID, digest: setting.selection.presetDigest },
      recipe: { id: RECIPE_ID, digest: setting.selection.recipeDigest },
      model: {
        id: recipe.spec.model.id,
        revision: recipe.spec.model.revision,
        digest: setting.modelFile.digest,
        servedName: recipe.spec.model.servedName,
      },
      runtime: runtimeEvidence,
      probes: {
        startupToolCall: true,
        unauthorizedStatus: 401,
        hostChat: "passed",
        openClaw: agentResult.probeEvidence,
      },
    };
  } catch (error) {
    primaryError = error;
  } finally {
    if (priorCredential === undefined) delete process.env[credentialName];
    else process.env[credentialName] = priorCredential;
    if (priorBaseUrl === undefined) delete process.env[baseUrlName];
    else process.env[baseUrlName] = priorBaseUrl;
    if (apiKey) {
      for (const index of installLog.keys())
        installLog[index] = installLog[index]!.replaceAll(apiKey, "<REDACTED>");
    }
    fs.writeFileSync(
      path.join(canonicalArtifactRoot, "managed-llama-cpp-install.log"),
      `${installLog.join("\n")}\n`,
      {
        encoding: "utf8",
        mode: 0o600,
      },
    );
    try {
      runtimeCleanup ??= requireCleanup(
        cleanupManagedLlamaCppRuntimeForSandbox(SANDBOX_NAME, { env: process.env }),
      );
      if (transactionId) {
        createDockerLlamaCppPrivateBridgeController().assertStopped(transactionId);
      }
      if (
        run("docker", ["container", "inspect", MANAGED_LLAMA_CPP_CONTAINER_NAME]).status !== 1 ||
        run("docker", ["network", "inspect", MANAGED_LLAMA_CPP_NETWORK_NAME]).status !== 1 ||
        fs.existsSync(statePaths.stateDir)
      ) {
        throw new Error("managed llama.cpp cleanup left owned runtime state");
      }
      if (apiKey && !fs.existsSync(cacheEntry)) {
        throw new Error("managed llama.cpp cleanup removed the verified shared Qwen model");
      }
      writeJson(canonicalArtifactRoot, "cleanup.json", {
        status: "passed",
        removed: runtimeCleanup.removed,
        preserved: runtimeCleanup.preserved,
        modelCachePreserved: Boolean(apiKey),
      });
    } catch (cleanupError) {
      writeJson(canonicalArtifactRoot, "cleanup.json", {
        status: "failed",
        reason: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
      });
      if (!primaryError) primaryError = cleanupError;
    }
  }

  if (primaryError) throw primaryError;
  if (!qualificationEvidence) throw new Error("Qwen GPU qualification produced no evidence");
  writeJson(canonicalArtifactRoot, "qualification-evidence.json", qualificationEvidence);
  writeJson(canonicalArtifactRoot, "target-result.json", {
    id: TARGET_ID,
    status: "passed",
    candidateSha,
    fullGpuOffload: true,
    model: setting.selection.recipe.spec.model.servedName,
    n1xWslPending: true,
    runner: "qualification-script",
  });
}

if (typeof require !== "undefined" && typeof module !== "undefined" && require.main === module) {
  void runQwenGpuQualification().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
