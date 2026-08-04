// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { createDeepAgentsCodeBaseImageResolutionOptions } from "../src/lib/agent/deep-agents-code-base-image.ts";
import { loadAgent } from "../src/lib/agent/defs.ts";

type WorkflowStep = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  env?: Record<string, unknown>;
  with?: Record<string, unknown>;
};

type PublisherMatrixEntry = {
  agent?: string;
  arch?: string;
  display_name?: string;
  dockerfile?: string;
  image?: string;
  platform?: string;
  runner?: string;
};

type WorkflowJob = {
  name?: string;
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: { include?: PublisherMatrixEntry[] };
  };
  steps?: WorkflowStep[];
};

type Workflow = {
  on?: { push?: { paths?: string[] } };
  jobs?: Record<string, WorkflowJob>;
};

type Publisher = {
  jobName: string;
  job: WorkflowJob;
  build: WorkflowStep;
  buildIndex: number;
  dockerfile: string;
  matrix: PublisherMatrixEntry;
};

type RegistryCacheEntry = {
  mode?: string;
  ref?: string;
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", "base-image.yaml"), "utf8"),
) as Workflow;
const FULL_SHA_ACTION = /^[^@]+@[0-9a-f]{40}$/i;
const OPENCLAW_AGENT_GATE =
  'if [ "$AGENT" = "openclaw" ] && [ -n "${OPENCLAW_VERSION_INPUT}" ]; then';
const PLATFORM_DIGEST_OUTPUT =
  "type=image,name=${{ env.REGISTRY }}/${{ matrix.image }},push-by-digest=true,name-canonical=true,push=true";

function renderMatrixValue(value: unknown, matrix: PublisherMatrixEntry): string {
  return String(value ?? "").replace(
    /\$\{\{\s*matrix\.([a-z_]+)\s*\}\}/gu,
    (_match, key: keyof PublisherMatrixEntry) => String(matrix[key] ?? ""),
  );
}

function publisherBuildSteps(candidate: Workflow): Omit<Publisher, "dockerfile" | "matrix">[] {
  return Object.entries(candidate.jobs ?? {}).flatMap(([jobName, job]) => {
    const steps = job.steps ?? [];
    return steps
      .map((build, buildIndex) => ({ build, buildIndex }))
      .filter(({ build }) => build.uses?.startsWith("docker/build-push-action@"))
      .map(({ build, buildIndex }) => ({ jobName, job, build, buildIndex }));
  });
}

function publisherJobs(candidate: Workflow): Publisher[] {
  return publisherBuildSteps(candidate).flatMap(({ jobName, job, build, buildIndex }) =>
    (job.strategy?.matrix?.include ?? [])
      .filter((matrix) => matrix.display_name)
      .map((matrix) => ({
        jobName: `${jobName} (${matrix.display_name})`,
        job,
        build,
        buildIndex,
        dockerfile: renderMatrixValue(build.with?.file, matrix),
        matrix,
      })),
  );
}

function openClawPlatformPublishers(candidate: Workflow): Publisher[] {
  const jobName = "build-openclaw-platforms";
  const job = candidate.jobs?.[jobName] as WorkflowJob;
  const steps = job?.steps ?? [];
  const buildIndex = steps.findIndex((step) => step.uses?.startsWith("docker/build-push-action@"));
  const build = steps[buildIndex] as WorkflowStep;
  return (job.strategy?.matrix?.include ?? []).map((matrix) => ({
    jobName: `${jobName} (${matrix.arch ?? "unnamed"})`,
    job,
    build,
    buildIndex,
    dockerfile: renderMatrixValue(build.with?.file, matrix),
    matrix,
  }));
}

function copiedInputs(dockerfile: string): string[] {
  return [
    ...fs
      .readFileSync(path.join(repoRoot, dockerfile), "utf8")
      .matchAll(/^COPY\s+(?!--from=)(?:--\S+\s+)*(\S+)\s+\S+/gm),
  ].map(([, input]) => input);
}

function copiedLocks(dockerfile: string): string[] {
  return copiedInputs(dockerfile).filter((input) => input.endsWith(".lock"));
}

function registryCacheEntries(value: unknown): RegistryCacheEntry[] {
  return String(value ?? "")
    .split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.split(",").includes("type=registry"))
    .map((entry) =>
      Object.fromEntries(
        entry
          .split(",")
          .filter((field) => field !== "type=registry")
          .map((field) => field.split("=", 2) as [string, string]),
      ),
    );
}

function hasAgentScopedOpenClawVersion(step: WorkflowStep | undefined): boolean {
  const segments = (step?.run ?? "").split(OPENCLAW_AGENT_GATE);
  return (
    step?.env?.AGENT === "${{ matrix.agent }}" &&
    segments.length === 3 &&
    segments[0].includes('openclaw_build_arg=""') &&
    segments[1].includes('openclaw_build_arg="OPENCLAW_VERSION=${OPENCLAW_VERSION_INPUT}"') &&
    segments[2].includes('if [[ "$OPENCLAW_VERSION_INPUT"')
  );
}

function validatePublisherInputs(candidate: Workflow, publishers: Publisher[]): string[] {
  const triggerPaths = candidate.on?.push?.paths ?? [];
  return publishers.flatMap(({ jobName, dockerfile }) => {
    const dockerfileExists =
      dockerfile.length > 0 && fs.existsSync(path.join(repoRoot, dockerfile));
    const copiedInputPaths = dockerfileExists ? copiedInputs(dockerfile) : [];
    return [
      ...(!dockerfileExists ? [`${jobName} must publish from an existing Dockerfile`] : []),
      ...(!triggerPaths.includes(dockerfile)
        ? [`${jobName} Dockerfile must trigger the publisher workflow`]
        : []),
      ...copiedInputPaths
        .filter((input) => !triggerPaths.includes(input))
        .map((input) => `${jobName} copied input must trigger the publisher workflow: ${input}`),
    ];
  });
}

function validatePublishers(candidate: Workflow): string[] {
  const publishers = publisherJobs(candidate);
  const exportedCacheRefCounts = new Map<string, number>();
  for (const { build, matrix } of publishers) {
    const cacheRef =
      registryCacheEntries(renderMatrixValue(build.with?.["cache-to"], matrix))[0]?.ref ?? "";
    exportedCacheRefCounts.set(cacheRef, (exportedCacheRefCounts.get(cacheRef) ?? 0) + 1);
  }

  return [
    ...validatePublisherInputs(candidate, publishers),
    ...publishers.flatMap(({ jobName, job, build, buildIndex, matrix }) => {
      const steps = job.steps ?? [];
      const metadata = steps.find((step) => step.id === "meta");
      const guardIndex = steps.findIndex((step) =>
        (step.run ?? "").includes("scripts/check-production-build-args.sh"),
      );
      const guard = steps[guardIndex];
      const dockerActions = steps.filter((step) => step.uses?.startsWith("docker/"));
      const tags = String(metadata?.with?.tags ?? "");
      const metadataImage = renderMatrixValue(metadata?.with?.images, matrix);
      const expectedCacheRef = `${metadataImage}:buildcache-${matrix.arch}`;
      const cacheFrom = registryCacheEntries(renderMatrixValue(build.with?.["cache-from"], matrix));
      const cacheTo = registryCacheEntries(renderMatrixValue(build.with?.["cache-to"], matrix));
      const importedCacheRef = cacheFrom[0]?.ref;
      const exportedCacheRef = cacheTo[0]?.ref;
      return [
        ...(guardIndex < 0 || guardIndex >= buildIndex
          ? [`${jobName} must validate production build args before publishing`]
          : []),
        ...(!hasAgentScopedOpenClawVersion(guard)
          ? [`${jobName} must scope OpenClaw version handling to the OpenClaw matrix entry`]
          : []),
        ...(!metadata?.uses?.startsWith("docker/metadata-action@")
          ? [`${jobName} must derive publication metadata with docker/metadata-action`]
          : []),
        ...(metadataImage.length === 0 ? [`${jobName} must declare a publication image`] : []),
        ...(tags.length > 0 ? [`${jobName} platform build must not publish mutable tags`] : []),
        ...dockerActions
          .filter((step) => !FULL_SHA_ACTION.test(step.uses ?? ""))
          .map((step) => `${jobName} Docker action must use a full commit SHA: ${step.uses}`),
        ...(!FULL_SHA_ACTION.test(build.uses ?? "")
          ? [`${jobName} build-push action must use a full commit SHA`]
          : []),
        ...(build.with?.context !== "." ? [`${jobName} must publish from repository context`] : []),
        ...(build.with?.platforms !== "${{ matrix.platform }}"
          ? [`${jobName} must build its selected native platform`]
          : []),
        ...(build.with?.outputs !== PLATFORM_DIGEST_OUTPUT
          ? [`${jobName} must push an immutable platform digest`]
          : []),
        ...(build.with?.tags !== undefined || build.with?.push !== undefined
          ? [`${jobName} platform build must not publish tags directly`]
          : []),
        ...(build.with?.labels !== "${{ steps.meta.outputs.labels }}"
          ? [`${jobName} must use the reviewed metadata labels`]
          : []),
        ...(cacheFrom.length !== 1 || !importedCacheRef
          ? [`${jobName} cache-from must declare exactly one registry cache ref`]
          : []),
        ...(cacheTo.length !== 1 || !exportedCacheRef
          ? [`${jobName} cache-to must declare exactly one registry cache ref`]
          : []),
        ...(importedCacheRef !== exportedCacheRef
          ? [`${jobName} must import and export the same registry cache ref`]
          : []),
        ...(cacheTo[0]?.mode !== "max"
          ? [`${jobName} must export its registry cache in max mode`]
          : []),
        ...(exportedCacheRef && exportedCacheRef !== expectedCacheRef
          ? [`${jobName} registry cache must use its publication image buildcache tag`]
          : []),
        ...(exportedCacheRef && exportedCacheRefCounts.get(exportedCacheRef) !== 1
          ? [`${jobName} must use a publisher-unique registry cache ref`]
          : []),
      ];
    }),
  ];
}

function pinnedAptVersion(dockerfile: string, packageName: string): string {
  const source = fs.readFileSync(path.join(repoRoot, dockerfile), "utf8");
  const version = source.match(new RegExp(`^\\s*${packageName}=([^\\s\\\\]+)`, "m"))?.[1];
  expect(version, `${dockerfile} must pin ${packageName}`).toBeDefined();
  return version as string;
}

describe("base-image publication behavior", () => {
  // source-shape-contract: security -- Publisher mutations must preserve immutable actions, guarded arguments, and trusted registry cache ownership
  it("accepts every discovered publisher and rejects supply-chain mutations", () => {
    const publishers = publisherJobs(workflow);
    expect(publisherBuildSteps(workflow)).toHaveLength(3);
    expect(
      publishers.map(({ dockerfile, matrix }) => ({
        agent: matrix.agent,
        arch: matrix.arch,
        dockerfile,
        image: matrix.image,
      })),
    ).toEqual([
      {
        agent: "hermes",
        arch: "amd64",
        dockerfile: "agents/hermes/Dockerfile.base",
        image: "nvidia/nemoclaw/hermes-sandbox-base",
      },
      {
        agent: "hermes",
        arch: "arm64",
        dockerfile: "agents/hermes/Dockerfile.base",
        image: "nvidia/nemoclaw/hermes-sandbox-base",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "amd64",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile.base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "arm64",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile.base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
      },
    ]);
    for (const publisher of publishers) {
      expect(publisher.job.strategy?.["fail-fast"]).toBe(false);
    }
    expect(validatePublishers(workflow)).toEqual([]);
    expect(validatePublisherInputs(workflow, openClawPlatformPublishers(workflow))).toEqual([]);

    const mutated = structuredClone(workflow);
    const mutatedPublisher = publisherJobs(mutated)[0];
    const mutatedSteps = mutatedPublisher.job.steps ?? [];
    const otherPublisher = publisherJobs(mutated)[1];
    const otherCacheRef = registryCacheEntries(
      renderMatrixValue(otherPublisher.build.with?.["cache-to"], otherPublisher.matrix),
    )[0]?.ref;
    const mutatedGuard = mutatedSteps.find((step) =>
      (step.run ?? "").includes("scripts/check-production-build-args.sh"),
    );
    mutatedPublisher.build.uses = "docker/build-push-action@v7";
    mutatedPublisher.build.with = {
      ...mutatedPublisher.build.with,
      push: false,
      "cache-from": "type=gha",
      "cache-to": `type=registry,ref=${otherCacheRef}`,
    };
    mutatedGuard!.run = "true";

    expect(validatePublishers(mutated)).toEqual(
      expect.arrayContaining([
        `${mutatedPublisher.jobName} must validate production build args before publishing`,
        `${mutatedPublisher.jobName} Docker action must use a full commit SHA: docker/build-push-action@v7`,
        `${mutatedPublisher.jobName} build-push action must use a full commit SHA`,
        `${mutatedPublisher.jobName} platform build must not publish tags directly`,
        `${mutatedPublisher.jobName} cache-from must declare exactly one registry cache ref`,
        `${mutatedPublisher.jobName} must import and export the same registry cache ref`,
        `${mutatedPublisher.jobName} must export its registry cache in max mode`,
        `${mutatedPublisher.jobName} registry cache must use its publication image buildcache tag`,
        `${mutatedPublisher.jobName} must use a publisher-unique registry cache ref`,
      ]),
    );

    const invertedGate = structuredClone(workflow);
    const invertedPublisher = publisherJobs(invertedGate)[0];
    const invertedGuard = (invertedPublisher.job.steps ?? []).find((step) =>
      (step.run ?? "").includes("scripts/check-production-build-args.sh"),
    );
    invertedGuard!.run = invertedGuard!.run!.replaceAll(
      OPENCLAW_AGENT_GATE,
      OPENCLAW_AGENT_GATE.replace("openclaw", "hermes"),
    );

    expect(validatePublishers(invertedGate)).toContain(
      `${invertedPublisher.jobName} must scope OpenClaw version handling to the OpenClaw matrix entry`,
    );

    const missingTriggers = structuredClone(workflow);
    const copiedInput = copiedInputs("Dockerfile.base")[0];
    missingTriggers.on!.push!.paths = missingTriggers.on!.push!.paths!.filter(
      (triggerPath) => triggerPath !== "Dockerfile.base" && triggerPath !== copiedInput,
    );
    expect(
      validatePublisherInputs(missingTriggers, openClawPlatformPublishers(missingTriggers)),
    ).toEqual(
      expect.arrayContaining([
        "build-openclaw-platforms (amd64) Dockerfile must trigger the publisher workflow",
        `build-openclaw-platforms (arm64) copied input must trigger the publisher workflow: ${copiedInput}`,
      ]),
    );
  });

  it("publishes OpenClaw atomically from native architecture runners", () => {
    const publishers = openClawPlatformPublishers(workflow);
    const platformJob = workflow.jobs?.["build-openclaw-platforms"];
    const manifestJob = workflow.jobs?.["build-and-push-openclaw"];

    expect(platformJob?.["timeout-minutes"]).toBe(60);
    expect(platformJob?.strategy?.["fail-fast"]).toBe(false);
    expect(
      publishers.map(({ matrix }) => ({
        agent: matrix.agent,
        arch: matrix.arch,
        platform: matrix.platform,
        runner: matrix.runner,
      })),
    ).toEqual([
      {
        agent: "openclaw",
        arch: "amd64",
        platform: "linux/amd64",
        runner: "ubuntu-24.04",
      },
      {
        agent: "openclaw",
        arch: "arm64",
        platform: "linux/arm64",
        runner: "ubuntu-24.04-arm",
      },
    ]);

    for (const { job, build, buildIndex, dockerfile, matrix } of publishers) {
      const steps = job.steps ?? [];
      const guardIndex = steps.findIndex((step) =>
        (step.run ?? "").includes("scripts/check-production-build-args.sh"),
      );
      const digestExport = steps.find((step) => step.name === "Export platform digest");
      const digestUpload = steps.find((step) => step.name === "Upload platform digest");
      const cacheSuffix = `buildcache-${matrix.arch}`;

      expect(dockerfile).toBe("Dockerfile.base");
      expect(job["runs-on"]).toBe("${{ matrix.runner }}");
      expect(steps.some((step) => step.uses?.startsWith("docker/setup-qemu-action@"))).toBe(false);
      expect(guardIndex).toBeGreaterThanOrEqual(0);
      expect(guardIndex).toBeLessThan(buildIndex);
      expect(hasAgentScopedOpenClawVersion(steps[guardIndex])).toBe(true);
      expect(build.with?.platforms).toBe("${{ matrix.platform }}");
      expect(build.with?.outputs).toBe(PLATFORM_DIGEST_OUTPUT);
      expect(build.with?.tags).toBeUndefined();
      expect(renderMatrixValue(build.with?.["cache-from"], matrix)).toContain(cacheSuffix);
      expect(renderMatrixValue(build.with?.["cache-to"], matrix)).toContain(
        `${cacheSuffix},mode=max`,
      );
      expect(digestExport?.env?.ARCH).toBe("${{ matrix.arch }}");
      expect(digestExport?.run).toContain("^sha256:[0-9a-f]{64}$");
      expect(digestExport?.run).toContain('touch "$RUNNER_TEMP/digests/${ARCH}-${DIGEST#sha256:}"');
      expect(digestUpload?.with?.name).toBe(
        "openclaw-base-digest-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.arch }}",
      );
      for (const step of steps.filter((step) => step.uses)) {
        expect(step.uses, `${matrix.arch}: ${step.name}`).toMatch(FULL_SHA_ACTION);
      }
    }

    expect(manifestJob?.name).toBe("Build and push OpenClaw base image");
    expect(manifestJob?.needs).toBe("build-openclaw-platforms");
    expect(manifestJob?.["timeout-minutes"]).toBe(10);
    expect(
      manifestJob?.steps?.some((step) => step.uses?.startsWith("docker/build-push-action@")),
    ).toBe(false);
    const download = manifestJob?.steps?.find((step) => step.name === "Download platform digests");
    const metadata = manifestJob?.steps?.find((step) => step.id === "meta");
    const createManifest = manifestJob?.steps?.find(
      (step) => step.name === "Create and verify multi-platform manifest",
    );
    expect(download?.with).toMatchObject({
      pattern: "openclaw-base-digest-${{ github.run_id }}-${{ github.run_attempt }}-*",
      "merge-multiple": true,
    });
    expect(metadata?.with?.images).toBe("${{ env.REGISTRY }}/nvidia/nemoclaw/sandbox-base");
    expect(metadata?.with?.tags).toContain("type=raw,value=latest");
    expect(metadata?.with?.tags).toContain("type=ref,event=tag");
    expect(metadata?.with?.tags).toContain("type=sha,prefix=,format=short");
    expect(createManifest?.env?.AGENT).toBe("openclaw");
    const openClawManifestScript = createManifest?.run ?? "";
    expect(openClawManifestScript).toContain('"${#digest_files[@]}" -ne 2');
    expect(openClawManifestScript).toContain("^(amd64|arm64)-([0-9a-f]{64})$");
    expect(openClawManifestScript).toContain("--format '{{.Image.OS}}/{{.Image.Architecture}}'");
    expect(openClawManifestScript).toContain(
      'if [ "$source_platform" != "linux/$expected_arch" ]; then',
    );
    expect(openClawManifestScript).toContain("duplicate platform digest");
    expect(openClawManifestScript).toContain("declare -A source_digests=()");
    expect(openClawManifestScript).toContain(
      'source_digests["linux/$expected_arch"]="sha256:$digest"',
    );
    expect(openClawManifestScript.indexOf("source_platform=")).toBeLessThan(
      openClawManifestScript.indexOf("docker buildx imagetools create"),
    );
    expect(openClawManifestScript).toContain('--tag "$candidate_tag"');
    expect(openClawManifestScript).toContain('--metadata-file "$candidate_metadata"');
    expect(openClawManifestScript).toContain('"${sources[@]}"');
    expect(openClawManifestScript).toContain('"amd64,arm64"');
    expect(openClawManifestScript).toContain('"${source_digests[linux/amd64]}"');
    expect(openClawManifestScript).toContain('"${source_digests[linux/arm64]}"');
    expect(openClawManifestScript).toContain("platform_digests_json=");
    expect(openClawManifestScript).toContain("declare -A platform_digests=()");
    expect(openClawManifestScript).toContain("scripts/export-managed-base-image-contract.sh");
    expect(openClawManifestScript).not.toContain("first_tag=");
    expect(openClawManifestScript).not.toContain(
      'imagetools create "${tag_args[@]}" "${sources[@]}"',
    );
    const openClawValidationIndex = openClawManifestScript.indexOf(
      "scripts/checks/validate-managed-base-index.sh",
    );
    const openClawPromotionIndex = openClawManifestScript.indexOf("publication_metadata=");
    expect(openClawManifestScript.indexOf("candidate_tag=")).toBeLessThan(openClawValidationIndex);
    expect(openClawValidationIndex).toBeLessThan(openClawPromotionIndex);
    expect(openClawManifestScript.slice(openClawPromotionIndex)).toContain('"${tag_args[@]}"');
    expect(openClawManifestScript.slice(openClawPromotionIndex)).toContain('"$reference"');
    expect(openClawManifestScript).toContain("published_digest=");
    expect(openClawManifestScript).toContain('if [ "$published_digest" != "$digest" ]; then');
    for (const step of (manifestJob?.steps ?? []).filter((step) => step.uses)) {
      expect(step.uses, step.name).toMatch(FULL_SHA_ACTION);
    }
  });

  it("publishes sibling images atomically from native architecture runners", () => {
    const publishers = publisherJobs(workflow);
    const imagePublishers = [
      {
        agent: "hermes",
        platformJobName: "build-hermes-platforms",
        manifestJobName: "build-and-push-hermes",
        manifestName: "Build and push Hermes base image",
        artifactPattern: "hermes-base-digest-${{ github.run_id }}-${{ github.run_attempt }}-*",
        image: "${{ env.REGISTRY }}/nvidia/nemoclaw/hermes-sandbox-base",
      },
      {
        agent: "langchain-deepagents-code",
        platformJobName: "build-dcode-platforms",
        manifestJobName: "build-and-push-dcode",
        manifestName: "Build and push Deep Agents Code base image",
        artifactPattern:
          "langchain-deepagents-code-base-digest-${{ github.run_id }}-${{ github.run_attempt }}-*",
        image: "${{ env.REGISTRY }}/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
      },
    ];

    for (const { platformJobName } of imagePublishers) {
      const platformJob = workflow.jobs?.[platformJobName];
      expect(platformJob?.["timeout-minutes"]).toBe(60);
      expect(platformJob?.["runs-on"]).toBe("${{ matrix.runner }}");
      expect(platformJob?.strategy?.["fail-fast"]).toBe(false);
    }
    expect(
      publishers.map(({ matrix }) => ({
        agent: matrix.agent,
        arch: matrix.arch,
        platform: matrix.platform,
        runner: matrix.runner,
      })),
    ).toEqual([
      {
        agent: "hermes",
        arch: "amd64",
        platform: "linux/amd64",
        runner: "ubuntu-24.04",
      },
      {
        agent: "hermes",
        arch: "arm64",
        platform: "linux/arm64",
        runner: "ubuntu-24.04-arm",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "amd64",
        platform: "linux/amd64",
        runner: "ubuntu-24.04",
      },
      {
        agent: "langchain-deepagents-code",
        arch: "arm64",
        platform: "linux/arm64",
        runner: "ubuntu-24.04-arm",
      },
    ]);

    for (const { job, build, matrix } of publishers) {
      const steps = job.steps ?? [];
      const digestExport = steps.find((step) => step.name === "Export platform digest");
      const digestUpload = steps.find((step) => step.name === "Upload platform digest");

      expect(steps.some((step) => step.uses?.startsWith("docker/setup-qemu-action@"))).toBe(false);
      expect(build.with?.platforms).toBe("${{ matrix.platform }}");
      expect(build.with?.outputs).toBe(PLATFORM_DIGEST_OUTPUT);
      expect(digestExport?.env?.ARCH).toBe("${{ matrix.arch }}");
      expect(digestExport?.run).toContain('touch "$RUNNER_TEMP/digests/${ARCH}-${DIGEST#sha256:}"');
      expect(digestUpload?.with?.name).toBe(
        "${{ matrix.agent }}-base-digest-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.arch }}",
      );
      expect(renderMatrixValue(digestUpload?.with?.name, matrix)).toBe(
        `${matrix.agent}-base-digest-` +
          "${{ github.run_id }}-${{ github.run_attempt }}-" +
          matrix.arch,
      );
    }

    for (const imagePublisher of imagePublishers) {
      const manifestJob = workflow.jobs?.[imagePublisher.manifestJobName];
      expect(manifestJob?.name).toBe(imagePublisher.manifestName);
      expect(manifestJob?.needs).toBe(imagePublisher.platformJobName);
      expect(manifestJob?.["timeout-minutes"]).toBe(10);
      expect(
        manifestJob?.steps?.some((step) => step.uses?.startsWith("docker/build-push-action@")),
      ).toBe(false);
      const download = manifestJob?.steps?.find(
        (step) => step.name === "Download platform digests",
      );
      const metadata = manifestJob?.steps?.find((step) => step.id === "meta");
      const createManifest = manifestJob?.steps?.find(
        (step) => step.name === "Create and verify multi-platform manifest",
      );
      expect(download?.with).toMatchObject({
        pattern: imagePublisher.artifactPattern,
        "merge-multiple": true,
      });
      expect(metadata?.with?.images).toBe(imagePublisher.image);
      expect(metadata?.with?.tags).toContain("type=raw,value=latest");
      expect(metadata?.with?.tags).toContain("type=ref,event=tag");
      expect(metadata?.with?.tags).toContain("type=sha,prefix=,format=short");
      expect(createManifest?.env?.AGENT).toBe(imagePublisher.agent);
      expect(createManifest?.env?.IMAGE).toBe(imagePublisher.image);
      const manifestScript = createManifest?.run ?? "";
      expect(manifestScript).toContain('"${#digest_files[@]}" -ne 2');
      expect(manifestScript).toContain("^(amd64|arm64)-([0-9a-f]{64})$");
      expect(manifestScript).toContain("--format '{{.Image.OS}}/{{.Image.Architecture}}'");
      expect(manifestScript).toContain('if [ "$source_platform" != "linux/$expected_arch" ]; then');
      expect(manifestScript).toContain("duplicate platform digest");
      expect(manifestScript).toContain("declare -A source_digests=()");
      expect(manifestScript).toContain('source_digests["linux/$expected_arch"]="sha256:$digest"');
      expect(manifestScript.indexOf("source_platform=")).toBeLessThan(
        manifestScript.indexOf("docker buildx imagetools create"),
      );
      expect(manifestScript).toContain('--tag "$candidate_tag"');
      expect(manifestScript).toContain('--metadata-file "$candidate_metadata"');
      expect(manifestScript).toContain('"${sources[@]}"');
      expect(manifestScript).toContain('"amd64,arm64"');
      expect(manifestScript).toContain("scripts/checks/validate-managed-base-index.sh");
      expect(manifestScript).toContain('"${source_digests[linux/amd64]}"');
      expect(manifestScript).toContain('"${source_digests[linux/arm64]}"');
      expect(manifestScript).toContain("platform_digests_json=");
      expect(manifestScript).toContain("declare -A platform_digests=()");
      expect(manifestScript).toContain("scripts/export-managed-base-image-contract.sh");
      expect(manifestScript).not.toContain("first_tag=");
      expect(manifestScript).not.toContain('imagetools create "${tag_args[@]}" "${sources[@]}"');
      const validationIndex = manifestScript.indexOf(
        "scripts/checks/validate-managed-base-index.sh",
      );
      const promotionIndex = manifestScript.indexOf("publication_metadata=");
      expect(manifestScript.indexOf("candidate_tag=")).toBeLessThan(validationIndex);
      expect(validationIndex).toBeLessThan(promotionIndex);
      expect(manifestScript.slice(promotionIndex)).toContain('"${tag_args[@]}"');
      expect(manifestScript.slice(promotionIndex)).toContain('"$reference"');
      expect(manifestScript).toContain("published_digest=");
      expect(manifestScript).toContain('if [ "$published_digest" != "$digest" ]; then');
      for (const step of (manifestJob?.steps ?? []).filter((step) => step.uses)) {
        expect(step.uses, step.name).toMatch(FULL_SHA_ACTION);
      }
    }
  });

  it("keeps shared apt dependencies pinned and aligned across discovered base images (#6679)", () => {
    const dockerfiles = [
      ...openClawPlatformPublishers(workflow).map(({ dockerfile }) => dockerfile),
      ...publisherJobs(workflow).map(({ dockerfile }) => dockerfile),
    ].filter((dockerfile, index, all) => all.indexOf(dockerfile) === index);
    const curlVersions = dockerfiles.map((dockerfile) => pinnedAptVersion(dockerfile, "curl"));

    expect(new Set(dockerfiles).size).toBe(dockerfiles.length);
    expect(new Set(curlVersions).size).toBe(1);
    for (const dockerfile of dockerfiles) {
      const source = fs.readFileSync(path.join(repoRoot, dockerfile), "utf8");
      expect(source, dockerfile).toMatch(/^FROM\s+\S+@sha256:[0-9a-f]{64}\s*$/m);
    }
  });

  it("binds a copied Deep Agents Code hash lock to the adjacent runtime manifest", () => {
    const lockedPublisher = publisherJobs(workflow).find(
      ({ dockerfile }) => copiedLocks(dockerfile).length > 0,
    );
    expect(lockedPublisher).toBeDefined();
    const [lockPath] = copiedLocks(lockedPublisher!.dockerfile);
    const lock = fs.readFileSync(path.join(repoRoot, lockPath), "utf8");
    const dockerfilePath = path.join(repoRoot, lockedPublisher!.dockerfile);
    const agent = loadAgent(path.basename(path.dirname(lockedPublisher!.dockerfile)));
    const resolution = createDeepAgentsCodeBaseImageResolutionOptions(agent, dockerfilePath);
    const lockedVersion = lock.match(/^deepagents-code==([^\s\\]+)/m)?.[1];

    expect(resolution).toBeDefined();
    expect(resolution?.inputPaths).toEqual(
      expect.arrayContaining([agent.manifestPath, path.join(repoRoot, lockPath)]),
    );
    expect(lock).toMatch(/^deepagents-code==[^\s\\]+\s+\\\n\s+--hash=sha256:[0-9a-f]{64}/m);
    expect(lockedVersion).toBeDefined();
    expect(agent.expectedVersion).toBe(lockedVersion);
    expect(resolution?.validationDescription).toBe(
      `deepagents-code==${lockedVersion} and the immutable security package inventory`,
    );
  });
});
