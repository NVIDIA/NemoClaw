// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import {
  MANAGED_IMAGE_LOCAL_INFERENCE_KINDS,
  PROTECTED_MANAGED_IMAGE_AGENTS,
  parseProtectedManagedImageContracts,
  resolveManagedImageLocalInferenceRoute,
} from "../scripts/checks/managed-image-protected-runtime-contract.ts";
import { parseManagedImageDirectE2eInputs } from "../scripts/checks/run-managed-image-direct-e2e.ts";
import {
  assertProtectedManagedImageAgentTurn,
  assertVerifiedProtectedGpuProof,
  managedImageOpenShellBasePolicyPath,
  managedImageOpenShellCommittedProbe,
  managedImageOpenShellProbe,
  parseManagedImageOpenShellE2eInputs,
  protectedManagedImageAgentTurnArgv,
} from "../scripts/checks/run-managed-image-openshell-e2e.ts";

import {
  publicationAgents,
  publicationPlatforms,
  runManagedImagePromotion,
  runPublicationBarrier,
} from "./helpers/managed-image-publication-barrier";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type MatrixEntry = {
  agent?: string;
  arch?: string;
  artifact_platform?: string;
  base_alias?: string;
  base_image?: string;
  base_repository?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  platform?: string;
  required_binary?: string;
  runner?: string;
};

type Job = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: Step[];
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: MatrixEntry[] };
  };
  "timeout-minutes"?: number;
  uses?: string;
};

type Workflow = {
  concurrency?: {
    "cancel-in-progress"?: string | boolean;
    group?: string;
  };
  env?: Record<string, string>;
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: {
      branches?: string[];
      paths?: string[];
    };
    push?: {
      paths?: string[];
    };
    workflow_call?: unknown;
  };
  permissions?: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const fullShaAction = /^[^@]+@[0-9a-f]{40}$/iu;
const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<unknown>;
const managedArtifactInputPaths = [
  ".dockerignore",
  ".github/workflows/managed-images.yaml",
  "Dockerfile",
  "agents/**",
  "ci/npm-audit-exceptions.json",
  "nemoclaw/**",
  "nemoclaw-blueprint/**",
  "scripts/**",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v*.json",
  "src/lib/core/json-types.ts",
  "src/lib/core/ports.ts",
  "src/lib/messaging/**",
  "src/lib/onboard/managed-startup/**",
  "src/lib/security/credential-hash.ts",
  "src/lib/state/paths.ts",
  "src/lib/state/state-root.ts",
  "src/lib/tool-disclosure.ts",
  "tools/mcp-tool-discovery-runtime/**",
  "tsconfig.runtime-preloads.json",
] as const;
const managedPrRuntimeInputPaths = [...managedArtifactInputPaths, "src/lib/**"] as const;

describe("protected managed-image GPU evidence", () => {
  it("requires a verified CUDA-usability receipt before claiming GPU qualification", () => {
    expect(() =>
      assertVerifiedProtectedGpuProof({
        status: "verified",
        cudaVerified: true,
        label: null,
        detail: null,
        at: "2026-07-29T00:00:00.000Z",
      }),
    ).not.toThrow();

    for (const proof of [
      null,
      {
        status: "unverified" as const,
        cudaVerified: false,
        label: null,
        detail: null,
        at: "2026-07-29T00:00:00.000Z",
      },
      {
        status: "failed" as const,
        cudaVerified: false,
        label: "cuda-init",
        detail: "cuInit(0)=100",
        at: "2026-07-29T00:00:00.000Z",
      },
    ]) {
      expect(() => assertVerifiedProtectedGpuProof(proof)).toThrow(
        /requires verified CUDA usability/u,
      );
    }
  });

  it("runs and validates one real turn through every shipped agent entrypoint", () => {
    const model = "Qwen/Qwen2.5-0.5B-Instruct";
    const session = "managed-image-openclaw-vllm-1";
    expect(protectedManagedImageAgentTurnArgv("openclaw", model, session)).toEqual([
      "openclaw",
      "agent",
      "--agent",
      "main",
      "--json",
      "--thinking",
      "off",
      "--session-id",
      session,
      "-m",
      "Reply with exactly one word: PONG",
    ]);
    expect(protectedManagedImageAgentTurnArgv("hermes", model, session).join(" ")).toContain(
      "http://127.0.0.1:8642/v1/chat/completions",
    );
    expect(protectedManagedImageAgentTurnArgv("langchain-deepagents-code", model, session)).toEqual(
      ["dcode", "-n", "Reply with exactly one word: PONG", "--json"],
    );

    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "openclaw",
        {
          status: 0,
          stdout: JSON.stringify({
            status: "ok",
            summary: "completed",
            result: {
              payloads: [{ text: "PONG" }],
              meta: {
                aborted: false,
                agentMeta: { provider: "inference", model },
                executionTrace: {
                  winnerProvider: "inference",
                  winnerModel: model,
                  attempts: [
                    { provider: "inference", model, stage: "assistant", result: "success" },
                  ],
                },
              },
            },
          }),
        },
        model,
      ),
    ).not.toThrow();
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "hermes",
        {
          status: 0,
          stdout: JSON.stringify({ model, choices: [{ message: { content: "PONG" } }] }),
        },
        model,
      ),
    ).not.toThrow();
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "langchain-deepagents-code",
        {
          status: 0,
          stdout: JSON.stringify({
            schema_version: 1,
            command: "non-interactive",
            data: {
              status: "success",
              exit_code: 0,
              response: "PONG",
              completion: { thread_id: "thread-1", duration_ms: 1, response_bytes: 4 },
            },
          }),
        },
        model,
      ),
    ).not.toThrow();
  });

  it("does not credit echoed prompts, fallbacks, malformed envelopes, or nonzero turns", () => {
    const model = "Qwen/Qwen2.5-0.5B-Instruct";
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "openclaw",
        {
          status: 0,
          stdout: JSON.stringify({ request: "Reply with exactly one word: PONG" }),
        },
        model,
      ),
    ).toThrow(/expected inference\.local provider and model/u);
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "openclaw",
        {
          status: 0,
          stdout: JSON.stringify({ result: { payloads: [{ text: "PONG" }] } }),
          stderr: "EMBEDDED FALLBACK",
        },
        model,
      ),
    ).toThrow(/fallback/u);
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "hermes",
        {
          status: 0,
          stdout: JSON.stringify({ messages: [{ content: "PONG" }] }),
        },
        model,
      ),
    ).toThrow(/expected local model/u);
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "langchain-deepagents-code",
        {
          status: 0,
          stdout: JSON.stringify({ data: { response: "PONG" } }),
        },
        model,
      ),
    ).toThrow(/successful v1 headless envelope/u);
    expect(() =>
      assertProtectedManagedImageAgentTurn(
        "hermes",
        {
          status: 1,
          stdout: "PONG",
        },
        model,
      ),
    ).toThrow(/failed with status 1/u);
  });
});

function readWorkflow(file: string): Workflow {
  return YAML.parse(
    fs.readFileSync(path.join(repoRoot, ".github", "workflows", file), "utf8"),
  ) as Workflow;
}

function required<T>(value: T | undefined, message: string): T {
  return (
    value ??
    (() => {
      throw new Error(message);
    })()
  );
}

function step(job: Job, name: string): Step {
  return required(
    job.steps?.find((candidate) => candidate.name === name),
    `managed-image workflow is missing '${name}'`,
  );
}

function managedBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["build-and-validate"],
    "managed-image workflow is missing its build-and-validate matrix",
  );
}

const managedPublisher = managedBuilder;

function managedPrBuilder(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["pr-build-and-entrypoint"],
    "managed-image workflow is missing its all-agent PR build and runtime gate",
  );
}

function managedPromoter(workflow: Workflow): Job {
  return required(
    workflow.jobs?.promote,
    "managed-image workflow is missing its aggregate promoter",
  );
}

function publicationBoundaryErrors(baseWorkflow: Workflow, managedWorkflow: Workflow): string[] {
  const triggerPaths = baseWorkflow.on?.push?.paths ?? [];
  const caller = required(
    baseWorkflow.jobs?.["publish-managed-images"],
    "base-image workflow is missing the managed-image publisher",
  );
  const publisher = managedPublisher(managedWorkflow);
  const promoter = managedPromoter(managedWorkflow);
  const steps = publisher.steps ?? [];
  const build = step(publisher, "Build and push managed image by digest");
  const base = step(publisher, "Validate exact base image contract");
  const validate = step(publisher, "Validate exact managed image before promotion");
  const workflowSource = JSON.stringify(managedWorkflow);
  const publisherSource = JSON.stringify(publisher);
  const validationMarkers = [
    'mktemp -d "$RUNNER_TEMP/anonymous-docker-XXXXXX"',
    'DOCKER_CONFIG="$anonymous_config" docker pull --platform "$PLATFORM" "$reference"',
    "bootstrap the GHCR package",
    "/opt/nemoclaw-blueprint/blueprint.yaml",
    "/usr/local/share/nemoclaw/node-tar-inventory.json",
    "/usr/local/share/nemoclaw/corporate-ca.pem",
    'entry.status !== "fixed"',
    '--entrypoint "$REQUIRED_BINARY"',
    "io.nvidia.nemoclaw.managed-image.contract",
    "io.nvidia.nemoclaw.managed-image.startup-profile",
    "io.nvidia.nemoclaw.managed-image.capabilities",
    "io.nvidia.nemoclaw.managed-image.cohort",
    "^ghrun-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$",
    "NEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION",
    "@openclaw/diagnostics-otel",
    "@openclaw/brave-plugin",
    "@openclaw/discord",
    "@tencent-weixin/openclaw-weixin",
    "@openclaw/slack",
    "@openclaw/whatsapp",
    "@openclaw/msteams",
    "microsoft-teams-apps",
    "config.plugins?.entries?.[id]?.enabled !== false",
    'config["platforms"].get(name) != {"enabled": False}',
    "run-managed-image-direct-e2e.ts",
    '--agent "$AGENT"',
    '--image "$reference"',
    '--platform "$PLATFORM"',
  ];
  const forbiddenPerLanePromotionMarkers = [
    'aliases=("${IMAGE}:${GITHUB_SHA}")',
    "docker buildx imagetools create",
    "docker tag ",
    "docker push ",
  ];
  const buildIndex = steps.indexOf(build);
  const validateIndex = steps.indexOf(validate);

  return [
    ...managedArtifactInputPaths
      .filter((input) => !triggerPaths.includes(input))
      .map((input) => `managed image trigger is missing ${input}`),
    ...(baseWorkflow.concurrency?.group === "base-image-${{ github.ref }}"
      ? []
      : ["base image concurrency must be scoped by github.ref"]),
    ...(baseWorkflow.concurrency?.["cancel-in-progress"] ===
    "${{ !startsWith(github.ref, 'refs/tags/v') }}"
      ? []
      : ["v* release runs must never be cancelled"]),
    ...(caller.if?.includes("inputs.openclaw_version == ''")
      ? []
      : ["custom OpenClaw base builds must not publish managed images"]),
    ...(build.with?.outputs ===
      "type=image,name=${{ env.REGISTRY }}/${{ matrix.image }},push-by-digest=true,name-canonical=true,push=true" &&
    build.with.push === undefined &&
    build.with.tags === undefined
      ? []
      : ["managed images must be pushed by digest without consumer tags"]),
    ...(!workflowSource.includes("GITHUB_SHA:0:8") && !workflowSource.includes("format=short")
      ? []
      : ["managed image handoff and aliases must not use short source SHAs"]),
    ...(base.run?.includes('.reference == (.image + "@" + .digest)') &&
    base.run.includes(".sourceRevision == $revision") &&
    base.run.includes(".run == {id: $runId, attempt: $runAttempt}")
      ? []
      : ["managed image build must consume the same-run exact base digest contract"]),
    ...validationMarkers
      .filter((marker) => !validate.run?.includes(marker))
      .map((marker) => `exact managed image validation is missing ${marker}`),
    ...forbiddenPerLanePromotionMarkers
      .filter((marker) => publisherSource.includes(marker))
      .map((marker) => `per-agent lane must not publish mutable alias with ${marker}`),
    ...(buildIndex >= 0 && buildIndex < validateIndex
      ? []
      : ["managed image validation must follow its immutable digest build"]),
    ...(promoter.needs === "build-and-validate"
      ? []
      : ["aggregate promotion must require every matrix lane"]),
  ];
}

describe("complete managed-image publication workflow", () => {
  it.each([
    "linux/amd64",
    "linux/arm64",
  ] as const)("accepts the direct managed-image harness on %s", (platform) => {
    const image = `localhost:5000/nemoclaw-managed-pr/openclaw@sha256:${"a".repeat(64)}`;
    expect(
      parseManagedImageDirectE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        image,
        "--platform",
        platform,
      ]),
    ).toEqual({ agent: "openclaw", image, platform });
  });

  it("requires the real OpenShell harness to receive an immutable named manifest", () => {
    const image = `localhost:5000/nemoclaw-managed-pr/hermes@sha256:${"b".repeat(64)}`;
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "hermes",
        "--image",
        image,
        "--sandbox",
        "nemoclaw-pr-hermes",
      ]),
    ).toEqual({
      agent: "hermes",
      image,
      sandbox: "nemoclaw-pr-hermes",
    });
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "hermes",
        "--image",
        `sha256:${"b".repeat(64)}`,
        "--sandbox",
        "nemoclaw-pr-hermes",
      ]),
    ).toThrow("immutable repository@sha256 manifest reference");
  });

  it("accepts only bounded protected GPU and rollback harness modes", () => {
    const image = `localhost:5000/nemoclaw-managed-protected/openclaw@sha256:${"c".repeat(64)}`;
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        image,
        "--sandbox",
        "nemoclaw-managed-openclaw-ollama",
        "--gpu",
        "--local-provider",
        "ollama",
        "--model",
        "qwen3.5:9b",
      ]),
    ).toEqual({
      agent: "openclaw",
      image,
      sandbox: "nemoclaw-managed-openclaw-ollama",
      gpu: true,
      localProvider: "ollama",
      model: "qwen3.5:9b",
    });
    expect(
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        image,
        "--sandbox",
        "nemoclaw-managed-openclaw-rollback",
        "--inject-bootstrap-completion-failure",
      ]).failureInjection,
    ).toBe("bootstrap-completion");
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        image,
        "--sandbox",
        "nemoclaw-managed-openclaw-invalid",
        "--gpu",
        "--local-provider",
        "nim",
        "--model",
        "model",
        "--inject-bootstrap-completion-failure",
      ]),
    ).toThrow("cannot be combined");
    expect(() =>
      parseManagedImageOpenShellE2eInputs([
        "--agent",
        "openclaw",
        "--image",
        image,
        "--sandbox",
        "nemoclaw-managed-openclaw-nim",
        "--gpu",
        "--local-provider",
        "nim",
        "--model",
        "model",
      ]),
    ).toThrow("trusted NGC-backed engine evidence");
  });

  it("keeps Ollama, NIM, and vLLM source contracts explicit without claiming NIM equivalence", () => {
    expect(MANAGED_IMAGE_LOCAL_INFERENCE_KINDS).toEqual(["ollama", "nim", "vllm"]);
    expect(resolveManagedImageLocalInferenceRoute("ollama")).toEqual({
      kind: "ollama",
      providerName: "ollama-local",
      credentialEnv: "NEMOCLAW_OLLAMA_PROXY_TOKEN",
      defaultBaseUrl: "http://host.openshell.internal:11435/v1",
    });
    expect(resolveManagedImageLocalInferenceRoute("nim")).toMatchObject({
      kind: "nim",
      providerName: "vllm-local",
      credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    });
    expect(resolveManagedImageLocalInferenceRoute("vllm")).toMatchObject({
      kind: "vllm",
      providerName: "vllm-local",
      credentialEnv: "NEMOCLAW_VLLM_LOCAL_TOKEN",
    });
  });

  it("requires one unique exact amd64 protected image for every shipped agent", () => {
    const contracts = PROTECTED_MANAGED_IMAGE_AGENTS.map((agent, index) => ({
      agent,
      platform: "linux/amd64",
      reference: `localhost:5000/nemoclaw-managed-protected/${agent}@sha256:${String(index + 1).repeat(64)}`,
    }));
    expect(parseProtectedManagedImageContracts(contracts)).toEqual(contracts);
    expect(() => parseProtectedManagedImageContracts(contracts.slice(0, 2))).toThrow(
      "exactly all shipped agents",
    );
    expect(() =>
      parseProtectedManagedImageContracts([contracts[0], contracts[0], contracts[2]]),
    ).toThrow("one unique image per agent");
  });

  it("runs protected exact-image GPU and rollback qualification only in the trusted E2E workflow", () => {
    const protectedWorkflow = readWorkflow("e2e.yaml");
    const gpu = required(
      protectedWorkflow.jobs?.["managed-image-gpu-e2e"],
      "protected E2E workflow is missing managed-image GPU qualification",
    );
    const rollback = required(
      protectedWorkflow.jobs?.["managed-image-bootstrap-rollback"],
      "protected E2E workflow is missing managed-image rollback qualification",
    );
    const publicWorkflowSource = fs.readFileSync(
      path.join(repoRoot, ".github", "workflows", "managed-images.yaml"),
      "utf8",
    );

    expect(gpu["runs-on"]).toBe("linux-amd64-gpu-rtxpro6000-latest-1");
    expect(rollback["runs-on"]).toBe("ubuntu-latest");
    expect(gpu.env?.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT).toContain("runner.temp");
    expect(gpu.env?.NEMOCLAW_PROTECTED_MANAGED_IMAGE_HOME).toBe(
      "${{ runner.temp }}/nemoclaw-managed-image-home",
    );
    expect(rollback.env?.NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT).toContain("runner.temp");
    for (const job of [gpu, rollback]) {
      expect(step(job, "Set up protected managed-image Buildx").with).toMatchObject({
        "driver-opts": "network=host",
        "buildkitd-config-inline": expect.stringContaining('[registry."localhost:5000"]'),
      });
      expect(step(job, "Start isolated protected managed-image registry").run).toContain(
        "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
      );
      expect(step(job, "Build exact all-agent protected managed images").run).toContain(
        "build-protected-managed-images.sh",
      );
    }
    expect(step(rollback, "Remove isolated protected managed-image registry").if).toBe("always()");
    expect(step(rollback, "Remove isolated protected managed-image registry").run).toContain(
      "registry listener remained after cleanup",
    );
    expect(step(gpu, "Clean stale protected managed-image GPU resources").run).toBe(
      "bash scripts/checks/cleanup-protected-managed-image-e2e.sh",
    );
    expect(step(gpu, "Clean protected managed-image GPU resources")).toMatchObject({
      if: "always()",
      run: "bash scripts/checks/cleanup-protected-managed-image-e2e.sh",
    });
    expect(
      step(gpu, "Run exact all-agent GPU and host-local inference qualification").run,
    ).toContain("managed-image-gpu-e2e.test.ts");
    expect(
      step(gpu, "Run exact all-agent GPU and host-local inference qualification").run,
    ).toContain('export HOME="$NEMOCLAW_PROTECTED_MANAGED_IMAGE_HOME"');
    expect(
      step(rollback, "Run exact all-agent managed-bootstrap rollback qualification").run,
    ).toContain("managed-image-bootstrap-rollback.test.ts");
    expect(publicWorkflowSource).not.toContain("linux-amd64-gpu-rtxpro6000-latest-1");
    expect(publicWorkflowSource).not.toContain("managed-image-gpu-e2e");
  });

  it("builds all protected agents by exact digest and pins real vLLM GPU qualification", () => {
    const buildSource = fs.readFileSync(
      path.join(repoRoot, "scripts", "checks", "build-protected-managed-images.sh"),
      "utf8",
    );
    const gpuSource = fs.readFileSync(
      path.join(repoRoot, "test", "e2e", "live", "managed-image-gpu-e2e.test.ts"),
      "utf8",
    );
    const cleanupPath = path.join(
      repoRoot,
      "scripts",
      "checks",
      "cleanup-protected-managed-image-e2e.sh",
    );
    const cleanupSource = fs.readFileSync(cleanupPath, "utf8");
    for (const agent of PROTECTED_MANAGED_IMAGE_AGENTS) {
      expect(buildSource).toContain(`  ${agent} \\`);
    }
    expect(buildSource).toContain("docker buildx imagetools inspect");
    expect(buildSource).toContain("docker pull --platform linux/amd64");
    expect(gpuSource).toContain(
      "vllm/vllm-openai@sha256:0fec7ec5f3e6bc168e54899935fb0557da908a4832a1dbc88e2debcf2f889416",
    );
    expect(gpuSource).toContain("torch.cuda.is_available()");
    expect(gpuSource).toContain("size_vram");
    expect(gpuSource).toContain("successfulOllamaCompletions");
    expect(gpuSource.match(/contracts\.length \* 2/gu)).toHaveLength(2);
    expect(gpuSource).toContain("Actual NIM engine qualification remains outside this target");
    const protectedWorkflow = readWorkflow("e2e.yaml");
    const gpuJob = required(
      protectedWorkflow.jobs?.["managed-image-gpu-e2e"],
      "protected E2E workflow is missing managed-image GPU qualification",
    );
    const timeoutMinutes = Number(
      required(
        /const TIMEOUT_MS = ([1-9][0-9]*) \* 60_000;/u.exec(gpuSource)?.[1],
        "managed-image GPU test timeout is not statically bounded",
      ),
    );
    expect(gpuJob["timeout-minutes"]).toBeGreaterThanOrEqual(timeoutMinutes + 90);
    expect(fs.statSync(cleanupPath).mode & 0o111).not.toBe(0);
    for (const marker of [
      "nemoclaw-managed-openclaw-ollama",
      "nemoclaw-managed-hermes-vllm",
      "nemoclaw-managed-dcode-rollback",
      "nemoclaw-managed-image-vllm-e2e",
      "nemoclaw-openshell-gateway",
      "nemoclaw-managed-pr-",
      "nemoclaw-managed-openshell-",
      "NEMOCLAW_OPENSHELL_GATEWAY_STATE_DIR",
      "NEMOCLAW_PROTECTED_MANAGED_IMAGE_HOME",
      "protected-managed-image-ollama.pid",
      "docker info",
      "docker rm -f -v",
      "protected-managed-image-cleanup-docker-error-",
      "lsof -tiTCP:8080",
      'lsof -tiTCP:"${port}"',
      "HOME=${protected_home}",
      "OLLAMA_HOST=127.0.0.1:11434",
      "OLLAMA_PROXY_PORT=11435",
      "localContentId",
      "localhost:5000/nemoclaw-managed-protected/",
    ]) {
      expect(cleanupSource).toContain(marker);
    }
    expect(cleanupSource.indexOf('if [[ "${cleanup_failed}" -ne 0 ]]')).toBeLessThan(
      cleanupSource.indexOf('rm -f -- "${contract_path}"'),
    );
    expect(cleanupSource).not.toContain("systemctl");
    expect(cleanupSource).not.toContain("pkill");
    expect(gpuSource).toContain("cleanupProtectedLocalInference");
    expect(gpuSource).not.toContain("cleanupOllama");
  });

  it("starts after exact base contracts with complete main triggers and release-safe concurrency (#7744)", () => {
    const baseWorkflow = readWorkflow("base-image.yaml");
    const managedWorkflow = readWorkflow("managed-images.yaml");
    const publisher = required(
      baseWorkflow.jobs?.["publish-managed-images"],
      "base-image workflow is missing the managed-image publisher",
    );

    expect(publicationBoundaryErrors(baseWorkflow, managedWorkflow)).toEqual([]);
    expect(publisher).toMatchObject({
      needs: ["build-and-push", "build-and-push-openclaw"],
      permissions: {
        contents: "read",
        packages: "write",
      },
      uses: "./.github/workflows/managed-images.yaml",
    });
    expect(publisher.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(publisher.if).toContain("github.ref == 'refs/heads/main'");
    expect(publisher.if).toContain("startsWith(github.ref, 'refs/tags/v')");

    const qemuPublisher = required(
      baseWorkflow.jobs?.["build-and-push"],
      "base-image workflow is missing Hermes and DCode publishers",
    );
    expect(step(qemuPublisher, "Build and push").id).toBe("build");
    expect(step(qemuPublisher, "Build and push").with?.platforms).toBe("linux/amd64,linux/arm64");
    expect(step(qemuPublisher, "Export managed base image contract").run).toContain(
      'reference="${IMAGE}@${DIGEST}"',
    );
    expect(step(qemuPublisher, "Export managed base image contract").run).toContain(
      "platformReferences: $platformReferences",
    );
    expect(step(qemuPublisher, "Upload managed base image contract").with?.name).toBe(
      "managed-base-${{ matrix.agent }}",
    );

    const openClawPublisher = required(
      baseWorkflow.jobs?.["build-and-push-openclaw"],
      "base-image workflow is missing the OpenClaw manifest publisher",
    );
    expect(step(openClawPublisher, "Create and verify multi-platform manifest").id).toBe(
      "manifest",
    );
    expect(step(openClawPublisher, "Export managed base image contract").env?.DIGEST).toBe(
      "${{ steps.manifest.outputs.digest }}",
    );
    expect(step(openClawPublisher, "Export managed base image contract").run).toContain(
      "platformDigests: $platformDigests",
    );
    expect(step(openClawPublisher, "Upload managed base image contract").with?.name).toBe(
      "managed-base-openclaw",
    );

    const nativeOpenClaw = required(
      baseWorkflow.jobs?.["build-openclaw-platforms"],
      "base-image workflow is missing native OpenClaw platforms",
    );
    expect(nativeOpenClaw.strategy?.matrix?.include).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          arch: "amd64",
          platform: "linux/amd64",
          runner: "ubuntu-24.04",
        }),
        expect.objectContaining({
          arch: "arm64",
          platform: "linux/arm64",
          runner: "ubuntu-24.04-arm",
        }),
      ]),
    );
  });

  it("builds and exercises every shipped agent from an exact PR image before merge (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const prBuilder = managedPrBuilder(workflow);
    const matrix = prBuilder.strategy?.matrix?.include ?? [];
    const steps = prBuilder.steps ?? [];

    expect(prBuilder.if).toBe("github.event_name == 'pull_request'");
    expect(prBuilder["runs-on"]).toBe("${{ matrix.runner }}");
    expect(prBuilder["timeout-minutes"]).toBe(90);
    expect(prBuilder.permissions).toEqual({ contents: "read", packages: "read" });
    expect(matrix.map(({ agent, platform }) => `${agent}|${platform}`)).toEqual(
      publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => `${agent}|${platform}`),
      ),
    );
    expect(matrix.map(({ runner }) => runner)).toEqual([
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
      "ubuntu-24.04",
      "ubuntu-24.04-arm",
    ]);
    expect(matrix.every(({ base_alias }) => base_alias?.endsWith(":latest"))).toBe(true);
    expect(
      matrix.every(({ image }) => image?.startsWith("localhost:5000/nemoclaw-managed-pr/")),
    ).toBe(true);

    for (const action of steps.filter((candidate) => candidate.uses)) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }

    expect(step(prBuilder, "Set up Docker Buildx").with).toMatchObject({
      "driver-opts": "network=host",
      "buildkitd-config-inline": expect.stringContaining('[registry."localhost:5000"]'),
    });
    expect(step(prBuilder, "Start isolated PR image registry").run).toContain(
      "docker.io/library/registry@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373",
    );

    const resolveBase = required(
      step(prBuilder, "Resolve exact PR base").run,
      "PR base resolution is missing",
    );
    expect(resolveBase).toContain(".platform.architecture == $architecture");
    expect(resolveBase).toContain('reference="${BASE_REPOSITORY}@${digest}"');
    expect(resolveBase).toContain('actual="sha256:$(sha256sum "$exact_raw"');

    const build = step(prBuilder, "Build and push PR managed image to isolated registry");
    expect(build.id).toBe("build");
    expect(build.with).toMatchObject({
      platforms: "${{ matrix.platform }}",
      push: true,
    });
    expect(build.with).not.toHaveProperty("load");
    const contract = required(
      step(prBuilder, "Validate exact PR managed image contract").run,
      "PR image contract validation is missing",
    );
    expect(contract).toContain('reference="${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"');
    expect(contract).toContain('imagetools inspect "$reference" --raw');
    expect(contract).toContain('docker pull --platform "$PLATFORM" "$reference"');
    expect(contract).toContain("printf 'reference=%s\\n' \"$reference\"");
    expect(step(prBuilder, "Exercise managed startup root stdin and hold").run).toContain(
      "run-managed-image-direct-e2e.ts",
    );
    expect(step(prBuilder, "Exercise exact PR image through real OpenShell").run).toContain(
      "run-managed-image-openshell-e2e.ts",
    );
    expect(
      step(prBuilder, "Export sanitized managed-image OpenShell failure diagnostics").run,
    ).toContain("export-managed-image-failure-diagnostics.ts");
    expect(
      step(prBuilder, "Upload managed-image OpenShell failure diagnostics").with?.[
        "include-hidden-files"
      ],
    ).toBe(true);
    expect(step(prBuilder, "Remove isolated PR image registry").if).toBe("always()");
  });

  it("publishes an exact native amd64 and arm64 lane for every shipped agent (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const builder = managedBuilder(workflow);
    const promoter = managedPromoter(workflow);

    expect(Object.keys(workflow.on ?? {}).sort()).toEqual(["pull_request", "workflow_call"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(builder.if).toBe("github.event_name != 'pull_request'");
    expect(builder["runs-on"]).toBe("${{ matrix.runner }}");
    expect(builder["timeout-minutes"]).toBe(120);
    expect(builder.strategy?.["fail-fast"]).toBe(false);
    expect(builder.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        arch: "amd64",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/openclaw",
        runner: "ubuntu-24.04",
      },
      {
        agent: "openclaw",
        arch: "arm64",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/openclaw",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "hermes",
        arch: "amd64",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/hermes",
        runner: "ubuntu-24.04",
      },
      {
        agent: "hermes",
        arch: "arm64",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/hermes",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "amd64",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/dcode",
        runner: "ubuntu-24.04",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "arm64",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/arm64",
        artifact_platform: "linux-arm64",
        required_binary: "/usr/local/bin/dcode",
        runner: "ubuntu-24.04-arm",
      },
    ]);
    expect(
      builder.strategy?.matrix?.include?.map(({ agent, platform }) => `${agent}|${platform}`),
    ).toEqual(
      publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => `${agent}|${platform}`),
      ),
    );
  });

  it("pins actions, validates exact digests, and records the immutable image contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const promoter = managedPromoter(workflow);
    const steps = publisher.steps ?? [];

    for (const action of [...steps, ...(promoter.steps ?? [])].filter(
      (candidate) => candidate.uses,
    )) {
      expect(action.uses, action.name).toMatch(fullShaAction);
    }
    expect(step(publisher, "Checkout").with?.["persist-credentials"]).toBe(false);
    expect(step(publisher, "Download exact base image contract").with).toMatchObject({
      name: "managed-base-${{ matrix.agent }}",
      path: "${{ runner.temp }}/managed-base-contract",
    });

    const guard = step(publisher, "Validate production build args");
    const build = step(publisher, "Build and push managed image by digest");
    const validate = step(publisher, "Validate exact managed image before promotion");
    const dependencies = step(publisher, "Install managed-image publication harness dependencies");
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(build));
    expect(guard.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(build.uses).toBe("docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a");
    expect(build.with).toMatchObject({
      context: ".",
      file: "${{ matrix.dockerfile }}",
      platforms: "${{ matrix.platform }}",
      "build-args":
        "BASE_IMAGE=${{ steps.base.outputs.ref }}\nNEMOCLAW_MANAGED_IMAGE_CAPABILITY_UNION=1\nNEMOCLAW_MANAGED_IMAGE_RUNTIME_USER=root\n",
      provenance: "mode=max",
      sbom: true,
    });
    expect(build.with?.push).toBeUndefined();
    expect(build.with?.tags).toBeUndefined();
    expect(build.with?.labels).toContain("org.opencontainers.image.revision=${{ github.sha }}");
    expect(build.with?.labels).toContain("io.nvidia.nemoclaw.managed-image.contract=1");
    expect(build.with?.labels).toContain(
      "io.nvidia.nemoclaw.managed-image.cohort=ghrun-${{ github.run_id }}-${{ github.run_attempt }}",
    );

    const base = step(publisher, "Validate exact base image contract");
    expect(base.run).toContain(".platformReferences[$platform]");
    expect(base.run).toContain('imagetools inspect "$platform_reference"');

    const contract = step(publisher, "Export validated managed image candidate");
    for (const marker of [
      "--arg baseReference",
      "--arg digest",
      "--arg platform",
      "--arg cohort",
      "--arg revision",
      "--arg cohort",
      "--argjson runAttempt",
      "--argjson runId",
      "contractVersion: 1",
      'phase: "candidate"',
      "attestations: {",
      'provenance: "mode=max"',
      "sbom: true",
    ]) {
      expect(contract.run).toContain(marker);
    }
    expect(step(publisher, "Upload validated managed image candidate").with).toMatchObject({
      name: "managed-image-candidate-${{ matrix.agent }}-${{ matrix.artifact_platform }}",
      path: "${{ runner.temp }}/managed-image-candidate/contract.json",
      "if-no-files-found": "error",
      "retention-days": 1,
    });
    const validation = required(validate.run, "managed image validation script is missing");
    expect(validation.match(/docker run/g)).toHaveLength(2);
    expect(validation).toContain("run-managed-image-direct-e2e.ts");
    expect(validation).toContain("npx --no-install tsx");
    expect(validation).toContain('--image "$reference"');
    expect(validation).toContain("printf 'local_id=%s\\n' \"$image_id\"");
    expect(validation).not.toContain("NEMOCLAW_STARTUP_PROFILE_B64");
    expect(validation).not.toContain("NEMOCLAW_CORPORATE_CA_B64");
    expect(validation).not.toContain(".Config.Entrypoint");
    expect(validation).not.toContain(".Config.Cmd");
    expect(steps.indexOf(dependencies)).toBeLessThan(steps.indexOf(validate));
  });

  it("executes the all-three barrier and rejects incomplete or stale sets before promotion", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const steps = publisher.steps ?? [];
    const source = steps.map((candidate) => candidate.run ?? "").join("\n");
    const contract = step(publisher, "Export validated managed image candidate");

    expect(publisher.strategy?.matrix?.include).toHaveLength(6);
    expect(steps.map((candidate) => candidate.name)).not.toContain(
      "Promote validated managed image aliases",
    );
    expect(source).not.toContain('aliases=("${IMAGE}:${GITHUB_SHA}")');
    expect(source).not.toContain("docker buildx imagetools create");
    expect(source).not.toMatch(/(?:^|\s)docker\s+(?:tag|push)\s/u);
    expect(contract.run).toContain('(has("aliases") | not)');
    expect(contract.run).not.toContain("aliases:");
  });

  it("holds every alias behind the exact six-candidate aggregate barrier (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const promoter = managedPromoter(workflow);
    const steps = promoter.steps ?? [];
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(promoter, "Promote validated multi-platform managed image cohort");

    expect(promoter.needs).toBe("build-and-validate");
    expect(step(promoter, "Download all validated managed image candidates").with).toEqual({
      pattern: "managed-image-candidate-*",
      path: "${{ runner.temp }}/managed-image-candidates",
      "merge-multiple": false,
    });
    expect(barrier.run).toContain("expected exactly six managed image candidate artifacts");
    expect(barrier.run).toContain("length == 6");
    expect(barrier.run).toContain('([.[].platform] | sort) == ["linux/amd64", "linux/arm64"]');
    expect(barrier.run).toContain("([.[].reference] | unique | length) == 6");
    expect(barrier.run).toContain("([.[].baseReference] | unique | length) == 6");
    expect(barrier.run).not.toContain("docker buildx imagetools create");
    expect(steps.indexOf(barrier)).toBeLessThan(steps.indexOf(promotion));

    expect(promotion.run).toContain("for agent in openclaw hermes langchain-deepagents-code");
    expect(promotion.run).toContain(
      'docker buildx imagetools create --tag "$cohort_alias" "${sources[@]}"',
    );
    expect(promotion.run).toContain(') == ["linux/amd64", "linux/arm64"]');
    expect(promotion.run).toContain('DOCKER_CONFIG="$anonymous_config" docker pull');
    expect(promotion.run).toContain(
      'consumer_aliases=("$(jq -r \'.image\' <<<"$openclaw_manifest"):${GITHUB_SHA}")',
    );
    expect(promotion.run).not.toContain(":latest");
  });

  it("fails the barrier before alias code when either architecture is absent (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(promoter, "Promote validated multi-platform managed image cohort");
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) => candidates.slice(0, -1),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("expected exactly six managed image candidate artifacts");
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails the barrier before alias code on a duplicated architecture (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(promoter, "Promote validated multi-platform managed image cohort");
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate) =>
          candidate.artifact === "managed-image-candidate-openclaw-linux-arm64"
            ? {
                ...candidate,
                contract: { ...candidate.contract, platform: "linux/amd64" },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("candidate artifact identity is invalid");
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("fails the barrier before alias code on a mixed-run cohort (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const barrier = step(promoter, "Validate complete managed image candidate set");
    const promotion = step(promoter, "Promote validated multi-platform managed image cohort");
    const result = runPublicationBarrier(
      barrier.run ?? "",
      (candidates) =>
        candidates.map((candidate, index) =>
          index === 0
            ? {
                ...candidate,
                contract: {
                  ...candidate.contract,
                  source: {
                    ...(candidate.contract.source as Record<string, unknown>),
                    revision: "b".repeat(40),
                  },
                },
              }
            : candidate,
        ),
      promotion.run,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "complete managed image candidate set failed closed validation",
    );
    expect(result.dockerCalls).toEqual([]);
    expect(barrier.run).not.toContain("imagetools create");
  });

  it("accepts one exact candidate for every agent and architecture (#7744)", () => {
    const barrier = step(
      managedPromoter(readWorkflow("managed-images.yaml")),
      "Validate complete managed image candidate set",
    );

    expect(runPublicationBarrier(barrier.run ?? "").status).toBe(0);
  });

  it("stages all multi-platform cohort aliases before moving the sole root pointer (#7744)", () => {
    const promotion = required(
      step(
        managedPromoter(readWorkflow("managed-images.yaml")),
        "Promote validated multi-platform managed image cohort",
      ).run,
      "managed image promotion script is missing",
    );
    const cohort = "ghrun-7744-2";
    const revision = "a".repeat(40);

    const failed = runManagedImagePromotion(promotion, "langchain-deepagents-code");
    const failedCalls = failed.calls.join("\n");
    expect(failed.status, failed.stderr).toBe(91);
    expect(failedCalls).toContain(`hermes-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`langchain-deepagents-code-sandbox:cohort-${cohort}`);
    expect(failedCalls).toContain(`openclaw-sandbox:cohort-${cohort}`);
    expect(failedCalls).not.toContain(`openclaw-sandbox:${revision}`);

    const accepted = runManagedImagePromotion(promotion);
    const acceptedCalls = accepted.calls.join("\n");
    const lastCohortStage = Math.max(
      acceptedCalls.indexOf(`hermes-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`langchain-deepagents-code-sandbox:cohort-${cohort}`),
      acceptedCalls.indexOf(`openclaw-sandbox:cohort-${cohort}`),
    );
    const rootPointer = acceptedCalls.indexOf(`openclaw-sandbox:${revision}`);

    expect(accepted.status, accepted.stderr).toBe(0);
    expect(lastCohortStage).toBeGreaterThanOrEqual(0);
    expect(rootPointer).toBeGreaterThan(lastCohortStage);
    expect(acceptedCalls).not.toContain(`hermes-sandbox:${revision}`);
    expect(acceptedCalls).not.toContain(`langchain-deepagents-code-sandbox:${revision}`);
    expect(Object.keys(accepted.platformContracts).sort()).toEqual(
      publicationAgents
        .flatMap((agent) => publicationPlatforms.map((platform) => `${agent}|${platform}`))
        .sort(),
    );
    expect(accepted.cohortContract).toMatchObject({
      contractVersion: 1,
      cohort,
      platforms: ["linux/amd64", "linux/arm64"],
      agents: {
        openclaw: expect.objectContaining({
          platforms: expect.objectContaining({
            "linux/amd64": expect.any(Object),
            "linux/arm64": expect.any(Object),
          }),
        }),
        hermes: expect.any(Object),
        "langchain-deepagents-code": expect.any(Object),
      },
    });
  });

  it("retains exact platform and aggregate cohort contracts for ninety days (#7744)", () => {
    const promoter = managedPromoter(readWorkflow("managed-images.yaml"));
    const uploads = (promoter.steps ?? [])
      .filter((candidate) => candidate.uses?.startsWith("actions/upload-artifact@"))
      .map((candidate) => candidate.with);

    expect(uploads).toEqual([
      {
        name: "managed-image-cohort",
        path: "${{ runner.temp }}/managed-image-contracts/cohort.json",
        "if-no-files-found": "error",
        "retention-days": 90,
      },
      ...publicationAgents.flatMap((agent) =>
        publicationPlatforms.map((platform) => {
          const artifactPlatform = platform.replace("/", "-");
          const displayAgent =
            agent === "langchain-deepagents-code" ? "langchain-deepagents-code" : agent;
          return {
            name: `managed-image-${displayAgent}-${artifactPlatform}`,
            path: `\${{ runner.temp }}/managed-image-contracts/${agent}/${artifactPlatform}/contract.json`,
            "if-no-files-found": "error",
            "retention-days": 90,
          };
        }),
      ),
    ]);
  });
});
