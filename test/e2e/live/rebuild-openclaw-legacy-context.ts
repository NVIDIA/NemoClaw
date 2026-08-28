// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { stageOptimizedSandboxBuildContext } from "../../../src/lib/sandbox/build-context";

export interface LegacyOpenClawSandboxContext {
  buildCtx: string;
  dockerfile: string;
  blueprint: string;
  restoreCurrent(): void;
  cleanup(): void;
}

function replaceExactlyOne(
  source: string,
  pattern: RegExp,
  replacement: string,
  label: string,
): string {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error(`Expected one ${label}; found ${matches.length}`);
  }
  return source.replace(pattern, replacement);
}

function writePreservingMode(filePath: string, contents: string, mode: number): void {
  fs.chmodSync(filePath, mode | 0o200);
  fs.writeFileSync(filePath, contents, "utf8");
  fs.chmodSync(filePath, mode);
}

/**
 * Stage the complete trusted OpenClaw Docker build context, then lower only
 * the runtime inputs needed to create the historical sandbox exercised by this
 * E2E. The base image remains under the real onboard resolver's authority. The
 * caller restores the current trusted recipe before invoking rebuild.
 */
export function createLegacyOpenClawSandboxContext(options: {
  rootDir: string;
  openClawVersion: string;
}): LegacyOpenClawSandboxContext {
  const staged = stageOptimizedSandboxBuildContext(options.rootDir);
  const dockerfile = staged.stagedDockerfile;
  const blueprint = path.join(staged.buildCtx, "nemoclaw-blueprint", "blueprint.yaml");
  const currentDockerfile = fs.readFileSync(dockerfile, "utf8");
  const currentBlueprint = fs.readFileSync(blueprint, "utf8");
  const dockerfileMode = fs.statSync(dockerfile).mode & 0o777;
  const blueprintMode = fs.statSync(blueprint).mode & 0o777;

  try {
    let legacyDockerfile = replaceExactlyOne(
      currentDockerfile,
      /^ARG OPENCLAW_VERSION=.*$/gm,
      `ARG OPENCLAW_VERSION=${options.openClawVersion}`,
      "Dockerfile OPENCLAW_VERSION default",
    );
    legacyDockerfile = replaceExactlyOne(
      legacyDockerfile,
      /^ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=.*$/gm,
      "ARG NEMOCLAW_E2E_FIXTURE_LEGACY_OPENCLAW=1",
      "Dockerfile legacy OpenClaw fixture flag",
    );
    const legacyBlueprint = replaceExactlyOne(
      currentBlueprint,
      /^(\s*)min_openclaw_version:.*$/gm,
      `$1min_openclaw_version: "${options.openClawVersion}"`,
      "blueprint min_openclaw_version",
    );
    writePreservingMode(dockerfile, legacyDockerfile, dockerfileMode);
    writePreservingMode(blueprint, legacyBlueprint, blueprintMode);
  } catch (error) {
    fs.rmSync(staged.buildCtx, { recursive: true, force: true });
    throw error;
  }

  return {
    buildCtx: staged.buildCtx,
    dockerfile,
    blueprint,
    restoreCurrent() {
      writePreservingMode(dockerfile, currentDockerfile, dockerfileMode);
      writePreservingMode(blueprint, currentBlueprint, blueprintMode);
    },
    cleanup() {
      fs.rmSync(staged.buildCtx, { recursive: true, force: true });
    },
  };
}
