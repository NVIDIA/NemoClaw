// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { test as base } from "vitest";

import { createArtifactSink } from "./artifacts.ts";
import { type ProgressPhaseOutcome, startTestProgress, type TestProgress } from "./progress.ts";
import { SecretStore } from "./secrets.ts";

export interface WorkflowE2ETestFixtures {
  progress: TestProgress;
}

function taskOutcomeForState(state: string | undefined): ProgressPhaseOutcome | undefined {
  return state === "fail" ? "failed" : state === "skip" ? "skipped" : undefined;
}

function outcomeForTaskState(state: string | undefined): ProgressPhaseOutcome {
  return taskOutcomeForState(state) ?? "passed";
}

/**
 * Progress fixture for credential-free integration tests selected by the E2E
 * workflow's shared job. These tests cannot use the stateful e2e-live fixture,
 * but they must publish the same semantic timeline contract when run as E2E.
 */
export const test = base.extend<WorkflowE2ETestFixtures>({
  progress: [
    async ({ onTestFinished, skip, task }, use) => {
      const secrets = new SecretStore(process.env, skip);
      const targetId = process.env.E2E_TARGET_ID || process.env.GITHUB_JOB;
      const progress = startTestProgress(task.name, "execute E2E test", {
        targetId,
        redact: (text) => secrets.redact(text),
        taskStatus: () => ({
          errorCount: task.result?.errors?.length ?? 0,
          ...(taskOutcomeForState(task.result?.state)
            ? { outcome: taskOutcomeForState(task.result?.state) }
            : {}),
        }),
        logLine:
          process.env.NEMOCLAW_RUN_LIVE_E2E === "1"
            ? (line) => process.stdout.write(`${secrets.redact(line)}\n`)
            : () => {
                // Ordinary integration runs stay quiet; the shared E2E job logs progress.
              },
      });
      let finalized = false;
      onTestFinished(async () => {
        if (finalized) return;
        finalized = true;
        const outcome = outcomeForTaskState(task.result?.state);
        progress.stop(outcome);
        if (process.env.NEMOCLAW_RUN_LIVE_E2E === "1") {
          const artifacts = createArtifactSink(task.name, process.cwd(), secrets.redactionValues());
          await artifacts.ensureRoot();
          await artifacts.writeJson("test-progress.json", {
            ...progress.summary(),
            ...(targetId ? { targetId } : {}),
            ...(process.env.NEMOCLAW_E2E_SHARD ? { shardId: process.env.NEMOCLAW_E2E_SHARD } : {}),
          });
        }
      });
      await use(progress);
    },
    { auto: true },
  ],
});
