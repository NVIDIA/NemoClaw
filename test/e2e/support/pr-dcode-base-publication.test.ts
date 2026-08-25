// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  MANAGED_IMAGE_CONTRACT_VERSION,
  MANAGED_IMAGE_REPOSITORIES,
  MANAGED_IMAGE_SOURCE_REPOSITORY,
  MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
  SHIPPED_MANAGED_IMAGE_AGENTS,
  type ManagedImageAgent,
  type ManagedImageContractV1,
} from "../../../src/lib/onboard/managed-image/contract.ts";
import {
  buildDockerInspectionEnvironment,
  readDcodeBaseResolution,
  resolvePrDcodeBasePublication,
} from "../../../tools/e2e/pr-dcode-base-publication.mts";

const CANDIDATE_SHA = "a".repeat(40);
const BASE_SOURCE_SHA = "b".repeat(40);
const COHORT = "ghrun-32841372913-1";
const BASE_IMAGE = "ghcr.io/nvidia/nemoclaw/langchain-deepagents-code-sandbox-base";
const BASE_DIGEST = `sha256:${"c".repeat(64)}`;
const BASE_REFERENCE = `${BASE_IMAGE}@${BASE_DIGEST}`;
const MANAGED_DIGEST = `sha256:${"d".repeat(64)}`;
const DCODE_IMAGE = MANAGED_IMAGE_REPOSITORIES["langchain-deepagents-code"];
const DCODE_REFERENCE = `${DCODE_IMAGE}@${MANAGED_DIGEST}`;

function contract(agent: ManagedImageAgent, index: number): ManagedImageContractV1 {
  const image = MANAGED_IMAGE_REPOSITORIES[agent];
  const digest: ManagedImageContractV1["digest"] =
    agent === "langchain-deepagents-code"
      ? (MANAGED_DIGEST as ManagedImageContractV1["digest"])
      : (`sha256:${String(index + 1).repeat(64)}` as const);
  return {
    contractVersion: MANAGED_IMAGE_CONTRACT_VERSION,
    agent,
    platform: "linux/amd64",
    image,
    digest,
    reference: `${image}@${digest}`,
    source: {
      repository: MANAGED_IMAGE_SOURCE_REPOSITORY,
      revision: CANDIDATE_SHA,
      release: "v0.0.113",
      cohort: COHORT,
    },
    startupProfileContractVersion: MANAGED_IMAGE_STARTUP_PROFILE_CONTRACT_VERSION,
    capabilityContractVersion: MANAGED_IMAGE_CAPABILITY_CONTRACT_VERSION,
  };
}

function catalog(): string {
  return JSON.stringify(
    Object.fromEntries(
      SHIPPED_MANAGED_IMAGE_AGENTS.map((agent, index) => [agent, contract(agent, index)]),
    ),
  );
}

function baseResolution(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const value = {
    schema: 1,
    key: "",
    imageName: BASE_IMAGE,
    ref: BASE_REFERENCE,
    digest: BASE_DIGEST,
    source: "override",
    sourceRevision: BASE_SOURCE_SHA,
    imageId: `sha256:${"e".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.39",
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
    ...overrides,
  };
  value.key = createHash("sha256")
    .update(JSON.stringify({ ...value, key: "" }))
    .digest("hex");
  return value;
}

function inspection(resolution = baseResolution()): unknown {
  const encoded = Buffer.from(JSON.stringify(resolution)).toString("base64url");
  return [
    {
      Architecture: "amd64",
      Os: "linux",
      RepoDigests: [DCODE_REFERENCE],
      Config: {
        Labels: {
          "com.nvidia.nemoclaw.base-resolution": encoded,
          "com.nvidia.nemoclaw.base-resolution-key": resolution.key,
          "io.nvidia.nemoclaw.agent": "langchain-deepagents-code",
          "io.nvidia.nemoclaw.managed-image.cohort": COHORT,
          "io.nvidia.nemoclaw.managed-image.contract": "1",
          "io.nvidia.nemoclaw.managed-image.platform": "linux/amd64",
          "org.opencontainers.image.revision": CANDIDATE_SHA,
          "org.opencontainers.image.version": "v0.0.113",
        },
      },
    },
  ];
}

const publication = {
  id: 32832002443,
  attempt: 1,
  workflowId: 194842001,
  headSha: BASE_SOURCE_SHA,
  status: "completed",
  conclusion: "success",
  url: "https://github.com/NVIDIA/NemoClaw/actions/runs/32832002443",
};

describe("exact PR Deep Agents Code base publication pairing", () => {
  it("keeps controller credentials out of Docker inspection subprocesses", () => {
    expect(
      buildDockerInspectionEnvironment({
        DOCKER_HOST: "unix:///var/run/docker.sock",
        GITHUB_TOKEN: "github-secret",
        LC_ALL: "C.UTF-8",
        NVIDIA_API_KEY: "nvidia-secret",
        PATH: "/usr/bin:/bin",
      }),
    ).toEqual({
      DOCKER_HOST: "unix:///var/run/docker.sock",
      LC_ALL: "C.UTF-8",
      PATH: "/usr/bin:/bin",
    });
  });

  it("selects the trusted publication for the base source revision recorded by the exact PR managed image", async () => {
    const inspectManagedImage = vi.fn(() => inspection());
    const resolvePublication = vi.fn(async () => publication);

    await expect(
      resolvePrDcodeBasePublication(
        { candidateSha: CANDIDATE_SHA, catalog: catalog(), token: "test-token" },
        { inspectManagedImage, resolvePublication },
      ),
    ).resolves.toEqual({ baseReference: BASE_REFERENCE, run: publication });
    expect(inspectManagedImage).toHaveBeenCalledWith(DCODE_REFERENCE);
    expect(resolvePublication).toHaveBeenCalledWith(BASE_SOURCE_SHA);
  });

  it("accepts the fixed base-resolution key for the producer field order", () => {
    const expectedResolutionHash =
      "083e317cc6f3dd2a14a4f2c7a52c3cbd40864b35c8182df2a6546e3b6f4236a1";
    const resolution = {
      schema: 1,
      key: expectedResolutionHash,
      imageName: BASE_IMAGE,
      ref: BASE_REFERENCE,
      digest: BASE_DIGEST,
      source: "override",
      sourceRevision: BASE_SOURCE_SHA,
      imageId: `sha256:${"e".repeat(64)}`,
      os: "linux",
      architecture: "amd64",
      glibcVersion: "2.39",
      requireOpenshellSandboxAbi: true,
      minGlibcVersion: "2.39",
    };

    expect(
      readDcodeBaseResolution(
        inspection(resolution),
        contract("langchain-deepagents-code", 2),
        CANDIDATE_SHA,
      ),
    ).toEqual({ reference: BASE_REFERENCE, sourceRevision: BASE_SOURCE_SHA });
  });

  it("rejects a base-resolution key that does not bind the recorded fields", () => {
    const resolution = baseResolution();
    resolution.key = "f".repeat(64);

    expect(() =>
      readDcodeBaseResolution(
        inspection(resolution),
        contract("langchain-deepagents-code", 2),
        CANDIDATE_SHA,
      ),
    ).toThrow("base resolution key is invalid");
  });

  it("rejects a trusted publication from a different base source revision", async () => {
    await expect(
      resolvePrDcodeBasePublication(
        { candidateSha: CANDIDATE_SHA, catalog: catalog(), token: "test-token" },
        {
          inspectManagedImage: () => inspection(),
          resolvePublication: async () => ({ ...publication, headSha: "f".repeat(40) }),
        },
      ),
    ).rejects.toThrow("does not match the managed image binding");
  });

  it("rejects an image inspection that is not bound to the exact managed-image reference", () => {
    const value = inspection() as Array<Record<string, unknown>>;
    value[0]!.RepoDigests = [`${DCODE_IMAGE}@sha256:${"f".repeat(64)}`];

    expect(() =>
      readDcodeBaseResolution(value, contract("langchain-deepagents-code", 2), CANDIDATE_SHA),
    ).toThrow("does not match its exact reference");
  });
});
