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
  with?: Record<string, unknown>;
};

type WorkflowJob = {
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
};

const repoRoot = path.resolve(import.meta.dirname, "..");
const workflow = YAML.parse(
  fs.readFileSync(path.join(repoRoot, ".github", "workflows", "base-image.yaml"), "utf8"),
) as Workflow;
const FULL_SHA_ACTION = /^[^@]+@[0-9a-f]{40}$/i;

function publisherJobs(candidate: Workflow): Publisher[] {
  return Object.entries(candidate.jobs ?? {}).flatMap(([jobName, job]) => {
    const steps = job.steps ?? [];
    return steps
      .map((build, buildIndex) => ({ build, buildIndex }))
      .filter(({ build }) => build.uses?.startsWith("docker/build-push-action@"))
      .map(({ build, buildIndex }) => ({
        jobName,
        job,
        build,
        buildIndex,
        dockerfile: String(build.with?.file ?? ""),
      }));
  });
}

function copiedLocks(dockerfile: string): string[] {
  return [
    ...fs
      .readFileSync(path.join(repoRoot, dockerfile), "utf8")
      .matchAll(/^COPY\s+(\S+\.lock)\s+/gm),
  ].map(([, lock]) => lock);
}

function validatePublishers(candidate: Workflow): string[] {
  const triggerPaths = candidate.on?.push?.paths ?? [];
  return publisherJobs(candidate).flatMap(({ jobName, job, build, buildIndex, dockerfile }) => {
    const steps = job.steps ?? [];
    const metadata = steps.find((step) => step.id === "meta");
    const guardIndex = steps.findIndex((step) =>
      (step.run ?? "").includes("scripts/check-production-build-args.sh"),
    );
    const dockerfileExists =
      dockerfile.length > 0 && fs.existsSync(path.join(repoRoot, dockerfile));
    const copiedLockPaths = dockerfileExists ? copiedLocks(dockerfile) : [];
    const dockerActions = steps.filter((step) => step.uses?.startsWith("docker/"));
    const tags = String(metadata?.with?.tags ?? "");

    return [
      ...(!dockerfileExists ? [`${jobName} must publish from an existing Dockerfile`] : []),
      ...(!triggerPaths.includes(dockerfile)
        ? [`${jobName} Dockerfile must trigger the publisher workflow`]
        : []),
      ...copiedLockPaths
        .filter((lock) => !triggerPaths.includes(lock))
        .map((lock) => `${jobName} copied lockfile must trigger the publisher workflow: ${lock}`),
      ...(guardIndex < 0 || guardIndex >= buildIndex
        ? [`${jobName} must validate production build args before publishing`]
        : []),
      ...(!metadata?.uses?.startsWith("docker/metadata-action@")
        ? [`${jobName} must derive publication metadata with docker/metadata-action`]
        : []),
      ...(String(metadata?.with?.images ?? "").length === 0
        ? [`${jobName} must declare a publication image`]
        : []),
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
  // source-shape-contract: security -- Publisher mutations must preserve immutable actions and guarded production build arguments
  it("accepts every discovered publisher and rejects supply-chain mutations", () => {
    const publishers = publisherJobs(workflow);
    expect(publishers.length).toBeGreaterThan(0);
    expect(validatePublishers(workflow)).toEqual([]);

    const mutated = structuredClone(workflow);
    const mutatedPublisher = publisherJobs(mutated)[0];
    const mutatedSteps = mutatedPublisher.job.steps ?? [];
    const mutatedGuard = mutatedSteps.find((step) =>
      (step.run ?? "").includes("scripts/check-production-build-args.sh"),
    );
    mutatedPublisher.build.uses = "docker/build-push-action@v7";
    mutatedPublisher.build.with = { ...mutatedPublisher.build.with, push: false };
    mutatedGuard!.run = "true";

    expect(validatePublishers(mutated)).toEqual(
      expect.arrayContaining([
        `${mutatedPublisher.jobName} must validate production build args before publishing`,
        `${mutatedPublisher.jobName} Docker action must use a full commit SHA: docker/build-push-action@v7`,
        `${mutatedPublisher.jobName} build-push action must use a full commit SHA`,
        `${mutatedPublisher.jobName} must push the built image`,
      ]),
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
