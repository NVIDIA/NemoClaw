// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS } from "../../../tools/e2e/staging-launchable-timeout-contract.mts";
import { BrevLaunchableFixture } from "../fixtures/brev-launchable.ts";
import { test } from "../fixtures/e2e-test.ts";

const REMOTE_EXECUTION_READINESS_TEST_TIMEOUT_MS = 60 * 60_000;

test(
  "creates the staging Launchable workspace and proves remote execution readiness",
  {
    timeout: REMOTE_EXECUTION_READINESS_TEST_TIMEOUT_MS,
    meta: {
      e2eCleanupTimeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS,
      e2ePhases: [
        "resolve the latest staging handoff",
        "create the staging workspace",
        "prove remote execution readiness",
        "record remote execution readiness",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, secrets }) => {
    const brevLaunchable = new BrevLaunchableFixture({ artifacts, host, secrets });
    const launchableId = secrets.required("BREV_LAUNCHABLE_ID");
    const name = `staging-full-${randomUUID().slice(0, 8)}`;
    const handoff = await brevLaunchable.resolveLatestStagingHandoff();

    progress.phase("create the staging workspace");
    const ownership = brevLaunchable.ownership(name);
    cleanup.add(`delete Brev workspace ${name}`, () => brevLaunchable.delete(ownership));
    const workspace = await brevLaunchable.create(ownership, launchableId);

    progress.phase("prove remote execution readiness");
    await brevLaunchable.waitForExec(ownership);

    progress.phase("record remote execution readiness");
    await artifacts.writeJson("staging-launchable-remote-execution-readiness.json", {
      bootImage: handoff.bootImage,
      candidateSha: handoff.nemoclawSha,
      imageRepositorySha: handoff.imageRepositorySha,
      launchableId,
      producerRunId: handoff.producerRunId,
      remoteExecutionReady: true,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
    });
    await artifacts.target.complete({
      id: "staging-launchable-full",
      classification: "remote-execution-ready",
    });
  },
);
