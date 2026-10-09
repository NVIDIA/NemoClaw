// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

import {
  PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH,
  parseProtectedManagedImageActivation,
  parseProtectedManagedImageContracts,
  parseProtectedManagedImageEvidence,
} from "../../../scripts/checks/protected-managed-image-contract.ts";
import {
  dockerEngine27ReceiptDaemonName,
  dockerEngine27ReceiptIdentityArguments,
} from "../../../scripts/checks/docker-engine-27-receipt-transfer-e2e.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import {
  protectedManagedImageDispatchEnvironment,
  readRegularArtifact,
} from "./managed-image-multiarch-startup-helpers.ts";
import { trustedShellCommand } from "../fixtures/shell-probe.ts";

test(
  "binds protected all-agent direct startup to the exact multiarch dispatch (#7744)",
  {
    meta: {
      e2ePhases: [
        "validate protected activation and dispatch identity",
        "validate exact all-agent managed-image contracts",
        "validate direct-start evidence binding",
        "verify Docker Engine 27 receipt transfer",
      ],
    },
  },
  async ({ cleanup, progress, shellProbe }) => {
    progress.phase("validate protected activation and dispatch identity");
    const dispatch = protectedManagedImageDispatchEnvironment();

    const activationPath = path.join(dispatch.workspace, PROTECTED_MANAGED_IMAGE_ACTIVATION_PATH);
    const activationBytes = readRegularArtifact(activationPath, dispatch.workspace);
    parseProtectedManagedImageActivation(JSON.parse(activationBytes.toString("utf8")));

    progress.phase("validate exact all-agent managed-image contracts");
    const contractBytes = readRegularArtifact(dispatch.contractFile, dispatch.artifactDirectory);
    const evidenceBytes = readRegularArtifact(dispatch.evidenceFile, dispatch.artifactDirectory);
    const contracts = parseProtectedManagedImageContracts(
      JSON.parse(contractBytes.toString("utf8")),
      dispatch.platform,
    );
    progress.phase("validate direct-start evidence binding");
    const evidence = parseProtectedManagedImageEvidence(
      JSON.parse(evidenceBytes.toString("utf8")),
      {
        baseSha: dispatch.baseSha,
        cohort: dispatch.cohort,
        headSha: dispatch.headSha,
        platform: dispatch.platform,
        runAttempt: dispatch.runAttempt,
        runId: dispatch.runId,
        workflowSha: dispatch.workflowSha,
      },
    );

    progress.phase("verify Docker Engine 27 receipt transfer");
    const docker27DaemonName = dockerEngine27ReceiptDaemonName(
      dispatch.runId,
      dispatch.runAttempt,
      dispatch.platform,
    );
    const docker27IdentityArgs = dockerEngine27ReceiptIdentityArguments(
      dispatch.runId,
      dispatch.runAttempt,
      dispatch.platform,
    );
    cleanup.trackDisposable(`remove owned Docker Engine 27 daemon ${docker27DaemonName}`, () => {
      execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/checks/docker-engine-27-receipt-transfer-e2e.ts",
          "--cleanup-only",
          ...docker27IdentityArgs,
        ],
        {
          cwd: dispatch.workspace,
          killSignal: "SIGKILL",
          stdio: "ignore",
          timeout: 90_000,
        },
      );
    });
    const docker27Result = await shellProbe.run(
      trustedShellCommand({
        command: process.execPath,
        args: [
          "--import",
          "tsx",
          "scripts/checks/docker-engine-27-receipt-transfer-e2e.ts",
          ...docker27IdentityArgs,
        ],
        reason: "verify the Docker Engine 27 receipt archive-copy boundary",
      }),
      {
        artifactName: "docker-engine-27-receipt-transfer",
        cwd: dispatch.workspace,
        env: {
          ...(process.env.DOCKER_CONFIG ? { DOCKER_CONFIG: process.env.DOCKER_CONFIG } : {}),
          ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
        },
        timeoutMs: 30 * 60_000,
      },
    );

    expect(
      docker27Result.exitCode === 0 &&
        !docker27Result.timedOut &&
        evidence.contractSha256 ===
          `sha256:${createHash("sha256").update(contractBytes).digest("hex")}` &&
        JSON.stringify(evidence.contracts) === JSON.stringify(contracts),
    ).toBe(true);
  },
);
