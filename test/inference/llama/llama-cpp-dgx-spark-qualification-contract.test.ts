// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LLAMA_CPP_DGX_SPARK_AGENT_PROBES,
  LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE,
  LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
  LLAMA_CPP_DGX_SPARK_DIGEST_PATTERN,
  LLAMA_CPP_DGX_SPARK_ENVIRONMENT_PATTERN,
  LLAMA_CPP_DGX_SPARK_GPU_PATTERN,
  LLAMA_CPP_DGX_SPARK_MODEL_DIGEST,
  LLAMA_CPP_DGX_SPARK_MODEL_ID,
  LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN,
  LLAMA_CPP_DGX_SPARK_OPENCLAW_IMAGE,
  LLAMA_CPP_DGX_SPARK_OPENCLAW_SANDBOX,
  LLAMA_CPP_DGX_SPARK_OPENCLAW_SOURCE_REVISION,
  LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
  LLAMA_CPP_DGX_SPARK_REJECTED_REQUEST_BODY_BYTES,
  LLAMA_CPP_DGX_SPARK_RUNNER_PATTERN,
  LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
  LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256,
  LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_SOURCE_REVISION,
  LLAMA_CPP_DGX_SPARK_TOOL_IMAGE,
  llamaCppDgxSparkExecutionPlanSha256,
  parseLlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkQualificationActivation,
  parseLlamaCppDgxSparkQualificationEvidenceIdentity,
  parseLlamaCppDgxSparkQualificationPlan,
  parseLlamaCppDgxSparkQualificationReceipt as parseQualificationReceiptWithPlan,
  verifyLlamaCppDgxSparkExecutionPlanSha256,
} from "../../../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const MODEL_HOST_PATH = "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";

function probeBounds() {
  return {
    cancellationMaxTokens: 4096,
    clientTimeoutMilliseconds: 250,
    maxResponseBytes: 16777216,
    maxStreamEvents: 512,
    maxTokens: {
      streamingChat: 32,
      structuredOutput: 64,
      synchronousChat: 16,
      toolCall: 256,
      toolResultContinuation: 64,
    },
  };
}

function activation() {
  return {
    contractVersion: 1,
    jobId: LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
    profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
  };
}

function agentQualification() {
  return {
    agent: "openclaw",
    bounds: {
      commandTimeoutSeconds: 420,
      maxResponseBytes: 16777216,
      maxStreamEvents: 512,
      maxTokens: 32,
    },
    execution: "disabled",
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
      continuation:
        "Repeat the exact value LLAMA_CPP_OPENCLAW_TOOL_OK from the file you read in the prior turn.",
      normal: "Reply with exactly one word: PONG",
      tool: "Use the read tool to read /tmp/nemoclaw-llama-cpp-tool.txt. Reply with exactly the file contents: LLAMA_CPP_OPENCLAW_TOOL_OK",
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

function disabledPlan() {
  return {
    environment: null,
    execution: "disabled",
    gpu: { cpuFallback: "reject", fullOffload: true, vendor: "nvidia" },
    model: {
      digest: LLAMA_CPP_DGX_SPARK_MODEL_DIGEST,
      hostPath: null,
      id: LLAMA_CPP_DGX_SPARK_MODEL_ID,
    },
    platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
    probeBounds: probeBounds(),
    probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
    profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
    recipeRef: LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
    requestGuard: "required",
    required: true,
    runner: null,
  };
}

function enabledPlan() {
  return {
    ...disabledPlan(),
    environment: "approve-dgx-spark-image-qualification",
    execution: "enabled",
    model: { ...disabledPlan().model, hostPath: MODEL_HOST_PATH },
    runner: "linux-arm64-gpu-dgx-spark-gb10-protected-1",
  };
}

function evidenceIdentity() {
  return {
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    runAttempt: 2,
    runId: 42,
    workflowSha: WORKFLOW_SHA,
  };
}

function receipt() {
  return {
    agentQualification: { execution: "disabled" },
    baseSha: BASE_SHA,
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
      offloadedLayers: 57,
      totalLayers: 57,
    },
    headSha: HEAD_SHA,
    host: {
      architecture: "arm64",
      driverVersion: "580.65.06",
      gpuName: "NVIDIA GB10",
      profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
    },
    image: {
      digest: IMAGE_DIGEST,
      platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
      reference: `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY}@${IMAGE_DIGEST}`,
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
      contextWindow: { contextSize: 262144, ok: true, slots: 1 },
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
      requestBodyLimit: {
        acceptedBytes: 32768,
        acceptedHttpStatus: 200,
        continuationHealthHttpStatus: 200,
        continuationHttpStatus: 200,
        errorCode: "request_body_too_large",
        errorType: "invalid_request_error",
        ok: true,
        rejectedBytes: LLAMA_CPP_DGX_SPARK_REJECTED_REQUEST_BODY_BYTES,
        rejectedHttpStatus: 413,
      },
      metrics: {
        httpStatus: 200,
        ok: true,
        requiredSeries: 11,
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
        limitMilliseconds: 250,
        ok: true,
        recovered: true,
      },
      streamingChat: {
        done: true,
        events: 4,
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
      usage: { completionTokens: 2, ok: true, promptTokens: 5, totalTokens: 7 },
    },
    repository: "NVIDIA/NemoClaw",
    run: { attempt: 2, id: 42 },
    workflowSha: WORKFLOW_SHA,
  };
}

function executionPlan() {
  return {
    contractVersion: 1,
    imageBuild: {
      backendDirectory: "/opt/llama.cpp/lib",
      compiler: { c: "gcc-14", cudaHostCxx: "g++-14", cxx: "g++-14" },
      cuda: {
        developmentBase: LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE,
        runtimeBase: LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
      },
      platform: { cudaArchitectures: "121a-real", platform: "linux/arm64" },
      repository: LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY,
      runtime: { gid: 10001, port: 8081, uid: 10001 },
      source: {
        archiveSha256: LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256,
        repository: LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY,
        revision: LLAMA_CPP_DGX_SPARK_SOURCE_REVISION,
      },
    },
    qualification: {
      agentQualification: agentQualification(),
      probeBounds: probeBounds(),
      probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES,
      requestGuard: "required",
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
          sizeBytes: 22833947424,
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
        timeoutSeconds: 1800,
        expectedModel: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
        probeImage: LLAMA_CPP_DGX_SPARK_TOOL_IMAGE,
        probes: { models: true, health: true, properties: true, metrics: true },
      },
      runtime: {
        restartPolicy: "unless-stopped",
        cuda: {
          baseImage: LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
          minimumDriverVersion: "580.65.06",
        },
        gpu: { vendor: "nvidia", count: 1, offload: "full", cpuFallback: "reject" },
        resources: {
          memoryBytes: 51539607552,
          writableStorageBytes: 42949672960,
          pidsLimit: 256,
        },
      },
      serve: {
        protocol: "openai-completions",
        authentication: "bearer",
        port: 8081,
        chatTemplate: "nemotron-v3-embedded",
        contextSize: 262144,
        slots: 1,
        idleSleepSeconds: -1,
        batchSize: 2048,
        microBatchSize: 512,
        flashAttention: "enabled",
        kvCache: { key: "f16", value: "f16" },
        speculativeDecoding: "disabled",
        limits: {
          maxRequestBodyBytes: 32768,
          maxRequestHeaderBytes: 32768,
          maxOutputTokens: 4096,
          requestTimeoutSeconds: 900,
          shutdownTimeoutSeconds: 25,
        },
        requestGuard: { upstreamPort: 8082 },
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
}

function parseLlamaCppDgxSparkQualificationReceipt(value: unknown, identity: unknown) {
  return parseQualificationReceiptWithPlan(value, identity, executionPlan());
}

describe("llama.cpp DGX Spark qualification contract", () => {
  it("pins the exact protected ARM64 activation identity and patterns (#8260)", () => {
    expect(LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH).toBe(
      "ci/llama-cpp-dgx-spark-qualification-v1.yaml",
    );
    expect(LLAMA_CPP_DGX_SPARK_RUNNER_PATTERN.test("ubuntu-latest")).toBe(false);
    expect(
      LLAMA_CPP_DGX_SPARK_RUNNER_PATTERN.test("linux-arm64-gpu-dgx-spark-gb10-protected-1"),
    ).toBe(true);
    expect(LLAMA_CPP_DGX_SPARK_ENVIRONMENT_PATTERN.test("production")).toBe(false);
    expect(
      LLAMA_CPP_DGX_SPARK_ENVIRONMENT_PATTERN.test("approve-dgx-spark-image-qualification"),
    ).toBe(true);
    expect(LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN.test(MODEL_HOST_PATH)).toBe(true);
    expect(LLAMA_CPP_DGX_SPARK_GPU_PATTERN.test("NVIDIA GB10")).toBe(true);
    expect(LLAMA_CPP_DGX_SPARK_DIGEST_PATTERN.test(IMAGE_DIGEST)).toBe(true);
  });

  it("accepts only the exact activation mapping as YAML or an object (#8260)", () => {
    const expected = activation();
    const yaml = `contractVersion: 1\njobId: ${expected.jobId}\nplatform: ${expected.platform}\nprofile: ${expected.profile}\n`;

    expect(parseLlamaCppDgxSparkQualificationActivation(expected)).toEqual(expected);
    expect(parseLlamaCppDgxSparkQualificationActivation(yaml)).toEqual(expected);
    expect(() =>
      parseLlamaCppDgxSparkQualificationActivation({ ...expected, jobId: "gpu-e2e" }),
    ).toThrow("activation contract is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationActivation({ ...expected, token: "secret" }),
    ).toThrow("unexpected fields");
  });

  it("rejects ambiguous or unsafe activation YAML before selecting protected work (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationActivation(
        `contractVersion: 1\ncontractVersion: 1\njobId: ${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID}\nplatform: linux/arm64\nprofile: dgx-spark-gb10-single\n`,
      ),
    ).toThrow("activation YAML is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationActivation(
        `contractVersion: &version 1\njobId: ${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID}\nplatform: linux/arm64\nprofile: *version\n`,
      ),
    ).toThrow();
    expect(() =>
      parseLlamaCppDgxSparkQualificationActivation(
        `contractVersion: 1\njobId: ${LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID}\u0000\nplatform: linux/arm64\nprofile: dgx-spark-gb10-single\n`,
      ),
    ).toThrow("activation YAML is empty, exceeds 4096 bytes, or contains control characters");
  });

  it("accepts dormant and completely bound enabled plans compiled from YAML (#8260)", () => {
    expect(parseLlamaCppDgxSparkQualificationPlan(disabledPlan())).toEqual(disabledPlan());
    expect(parseLlamaCppDgxSparkQualificationPlan(enabledPlan())).toEqual(enabledPlan());
  });

  it("rejects enabled or partially bound plans without the exact protected infrastructure (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({ ...disabledPlan(), execution: "enabled" }),
    ).toThrow("infrastructure is incomplete");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...disabledPlan(),
        runner: "linux-arm64-gpu-dgx-spark-gb10-protected-1",
      }),
    ).toThrow("infrastructure is incomplete");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({ ...enabledPlan(), runner: "ubuntu-latest" }),
    ).toThrow("infrastructure is incomplete");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        environment: "approve-dgx-spark-image-qualification\nTOKEN=secret",
      }),
    ).toThrow("infrastructure is incomplete");
  });

  it("rejects plan drift, unsafe model paths, and unexpected fields (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        recipeRef: "llama-cpp.unreviewed.v1",
      }),
    ).toThrow("qualification plan is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        gpu: { ...enabledPlan().gpu, fullOffload: false },
      }),
    ).toThrow("qualification plan is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        model: { ...enabledPlan().model, hostPath: "/models/../model.gguf" },
      }),
    ).toThrow("infrastructure is incomplete");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({ ...enabledPlan(), arguments: ["--shell"] }),
    ).toThrow("unexpected fields");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES.filter((probe) => probe !== "tool-call"),
      }),
    ).toThrow("qualification plan is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        probes: ["health", "completion"],
      }),
    ).toThrow("qualification plan is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationPlan({
        ...enabledPlan(),
        probeBounds: { ...probeBounds(), clientTimeoutMilliseconds: 0 },
      }),
    ).toThrow("client timeout is invalid");
  });

  it("validates the exact workflow evidence identity before receipt parsing (#8260)", () => {
    expect(parseLlamaCppDgxSparkQualificationEvidenceIdentity(evidenceIdentity())).toEqual(
      evidenceIdentity(),
    );
    expect(() =>
      parseLlamaCppDgxSparkQualificationEvidenceIdentity({
        ...evidenceIdentity(),
        headSha: "A".repeat(40),
      }),
    ).toThrow("head SHA is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationEvidenceIdentity({
        ...evidenceIdentity(),
        runAttempt: 0,
      }),
    ).toThrow("run attempt is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationEvidenceIdentity({
        ...evidenceIdentity(),
        actor: "untrusted",
      }),
    ).toThrow("unexpected fields");
  });

  it("parses and verifies the exact immutable execution plan emitted from YAML (#8260)", () => {
    const value = executionPlan();
    const expectedDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")}`;

    expect(parseLlamaCppDgxSparkExecutionPlan(value)).toEqual(value);
    expect(llamaCppDgxSparkExecutionPlanSha256(value)).toBe(expectedDigest);
    expect(parseLlamaCppDgxSparkExecutionPlan(value, expectedDigest)).toEqual(value);
    expect(verifyLlamaCppDgxSparkExecutionPlanSha256(value, expectedDigest)).toEqual(value);
    expect(() => parseLlamaCppDgxSparkExecutionPlan(value, `sha256:${"e".repeat(64)}`)).toThrow(
      "plan digest does not match",
    );
  });

  it("canonicalizes execution plan field order before digest verification (#8260)", () => {
    const value = executionPlan();
    const reordered = {
      recipe: value.recipe,
      qualification: value.qualification,
      imageBuild: value.imageBuild,
      contractVersion: value.contractVersion,
    };

    expect(llamaCppDgxSparkExecutionPlanSha256(reordered)).toBe(
      llamaCppDgxSparkExecutionPlanSha256(value),
    );
  });

  it("allows bounded YAML tuning while preserving the Spark execution invariants (#8260)", () => {
    const value = executionPlan();
    const tuned = {
      ...value,
      recipe: {
        ...value.recipe,
        readiness: { ...value.recipe.readiness, timeoutSeconds: 1200 },
        runtime: {
          ...value.recipe.runtime,
          resources: {
            memoryBytes: 68719476736,
            writableStorageBytes: 34359738368,
            pidsLimit: 512,
          },
        },
        serve: {
          ...value.recipe.serve,
          contextSize: 131072,
          batchSize: 1024,
          microBatchSize: 256,
          kvCache: { key: "q8_0", value: "q8_0" },
          limits: {
            ...value.recipe.serve.limits,
            requestTimeoutSeconds: 600,
          },
        },
      },
    };

    expect(parseLlamaCppDgxSparkExecutionPlan(tuned)).toEqual(tuned);
  });

  it("rejects mutable build inputs and unsafe execution plan extensions (#8260)", () => {
    const value = executionPlan();
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        imageBuild: { ...value.imageBuild, repository: "ghcr.io/nvidia/nemoclaw:latest" },
      }),
    ).toThrow("image build identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        imageBuild: {
          ...value.imageBuild,
          platform: { ...value.imageBuild.platform, cudaArchitectures: "native" },
        },
      }),
    ).toThrow("image build identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: { ...value.recipe, arguments: ["--server-tools", "all"] },
      }),
    ).toThrow("unexpected fields");
  });

  it("rejects unbounded serving values and weakened recipe behavior (#8260)", () => {
    const value = executionPlan();
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          serve: { ...value.recipe.serve, microBatchSize: 4096 },
        },
      }),
    ).toThrow("micro-batch size is invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          serve: {
            ...value.recipe.serve,
            limits: { ...value.recipe.serve.limits, maxOutputTokens: 262145 },
          },
        },
      }),
    ).toThrow("maximum output tokens is invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          serve: {
            ...value.recipe.serve,
            requestGuard: { upstreamPort: value.recipe.serve.port },
          },
        },
      }),
    ).toThrow("serve contract is invalid");
    const { shutdownTimeoutSeconds: _removed, ...incompleteLimits } = value.recipe.serve.limits;
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          serve: { ...value.recipe.serve, limits: incompleteLimits },
        },
      }),
    ).toThrow("request limits has unexpected fields");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          policy: { ...value.recipe.policy, egress: "enabled" },
        },
      }),
    ).toThrow("policy is invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          surfaces: { ...value.recipe.surfaces, serverTools: "enabled" },
        },
      }),
    ).toThrow("surfaces are not disabled");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        recipe: {
          ...value.recipe,
          capabilities: { ...value.recipe.capabilities, toolCalls: false },
        },
      }),
    ).toThrow("capability claims are invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        qualification: {
          ...value.qualification,
          probes: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROBES.slice(0, -1),
        },
      }),
    ).toThrow("protocol probes are invalid");
    expect(() =>
      parseLlamaCppDgxSparkExecutionPlan({
        ...value,
        qualification: { ...value.qualification, requestGuard: "disabled" },
      }),
    ).toThrow("request-guard activation is invalid");
  });

  it("accepts one bounded receipt with only allowlisted workflow, image, model, and Spark evidence (#8260)", () => {
    expect(parseLlamaCppDgxSparkQualificationReceipt(receipt(), evidenceIdentity())).toEqual(
      receipt(),
    );
  });

  it("binds enabled OpenClaw evidence to the exact YAML-authored tuple", () => {
    const plan = executionPlan();
    plan.qualification.agentQualification.execution = "enabled";
    const value = {
      ...receipt(),
      agentQualification: {
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
          streamingChat: { done: true, events: 7 },
          synchronousChat: true,
        },
        route: plan.qualification.agentQualification.route,
        runtimeProvider: "docker",
      },
    };

    expect(
      parseQualificationReceiptWithPlan(value, evidenceIdentity(), plan).agentQualification,
    ).toEqual(value.agentQualification);
    expect(() =>
      parseQualificationReceiptWithPlan(value, evidenceIdentity(), executionPlan()),
    ).toThrow(/without declarative activation/u);
    expect(() =>
      parseQualificationReceiptWithPlan(
        {
          ...value,
          agentQualification: {
            ...value.agentQualification,
            route: { ...value.agentQualification.route, provider: "vllm-local" },
          },
        },
        evidenceIdentity(),
        plan,
      ),
    ).toThrow(/evidence is invalid/u);
  });

  it("rejects stale workflow identity and extra sensitive receipt fields (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), headSha: "e".repeat(40) },
        evidenceIdentity(),
      ),
    ).toThrow("receipt identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), run: { attempt: 3, id: 42 } },
        evidenceIdentity(),
      ),
    ).toThrow("receipt run is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), bearerToken: "secret", prompt: "sensitive" },
        evidenceIdentity(),
      ),
    ).toThrow("unexpected fields");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            completion: { httpStatus: 200, ok: true },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("unexpected fields");
  });

  it("rejects mutable, mismatched, or wrong-platform image identity (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          image: {
            ...receipt().image,
            reference: `${LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY}:latest`,
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("image identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          image: { ...receipt().image, digest: `sha256:${"e".repeat(64)}` },
        },
        evidenceIdentity(),
      ),
    ).toThrow("image identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), image: { ...receipt().image, platform: "linux/amd64" } },
        evidenceIdentity(),
      ),
    ).toThrow("image identity is invalid");
  });

  it("rejects model, GB10, and minimum driver identity drift (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), model: { ...receipt().model, id: "unreviewed/model" } },
        evidenceIdentity(),
      ),
    ).toThrow("model identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), host: { ...receipt().host, gpuName: "NVIDIA H100" } },
        evidenceIdentity(),
      ),
    ).toThrow("host identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), host: { ...receipt().host, driverVersion: "579.99.99" } },
        evidenceIdentity(),
      ),
    ).toThrow("host identity is invalid");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), host: { ...receipt().host, gpuName: "NVIDIA GB10\nTOKEN=secret" } },
        evidenceIdentity(),
      ),
    ).toThrow("host identity is invalid");
  });

  it("rejects partial offload, CPU fallback, and CPU warnings (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), execution: { ...receipt().execution, offloadedLayers: 56 } },
        evidenceIdentity(),
      ),
    ).toThrow("did not prove full GPU offload");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), execution: { ...receipt().execution, cpuFallback: true } },
        evidenceIdentity(),
      ),
    ).toThrow("did not prove full GPU offload");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), execution: { ...receipt().execution, cpuWarning: true } },
        evidenceIdentity(),
      ),
    ).toThrow("did not prove full GPU offload");
  });

  it("rejects failed probes and incomplete cleanup evidence (#8260)", () => {
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: { ...receipt().probes, health: { httpStatus: 503, ok: false } },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            requestBodyLimit: {
              ...receipt().probes.requestBodyLimit,
              continuationHealthHttpStatus: 503,
            },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            usage: { ...receipt().probes.usage, totalTokens: 8 },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            cancellation: {
              ...receipt().probes.cancellation,
              recovered: false,
            },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            models: { ...receipt().probes.models, model: "/models/private.gguf" },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            metrics: { ...receipt().probes.metrics, requiredSeries: 10 },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: {
            ...receipt().probes,
            disabledSurfaces: {
              ...receipt().probes.disabledSurfaces,
              toolsHttpStatus: 200,
            },
          },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        {
          ...receipt(),
          probes: { ...receipt().probes, logRedaction: { ok: false } },
        },
        evidenceIdentity(),
      ),
    ).toThrow("probes did not pass");
    expect(() =>
      parseLlamaCppDgxSparkQualificationReceipt(
        { ...receipt(), cleanup: { ...receipt().cleanup, credentialsRemoved: false } },
        evidenceIdentity(),
      ),
    ).toThrow("cleanup is incomplete");
  });
});
