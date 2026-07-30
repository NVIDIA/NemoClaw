// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import {
  publicationAgents,
  publicationPlatforms,
  runManagedImagePromotion,
  runPublicationBarrier,
} from "./helpers/managed-image-publication-barrier";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type MatrixEntry = {
  agent?: string;
  arch?: string;
  artifact_platform?: string;
  base_image?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  platform?: string;
  required_binary?: string;
  runner?: string;
};

type Job = {
  if?: string;
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
    push?: {
      paths?: string[];
    };
    workflow_call?: unknown;
  };
  permissions?: Record<string, string>;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const fullShaAction = /^[^@]+@[0-9a-f]{40}$/iu;
const managedInputPaths = [
  ".dockerignore",
  ".github/workflows/managed-images.yaml",
  "Dockerfile",
  "agents/**",
  "ci/npm-audit-exceptions.json",
  "nemoclaw/**",
  "nemoclaw-blueprint/**",
  "scripts/**",
  "src/lib/actions/sandbox/openshell-child-visible-credentials.v*.json",
  "src/lib/messaging/**",
  "src/lib/tool-disclosure.ts",
  "tools/mcp-tool-discovery-runtime/**",
  "tsconfig.runtime-preloads.json",
] as const;

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

function managedPublisher(workflow: Workflow): Job {
  return required(
    workflow.jobs?.["build-and-validate"],
    "managed-image workflow is missing its publisher",
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
  const validate = step(publisher, "Validate exact managed image");
  const workflowSource = JSON.stringify(managedWorkflow);
  const publisherSource = JSON.stringify(publisher);
  const validationMarkers = [
    'mktemp -d "$RUNNER_TEMP/anonymous-docker-XXXXXX"',
    'DOCKER_CONFIG="$anonymous_config" docker pull --platform "$PLATFORM" "$reference"',
    "bootstrap the GHCR package",
    ".Config.Entrypoint",
    ".Config.Cmd",
    "/usr/local/bin/nemoclaw-start",
    "/opt/nemoclaw-blueprint/blueprint.yaml",
    "/usr/local/share/nemoclaw/node-tar-inventory.json",
    "/usr/local/share/nemoclaw/corporate-ca.pem",
    'entry.status !== "fixed"',
    '--entrypoint "$REQUIRED_BINARY"',
    "io.nvidia.nemoclaw.managed-image.contract",
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
    ...managedInputPaths
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
  it("starts after exact base contracts with complete main triggers and does not cancel release-tag runs (#7744)", () => {
    const baseWorkflow = readWorkflow("base-image.yaml");
    const managedWorkflow = readWorkflow("managed-images.yaml");
    const publisher = required(
      baseWorkflow.jobs?.["publish-managed-images"],
      "base-image workflow is missing the managed-image publisher",
    );

    expect(publicationBoundaryErrors(baseWorkflow, managedWorkflow)).toEqual([]);
    expect(publisher).toMatchObject({
      needs: ["build-and-push-hermes", "build-and-push-dcode", "build-and-push-openclaw"],
      permissions: {
        contents: "read",
        packages: "write",
      },
      uses: "./.github/workflows/managed-images.yaml",
    });
    expect(publisher.if).toContain("github.repository == 'NVIDIA/NemoClaw'");
    expect(publisher.if).toContain("github.ref == 'refs/heads/main'");
    expect(publisher.if).toContain("startsWith(github.ref, 'refs/tags/v')");

    const basePublishers = [
      {
        agent: "hermes",
        artifact: "managed-base-hermes",
        job: "build-and-push-hermes",
        platformsJob: "build-hermes-platforms",
      },
      {
        agent: "langchain-deepagents-code",
        artifact: "managed-base-langchain-deepagents-code",
        job: "build-and-push-dcode",
        platformsJob: "build-dcode-platforms",
      },
      {
        agent: "openclaw",
        artifact: "managed-base-openclaw",
        job: "build-and-push-openclaw",
        platformsJob: "build-openclaw-platforms",
      },
    ] as const;

    for (const expectedPublisher of basePublishers) {
      const basePublisher = required(
        baseWorkflow.jobs?.[expectedPublisher.job],
        `base-image workflow is missing ${expectedPublisher.agent} manifest publisher`,
      );
      const manifest = step(basePublisher, "Create and verify multi-platform manifest");
      expect(manifest.id).toBe("manifest");
      expect(manifest.run).toContain('reference="$IMAGE@$digest"');
      expect(manifest.run).toContain(`agent: "${expectedPublisher.agent}"`);
      expect(manifest.run).toContain("platformDigests: {");
      expect(step(basePublisher, "Upload managed base image contract").with?.name).toBe(
        expectedPublisher.artifact,
      );

      const nativePlatforms = required(
        baseWorkflow.jobs?.[expectedPublisher.platformsJob],
        `base-image workflow is missing native ${expectedPublisher.agent} platforms`,
      );
      expect(nativePlatforms.strategy?.matrix?.include).toEqual(
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
    }
  });

  it("publishes an exact native amd64 and arm64 lane for every shipped agent (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(publisher["runs-on"]).toBe("${{ matrix.runner }}");
    expect(publisher["timeout-minutes"]).toBe(120);
    expect(publisher.strategy?.["fail-fast"]).toBe(false);
    expect(publisher.strategy?.matrix?.include).toEqual([
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
      publisher.strategy?.matrix?.include?.map(({ agent, platform }) => `${agent}|${platform}`),
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
    expect(steps.indexOf(guard)).toBeLessThan(steps.indexOf(build));
    expect(guard.run).toContain('scripts/check-production-build-args.sh "${build_args[@]}"');
    expect(build.uses).toBe("docker/build-push-action@53b7df96c91f9c12dcc8a07bcb9ccacbed38856a");
    expect(build.with).toMatchObject({
      context: ".",
      file: "${{ matrix.dockerfile }}",
      platforms: "${{ matrix.platform }}",
      "build-args": "BASE_IMAGE=${{ steps.base.outputs.ref }}",
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
  });

  it("cannot publish a public mutable alias from an individual agent lane (#7744)", () => {
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
