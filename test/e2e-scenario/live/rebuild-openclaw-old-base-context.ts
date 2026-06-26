// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const DOCKERFILE_BASE = path.join(REPO_ROOT, "Dockerfile.base");
const OLD_OPENCLAW_VERSION = "2026.3.11";
const BLUEPRINT_RELPATH = "nemoclaw-blueprint/blueprint.yaml";

export function oldBaseContextSources(): string[] {
  return [BLUEPRINT_RELPATH, ...directDockerfileBaseCopySources()];
}

export function directDockerfileBaseCopySources(dockerfilePath = DOCKERFILE_BASE): string[] {
  const text = fs.readFileSync(dockerfilePath, "utf8");
  const sources: string[] = [];

  for (const [lineIndex, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const instructionMatch = /^(\S+)\b([\s\S]*)$/.exec(line);
    if (!instructionMatch || instructionMatch[1].toUpperCase() !== "COPY") continue;

    const tokens = instructionMatch[2].trim().split(/\s+/).filter(Boolean);
    const normalizedTokens = tokens.map((token) => token.toLowerCase());
    const nonFlagTokens = tokens.filter((token) => !token.startsWith("--"));
    const hasStageSource = normalizedTokens.some(
      (token) => token === "--from" || token.startsWith("--from="),
    );
    if (hasStageSource) continue;

    if (nonFlagTokens.length !== 2 || nonFlagTokens[0]?.startsWith("[")) {
      throw new Error(
        `Unsupported direct Dockerfile.base COPY form at line ${lineIndex + 1}: ${rawLine}`,
      );
    }

    validateOldBaseContextSource(nonFlagTokens[0]);
    sources.push(nonFlagTokens[0]);
  }

  return sources;
}

function validateOldBaseContextSource(relativePath: string): string {
  const parts = relativePath.split("/");
  const resolved = path.resolve(REPO_ROOT, relativePath);
  const repoPrefix = `${REPO_ROOT}${path.sep}`;
  const invalidSource =
    path.isAbsolute(relativePath) ||
    relativePath.includes("\\") ||
    parts.some((part) => !part || part === "." || part === "..") ||
    (resolved !== REPO_ROOT && !resolved.startsWith(repoPrefix));
  if (invalidSource) {
    throw new Error(`Unsupported direct Dockerfile.base COPY source: ${relativePath}`);
  }
  return resolved;
}

function copyOldBaseContextFile(buildContext: string, relativePath: string): void {
  const source = validateOldBaseContextSource(relativePath);
  const target = path.join(buildContext, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
}

export function createOldBaseBuildContext(): string {
  const buildContext = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-rebuild-openclaw-base-"));
  // The legacy bash test builds Dockerfile.base with the full repository as
  // context after temporarily lowering blueprint.yaml in-place. Keep the
  // trusted checkout read-only while staging every current Dockerfile.base
  // direct COPY dependency needed by that old-base build.
  for (const relativePath of oldBaseContextSources()) {
    copyOldBaseContextFile(buildContext, relativePath);
  }

  const stagedBlueprint = path.join(buildContext, ...BLUEPRINT_RELPATH.split("/"));
  const original = fs.readFileSync(stagedBlueprint, "utf8");
  const minOpenClawVersion = /^(\s*min_openclaw_version:\s*).*/m;
  if (!minOpenClawVersion.test(original)) {
    throw new Error("blueprint min_openclaw_version line was not found");
  }
  const lowered = original.replace(minOpenClawVersion, `$1"${OLD_OPENCLAW_VERSION}"`);
  fs.writeFileSync(stagedBlueprint, lowered, "utf8");
  return buildContext;
}
