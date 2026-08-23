// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from "node:crypto";

import { STAGING_LAUNCHABLE_FULL_TEST_TIMEOUT_MS } from "../../../tools/e2e/staging-launchable-timeout-contract.mts";
import { resultText } from "../fixtures/clients/command.ts";
import { expect, test } from "../fixtures/e2e-test.ts";

test(
  "staging Launchable runs the baked full E2E scenario",
  {
    timeout: STAGING_LAUNCHABLE_FULL_TEST_TIMEOUT_MS,
    meta: {
      e2ePhases: [
        "resolve the latest staging handoff",
        "create and verify the staging workspace",
        "run the baked full E2E scenario",
        "record the full scenario result",
      ],
    },
  },
  async ({ artifacts, brevLaunchable, cleanup, progress, secrets }) => {
    const launchableId = secrets.required("BREV_LAUNCHABLE_ID");
    const inferenceKey = secrets.required("NVIDIA_INFERENCE_API_KEY");
    const name = `staging-full-${randomUUID().slice(0, 8)}`;
    const handoff = await brevLaunchable.resolveLatestStagingHandoff();

    progress.phase("create and verify the staging workspace");
    const ownership = brevLaunchable.ownership(name);
    cleanup.add(`delete Brev workspace ${name}`, () => brevLaunchable.delete(ownership));
    const workspace = await brevLaunchable.create(ownership, launchableId);
    await brevLaunchable.waitForExec(name);
    const identity = await brevLaunchable.verifyIdentity(name, handoff);

    progress.phase("run the baked full E2E scenario");
    const script = `#!/usr/bin/env bash
set -euo pipefail
export NVIDIA_INFERENCE_API_KEY=${shellQuote(inferenceKey)}
export NEMOCLAW_SOURCE_PATH=${shellQuote(identity.sourcePath)}
cd "$NEMOCLAW_SOURCE_PATH"
test -x ./node_modules/.bin/vitest
export CI=true GITHUB_ACTIONS=true E2E_TARGET_ID=staging-brev-launchable
export NEMOCLAW_E2E_SETUP_MODE=preinstalled-launchable NEMOCLAW_RUN_LIVE_E2E=1
export E2E_ARTIFACT_DIR=/tmp/nemoclaw-staging-full-artifacts
export NEMOCLAW_MODEL="$(node /usr/local/lib/nemoclaw/launchable-config.mjs /usr/local/share/nemoclaw/launchable-agents.json openclaw cloudModel)"
export NEMOCLAW_SANDBOX_NAME=e2e-staging
./node_modules/.bin/vitest run --project e2e-live test/e2e/live/full-e2e.test.ts --silent=false --reporter=default
printf 'NEMOCLAW_FULL_E2E_PASSED\n'
`;
    const result = await brevLaunchable.execScript(name, script, {
      artifactName: "staging-launchable-full-scenario",
      captureLimitBytes: 64 * 1024,
      redactionValues: [inferenceKey],
      timeoutMs: 50 * 60_000,
    });
    expect(result.exitCode, resultText(result)).toBe(0);
    expect(result.stdout).toContain("NEMOCLAW_FULL_E2E_PASSED");

    progress.phase("record the full scenario result");
    await artifacts.target.complete({
      id: "staging-launchable-full",
      workspaceId: workspace.id,
      producerRunId: handoff.producerRunId,
      candidateSha: handoff.nemoclawSha,
    });
  },
);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
