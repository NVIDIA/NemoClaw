// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dockerfiles = [
  "Dockerfile.base",
  "Dockerfile",
  "agents/hermes/Dockerfile.base",
  "agents/hermes/Dockerfile",
  "agents/langchain-deepagents-code/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile",
] as const;

function completedStage(source: string): string {
  const finalBase = source.lastIndexOf("FROM ${BASE_IMAGE}");
  return finalBase >= 0 ? source.slice(finalBase) : source;
}

describe("node-tar image remediation contract", () => {
  it.each(dockerfiles)("patches npm before use and scans the completed %s filesystem", (file) => {
    const source = completedStage(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    const reviewedCopy = source.indexOf(
      "COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts",
    );
    const patchCopy = source.indexOf(
      "COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts",
    );
    const patchRun = source.indexOf(
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
    );
    const scanCopy = source.indexOf(
      "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts",
    );
    const scanRun = source.indexOf(
      "node --experimental-strip-types /scripts/checks/node-tar-image-scan.mts",
    );

    expect(reviewedCopy, file).toBeGreaterThanOrEqual(0);
    expect(patchCopy, file).toBeGreaterThan(reviewedCopy);
    expect(patchRun, file).toBeGreaterThan(patchCopy);
    expect(scanCopy, file).toBeGreaterThan(patchRun);
    expect(scanRun, file).toBeGreaterThan(scanCopy);
    expect(source, file).toContain("> /usr/local/share/nemoclaw/node-tar-inventory.json");

    const npmConsumersBeforePatch = [...source.matchAll(/^RUN\s+.*\bnpm\s+(?:ci|install)\b/gmu)]
      .map((match) => match.index)
      .filter((index) => index < patchRun);
    expect(npmConsumersBeforePatch, file).toEqual([]);
  });
});
