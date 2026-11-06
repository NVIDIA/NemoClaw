// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  baseImageInputsChanged,
  parseBaseImagePushPaths,
} from "../../../tools/e2e/base-image-publication.mts";

const BASE_IMAGE_WORKFLOW_SOURCE = fs.readFileSync(
  path.resolve(import.meta.dirname, "../../../.github/workflows/base-image.yaml"),
  "utf8",
);

describe("base-image publication inputs", () => {
  it("publishes after a root package manifest changes", () => {
    const reviewedPaths = parseBaseImagePushPaths(BASE_IMAGE_WORKFLOW_SOURCE);

    expect(reviewedPaths).toEqual(expect.arrayContaining(["package.json", "package-lock.json"]));
    expect(baseImageInputsChanged(["package.json"], reviewedPaths)).toBe(true);
    expect(baseImageInputsChanged(["package-lock.json"], reviewedPaths)).toBe(true);
  });

  it.each([
    [
      "src/lib/inference/native-provider/catalog.ts",
      "src/lib/inference/native-provider/catalog.ts",
    ],
    ["src/lib/adapters/container-engine.ts", "src/lib/adapters/container-engine.ts"],
    ["src/lib/adapters/podman/**", "src/lib/adapters/podman/index.ts"],
    [
      "src/lib/agent/deep-agents-code-runtime-identity.json",
      "src/lib/agent/deep-agents-code-runtime-identity.json",
    ],
    ["test/e2e/fixtures/docker-build-guard.ts", "test/e2e/fixtures/docker-build-guard.ts"],
  ])("publishes after managed-image input %s changes", (publisherPath, changedPath) => {
    const reviewedPaths = parseBaseImagePushPaths(BASE_IMAGE_WORKFLOW_SOURCE);

    expect(reviewedPaths).toContain(publisherPath);
    expect(baseImageInputsChanged([changedPath], reviewedPaths)).toBe(true);
  });
});
