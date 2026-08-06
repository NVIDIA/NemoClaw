// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { CUA_QUALIFICATION_ARTIFACT_RUNNER_ENV, isCuaQualificationEnabled } from "./feature";

export const CUA_QUALIFICATION_ARTIFACT_RUNNER_PATH =
  "/usr/local/libexec/nemoclaw-cua-qualification-artifact-runner" as const;
export const CUA_QUALIFICATION_ISOLATED_TASK_INPUT_PATH =
  "/run/nemoclaw-cua-artifact/task-input" as const;

const MAX_RUNNER_BYTES = 64 * 1024;

function stableIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertRootOwnedDirectoryAncestors(filePath: string): void {
  const root = path.parse(filePath).root;
  let current = path.dirname(filePath);
  while (true) {
    const stat = fs.lstatSync(current, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== 0n ||
      (stat.mode & 0o022n) !== 0n ||
      fs.realpathSync(current) !== current
    ) {
      throw new Error("CUA candidate qualification artifact runner authority is unsafe");
    }
    if (current === root) return;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error("CUA candidate qualification artifact runner authority is unsafe");
    }
    current = parent;
  }
}

/**
 * Resolve the root-installed process boundary used only by live candidate qualification.
 *
 * The runner enters fresh mount and PID namespaces, copies the already
 * digest-checked artifact into root-owned scratch space, and drops to the
 * dedicated `nemoclaw-cua-artifact` account before execution. Ordinary and
 * final CUA lifecycle calls do not use this candidate-only boundary.
 */
export function resolveCuaQualificationArtifactRunner(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (!isCuaQualificationEnabled(env)) return undefined;
  if (
    process.platform !== "linux" ||
    env[CUA_QUALIFICATION_ARTIFACT_RUNNER_ENV] !== CUA_QUALIFICATION_ARTIFACT_RUNNER_PATH
  ) {
    throw new Error("CUA candidate qualification requires its exact Linux artifact runner");
  }

  const runner = CUA_QUALIFICATION_ARTIFACT_RUNNER_PATH;
  assertRootOwnedDirectoryAncestors(runner);
  const before = fs.lstatSync(runner, { bigint: true });
  if (
    fs.realpathSync(runner) !== runner ||
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.uid !== 0n ||
    before.nlink !== 1n ||
    before.size < 1n ||
    before.size > BigInt(MAX_RUNNER_BYTES) ||
    (before.mode & 0o022n) !== 0n ||
    (before.mode & 0o005n) !== 0o005n
  ) {
    throw new Error("CUA candidate qualification artifact runner authority is unsafe");
  }

  const descriptor = fs.openSync(runner, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !stableIdentity(before, opened)) {
      throw new Error("CUA candidate qualification artifact runner changed during validation");
    }
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = fs.readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (read === 0) break;
      offset += read;
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      offset !== Number(opened.size) ||
      !stableIdentity(opened, after) ||
      !bytes.subarray(0, offset).toString("utf8").startsWith("#!/bin/bash\n")
    ) {
      throw new Error("CUA candidate qualification artifact runner changed during validation");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return runner;
}
