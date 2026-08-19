// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/** Verifies direct COPY sources from the root Dockerfile in the optimized build context. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  formatMissingDockerfileCopySources,
  missingDockerfileCopySources,
} from "../lib/dockerfile-copy-sources.mts";

type BuildContextModule = typeof import("../../src/lib/sandbox/build-context.ts");

const importedBuildContext = (await import("../../src/lib/sandbox/build-context.ts")) as
  | BuildContextModule
  | { default: BuildContextModule };
const buildContextModule =
  "default" in importedBuildContext ? importedBuildContext.default : importedBuildContext;
const { stageOptimizedSandboxBuildContext } = buildContextModule;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export function checkOptimizedBuildContextCopySources(
  rootDir: string = REPO_ROOT,
  temporaryRoot: string = os.tmpdir(),
): void {
  const stagingRoot = fs.mkdtempSync(
    path.join(temporaryRoot, "nemoclaw-build-context-copy-check-"),
  );
  try {
    const staged = stageOptimizedSandboxBuildContext(rootDir, stagingRoot);
    const missingSources = missingDockerfileCopySources(
      staged.stagedDockerfile,
      staged.buildCtx,
      "Dockerfile",
    );
    if (missingSources.length > 0) {
      throw new Error(formatMissingDockerfileCopySources(missingSources));
    }
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

const currentModule = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentModule) {
  checkOptimizedBuildContextCopySources();
}
