// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";

const MANIFEST_DIGEST = "sha256:b0e84e5f2b00a7268e4fdda332790ebd4bfb166b64757e166914753afaeee965";
export const MUSE_GLIMMER_VLLM_IMAGE_REFERENCE = `vllm/vllm-openai@${MANIFEST_DIGEST}`;
const CONFIG_DIGEST = "sha256:49d2eb65dc2a8dea24e43c27b226f650481ac97d4ba9c567b6e1ca08bc472303";
const SOURCE_REVISION = "5a4c8d99242e9e069b604d0e9b969e77f7dd501d";
const MUSE_MERGE_COMMIT = "6adad08767583f52eb4d2122111af0bf638ed5e6";
const REVISION_FIX_COMMIT = "90984ddbed27a09409506d6d6c0eea87f54b04b5";
const MODEL_REVISION = "d35cb79050f419c457611b1cee5c5d15b176f285";
const PIPELINE_ID = "019d130e-464e-4ff7-b84b-492992c0c06b";

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
    configSizeBytes: 34_738,
    configUrl: `https://registry-1.docker.io/v2/vllm/vllm-openai/blobs/${CONFIG_DIGEST}`,
    layerCount: 32,
    compressedLayerSizeBytes: 9_706_339_423,
    createdAt: "2026-08-19T05:34:00.562836767Z",
    platform: {
      os: "linux",
      architecture: "arm64",
    },
  },
  build: {
    sourceRevision: SOURCE_REVISION,
    imageTag: `vllm/vllm-openai:nightly-${SOURCE_REVISION}`,
    pipelineId: PIPELINE_ID,
  },
  upstreamSupport: {
    museMergeCommit: MUSE_MERGE_COMMIT,
    relationship: "descendant",
    aheadBy: 173,
    revisionFixCommit: REVISION_FIX_COMMIT,
    revisionFixRelationship: "descendant",
    revisionFixAheadBy: 33,
  },
  reportedLabels: {
    "ai.vllm.build.commit": SOURCE_REVISION,
    "ai.vllm.build.pipeline": PIPELINE_ID,
    "ai.vllm.image.tag": `vllm/vllm-openai:nightly-${SOURCE_REVISION}`,
    "org.opencontainers.image.revision": SOURCE_REVISION,
  },
  runtimeDependencies: {
    vllmVersion: "0.26.1rc1.dev942+g5a4c8d992",
    huggingfaceHubVersion: "1.28.0",
    sentencepieceVersion: "0.2.2",
    tiktokenVersion: "0.14.0",
  },
  revisionSerialization: {
    model: "Inferact/Muse-Glimmer-30B-NVFP4-W4A4",
    requestedRevision: MODEL_REVISION,
    resolvedRevisionBeforePickle: MODEL_REVISION,
    resolvedRevisionAfterPickle: MODEL_REVISION,
    preserved: true,
  },
  verification: {
    observedAt: "2026-08-19T22:53:46Z",
    methods: [
      "docker-buildx-imagetools-inspect-raw",
      "docker-image-inspect",
      "github-compare-api",
      "container-package-imports",
      "resolved-revision-pickle-round-trip",
      "dgx-spark-cold-cache-startup",
      "vllm-openai-api-validation",
    ],
    signedProvenanceAttestation: "not-available",
  },
} as const;

export function verifyMuseGlimmerVllmImageProvenance(value: unknown): void {
  assert.deepStrictEqual(value, EXPECTED_PROVENANCE);
}
