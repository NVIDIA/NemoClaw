// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

const MANIFEST_DIGEST = "sha256:677afd5bf3b4bb9881f91e107af7098f8410726b4c05b25cb4a815900b398204";
export const MUSE_GLIMMER_VLLM_IMAGE_REFERENCE = `vllm/vllm-openai@${MANIFEST_DIGEST}`;
const CONFIG_DIGEST = "sha256:c3f199e54a26d2d7a9a41115cd07ce9d90a6488c5a4e75b17129e1006ce533fd";
const SOURCE_REVISION = "ac7509e2b1db40fec2f03dde1ed4e9dfdc2338c9";
const MUSE_MERGE_COMMIT = "6adad08767583f52eb4d2122111af0bf638ed5e6";
const PIPELINE_ID = "019d130e-464e-4ff7-b84b-492992c0c06b";
const PIPELINE_URL = "https://buildkite.com/vllm/release-v2/builds/5174";

const EXPECTED_PROVENANCE = {
  schemaVersion: 1,
  kind: "nemoclaw-reviewed-vllm-image-provenance",
  consumer: {
    recipe: "managed-inference/recipes/vllm.muse-glimmer-30b-nvfp4-w4a4.spark-single.v1.yaml",
    profile: "muse-glimmer-30b",
  },
  publisher: {
    registry: "registry-1.docker.io",
    namespace: "vllm",
    repository: "vllm/vllm-openai",
  },
  image: {
    reference: MUSE_GLIMMER_VLLM_IMAGE_REFERENCE,
    manifestDigest: MANIFEST_DIGEST,
    manifestMediaType: "application/vnd.docker.distribution.manifest.v2+json",
    manifestUrl: `https://registry-1.docker.io/v2/vllm/vllm-openai/manifests/${MANIFEST_DIGEST}`,
    configDigest: CONFIG_DIGEST,
    configMediaType: "application/vnd.docker.container.image.v1+json",
    configSizeBytes: 34_762,
    configUrl: `https://registry-1.docker.io/v2/vllm/vllm-openai/blobs/${CONFIG_DIGEST}`,
    layerCount: 32,
    compressedLayerSizeBytes: 9_699_710_136,
    createdAt: "2026-08-14T05:33:50.528328374Z",
    platform: {
      os: "linux",
      architecture: "arm64",
    },
  },
  build: {
    sourceRepository: "https://github.com/vllm-project/vllm",
    sourceRevision: SOURCE_REVISION,
    sourceRevisionUrl: `https://github.com/vllm-project/vllm/commit/${SOURCE_REVISION}`,
    imageTag: `vllm/vllm-openai:nightly-${SOURCE_REVISION}`,
    pipelineId: PIPELINE_ID,
    pipelineUrl: PIPELINE_URL,
  },
  upstreamSupport: {
    museMergeCommit: MUSE_MERGE_COMMIT,
    museMergeCommitUrl: `https://github.com/vllm-project/vllm/commit/${MUSE_MERGE_COMMIT}`,
    comparisonUrl: `https://github.com/vllm-project/vllm/compare/${MUSE_MERGE_COMMIT}...${SOURCE_REVISION}`,
    relationship: "direct-descendant",
    aheadBy: 1,
  },
  reportedLabels: {
    "ai.vllm.build.commit": SOURCE_REVISION,
    "ai.vllm.build.pipeline": PIPELINE_ID,
    "ai.vllm.build.url": PIPELINE_URL,
    "ai.vllm.image.tag": `vllm/vllm-openai:nightly-${SOURCE_REVISION}`,
    "org.opencontainers.image.revision": SOURCE_REVISION,
    "org.opencontainers.image.source": "https://github.com/vllm-project/vllm",
  },
  verification: {
    observedAt: "2026-08-14T16:33:50Z",
    methods: ["docker-buildx-imagetools-inspect-raw", "docker-image-inspect", "github-compare-api"],
    signedProvenanceAttestation: "not-available",
  },
} as const;

export function verifyMuseGlimmerVllmImageProvenance(value: unknown): void {
  assert.deepStrictEqual(value, EXPECTED_PROVENANCE);
}
