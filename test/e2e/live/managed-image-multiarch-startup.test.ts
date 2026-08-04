// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH,
  parseProtectedManagedImageActivation,
  parseProtectedManagedImageContracts,
  parseProtectedManagedImageEvidence,
} from "../../../scripts/checks/protected-managed-image-contract.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  protectedManagedImageDispatchEnvironment,
  readRegularArtifact,
} from "./managed-image-multiarch-startup-helpers.ts";

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
  const dispatch = protectedManagedImageDispatchEnvironment();

  const activationPath = path.join(dispatch.workspace, PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH);
  const activationStatus = fs.lstatSync(activationPath);
  expect(activationStatus.isFile()).toBe(true);
  expect(activationStatus.isSymbolicLink()).toBe(false);
  parseProtectedManagedImageActivation(JSON.parse(fs.readFileSync(activationPath, "utf8")));

  progress.phase("validate exact all-agent managed-image contracts");
  const contractBytes = readRegularArtifact(dispatch.contractFile, dispatch.artifactDirectory);
  const evidenceBytes = readRegularArtifact(dispatch.evidenceFile, dispatch.artifactDirectory);
  const contracts = parseProtectedManagedImageContracts(
    JSON.parse(contractBytes.toString("utf8")),
    dispatch.platform,
  );

  progress.phase("validate direct-start evidence binding");
  const evidence = parseProtectedManagedImageEvidence(JSON.parse(evidenceBytes.toString("utf8")), {
    baseSha: dispatch.baseSha,
    cohort: dispatch.cohort,
    headSha: dispatch.headSha,
    platform: dispatch.platform,
    runAttempt: dispatch.runAttempt,
    runId: dispatch.runId,
    workflowSha: dispatch.workflowSha,
  });

  expect(evidence.contractSha256).toBe(
    `sha256:${createHash("sha256").update(contractBytes).digest("hex")}`,
  );
  expect(evidence.contracts).toEqual(contracts);
});
