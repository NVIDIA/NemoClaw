// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH,
  PROTECTED_MANAGED_IMAGE_PLATFORMS,
  type ProtectedManagedImagePlatform,
  parseProtectedManagedImageActivation,
  parseProtectedManagedImageContracts,
  parseProtectedManagedImageEvidence,
} from "../../../scripts/checks/protected-managed-image-contract.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const COHORT_PATTERN = /^protected-[1-9][0-9]{0,19}-[1-9][0-9]{0,9}$/u;

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

function regularArtifact(file: string, artifactDirectory: string): Buffer {
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

test("binds protected all-agent direct startup to the exact multiarch dispatch (#7744)", {
  meta: {
    e2ePhases: [
      "validate protected activation and dispatch identity",
      "validate exact all-agent managed-image contracts",
      "validate direct-start evidence binding",
    ],
  },
}, ({ progress }) => {
  progress.phase("validate protected activation and dispatch identity");
  const workspace = fs.realpathSync(requiredEnvironment("GITHUB_WORKSPACE"));
  const artifactDirectory = requiredEnvironment("E2E_ARTIFACT_DIR");
  const contractFile = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_CONTRACT");
  const evidenceFile = requiredEnvironment("NEMOCLAW_PROTECTED_MANAGED_IMAGE_EVIDENCE");
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
  const expectedPlatform = platform as ProtectedManagedImagePlatform;

  const activationPath = path.join(workspace, PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH);
  const activationStatus = fs.lstatSync(activationPath);
  expect(activationStatus.isFile()).toBe(true);
  expect(activationStatus.isSymbolicLink()).toBe(false);
  parseProtectedManagedImageActivation(JSON.parse(fs.readFileSync(activationPath, "utf8")));

  progress.phase("validate exact all-agent managed-image contracts");
  const contractBytes = regularArtifact(contractFile, artifactDirectory);
  const evidenceBytes = regularArtifact(evidenceFile, artifactDirectory);
  const contracts = parseProtectedManagedImageContracts(
    JSON.parse(contractBytes.toString("utf8")),
    expectedPlatform,
  );

  progress.phase("validate direct-start evidence binding");
  const evidence = parseProtectedManagedImageEvidence(JSON.parse(evidenceBytes.toString("utf8")), {
    baseSha,
    cohort,
    headSha,
    platform: expectedPlatform,
    runAttempt: positiveIntegerEnvironment("GITHUB_RUN_ATTEMPT"),
    runId: positiveIntegerEnvironment("GITHUB_RUN_ID"),
    workflowSha,
  });

  expect(evidence.contractSha256).toBe(
    `sha256:${createHash("sha256").update(contractBytes).digest("hex")}`,
  );
  expect(evidence.contracts).toEqual(contracts);
});
