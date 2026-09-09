// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS } from "../../../tools/e2e/staging-launchable-timeout-contract.mts";
import { BrevLaunchableFixture } from "../fixtures/brev-launchable.ts";
import { test } from "../fixtures/e2e-test.ts";

const CONTROL_PLANE_TEST_TIMEOUT_MS = 45 * 60_000;

test(
  "creates the issue 9880 staging Launchable workspace and records its identity",
  {
    timeout: CONTROL_PLANE_TEST_TIMEOUT_MS,
    meta: {
      e2eCleanupTimeoutMs: ISSUE_9880_STAGING_LAUNCHABLE_CLEANUP_TIMEOUT_MS,
      e2ePhases: [
        "resolve the latest staging handoff",
        "create the issue workspace",
        "record the control-plane checkpoint",
      ],
    },
  },
  async ({ artifacts, cleanup, host, progress, secrets }) => {
    const brevLaunchable = new BrevLaunchableFixture({ artifacts, host, secrets });
    const launchableId = secrets.required("BREV_LAUNCHABLE_ID");
    const name = `issue-9880-${randomUUID().slice(0, 8)}`;
    const handoff = await brevLaunchable.resolveLatestStagingHandoff();

    progress.phase("create the issue workspace");
    const ownership = brevLaunchable.ownership(name);
    cleanup.add(`delete Brev workspace ${name}`, () => brevLaunchable.delete(ownership));
    const workspace = await brevLaunchable.create(ownership, launchableId);

    progress.phase("record the control-plane checkpoint");
    await artifacts.writeJson("issue-9880-control-plane-checkpoint.json", {
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      launchableId,
      producerRunId: handoff.producerRunId,
      candidateSha: handoff.nemoclawSha,
      imageRepositorySha: handoff.imageRepositorySha,
      bootImage: handoff.bootImage,
    });
    await artifacts.target.complete({
      id: "issue-9880-staging-launchable",
      classification: "control-plane-checkpoint-passed",
    });
  },
);
