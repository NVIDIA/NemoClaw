// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { SandboxBaseImageResolutionMetadata } from "../../../src/lib/sandbox-base-image/types.ts";
import { DCODE_BASE_IMAGE, DCODE_BASE_IMAGE_ENV } from "../fixtures/dcode-base-image.ts";
import {
  DCODE_BASE_IMAGE_TARGET_ID,
  dcodeBaseImageReferenceForContract,
  loadDcodeBaseImagePublicationEvidence,
  parseDcodeBaseImagePublicationEvidence,
  verifyDcodeBaseImageRuntimeEvidence,
} from "../live/dcode-base-image-runtime-evidence.ts";
import {
  DCODE_BASE_IMAGE_AMD64_DIGEST,
  DCODE_BASE_IMAGE_AMD64_REFERENCE,
  DCODE_BASE_IMAGE_ARM64_DIGEST,
  DCODE_BASE_IMAGE_ARM64_REFERENCE,
  DCODE_BASE_IMAGE_CANDIDATE_SHA,
  DCODE_BASE_IMAGE_INDEX_DIGEST,
  DCODE_BASE_IMAGE_INDEX_REFERENCE,
  dcodeBaseImagePublicationEvidence,
  DCODE_BASE_IMAGE_SOURCE_REVISION,
} from "./fixtures/dcode-base-image-publication-evidence.ts";
const PLATFORM_MISMATCH =
  "Deep Agents Code sandbox image did not use the published linux/amd64 base digest";

function baseContractMismatch(...labels: string[]): string {
  return `Deep Agents Code sandbox image does not match the published linux/amd64 base-image contract (mismatched fields: ${labels.join(", ")})`;
}

function thrownMessage(action: () => unknown): string {
  let thrown: unknown;
  try {
    action();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(Error);
  return (thrown as Error).message;
}

function publicationEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    [DCODE_BASE_IMAGE_ENV]: DCODE_BASE_IMAGE_AMD64_REFERENCE,
    ...overrides,
  };
}

function resolutionMetadata(
  overrides: Partial<SandboxBaseImageResolutionMetadata> = {},
): SandboxBaseImageResolutionMetadata {
  return {
    schema: 1,
    key: "resolution-key",
    imageName: DCODE_BASE_IMAGE,
    ref: DCODE_BASE_IMAGE_AMD64_REFERENCE,
    digest: DCODE_BASE_IMAGE_AMD64_DIGEST,
    source: "override",
    sourceRevision: DCODE_BASE_IMAGE_SOURCE_REVISION,
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
  it("selects the linux/amd64 platform reference when trusted manual PR E2E supplies it", () => {
    const environment = publicationEnvironment({
      GITHUB_ACTIONS: "true",
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_SHA: "f".repeat(40),
      NEMOCLAW_E2E_EXPECTED_SHA: DCODE_BASE_IMAGE_CANDIDATE_SHA,
    });
    const contract = parseDcodeBaseImagePublicationEvidence(
      dcodeBaseImagePublicationEvidence(),
      environment,
    );

    expect(dcodeBaseImageReferenceForContract(contract)).toBe(DCODE_BASE_IMAGE_AMD64_REFERENCE);
    expect(environment[DCODE_BASE_IMAGE_ENV]).toBe(DCODE_BASE_IMAGE_AMD64_REFERENCE);
  });

  it("records the completed sandbox image only when its platform digest matches publication", () => {
    const contract = parseDcodeBaseImagePublicationEvidence(
      dcodeBaseImagePublicationEvidence(),
      publicationEnvironment(),
    );

    expect(
      verifyDcodeBaseImageRuntimeEvidence(
        contract,
        "nemoclaw-langchain-deepagents-code:e2e",
        resolutionMetadata(),
      ),
    ).toEqual({
      contractReference: DCODE_BASE_IMAGE_INDEX_REFERENCE,
      digest: DCODE_BASE_IMAGE_AMD64_DIGEST,
      image: DCODE_BASE_IMAGE,
      imageId: `sha256:${"e".repeat(64)}`,
      platform: "linux/amd64",
      reference: DCODE_BASE_IMAGE_AMD64_REFERENCE,
      sandboxImage: "nemoclaw-langchain-deepagents-code:e2e",
      source: "override",
      sourceRevision: DCODE_BASE_IMAGE_SOURCE_REVISION,
    });
  });

  it("reports base-image resolution mismatch labels without rejected values (#9386)", () => {
    const contract = parseDcodeBaseImagePublicationEvidence(
      dcodeBaseImagePublicationEvidence(),
      publicationEnvironment(),
    );
    const message = thrownMessage(() =>
      verifyDcodeBaseImageRuntimeEvidence(
        contract,
        "nemoclaw-langchain-deepagents-code:e2e",
        resolutionMetadata({
          source: "source-sha",
          digest: DCODE_BASE_IMAGE_INDEX_DIGEST,
          ref: DCODE_BASE_IMAGE_INDEX_REFERENCE,
        }),
      ),
    );

    expect(message).toBe(baseContractMismatch("source", "digest", "reference"));
    expect(
      ["source-sha", DCODE_BASE_IMAGE_INDEX_DIGEST, DCODE_BASE_IMAGE_INDEX_REFERENCE].filter(
        (value) => message.includes(value),
      ),
    ).toEqual([]);
  });

  it("rejects the publication index instead of the validated platform reference (#9386)", () => {
    expect(() =>
      parseDcodeBaseImagePublicationEvidence(
        dcodeBaseImagePublicationEvidence(),
        publicationEnvironment({
          [DCODE_BASE_IMAGE_ENV]: DCODE_BASE_IMAGE_INDEX_REFERENCE,
        }),
      ),
    ).toThrow(/does not match the published linux\/amd64 base contract/);
  });

  it("prefers the selected manual candidate over the trusted workflow SHA", () => {
    expect(
      parseDcodeBaseImagePublicationEvidence(
        dcodeBaseImagePublicationEvidence(),
        publicationEnvironment({
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: "f".repeat(40),
          NEMOCLAW_E2E_EXPECTED_SHA: DCODE_BASE_IMAGE_CANDIDATE_SHA,
        }),
      ),
    ).toMatchObject({ reference: DCODE_BASE_IMAGE_INDEX_REFERENCE });
  });

  it("uses the workflow SHA for trusted main qualification", () => {
    expect(
      parseDcodeBaseImagePublicationEvidence(
        dcodeBaseImagePublicationEvidence(),
        publicationEnvironment({
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: DCODE_BASE_IMAGE_CANDIDATE_SHA,
          NEMOCLAW_E2E_EXPECTED_SHA: "",
        }),
      ),
    ).toMatchObject({ reference: DCODE_BASE_IMAGE_INDEX_REFERENCE });
  });

  it.each([
    [
      "a manual candidate",
      {
        GITHUB_ACTIONS: "true",
        GITHUB_SHA: DCODE_BASE_IMAGE_CANDIDATE_SHA,
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
        dcodeBaseImagePublicationEvidence(),
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
        dcodeBaseImagePublicationEvidence(),
        publicationEnvironment({
          GITHUB_ACTIONS: "true",
          GITHUB_SHA: githubSha,
          NEMOCLAW_E2E_EXPECTED_SHA: "",
        }),
      ),
    ).toThrow(/expected candidate SHA is invalid/);
  });

  it("rejects a platform reference that does not match its published digest", () => {
    const evidence = dcodeBaseImagePublicationEvidence();
    evidence.base.platformReferences["linux/amd64"] = DCODE_BASE_IMAGE_INDEX_REFERENCE;

    expect(() =>
      parseDcodeBaseImagePublicationEvidence(evidence, publicationEnvironment()),
    ).toThrow(/base contract linux\/amd64 reference is invalid/);
  });

  it("allows direct local execution without the workflow-only publication artifact", () => {
    expect(
      loadDcodeBaseImagePublicationEvidence(
        DCODE_BASE_IMAGE_TARGET_ID,
        `/missing-dcode-base-evidence-${process.pid}.json`,
        { [DCODE_BASE_IMAGE_ENV]: DCODE_BASE_IMAGE_AMD64_REFERENCE },
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
          [DCODE_BASE_IMAGE_ENV]: DCODE_BASE_IMAGE_AMD64_REFERENCE,
        },
      ),
    ).toThrow(/GitHub Actions run is missing published base evidence/);
  });

  it.each([
    {
      label: "missing metadata",
      metadata: null,
      expectedMessage: "Deep Agents Code sandbox image is missing base resolution metadata",
      rejectedValues: [],
    },
    {
      label: "an unsupported metadata schema version",
      metadata: resolutionMetadata({ schema: 2 }),
      expectedMessage: baseContractMismatch("schema"),
      rejectedValues: ["2"],
    },
    {
      label: "the publication index instead of the selected platform",
      metadata: resolutionMetadata({
        digest: DCODE_BASE_IMAGE_INDEX_DIGEST,
        ref: DCODE_BASE_IMAGE_INDEX_REFERENCE,
      }),
      expectedMessage: baseContractMismatch("digest", "reference"),
      rejectedValues: [DCODE_BASE_IMAGE_INDEX_DIGEST, DCODE_BASE_IMAGE_INDEX_REFERENCE],
    },
    {
      label: "the opposite platform digest for amd64",
      metadata: resolutionMetadata({
        digest: DCODE_BASE_IMAGE_ARM64_DIGEST,
        ref: DCODE_BASE_IMAGE_ARM64_REFERENCE,
      }),
      expectedMessage: baseContractMismatch("digest", "reference"),
      rejectedValues: [DCODE_BASE_IMAGE_ARM64_DIGEST, DCODE_BASE_IMAGE_ARM64_REFERENCE],
    },
    {
      label: "self-consistent opposite-platform metadata",
      metadata: resolutionMetadata({
        architecture: "arm64",
        digest: DCODE_BASE_IMAGE_ARM64_DIGEST,
        ref: DCODE_BASE_IMAGE_ARM64_REFERENCE,
      }),
      expectedMessage: PLATFORM_MISMATCH,
      rejectedValues: [DCODE_BASE_IMAGE_ARM64_DIGEST, DCODE_BASE_IMAGE_ARM64_REFERENCE],
    },
    {
      label: "a different image repository",
      metadata: resolutionMetadata({ imageName: "ghcr.io/example/base" }),
      expectedMessage: baseContractMismatch("image", "reference binding"),
      rejectedValues: ["ghcr.io/example/base"],
    },
    {
      label: "a fallback resolution source",
      metadata: resolutionMetadata({ source: "latest" }),
      expectedMessage: baseContractMismatch("source"),
      rejectedValues: ["latest"],
    },
    {
      label: "a pinned fallback reference",
      metadata: resolutionMetadata({ pinnedRemoteRef: DCODE_BASE_IMAGE_AMD64_REFERENCE }),
      expectedMessage: baseContractMismatch("pinned reference"),
      rejectedValues: [DCODE_BASE_IMAGE_AMD64_REFERENCE],
    },
    {
      label: "a missing source revision",
      metadata: resolutionMetadata({ sourceRevision: undefined }),
      expectedMessage: baseContractMismatch("source revision"),
      rejectedValues: [],
    },
    {
      label: "a malformed source revision",
      metadata: resolutionMetadata({ sourceRevision: "main" }),
      expectedMessage: baseContractMismatch("source revision"),
      rejectedValues: ["main"],
    },
    {
      label: "a mismatched source revision",
      metadata: resolutionMetadata({ sourceRevision: "f".repeat(40) }),
      expectedMessage: baseContractMismatch("source revision"),
      rejectedValues: ["f".repeat(40)],
    },
    {
      label: "an unsupported platform",
      metadata: resolutionMetadata({ architecture: "ppc64le" }),
      expectedMessage: PLATFORM_MISMATCH,
      rejectedValues: ["ppc64le"],
    },
  ])("rejects $label", ({ metadata, expectedMessage, rejectedValues }) => {
    const contract = parseDcodeBaseImagePublicationEvidence(
      dcodeBaseImagePublicationEvidence(),
      publicationEnvironment(),
    );
    const message = thrownMessage(() =>
      verifyDcodeBaseImageRuntimeEvidence(
        contract,
        "nemoclaw-langchain-deepagents-code:e2e",
        metadata,
      ),
    );

    expect(message).toBe(expectedMessage);
    expect(rejectedValues.filter((value) => message.includes(value))).toEqual([]);
  });
});
