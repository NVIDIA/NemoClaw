// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";
import { NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH } from "../scripts/patch-bundled-npm-tar.mts";
import { requireSingleReviewedDockerfileRunCommand } from "./helpers/dockerfile-run-commands";

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
  { file: "agents/pi/Dockerfile.base", installsPatchDownloader: true, installsWithNpm: false },
  { file: "agents/pi/Dockerfile", installsPatchDownloader: false, installsWithNpm: false },
] as const;
const patchCommand = "node --experimental-strip-types /scripts/patch-bundled-npm-tar.mts";
const npmRootArguments = ["--npm-root", "/usr/local/lib/node_modules/npm"] as const;
const pinnedBaseDockerfiles = [
  "Dockerfile.base",
  "agents/hermes/Dockerfile.base",
  "agents/langchain-deepagents-code/Dockerfile.base",
] as const;
const reviewedNodeBases = new Set<string>(NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH);

function nodeBaseReferences(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/^FROM\s+(node:[^\s]+@sha256:[0-9a-f]{64})(?:\s|$)/gmu)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
}

function assertReviewedNodeBases(file: string, source: string): void {
  const bases = nodeBaseReferences(source);
  assert(bases.length > 0, `${file} must pin at least one upstream Node base image`);
  const unreviewed = bases.filter((base) => !reviewedNodeBases.has(base));
  assert.deepEqual(unreviewed, [], `${file} contains an unreviewed upstream Node base image`);
}

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
    const observedBases = new Set<string>();
    pinnedBaseDockerfiles.forEach((file) => {
      const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
      assertReviewedNodeBases(file, source);
      for (const base of nodeBaseReferences(source)) observedBases.add(base);
    });
    expect([...observedBases].sort()).toEqual(
      [...NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH].sort(),
    );
  });

  // source-shape-contract: security -- Each managed Dockerfile must remain bound to a reviewed Node base digest.
  it("rejects an isolated unreviewed Deep Agents Code Node base pin", () => {
    const file = "agents/langchain-deepagents-code/Dockerfile.base";
    const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const reviewedBase = NODE_BASES_REQUIRING_BUNDLED_NPM_TAR_PATCH.find((base) =>
      base.startsWith("node:22-"),
    );
    assert(reviewedBase !== undefined, "the reviewed Node 22 base must be registered");
    const unreviewedBase = `node:22-trixie-slim@sha256:${"0".repeat(64)}`;
    const changedSource = source.replaceAll(reviewedBase, unreviewedBase);

    expect(() => assertReviewedNodeBases(file, changedSource)).toThrow(
      `${file} contains an unreviewed upstream Node base image`,
    );
  });

  it.each([
    "Dockerfile.base",
    "agents/hermes/Dockerfile.base",
    "agents/langchain-deepagents-code/Dockerfile.base",
  ])("installs curl before patching the bundled npm tar in $file", (file) => {
    const source = completedStage(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    const curlInstall = source.indexOf("curl=");
    const patchRun = requireSingleReviewedDockerfileRunCommand(
      source,
      patchCommand,
      npmRootArguments,
    ).commandStart;

    expect(curlInstall, file).toBeGreaterThanOrEqual(0);
    expect(patchRun, file).toBeGreaterThan(curlInstall);
  });

  it.each(
    dockerfiles,
  )("places bundled npm tar remediation in the final $file stage before any npm consumers", (entry) => {
    const { file, installsPatchDownloader, installsWithNpm } = entry;
    const dockerfile = fs.readFileSync(path.join(repoRoot, file), "utf8");
    const source = completedStage(dockerfile);
    const patchPayloadStage = ["hermes-npm-patch-payload", "openclaw-dependency-payload"].find(
      (stage) => source.includes(`COPY --from=${stage} / /`),
    );
    const patchPayloadLayer =
      patchPayloadStage === undefined ? -1 : source.indexOf(`COPY --from=${patchPayloadStage} / /`);
    const patchInputStage =
      patchPayloadStage === undefined ? source : namedStage(dockerfile, patchPayloadStage);
    const flattenedPatchInputStage = patchInputStage.replace(/\\\s*\n/g, " ").replace(/\s+/g, " ");
    const reviewedCopy = patchInputStage.indexOf("COPY scripts/lib/reviewed-npm-archive.mts");
    const helperCopy = patchInputStage.indexOf("scripts/lib/bundled-npm-package.mts");
    const patchCopy = patchInputStage.indexOf(
      "COPY scripts/patch-bundled-npm-tar.mts /scripts/patch-bundled-npm-tar.mts",
    );
    const patchRun = requireSingleReviewedDockerfileRunCommand(
      source,
      patchCommand,
      npmRootArguments,
    ).commandStart;
    const patchInputReady = patchPayloadLayer >= 0 ? patchPayloadLayer : patchCopy;

    expect(reviewedCopy, file).toBeGreaterThanOrEqual(0);
    expect(
      flattenedPatchInputStage.includes(
        "COPY scripts/lib/reviewed-npm-archive.mts scripts/lib/bundled-npm-package.mts scripts/lib/reviewed-npm-audit.mts scripts/lib/openclaw-npm-remediation.mts /scripts/lib/",
      ) ||
        patchInputStage.includes(
          "COPY scripts/lib/reviewed-npm-archive.mts /scripts/lib/reviewed-npm-archive.mts",
        ),
      file,
    ).toBe(true);
    expect(helperCopy, file).toBeGreaterThan(reviewedCopy);
    expect(patchCopy, file).toBeGreaterThan(helperCopy);
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

describe("reviewed npm image remediation contract", () => {
  it.each([
    { file: "Dockerfile.base", installsWithNpm: true },
    { file: "agents/hermes/Dockerfile.base", installsWithNpm: true },
    { file: "agents/langchain-deepagents-code/Dockerfile.base", installsWithNpm: false },
  ])("upgrades npm before use in $file", ({ file, installsWithNpm }) => {
    const source = completedStage(fs.readFileSync(path.join(repoRoot, file), "utf8"));
    const patchRun = requireSingleReviewedDockerfileRunCommand(
      source,
      patchCommand,
      npmRootArguments,
    ).commandStart;
    const upgradeCopy = source.indexOf(
      "COPY scripts/upgrade-bundled-npm.mts /scripts/upgrade-bundled-npm.mts",
    );
    const upgradeRun = requireSingleReviewedDockerfileRunCommand(
      source,
      "node --experimental-strip-types /scripts/upgrade-bundled-npm.mts",
      npmRootArguments,
    ).commandStart;

    expect(upgradeCopy, file).toBeGreaterThanOrEqual(0);
    expect(patchRun, file).toBeGreaterThan(upgradeCopy);
    expect(upgradeRun, file).toBeGreaterThan(patchRun);

    const executableSource = source.replace(/^\s*#.*$/gmu, (comment) => " ".repeat(comment.length));
    const npmConsumers = [...executableSource.matchAll(/\bnpm\s+(?:ci|install)\b/gu)].map(
      (match) => match.index,
    );
    expect(npmConsumers.length > 0, file).toBe(installsWithNpm);
    expect(
      npmConsumers.every((index) => index > upgradeRun),
      file,
    ).toBe(true);
  });
});
