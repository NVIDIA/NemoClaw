// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { VLLM_MODELS } from "../../../src/lib/inference/vllm-models.js";
import { detectVllmProfile, resolveVllmRuntimeProfile } from "../../../src/lib/inference/vllm.js";

const EXPECTED_IMAGE =
  "vllm/vllm-openai@sha256:b0e84e5f2b00a7268e4fdda332790ebd4bfb166b64757e166914753afaeee965";
const EXPECTED_ARCHITECTURE = "arm64";
const EXPECTED_DOWNLOAD_SIZE_BYTES = 9_706_339_423;
const recipePath = path.resolve(
  import.meta.dirname,
  "../../../managed-inference/recipes/vllm.muse-glimmer-30b-nvfp4-w4a4.spark-single.v1.yaml",
);

const recipe = YAML.parse(readFileSync(recipePath, "utf8")) as {
  spec: { runtime: { architecture: string; image: string; imageDownloadSizeBytes: number } };
};

describe("Muse Glimmer vLLM runtime image", () => {
  it("selects the expected immutable image for DGX Spark", () => {
    expect(recipe.spec.runtime).toMatchObject({
      architecture: EXPECTED_ARCHITECTURE,
      image: EXPECTED_IMAGE,
      imageDownloadSizeBytes: EXPECTED_DOWNLOAD_SIZE_BYTES,
    });

    const profile = detectVllmProfile({ platform: "spark", type: "nvidia" });
    const model = VLLM_MODELS.find(({ envValue }) => envValue === "muse-glimmer-30b");
    expect(profile).not.toBeNull();
    expect(model).toBeDefined();
    expect(resolveVllmRuntimeProfile(profile!, model!)).toMatchObject({
      architecture: EXPECTED_ARCHITECTURE,
      image: EXPECTED_IMAGE,
      imageDownloadSizeBytes: EXPECTED_DOWNLOAD_SIZE_BYTES,
    });
  });
});
