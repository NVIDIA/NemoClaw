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
  display_name?: string;
  dockerfile?: string;
  image?: string;
};

type WorkflowJob = {
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
    (job.strategy?.matrix?.include ?? []).map((matrix) => ({
      jobName: `${jobName} (${matrix.display_name ?? matrix.agent ?? "unnamed"})`,
      job,
      build,
      buildIndex,
      dockerfile: renderMatrixValue(build.with?.file, matrix),
      matrix,
    })),
  );
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

function validatePublishers(candidate: Workflow): string[] {
  const triggerPaths = candidate.on?.push?.paths ?? [];
  const publishers = publisherJobs(candidate);
  const exportedCacheRefCounts = new Map<string, number>();
  for (const { build, matrix } of publishers) {
    const cacheRef =
      registryCacheEntries(renderMatrixValue(build.with?.["cache-to"], matrix))[0]?.ref ?? "";
    exportedCacheRefCounts.set(cacheRef, (exportedCacheRefCounts.get(cacheRef) ?? 0) + 1);
  }

  return publishers.flatMap(({ jobName, job, build, buildIndex, dockerfile, matrix }) => {
    const steps = job.steps ?? [];
    const metadata = steps.find((step) => step.id === "meta");
    const guardIndex = steps.findIndex((step) =>
      (step.run ?? "").includes("scripts/check-production-build-args.sh"),
    );
    const guard = steps[guardIndex];
    const dockerfileExists =
      dockerfile.length > 0 && fs.existsSync(path.join(repoRoot, dockerfile));
    const copiedInputPaths = dockerfileExists ? copiedInputs(dockerfile) : [];
    const dockerActions = steps.filter((step) => step.uses?.startsWith("docker/"));
    const tags = String(metadata?.with?.tags ?? "");
    const metadataImage = renderMatrixValue(metadata?.with?.images, matrix);
    const expectedCacheRef = `${metadataImage}:buildcache`;
    const cacheFrom = registryCacheEntries(renderMatrixValue(build.with?.["cache-from"], matrix));
    const cacheTo = registryCacheEntries(renderMatrixValue(build.with?.["cache-to"], matrix));
    const importedCacheRef = cacheFrom[0]?.ref;
    const exportedCacheRef = cacheTo[0]?.ref;

    return [
      ...(!dockerfileExists ? [`${jobName} must publish from an existing Dockerfile`] : []),
      ...(!triggerPaths.includes(dockerfile)
        ? [`${jobName} Dockerfile must trigger the publisher workflow`]
        : []),
      ...copiedInputPaths
        .filter((input) => !triggerPaths.includes(input))
        .map((input) => `${jobName} copied input must trigger the publisher workflow: ${input}`),
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
      ...(!tags.includes("type=ref,event=tag") ||
      !tags.includes("type=raw,value=latest") ||
      !tags.includes("type=sha,prefix=,format=short")
        ? [`${jobName} must publish release, latest, and commit tags`]
        : []),
      ...dockerActions
        .filter((step) => !FULL_SHA_ACTION.test(step.uses ?? ""))
        .map((step) => `${jobName} Docker action must use a full commit SHA: ${step.uses}`),
      ...(!FULL_SHA_ACTION.test(build.uses ?? "")
        ? [`${jobName} build-push action must use a full commit SHA`]
        : []),
      ...(build.with?.context !== "." ? [`${jobName} must publish from repository context`] : []),
      ...(build.with?.platforms !== "linux/amd64,linux/arm64"
        ? [`${jobName} must publish both supported architectures`]
        : []),
      ...(build.with?.push !== true ? [`${jobName} must push the built image`] : []),
      ...(build.with?.tags !== "${{ steps.meta.outputs.tags }}" ||
      build.with?.labels !== "${{ steps.meta.outputs.labels }}"
        ? [`${jobName} must publish the reviewed metadata outputs`]
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
  });
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
    expect(publisherBuildSteps(workflow)).toHaveLength(1);
    expect(
      publishers.map(({ dockerfile, matrix }) => ({
        agent: matrix.agent,
        dockerfile,
        image: matrix.image,
      })),
    ).toEqual([
      {
        agent: "openclaw",
        dockerfile: "Dockerfile.base",
        image: "nvidia/nemoclaw/sandbox-base",
      },
      {
        agent: "hermes",
        dockerfile: "agents/hermes/Dockerfile.base",
        image: "nvidia/nemoclaw/hermes-sandbox-base",
      },
      {
        agent: "langchain-deepagents-code",
        dockerfile: "agents/langchain-deepagents-code/Dockerfile.base",
        image: "nvidia/nemoclaw/langchain-deepagents-code-sandbox-base",
      },
    ]);
    expect(publishers[0].job.strategy?.["fail-fast"]).toBe(false);
    expect(validatePublishers(workflow)).toEqual([]);

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
        `${mutatedPublisher.jobName} must push the built image`,
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
  });

  it("keeps shared apt dependencies pinned and aligned across discovered base images (#6679)", () => {
    const dockerfiles = publisherJobs(workflow).map(({ dockerfile }) => dockerfile);
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
    expect(resolution?.validationDescription).toBe(`deepagents-code==${lockedVersion}`);
  });
});
