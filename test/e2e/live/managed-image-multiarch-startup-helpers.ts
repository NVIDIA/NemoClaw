// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import {
  PROTECTED_MANAGED_IMAGE_PLATFORMS,
  type ProtectedManagedImagePlatform,
} from "../../../scripts/checks/protected-managed-image-contract.ts";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const COHORT_PATTERN = /^protected-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;

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
  const headSha = requiredEnvironment("NEMOCLAW_E2E_EXPECTED_SHA");
  const baseSha = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_BASE_SHA");
  const workflowSha = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_WORKFLOW_SHA");

  if (
    !(PROTECTED_MANAGED_IMAGE_PLATFORMS as readonly string[]).includes(platform) ||
    !COHORT_PATTERN.test(cohort) ||
    !SHA_PATTERN.test(headSha) ||
    !SHA_PATTERN.test(baseSha) ||
    !SHA_PATTERN.test(workflowSha)
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
  const relative = path.relative(fs.realpathSync(artifactDirectory), fs.realpathSync(file));
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`${file} must be a child of the protected artifact directory`);
  }
  const status = fs.lstatSync(file);
  if (!status.isFile() || status.isSymbolicLink() || status.size > 1024 * 1024) {
    throw new Error(`${file} must be a bounded regular file`);
  }
  return fs.readFileSync(file);
}
