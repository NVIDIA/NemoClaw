// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

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
  artifact_platform?: string;
  base_image?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  platform?: string;
  required_binary?: string;
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

function publicationBoundaryErrors(baseWorkflow: Workflow, managedWorkflow: Workflow): string[] {
  const triggerPaths = baseWorkflow.on?.push?.paths ?? [];
  const caller = required(
    baseWorkflow.jobs?.["publish-managed-images"],
    "base-image workflow is missing the managed-image publisher",
  );
  const publisher = managedPublisher(managedWorkflow);
  const steps = publisher.steps ?? [];
  const build = step(publisher, "Build and push managed image by digest");
  const base = step(publisher, "Validate exact base image contract");
  const validate = step(publisher, "Validate exact managed image");
  const workflowSource = JSON.stringify(managedWorkflow);
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
    'release_tag="${GITHUB_REF#refs/tags/}"',
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
      .filter((marker) => workflowSource.includes(marker))
      .map((marker) => `per-agent lane must not publish mutable alias with ${marker}`),
    ...(buildIndex >= 0 && buildIndex < validateIndex
      ? []
      : ["managed image validation must follow its immutable digest build"]),
  ];
}

describe("complete managed-image publication workflow", () => {
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
    expect(step(qemuPublisher, "Export managed base image contract").run).toContain(
      'reference="${IMAGE}@${DIGEST}"',
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
    expect(step(openClawPublisher, "Upload managed base image contract").with?.name).toBe(
      "managed-base-openclaw",
    );
  });

  it("publishes every complete agent image for the initial Linux x86_64 contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_call"]);
    expect(workflow.permissions).toEqual({
      contents: "read",
      packages: "write",
    });
    expect(publisher["runs-on"]).toBe("ubuntu-24.04");
    expect(publisher["timeout-minutes"]).toBe(90);
    expect(publisher.strategy?.["fail-fast"]).toBe(false);
    expect(publisher.strategy?.matrix?.include).toEqual([
      {
        agent: "openclaw",
        display_name: "OpenClaw",
        dockerfile: "Dockerfile",
        base_image: "nvidia/nemoclaw/sandbox-base",
        image: "nvidia/nemoclaw/openclaw-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/openclaw",
      },
      {
        agent: "hermes",
        display_name: "Hermes",
        dockerfile: "agents/hermes/Dockerfile",
        base_image: "nvidia/nemoclaw/hermes-sandbox-base",
        image: "nvidia/nemoclaw/hermes-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/hermes",
      },
      {
        agent: "langchain-deepagents-code",
        display_name: "Deep Agents Code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile",
        base_image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox",
        platform: "linux/amd64",
        artifact_platform: "linux-amd64",
        required_binary: "/usr/local/bin/dcode",
      },
    ]);
  });

  it("pins actions, validates exact digests, and records the immutable image contract (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const steps = publisher.steps ?? [];

    for (const action of steps.filter((candidate) => candidate.uses)) {
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

    const contract = step(publisher, "Export managed image contract");
    for (const marker of [
      "--arg baseReference",
      "--arg digest",
      "--arg platform",
      "--arg revision",
      "--argjson runAttempt",
      "--argjson runId",
      "contractVersion: 1",
    ]) {
      expect(contract.run).toContain(marker);
    }
    expect(step(publisher, "Upload managed image contract").with).toMatchObject({
      name: "managed-image-${{ matrix.agent }}-${{ matrix.artifact_platform }}",
      path: "${{ runner.temp }}/managed-image-contract/contract.json",
      "if-no-files-found": "error",
      "retention-days": 90,
    });
  });

  it("cannot publish a public mutable alias from an individual agent lane (#7744)", () => {
    const workflow = readWorkflow("managed-images.yaml");
    const publisher = managedPublisher(workflow);
    const steps = publisher.steps ?? [];
    const source = steps.map((candidate) => candidate.run ?? "").join("\n");
    const contract = step(publisher, "Export managed image contract");

    expect(publisher.strategy?.matrix?.include).toHaveLength(3);
    expect(steps.map((candidate) => candidate.name)).not.toContain(
      "Promote validated managed image aliases",
    );
    expect(source).not.toContain('aliases=("${IMAGE}:${GITHUB_SHA}")');
    expect(source).not.toContain('release_tag="${GITHUB_REF#refs/tags/}"');
    expect(source).not.toContain("docker buildx imagetools create");
    expect(source).not.toMatch(/(?:^|\s)docker\s+(?:tag|push)\s/u);
    expect(contract.run).toContain('(has("aliases") | not)');
    expect(contract.run).not.toContain("aliases:");
  });
});
