// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { DCODE_BASE_IMAGE } from "../../fixtures/dcode-base-image.ts";

export const DCODE_BASE_IMAGE_CANDIDATE_SHA = "d".repeat(40);
export const DCODE_BASE_IMAGE_SOURCE_REVISION = "e".repeat(40);
export const DCODE_BASE_IMAGE_INDEX_DIGEST = `sha256:${"a".repeat(64)}`;
export const DCODE_BASE_IMAGE_AMD64_DIGEST = `sha256:${"b".repeat(64)}`;
export const DCODE_BASE_IMAGE_ARM64_DIGEST = `sha256:${"c".repeat(64)}`;
export const DCODE_BASE_IMAGE_INDEX_REFERENCE = `${DCODE_BASE_IMAGE}@${DCODE_BASE_IMAGE_INDEX_DIGEST}`;
export const DCODE_BASE_IMAGE_AMD64_REFERENCE = `${DCODE_BASE_IMAGE}@${DCODE_BASE_IMAGE_AMD64_DIGEST}`;
export const DCODE_BASE_IMAGE_ARM64_REFERENCE = `${DCODE_BASE_IMAGE}@${DCODE_BASE_IMAGE_ARM64_DIGEST}`;

export function dcodeBaseImagePublicationEvidence({ runId = 1234 }: { runId?: number } = {}) {
  return {
    contractVersion: 1,
    candidateSha: DCODE_BASE_IMAGE_CANDIDATE_SHA,
    base: {
      agent: "langchain-deepagents-code",
      contractVersion: 1,
      digest: DCODE_BASE_IMAGE_INDEX_DIGEST,
      image: DCODE_BASE_IMAGE,
      platformDigests: {
        "linux/amd64": DCODE_BASE_IMAGE_AMD64_DIGEST,
        "linux/arm64": DCODE_BASE_IMAGE_ARM64_DIGEST,
      },
      platformReferences: {
        "linux/amd64": DCODE_BASE_IMAGE_AMD64_REFERENCE,
        "linux/arm64": DCODE_BASE_IMAGE_ARM64_REFERENCE,
      },
      platforms: ["linux/amd64", "linux/arm64"],
      reference: DCODE_BASE_IMAGE_INDEX_REFERENCE,
      run: { attempt: 1, id: runId },
      sourceRevision: DCODE_BASE_IMAGE_SOURCE_REVISION,
    },
  };
}
