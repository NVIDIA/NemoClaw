// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types.ts";
import { DCODE_BASE_IMAGE, DCODE_BASE_IMAGE_ENV } from "../fixtures/dcode-base-image.ts";
import {
  DCODE_BASE_IMAGE_TARGET_ID,
  loadDcodeBaseImagePublicationEvidence,
  parseDcodeBaseImagePublicationEvidence,
  verifyDcodeBaseImageRuntimeEvidence,
} from "../live/dcode-base-image-runtime-evidence.ts";

const INDEX_DIGEST = `sha256:${"a".repeat(64)}`;
const AMD64_DIGEST = `sha256:${"b".repeat(64)}`;
const ARM64_DIGEST = `sha256:${"c".repeat(64)}`;
const INDEX_REFERENCE = `${DCODE_BASE_IMAGE}@${INDEX_DIGEST}`;
const AMD64_REFERENCE = `${DCODE_BASE_IMAGE}@${AMD64_DIGEST}`;
const ARM64_REFERENCE = `${DCODE_BASE_IMAGE}@${ARM64_DIGEST}`;
const CANDIDATE_REVISION = "d".repeat(40);
const PUBLICATION_REVISION = "e".repeat(40);

function publicationEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [DCODE_BASE_IMAGE_ENV]: INDEX_REFERENCE,
    ...overrides,
  };
}

function publicationEvidence() {
  return {
    contractVersion: 1,
    candidateSha: CANDIDATE_REVISION,
    base: {
      agent: "langchain-deepagents-code",
      contractVersion: 1,
      digest: INDEX_DIGEST,
      image: DCODE_BASE_IMAGE,
      platformDigests: {
        "linux/amd64": AMD64_DIGEST,
        "linux/arm64": ARM64_DIGEST,
      },
      platformReferences: {
        "linux/amd64": AMD64_REFERENCE,
        "linux/arm64": ARM64_REFERENCE,
      },
      platforms: ["linux/amd64", "linux/arm64"],
      reference: INDEX_REFERENCE,
      run: { attempt: 1, id: 1234 },
      sourceRevision: PUBLICATION_REVISION,
    },
  };
}

function resolutionMetadata(
  overrides: Partial<SandboxBaseImageResolutionMetadata> = {},
): SandboxBaseImageResolutionMetadata {
  return {
    schema: 1,
    key: "resolution-key",
    imageName: DCODE_BASE_IMAGE,
    ref: AMD64_REFERENCE,
    digest: AMD64_DIGEST,
    source: "override",
    imageId: `sha256:${"e".repeat(64)}`,
    os: "linux",
    architecture: "amd64",
    glibcVersion: "2.39",
    requireOpenshellSandboxAbi: true,
    minGlibcVersion: "2.39",
    ...overrides,
  };
}

describe("Deep Agents Code published base runtime evidence", () => {
  it("records the completed sandbox image only when its platform digest matches publication", () => {
    const contract = parseDcodeBaseImagePublicationEvidence(
      publicationEvidence(),
      publicationEnvironment(),
    );

    expect(
      verifyDcodeBaseImageRuntimeEvidence(
        contract,
        "nemoclaw-langchain-deepagents-code:e2e",
        resolutionMetadata(),
      ),
    ).toEqual({
      contractReference: INDEX_REFERENCE,
      digest: AMD64_DIGEST,
      image: DCODE_BASE_IMAGE,
      imageId: `sha256:${"e".repeat(64)}`,
      platform: "linux/amd64",
      reference: AMD64_REFERENCE,
      sandboxImage: "nemoclaw-langchain-deepagents-code:e2e",
      source: "override",
      sourceRevision: PUBLICATION_REVISION,
    });
  });

  it("rejects a valid official reference that differs from the publication contract", () => {
    expect(() =>
      parseDcodeBaseImagePublicationEvidence(
        publicationEvidence(),
        publicationEnvironment({
          [DCODE_BASE_IMAGE_ENV]: `${DCODE_BASE_IMAGE}@sha256:${"f".repeat(64)}`,
        }),
      ),
    ).toThrow(/does not match the published base contract/);
  });

  it("prefers the selected manual candidate over the trusted workflow SHA", () => {
    expect(
      parseDcodeBaseImagePublicationEvidence(
        publicationEvidence(),
        publicationEnvironment({
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: "f".repeat(40),
          NEMOCLAW_E2E_EXPECTED_SHA: CANDIDATE_REVISION,
        }),
      ),
    ).toMatchObject({ reference: INDEX_REFERENCE });
  });

  it("uses the workflow SHA for trusted main qualification", () => {
    expect(
      parseDcodeBaseImagePublicationEvidence(
        publicationEvidence(),
        publicationEnvironment({
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: CANDIDATE_REVISION,
          NEMOCLAW_E2E_EXPECTED_SHA: "",
        }),
      ),
    ).toMatchObject({ reference: INDEX_REFERENCE });
  });

  it.each([
    [
      "a manual candidate",
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: CANDIDATE_REVISION,
        NEMOCLAW_E2E_EXPECTED_SHA: "f".repeat(40),
      },
    ],
    [
      "a trusted main candidate",
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: "f".repeat(40),
        NEMOCLAW_E2E_EXPECTED_SHA: "",
      },
    ],
  ])("rejects stale publication evidence for %s", (_label, environment) => {
    expect(() =>
      parseDcodeBaseImagePublicationEvidence(
        publicationEvidence(),
        publicationEnvironment(environment),
      ),
    ).toThrow(/candidate SHA does not match the selected candidate/);
  });

  it.each([
    ["a missing workflow SHA", undefined],
    ["a malformed workflow SHA", "main"],
  ])("rejects %s in GitHub Actions", (_label, githubSha) => {
    expect(() =>
      parseDcodeBaseImagePublicationEvidence(
        publicationEvidence(),
        publicationEnvironment({
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: githubSha,
          NEMOCLAW_E2E_EXPECTED_SHA: "",
        }),
      ),
    ).toThrow(/expected candidate SHA is invalid/);
  });

  it("rejects a platform reference that does not match its published digest", () => {
    const evidence = publicationEvidence();
    evidence.base.platformReferences["linux/amd64"] = INDEX_REFERENCE;

    expect(() =>
      parseDcodeBaseImagePublicationEvidence(evidence, publicationEnvironment()),
    ).toThrow(/base contract linux\/amd64 reference is invalid/);
  });

  it("allows direct local execution without the workflow-only publication artifact", () => {
    expect(
      loadDcodeBaseImagePublicationEvidence(
        DCODE_BASE_IMAGE_TARGET_ID,
        `/missing-dcode-base-evidence-${process.pid}.json`,
        { [DCODE_BASE_IMAGE_ENV]: INDEX_REFERENCE },
      ),
    ).toBeUndefined();
  });

  it("requires publication evidence for the GitHub Actions target", () => {
    expect(() =>
      loadDcodeBaseImagePublicationEvidence(
        DCODE_BASE_IMAGE_TARGET_ID,
        `/missing-dcode-base-evidence-${process.pid}.json`,
        {
          GITHUB_ACTIONS: "true",
          [DCODE_BASE_IMAGE_ENV]: INDEX_REFERENCE,
        },
      ),
    ).toThrow(/GitHub Actions run is missing published base evidence/);
  });

  it.each([
    ["missing metadata", null, /missing base resolution metadata/],
    [
      "the publication index instead of the selected platform",
      resolutionMetadata({ digest: INDEX_DIGEST, ref: INDEX_REFERENCE }),
      /did not use the published linux\/amd64 base digest/,
    ],
    [
      "the opposite platform digest",
      resolutionMetadata({ digest: ARM64_DIGEST, ref: ARM64_REFERENCE }),
      /did not use the published linux\/amd64 base digest/,
    ],
    [
      "a different image repository",
      resolutionMetadata({ imageName: "ghcr.io/example/base" }),
      /did not use the published linux\/amd64 base digest/,
    ],
    [
      "a fallback resolution source",
      resolutionMetadata({ source: "latest" }),
      /did not use the published linux\/amd64 base digest/,
    ],
    [
      "a pinned fallback reference",
      resolutionMetadata({ pinnedRemoteRef: AMD64_REFERENCE }),
      /did not use the published linux\/amd64 base digest/,
    ],
    [
      "an unsupported platform",
      resolutionMetadata({ architecture: "ppc64le" }),
      /used unsupported platform/,
    ],
  ])("rejects %s", (_label, metadata, expectedError) => {
    const contract = parseDcodeBaseImagePublicationEvidence(
      publicationEvidence(),
      publicationEnvironment(),
    );

    expect(() =>
      verifyDcodeBaseImageRuntimeEvidence(
        contract,
        "nemoclaw-langchain-deepagents-code:e2e",
        metadata,
      ),
    ).toThrow(expectedError);
  });
});
