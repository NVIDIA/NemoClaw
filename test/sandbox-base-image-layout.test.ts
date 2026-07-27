// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dockerfile = fs.readFileSync(path.join(repoRoot, "Dockerfile.base"), "utf8");

function completedStage(source: string): string {
  const stages = source.split(/(?=^FROM )/gmu).filter((stage) => stage.startsWith("FROM "));
  return stages.at(-1) ?? "";
}

describe("sandbox base image layout", () => {
  it("keeps the published image within the established layer budget", () => {
    const finalStage = completedStage(dockerfile);
    const layerInstructions = finalStage.match(/^(?:ADD|COPY|RUN)\b/gmu) ?? [];

    expect(finalStage).toContain("FROM node:22-trixie-slim@");
    expect(layerInstructions).toHaveLength(24);
  });
});
