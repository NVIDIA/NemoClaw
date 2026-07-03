// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AgentDefinition } from "../agent/defs";
import { isErrnoException } from "../core/errno";
import {
  collectBuildContextStats,
  type StagedBuildContext,
  stageOptimizedSandboxBuildContext,
} from "../sandbox/build-context";
import {
  createCustomBuildContextFilter,
  CUSTOM_BUILD_CONTEXT_WARN_BYTES,
  isInsideIgnoredCustomBuildContextPath,
} from "./custom-build-context";

export interface CreateSandboxBuildContextInput {
  root: string;
  fromDockerfile: string | null;
  agent: AgentDefinition | null | undefined;
  createAgentSandbox(agent: AgentDefinition): StagedBuildContext;
  log?(message: string): void;
  warn?(message: string): void;
  error?(message: string): void;
  exit?(code?: number): never;
  stageDefaultSandboxBuildContext?(rootDir: string): StagedBuildContext;
}

export interface CreateSandboxBuildContextResult extends StagedBuildContext {
  cleanupBuildCtx(): boolean;
}

function createCleanupBuildContext(buildCtx: string): () => boolean {
  return () => {
    try {
      fs.rmSync(buildCtx, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  };
}

export function stageCreateSandboxBuildContext(
  input: CreateSandboxBuildContextInput,
): CreateSandboxBuildContextResult {
  const log = input.log ?? console.log;
  const warn = input.warn ?? console.warn;
  const error = input.error ?? console.error;
  const exit = input.exit ?? ((code?: number): never => process.exit(code));

  let build: StagedBuildContext;

  if (input.fromDockerfile) {
    const fromResolved = path.resolve(input.fromDockerfile);
    if (!fs.existsSync(fromResolved)) {
      error(`  Custom Dockerfile not found: ${fromResolved}`);
      exit(1);
    }
    if (!fs.statSync(fromResolved).isFile()) {
      error(`  Custom Dockerfile path is not a file: ${fromResolved}`);
      exit(1);
    }
    const buildContextDir = path.dirname(fromResolved);
    if (isInsideIgnoredCustomBuildContextPath(buildContextDir)) {
      error(`  Custom Dockerfile is inside an ignored build-context path: ${buildContextDir}`);
      error("  Move your Dockerfile to a dedicated directory and retry.");
      exit(1);
    }
    log(`  Using custom Dockerfile: ${fromResolved}`);
    log(`  Docker build context: ${buildContextDir}`);
    const shouldIncludeCustomContextPath = createCustomBuildContextFilter(buildContextDir);
    const buildContextStats = collectBuildContextStats(
      buildContextDir,
      shouldIncludeCustomContextPath,
    );
    if (buildContextStats.totalBytes > CUSTOM_BUILD_CONTEXT_WARN_BYTES) {
      const sizeMb = (buildContextStats.totalBytes / 1_000_000).toFixed(1);
      warn(
        `  WARN: build context contains about ${sizeMb} MB across ${buildContextStats.fileCount} files.`,
      );
      warn(
        "  The --from flag sends the Dockerfile's parent directory to Docker; use a dedicated directory if this is not intentional.",
      );
    }
    const buildCtx = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-build-"));
    const stagedDockerfile = path.join(buildCtx, "Dockerfile");
    const cleanupCustomBuildCtx = (): void => {
      try {
        fs.rmSync(buildCtx, { recursive: true, force: true });
      } catch {
        // Best effort cleanup; the original error is more useful to the caller.
      }
    };
    try {
      fs.cpSync(buildContextDir, buildCtx, {
        recursive: true,
        filter: shouldIncludeCustomContextPath,
      });
      if (path.basename(fromResolved) !== "Dockerfile") {
        fs.copyFileSync(fromResolved, stagedDockerfile);
      }
    } catch (err) {
      cleanupCustomBuildCtx();
      const errorObject = typeof err === "object" && err !== null ? err : null;
      if (isErrnoException(errorObject) && errorObject.code === "EACCES") {
        error(`  Permission denied while copying build context from: ${buildContextDir}`);
        error(
          "  The --from flag uses the Dockerfile's parent directory as the Docker build context.",
        );
        error("  Move your Dockerfile to a dedicated directory and retry.");
        exit(1);
      }
      throw err;
    }
    build = { buildCtx, stagedDockerfile };
  } else if (input.agent) {
    build = input.createAgentSandbox(input.agent);
  } else {
    build = (input.stageDefaultSandboxBuildContext ?? stageOptimizedSandboxBuildContext)(
      input.root,
    );
  }

  return {
    ...build,
    cleanupBuildCtx: createCleanupBuildContext(build.buildCtx),
  };
}
