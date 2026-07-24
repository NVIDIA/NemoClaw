// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH } from "../scripts/patch-bundled-npm-tar.mts";

const repoRoot = path.resolve(import.meta.dirname, "..");
const dockerfiles = [
  { file: "Dockerfile.base", installsPatchDownloader: false, installsWithNpm: true },
  { file: "Dockerfile", installsPatchDownloader: false, installsWithNpm: true },
  {
    file: "agents/hermes/Dockerfile.base",
    installsPatchDownloader: false,
    installsWithNpm: true,
  },
  { file: "agents/hermes/Dockerfile", installsPatchDownloader: false, installsWithNpm: true },
  {
    file: "agents/langchain-deepagents-code/Dockerfile.base",
    installsPatchDownloader: true,
    installsWithNpm: false,
  },
  {
    file: "agents/langchain-deepagents-code/Dockerfile",
    installsPatchDownloader: false,
    installsWithNpm: false,
  },
] as const;

function completedStage(source: string): string {
  const finalStageStart = [...source.matchAll(/^FROM\b/gmu)].at(-1)?.index;
  assert(finalStageStart !== undefined, "Dockerfile must contain a completed image stage");
  return source.slice(finalStageStart);
}

function namedStage(source: string, name: string): string {
  const stageStart = source.indexOf(`FROM scratch AS ${name}`);
  assert(stageStart >= 0, `Dockerfile must contain the ${name} stage`);
  const nextStage = source.indexOf("\nFROM ", stageStart);
  return source.slice(stageStart, nextStage >= 0 ? nextStage : undefined);
}

describe("node-tar image remediation contract", () => {
  it("binds the remediation lifecycle to the affected upstream Node image pins", () => {
    const pinnedBaseSources = ["Dockerfile.base", "agents/hermes/Dockerfile.base"]
      .map((file) => fs.readFileSync(path.join(repoRoot, file), "utf8"))
      .join("\n");

    for (const base of NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH) {
      expect(pinnedBaseSources, base).toContain(`FROM ${base}`);
    }
  });

  it.each([
    "Dockerfile.base",
    "agents/hermes/Dockerfile.base",
    "agents/langchain-deepagents-code/Dockerfile.base",
  ])("installs curl before patching the bundled npm tar in $file", (file) => {
    const source = completedStage(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    const curlInstall = source.indexOf("curl=");
    const patchRun = source.indexOf(
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
    );

    expect(curlInstall, file).toBeGreaterThanOrEqual(0);
    expect(patchRun, file).toBeGreaterThan(curlInstall);
  });

  it.each(
    dockerfiles,
  )("patches npm before use and scans the completed $file filesystem", (entry) => {
    const { file, installsPatchDownloader, installsWithNpm } = entry;
    const dockerfile = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const source = completedStage(dockerfile);
    const patchPayloadLayer = source.indexOf("RUN --mount=type=bind,from=hermes-npm-patch-payload");
    const scanPayloadLayer = source.indexOf("RUN --mount=type=bind,from=hermes-scan-payload");
    const patchInputStage =
      patchPayloadLayer >= 0 ? namedStage(dockerfile, "hermes-npm-patch-payload") : source;
    const scanInputStage =
      scanPayloadLayer >= 0 ? namedStage(dockerfile, "hermes-scan-payload") : source;
    const reviewedCopy = patchInputStage.indexOf(
      "COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts",
    );
    const patchCopy = patchInputStage.indexOf(
      "COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts",
    );
    const patchRun = source.indexOf(
      "RUN node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts",
    );
    const scanCopy = scanInputStage.indexOf(
      "COPY scripts/checks/node-tar-image-scan.mts /scripts/checks/node-tar-image-scan.mts",
    );
    const scanRun = source.indexOf(
      "node --experimental-strip-types /scripts/checks/node-tar-image-scan.mts",
    );
    const patchInputReady = patchPayloadLayer >= 0 ? patchPayloadLayer : patchCopy;
    const scanInputReady = scanPayloadLayer >= 0 ? scanPayloadLayer : scanCopy;

    expect(reviewedCopy, file).toBeGreaterThanOrEqual(0);
    expect(patchCopy, file).toBeGreaterThan(reviewedCopy);
    expect(patchRun, file).toBeGreaterThan(patchInputReady);
    const aptInstall = source.indexOf(
      "RUN apt-get update && apt-get install -y --no-install-recommends",
      patchInputReady,
    );
    const curlPackage = source.indexOf("curl=8.14.1-2+deb13u4", aptInstall);
    const aptInstallCleanup = source.indexOf("&& rm -rf /var/lib/apt/lists/*", curlPackage);
    expect(
      aptInstall > patchCopy &&
        curlPackage > aptInstall &&
        aptInstallCleanup > curlPackage &&
        aptInstallCleanup < patchRun,
      file,
    ).toBe(installsPatchDownloader);
    expect(scanCopy, file).toBeGreaterThanOrEqual(0);
    expect(scanInputReady, file).toBeGreaterThan(patchRun);
    expect(scanRun, file).toBeGreaterThan(scanInputReady);
    expect(source, file).toContain("> /usr/local/share/nemoclaw/node-tar-inventory.json");

    const executableSource = source.replace(/^\s*#.*$/gmu, (comment) => " ".repeat(comment.length));
    const npmConsumers = [...executableSource.matchAll(/\bnpm\s+(?:ci|install)\b/gu)].map(
      (match) => match.index,
    );
    expect(npmConsumers.length > 0, file).toBe(installsWithNpm);
    expect(
      npmConsumers.every((index) => index > patchRun),
      file,
    ).toBe(true);
  });
});
