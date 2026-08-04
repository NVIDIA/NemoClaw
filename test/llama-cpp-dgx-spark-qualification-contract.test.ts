// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  LLAMA_CPP_DGX_SPARK_CUDA_DEVELOPMENT_BASE,
  LLAMA_CPP_DGX_SPARK_CUDA_RUNTIME_BASE,
  LLAMA_CPP_DGX_SPARK_DIGEST_PATTERN,
  LLAMA_CPP_DGX_SPARK_ENVIRONMENT_PATTERN,
  LLAMA_CPP_DGX_SPARK_GPU_PATTERN,
  LLAMA_CPP_DGX_SPARK_MODEL_DIGEST,
  LLAMA_CPP_DGX_SPARK_MODEL_ID,
  LLAMA_CPP_DGX_SPARK_MODEL_PATH_PATTERN,
  LLAMA_CPP_DGX_SPARK_OWNED_IMAGE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_ACTIVATION_PATH,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_IMAGE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_KIND,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
  LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
  LLAMA_CPP_DGX_SPARK_RUNNER_PATTERN,
  LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID,
  LLAMA_CPP_DGX_SPARK_SOURCE_ARCHIVE_SHA256,
  LLAMA_CPP_DGX_SPARK_SOURCE_REPOSITORY,
  LLAMA_CPP_DGX_SPARK_SOURCE_REVISION,
  llamaCppDgxSparkExecutionPlanSha256,
  parseLlamaCppDgxSparkExecutionPlan,
  parseLlamaCppDgxSparkQualificationActivation,
  parseLlamaCppDgxSparkQualificationEvidenceIdentity,
  parseLlamaCppDgxSparkQualificationPlan,
  parseLlamaCppDgxSparkQualificationReceipt,
  verifyLlamaCppDgxSparkExecutionPlanSha256,
} from "../scripts/checks/llama-cpp-dgx-spark-qualification-contract.mts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const IMAGE_DIGEST = `sha256:${"d".repeat(64)}`;
const MODEL_HOST_PATH = "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";

function activation() {
  return {
    contractVersion: 1,
    jobId: LLAMA_CPP_DGX_SPARK_QUALIFICATION_JOB_ID,
    platform: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PLATFORM,
    profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
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
    probes: ["health", "completion"],
    profile: LLAMA_CPP_DGX_SPARK_QUALIFICATION_PROFILE,
    recipeRef: LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
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
      completion: { httpStatus: 200, model: LLAMA_CPP_DGX_SPARK_SERVED_MODEL_ID, ok: true },
      health: { httpStatus: 200, ok: true },
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
    recipe: {
      id: LLAMA_CPP_DGX_SPARK_QUALIFICATION_RECIPE,
      model: {
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
        probes: { models: true, health: true, properties: true, metrics: true },
      },
      runtime: {
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
          maxRequestBodyBytes: 16777216,
          maxPromptTokens: 253952,
          maxCompletionTokens: 8192,
          requestTimeoutSeconds: 900,
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
            maxRequestBodyBytes: 8388608,
            maxPromptTokens: 120000,
            maxCompletionTokens: 4096,
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
  });

  it("accepts one bounded receipt with only allowlisted workflow, image, model, and Spark evidence (#8260)", () => {
    expect(parseLlamaCppDgxSparkQualificationReceipt(receipt(), evidenceIdentity())).toEqual(
      receipt(),
    );
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
            completion: { ...receipt().probes.completion, model: "/models/private.gguf" },
          },
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
