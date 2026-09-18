// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  PROTECTED_MANAGED_IMAGE_COHORT_PATTERN,
  PROTECTED_MANAGED_IMAGE_PLATFORMS,
  PROTECTED_MANAGED_IMAGE_SHA_PATTERN,
  type ProtectedManagedImagePlatform,
} from "../../../scripts/checks/protected-managed-image-contract.ts";

export interface ProtectedManagedImageDispatchEnvironment {
  artifactDirectory: string;
  baseSha: string;
  cohort: string;
  contractFile: string;
  evidenceFile: string;
  headSha: string;
  platform: ProtectedManagedImagePlatform;
  runAttempt: number;
  runId: number;
  workflowSha: string;
  workspace: string;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveIntegerEnvironment(name: string): number {
  const value = requiredEnvironment(name);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${name} must be a safe integer`);
  return parsed;
}

export function protectedManagedImageDispatchEnvironment(): ProtectedManagedImageDispatchEnvironment {
  const platform = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_PLATFORM");
  const cohort = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_COHORT");
  const headSha = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_HEAD_SHA");
  const baseSha = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA");
  const workflowSha = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA");

  if (
    !(PROTECTED_MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(platform) ||
    !PROTECTED_MANAGED_IMAGE_COHORT_PATTERN.test(cohort) ||
    !PROTECTED_MANAGED_IMAGE_SHA_PATTERN.test(headSha) ||
    !PROTECTED_MANAGED_IMAGE_SHA_PATTERN.test(baseSha) ||
    !PROTECTED_MANAGED_IMAGE_SHA_PATTERN.test(workflowSha)
  ) {
    throw new Error("protected managed-image dispatch identity is invalid");
  }

  return {
    artifactDirectory: requiredEnvironment("E2E_ARTIFACT_DIR"),
    baseSha,
    cohort,
    contractFile: requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT"),
    evidenceFile: requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_EVIDENCE"),
    headSha,
    platform: platform as ProtectedManagedImagePlatform,
    runAttempt: positiveIntegerEnvironment("GITHUB_RUN_ATTEMPT"),
    runId: positiveIntegerEnvironment("GITHUB_RUN_ID"),
    workflowSha,
    workspace: fs.realpathSync(requiredEnvironment("GITHUB_WORKSPACE")),
  };
}

export function readRegularArtifact(file: string, artifactDirectory: string): Buffer {
  const root = fs.realpathSync(artifactDirectory);
  const parent = fs.realpathSync(path.dirname(file));
  const candidate = path.join(parent, path.basename(file));
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file} must be a child of the protected artifact directory`);
  }

  const descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const status = fs.fstatSync(descriptor);
    if (!status.isFile() || status.size > 1024 * 1024) {
      throw new Error(`${file} must be a bounded regular file`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}
