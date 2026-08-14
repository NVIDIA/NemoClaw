// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { VLLM_MODELS } from "../src/lib/inference/vllm-models.js";
import { detectVllmProfile, resolveVllmRuntimeProfile } from "../src/lib/inference/vllm.js";

const ROOT = path.join(import.meta.dirname, "..");
const RECORD_PATH = path.join(
  ROOT,
  "internal",
  "security-reviews",
  "muse-glimmer-vllm-image-provenance-v1.json",
);
const RECIPE_PATH = path.join(
  ROOT,
  "managed-inference",
  "recipes",
  "vllm.muse-glimmer-30b-nvfp4-w4a4.spark-single.v1.yaml",
);
const IMAGE_REFERENCE =
  "vllm/vllm-openai@sha256:677afd5bf3b4bb9881f91e107af7098f8410726b4c05b25cb4a815900b398204";
const MANIFEST_DIGEST = "sha256:677afd5bf3b4bb9881f91e107af7098f8410726b4c05b25cb4a815900b398204";
const CONFIG_DIGEST = "sha256:c3f199e54a26d2d7a9a41115cd07ce9d90a6488c5a4e75b17129e1006ce533fd";
const SOURCE_REVISION = "ac7509e2b1db40fec2f03dde1ed4e9dfdc2338c9";
const MUSE_MERGE_COMMIT = "6adad08767583f52eb4d2122111af0bf638ed5e6";
const PIPELINE_ID = "019d130e-464e-4ff7-b84b-492992c0c06b";
const PIPELINE_URL = "https://buildkite.com/vllm/release-v2/builds/5174";

type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonRecord;
}

function exactKeys(value: JsonRecord, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  if (
    actual.length !== sortedExpected.length ||
    actual.some((key, index) => key !== sortedExpected[index])
  ) {
    throw new Error(`${label} has unexpected fields`);
  }
}

function verifyProvenanceRecord(value: unknown): void {
  const record = object(value, "provenance record");
  exactKeys(
    record,
    [
      "build",
      "consumer",
      "image",
      "kind",
      "publisher",
      "reportedLabels",
      "schemaVersion",
      "upstreamSupport",
      "verification",
    ],
    "provenance record",
  );
  if (record.schemaVersion !== 1 || record.kind !== "nemoclaw-reviewed-vllm-image-provenance") {
    throw new Error("provenance record identity is invalid");
  }

  const consumer = object(record.consumer, "consumer");
  exactKeys(consumer, ["profile", "recipe"], "consumer");
  if (
    consumer.recipe !==
      "managed-inference/recipes/vllm.muse-glimmer-30b-nvfp4-w4a4.spark-single.v1.yaml" ||
    consumer.profile !== "muse-glimmer-30b"
  ) {
    throw new Error("provenance consumer is invalid");
  }

  const publisher = object(record.publisher, "publisher");
  exactKeys(publisher, ["namespace", "registry", "repository"], "publisher");
  if (
    publisher.registry !== "registry-1.docker.io" ||
    publisher.namespace !== "vllm" ||
    publisher.repository !== "vllm/vllm-openai"
  ) {
    throw new Error("provenance publisher is invalid");
  }

  const image = object(record.image, "image");
  exactKeys(
    image,
    [
      "compressedLayerSizeBytes",
      "configDigest",
      "configMediaType",
      "configSizeBytes",
      "configUrl",
      "createdAt",
      "layerCount",
      "manifestDigest",
      "manifestMediaType",
      "manifestUrl",
      "platform",
      "reference",
    ],
    "image",
  );
  const platform = object(image.platform, "platform");
  exactKeys(platform, ["architecture", "os"], "platform");
  if (
    image.reference !== IMAGE_REFERENCE ||
    image.manifestDigest !== MANIFEST_DIGEST ||
    image.manifestMediaType !== "application/vnd.docker.distribution.manifest.v2+json" ||
    image.manifestUrl !==
      `https://registry-1.docker.io/v2/vllm/vllm-openai/manifests/${MANIFEST_DIGEST}` ||
    image.configDigest !== CONFIG_DIGEST ||
    image.configMediaType !== "application/vnd.docker.container.image.v1+json" ||
    image.configSizeBytes !== 34_762 ||
    image.configUrl !== `https://registry-1.docker.io/v2/vllm/vllm-openai/blobs/${CONFIG_DIGEST}` ||
    image.layerCount !== 32 ||
    image.compressedLayerSizeBytes !== 9_699_710_136 ||
    image.createdAt !== "2026-08-14T05:33:50.528328374Z" ||
    platform.os !== "linux" ||
    platform.architecture !== "arm64"
  ) {
    throw new Error("provenance image identity is invalid");
  }

  const build = object(record.build, "build");
  exactKeys(
    build,
    [
      "imageTag",
      "pipelineId",
      "pipelineUrl",
      "sourceRepository",
      "sourceRevision",
      "sourceRevisionUrl",
    ],
    "build",
  );
  if (
    build.sourceRepository !== "https://github.com/vllm-project/vllm" ||
    build.sourceRevision !== SOURCE_REVISION ||
    build.sourceRevisionUrl !== `https://github.com/vllm-project/vllm/commit/${SOURCE_REVISION}` ||
    build.imageTag !== `vllm/vllm-openai:nightly-${SOURCE_REVISION}` ||
    build.pipelineId !== PIPELINE_ID ||
    build.pipelineUrl !== PIPELINE_URL
  ) {
    throw new Error("provenance build identity is invalid");
  }

  const support = object(record.upstreamSupport, "upstream support");
  exactKeys(
    support,
    ["aheadBy", "comparisonUrl", "museMergeCommit", "museMergeCommitUrl", "relationship"],
    "upstream support",
  );
  if (
    support.museMergeCommit !== MUSE_MERGE_COMMIT ||
    support.museMergeCommitUrl !==
      `https://github.com/vllm-project/vllm/commit/${MUSE_MERGE_COMMIT}` ||
    support.comparisonUrl !==
      `https://github.com/vllm-project/vllm/compare/${MUSE_MERGE_COMMIT}...${SOURCE_REVISION}` ||
    support.relationship !== "direct-descendant" ||
    support.aheadBy !== 1
  ) {
    throw new Error("provenance upstream relationship is invalid");
  }

  const labels = object(record.reportedLabels, "reported labels");
  exactKeys(
    labels,
    [
      "ai.vllm.build.commit",
      "ai.vllm.build.pipeline",
      "ai.vllm.build.url",
      "ai.vllm.image.tag",
      "org.opencontainers.image.revision",
      "org.opencontainers.image.source",
    ],
    "reported labels",
  );
  if (
    labels["ai.vllm.build.commit"] !== SOURCE_REVISION ||
    labels["ai.vllm.build.pipeline"] !== PIPELINE_ID ||
    labels["ai.vllm.build.url"] !== PIPELINE_URL ||
    labels["ai.vllm.image.tag"] !== `vllm/vllm-openai:nightly-${SOURCE_REVISION}` ||
    labels["org.opencontainers.image.revision"] !== SOURCE_REVISION ||
    labels["org.opencontainers.image.source"] !== "https://github.com/vllm-project/vllm"
  ) {
    throw new Error("reported labels do not match the reviewed build");
  }

  const verification = object(record.verification, "verification");
  exactKeys(verification, ["methods", "observedAt", "signedProvenanceAttestation"], "verification");
  if (
    verification.observedAt !== "2026-08-14T16:33:50Z" ||
    JSON.stringify(verification.methods) !==
      JSON.stringify([
        "docker-buildx-imagetools-inspect-raw",
        "docker-image-inspect",
        "github-compare-api",
      ]) ||
    verification.signedProvenanceAttestation !== "not-available"
  ) {
    throw new Error("provenance verification boundary is invalid");
  }
}

const provenance = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as unknown;
const recipe = YAML.parse(readFileSync(RECIPE_PATH, "utf8")) as {
  spec: { runtime: { architecture: string; image: string; imageDownloadSizeBytes: number } };
};

describe("Muse Glimmer vLLM image provenance", () => {
  // source-shape-contract: security -- Exact manifest, publisher, platform, and source identities keep the credential-bearing managed runtime bound to the reviewed external image.
  it("binds the selected runtime to its reviewed publisher, manifest, platform, and source", () => {
    verifyProvenanceRecord(provenance);

    expect(recipe.spec.runtime).toMatchObject({
      architecture: "arm64",
      image: IMAGE_REFERENCE,
      imageDownloadSizeBytes: 9_699_710_136,
    });

    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    const model = VLLM_MODELS.find(({ envValue }) => envValue === "muse-glimmer-30b");
    expect(profile).not.toBeNull();
    expect(model).toBeDefined();
    expect(resolveVllmRuntimeProfile(profile!, model!)).toMatchObject({
      image: IMAGE_REFERENCE,
      imageDownloadSizeBytes: 9_699_710_136,
    });
  });

  // source-shape-contract: security -- Mutating each trust field proves the reviewed provenance record fails closed before a substituted external runtime can be published.
  it.each([
    ["publisher drift", ["publisher", "namespace"], "attacker"],
    ["manifest drift", ["image", "manifestDigest"], `sha256:${"0".repeat(64)}`],
    ["platform drift", ["image", "platform", "architecture"], "amd64"],
    ["source drift", ["build", "sourceRevision"], "0".repeat(40)],
    ["label drift", ["reportedLabels", "org.opencontainers.image.revision"], "0".repeat(40)],
    ["support ancestry drift", ["upstreamSupport", "relationship"], "unverified"],
  ] as const)("rejects %s", (_name, pathParts, replacement) => {
    const changed = structuredClone(provenance) as JsonRecord;
    let target = changed;
    for (const part of pathParts.slice(0, -1)) {
      target = object(target[part], part);
    }
    target[pathParts.at(-1)!] = replacement;

    expect(() => verifyProvenanceRecord(changed)).toThrow(/provenance|reported labels/u);
  });
});
