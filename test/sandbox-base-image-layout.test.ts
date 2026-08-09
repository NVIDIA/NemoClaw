// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

describe("sandbox base image layout", () => {
  // source-shape-contract: compatibility -- The exact instruction count preserves the reviewed final-stage layer budget
  it("keeps Dockerfile.base within the reviewed final-stage layer budget", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile.base", import.meta.url), "utf8");
    const stages = dockerfile.split(/(?=^FROM )/gmu).filter((stage) => stage.startsWith("FROM "));
    const finalStage = stages.at(-1) ?? "";
    const layerInstructions = finalStage.match(/^(?:ADD|COPY|RUN)\b/gmu) ?? [];

    expect(layerInstructions).toHaveLength(24);
  });
});
