// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  defineTool,
  type LsOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const PI_UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

type RepoPathGuard = {
  resolveExisting(candidate: string): Promise<string>;
};

function isContainedPath(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function createRepoPathGuard(cwd: string): RepoPathGuard {
  const lexicalRoot = path.resolve(cwd);
  const realRoot = fs.realpathSync(lexicalRoot);

  return {
    async resolveExisting(candidate) {
      const withoutAtPrefix = candidate.startsWith("@") ? candidate.slice(1) : candidate;
      const normalizedCandidate = withoutAtPrefix.replace(PI_UNICODE_SPACES, " ");
      const expandedCandidate =
        normalizedCandidate === "~"
          ? os.homedir()
          : normalizedCandidate.startsWith("~/")
            ? path.join(os.homedir(), normalizedCandidate.slice(2))
            : normalizedCandidate;
      const lexicalPath = path.resolve(lexicalRoot, expandedCandidate);
      if (!isContainedPath(lexicalRoot, lexicalPath)) {
        throw new Error(`Advisor read-only path is outside the workspace: ${candidate}`);
      }

      const realPath = await fs.promises.realpath(lexicalPath);
      if (!isContainedPath(realRoot, realPath)) {
        throw new Error(`Advisor read-only path resolves outside the workspace: ${candidate}`);
      }
      if (realPath.replace(PI_UNICODE_SPACES, " ") !== realPath) {
        throw new Error(
          `Advisor read-only path is not stable under Pi SDK normalization: ${candidate}`,
        );
      }
      return realPath;
    },
  };
}

function createGuardedLsOperations(guard: RepoPathGuard): LsOperations {
  return {
    async exists(absolutePath) {
      try {
        await guard.resolveExisting(absolutePath);
        return true;
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
    async stat(absolutePath) {
      return fs.promises.stat(await guard.resolveExisting(absolutePath));
    },
    async readdir(absolutePath) {
      return fs.promises.readdir(await guard.resolveExisting(absolutePath));
    },
  };
}

/**
 * Preserve Pi's read-only tool contracts while confining every requested root to cwd.
 * Canonical paths are delegated to Pi so a checked symlink cannot redirect the operation.
 */
export function createRepoConfinedReadOnlyTools(cwd: string): ToolDefinition[] {
  const guard = createRepoPathGuard(cwd);

  const read = createReadToolDefinition(cwd);
  const executeRead = read.execute;
  read.execute = async (toolCallId, input, signal, onUpdate, context) =>
    executeRead(
      toolCallId,
      { ...input, path: await guard.resolveExisting(input.path) },
      signal,
      onUpdate,
      context,
    );

  const grep = createGrepToolDefinition(cwd);
  const executeGrep = grep.execute;
  grep.execute = async (toolCallId, input, signal, onUpdate, context) =>
    executeGrep(
      toolCallId,
      { ...input, path: await guard.resolveExisting(input.path || ".") },
      signal,
      onUpdate,
      context,
    );

  const find = createFindToolDefinition(cwd);
  const executeFind = find.execute;
  find.execute = async (toolCallId, input, signal, onUpdate, context) =>
    executeFind(
      toolCallId,
      { ...input, path: await guard.resolveExisting(input.path || ".") },
      signal,
      onUpdate,
      context,
    );

  const ls = createLsToolDefinition(cwd, { operations: createGuardedLsOperations(guard) });
  const executeLs = ls.execute;
  ls.execute = async (toolCallId, input, signal, onUpdate, context) =>
    executeLs(
      toolCallId,
      { ...input, path: await guard.resolveExisting(input.path || ".") },
      signal,
      onUpdate,
      context,
    );

  return [defineTool(read), defineTool(grep), defineTool(find), defineTool(ls)];
}
