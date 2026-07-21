// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  cpSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export type StagedReplacement = Readonly<{
  label: string;
  livePath: string;
  stagedPath: string;
  stagingRoot: string;
}>;

export type StagedReplacementTransactionEvent = Readonly<{
  index: number;
  label: string;
  livePath: string;
  phase: "after-backup" | "after-install" | "before-verify";
}>;

export type StagedReplacementTransactionHook = (event: StagedReplacementTransactionEvent) => void;

function siblingRoot(livePath: string): string {
  const resolved = path.resolve(livePath);
  const parent = path.dirname(resolved);
  const base = path.basename(resolved).replaceAll(path.sep, "-");
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const candidate = path.join(
      parent,
      `.${base}.nemoclaw-stage-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    try {
      mkdirSync(candidate, { mode: 0o700 });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new Error(`could not allocate a staged replacement beside ${resolved}`);
}

function requireLiveEntry(livePath: string, kind: "directory" | "file"): void {
  const metadata = lstatSync(livePath);
  const valid = kind === "directory" ? metadata.isDirectory() : metadata.isFile();
  if (!valid || metadata.isSymbolicLink()) {
    throw new Error(`transaction target must be a real ${kind}: ${livePath}`);
  }
}

function requireSameFilesystem(replacement: StagedReplacement): void {
  const liveDevice = statSync(replacement.livePath).dev;
  const stagedDevice = statSync(replacement.stagedPath).dev;
  if (liveDevice !== stagedDevice) {
    throw new Error(
      `${replacement.label} must be staged on the same filesystem as ${replacement.livePath}`,
    );
  }
}

function pathsOverlap(first: string, second: string): boolean {
  const relative = path.relative(first, second);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function validateReplacementSet(replacements: readonly StagedReplacement[]): void {
  if (replacements.length === 0) throw new Error("replacement transaction has no targets");
  for (const [index, replacement] of replacements.entries()) {
    const livePath = path.resolve(replacement.livePath);
    const stagedPath = path.resolve(replacement.stagedPath);
    if (livePath !== replacement.livePath || stagedPath !== replacement.stagedPath) {
      throw new Error(`${replacement.label} transaction paths must be absolute`);
    }
    requireSameFilesystem(replacement);
    for (const prior of replacements.slice(0, index)) {
      if (
        pathsOverlap(path.resolve(prior.livePath), livePath) ||
        pathsOverlap(livePath, path.resolve(prior.livePath))
      ) {
        throw new Error(
          `${replacement.label} transaction target overlaps ${prior.label}: ${livePath}`,
        );
      }
    }
  }
}

export function stageDirectoryReplacement(options: {
  label: string;
  livePath: string;
  sourcePath: string;
}): StagedReplacement {
  const livePath = path.resolve(options.livePath);
  const sourcePath = path.resolve(options.sourcePath);
  requireLiveEntry(livePath, "directory");
  requireLiveEntry(sourcePath, "directory");
  const stagingRoot = siblingRoot(livePath);
  const stagedPath = path.join(stagingRoot, "replacement");
  try {
    cpSync(sourcePath, stagedPath, { recursive: true, dereference: false });
    return { label: options.label, livePath, stagedPath, stagingRoot };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function stageFileReplacement(options: {
  contents: string | NodeJS.ArrayBufferView;
  label: string;
  livePath: string;
}): StagedReplacement {
  const livePath = path.resolve(options.livePath);
  requireLiveEntry(livePath, "file");
  const descriptor = openSync(livePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let mode: number;
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile())
      throw new Error(`transaction target must be a regular file: ${livePath}`);
    mode = metadata.mode & 0o7777;
  } finally {
    closeSync(descriptor);
  }

  const stagingRoot = siblingRoot(livePath);
  const stagedPath = path.join(stagingRoot, "replacement");
  try {
    writeFileSync(stagedPath, options.contents, { flag: "wx", mode });
    return { label: options.label, livePath, stagedPath, stagingRoot };
  } catch (error) {
    rmSync(stagingRoot, { recursive: true, force: true });
    throw error;
  }
}

export function discardStagedReplacements(replacements: readonly StagedReplacement[]): void {
  for (const replacement of replacements) {
    rmSync(replacement.stagingRoot, { recursive: true, force: true });
  }
}

type ActiveReplacement = {
  backupPath: string;
  mutationStarted: boolean;
  replacement: StagedReplacement;
};

function rollback(active: readonly ActiveReplacement[]): Error[] {
  const errors: Error[] = [];
  for (const state of [...active].reverse()) {
    try {
      if (!state.mutationStarted) {
        rmSync(state.backupPath, { recursive: true, force: true });
        continue;
      }
      rmSync(state.replacement.livePath, { recursive: true, force: true });
      renameSync(state.backupPath, state.replacement.livePath);
    } catch (error) {
      errors.push(
        new Error(`${state.replacement.label} rollback failed: ${String(error)}`, {
          cause: error,
        }),
      );
    }
  }
  return errors;
}

export function commitStagedReplacementTransaction(options: {
  injectFailure?: StagedReplacementTransactionHook;
  replacements: readonly StagedReplacement[];
  verify: () => void;
}): void {
  const transactionId = `${process.pid}-${randomBytes(8).toString("hex")}`;
  const active: ActiveReplacement[] = [];
  try {
    validateReplacementSet(options.replacements);
    for (const [index, replacement] of options.replacements.entries()) {
      const backupPath = `${replacement.livePath}.nemoclaw-backup-${transactionId}`;
      const state = { backupPath, mutationStarted: false, replacement };
      active.push(state);
      cpSync(replacement.livePath, backupPath, {
        dereference: false,
        errorOnExist: true,
        force: false,
        preserveTimestamps: true,
        recursive: true,
      });
      options.injectFailure?.({
        index,
        label: replacement.label,
        livePath: replacement.livePath,
        phase: "after-backup",
      });
      state.mutationStarted = true;
      rmSync(replacement.livePath, { recursive: true, force: true });
      renameSync(replacement.stagedPath, replacement.livePath);
      options.injectFailure?.({
        index,
        label: replacement.label,
        livePath: replacement.livePath,
        phase: "after-install",
      });
    }
    options.injectFailure?.({
      index: options.replacements.length,
      label: "transaction verification",
      livePath: "",
      phase: "before-verify",
    });
    options.verify();
  } catch (error) {
    const rollbackErrors = rollback(active);
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        `staged replacement transaction failed and rollback was incomplete; backups were retained`,
      );
    }
    discardStagedReplacements(options.replacements);
    throw error;
  }

  for (const state of active) {
    rmSync(state.backupPath, { recursive: true, force: true });
  }
  discardStagedReplacements(options.replacements);
}
