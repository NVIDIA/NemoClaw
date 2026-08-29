// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { VLLM_MODELS } from "../../../src/lib/inference/vllm-models.js";
import { detectVllmProfile, resolveVllmRuntimeProfile } from "../../../src/lib/inference/vllm.js";
import {
  MUSE_GLIMMER_VLLM_IMAGE_REFERENCE,
  verifyMuseGlimmerVllmImageProvenance,
} from "../../support/muse-glimmer-vllm-image-provenance-test-support.js";

const ROOT = path.join(import.meta.dirname, "../../..");
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

type JsonRecord = Record<string, unknown>;

const provenance = JSON.parse(readFileSync(RECORD_PATH, "utf8")) as unknown;
const recipe = YAML.parse(readFileSync(RECIPE_PATH, "utf8")) as {
  spec: { runtime: { architecture: string; image: string; imageDownloadSizeBytes: number } };
};

describe("Muse Glimmer vLLM image provenance", () => {
  // source-shape-contract: security -- The checked-in provenance and recipe must resolve to the same reviewed external runtime image and size.
  it("binds the checked-in provenance to the selected runtime", () => {
    verifyMuseGlimmerVllmImageProvenance(provenance);

    expect(recipe.spec.runtime).toMatchObject({
      architecture: "arm64",
      image: MUSE_GLIMMER_VLLM_IMAGE_REFERENCE,
      imageDownloadSizeBytes: 9_706_339_423,
    });

    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    const model = VLLM_MODELS.find(({ envValue }) => envValue === "muse-glimmer-30b");
    expect(profile).not.toBeNull();
    expect(model).toBeDefined();
    expect(resolveVllmRuntimeProfile(profile!, model!)).toMatchObject({
      image: MUSE_GLIMMER_VLLM_IMAGE_REFERENCE,
      imageDownloadSizeBytes: 9_706_339_423,
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
    ["runtime dependency drift", ["runtimeDependencies", "huggingfaceHubVersion"], "1.27.0"],
    [
      "revision serialization drift",
      ["revisionSerialization", "resolvedRevisionAfterPickle"],
      "main",
    ],
  ] as const)("rejects %s", (_name, pathParts, replacement) => {
    const changed = structuredClone(provenance) as JsonRecord;
    let target = changed;
    pathParts.slice(0, -1).forEach((part) => {
      target = target[part] as JsonRecord;
    });
    const leaf = pathParts.at(-1)!;
    expect(Object.hasOwn(target, leaf)).toBe(true);
    const original = target[leaf];
    target[leaf] = replacement;
    expect(target[leaf]).not.toEqual(original);

    expect(() => verifyMuseGlimmerVllmImageProvenance(changed)).toThrow();
  });
});
