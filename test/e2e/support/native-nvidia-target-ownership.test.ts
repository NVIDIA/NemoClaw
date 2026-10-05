// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { catalogueTargetsForChangedFiles } from "../../../tools/e2e/target-catalogue.mts";

describe("native NVIDIA target ownership", () => {
  it.each([
    "src/lib/actions/inference-set.ts",
    "src/lib/inference/native-nvidia/index.ts",
    "managed-inference/provider-profiles/nemoclaw-nvidia-inference-v1.yaml",
    "test/e2e/live/public-nvidia-switch-provider.ts",
  ])("selects both provider-switch targets when %s changes", (changedFile) => {
    expect(catalogueTargetsForChangedFiles([changedFile]).map((target) => target.id)).toEqual(
      expect.arrayContaining(["hermes-inference-switch", "openclaw-inference-switch"]),
    );
  });
});
