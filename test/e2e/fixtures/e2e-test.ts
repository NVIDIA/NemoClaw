// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import { test as base, expect } from "vitest";

import {
  appendResourcePhaseBaseline,
  collectResourceSnapshot,
} from "../../../tools/e2e/runner-pressure.mts";
import { renderSnapshotLine } from "../../../tools/e2e/runner-pressure-core.mts";

import { type ArtifactSink, createArtifactSink } from "./artifacts.ts";
import { assertCleanupPassed, CleanupRegistry } from "./cleanup.ts";
import {
  GatewayClient,
  HostCliClient,
  ProviderClient,
  SandboxClient,
  StateClient,
} from "./clients/index.ts";
import { DockerPrerequisite, DockerProbe } from "./docker-probe.ts";
import { createE2EInferenceAdapter, type E2EInferenceAdapter } from "./inference-adapter.ts";
import {
  EnvironmentPhaseFixture,
  LifecyclePhaseFixture,
  OnboardingPhaseFixture,
  RuntimePhaseFixture,
  StateValidationPhaseFixture,
} from "./phases/index.ts";
import { type ProgressPhaseOutcome, startTestProgress, type TestProgress } from "./progress.ts";
import { SecretStore } from "./secrets.ts";
import { ShellProbe } from "./shell-probe.ts";

declare module "@vitest/runner" {
  interface TaskMeta {
    e2ePhases?: readonly string[];
  }
}

export interface E2ETargetFixtures {
  artifacts: ArtifactSink;
  cleanup: CleanupRegistry;
  secrets: SecretStore;
  docker: DockerPrerequisite;
  shellProbe: ShellProbe;
  host: HostCliClient;
  gateway: GatewayClient;
  sandbox: SandboxClient;
  provider: ProviderClient;
  inference: E2EInferenceAdapter;
  state: StateClient;
  environment: EnvironmentPhaseFixture;
  onboard: OnboardingPhaseFixture;
  lifecycle: LifecyclePhaseFixture;
  runtime: RuntimePhaseFixture;
  stateValidation: StateValidationPhaseFixture;
  progress: TestProgress;
}

const SUPPORT_PHASES = [
  "exercise E2E fixture support",
  "record E2E fixture support outcome",
] as const;
export const E2E_TEARDOWN_PHASE = "release registered E2E resources";

export function resourcePhaseLabel(targetId: string, phase: string): string {
  const slug = (value: string, fallback: string) =>
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || fallback;
  const fullLabel = `${slug(targetId, "target")}.${slug(phase, "phase")}`;
  if (fullLabel.length <= 64) return fullLabel;

  const digest = createHash("sha256")
    .update(targetId)
    .update("\0")
    .update(phase)
    .digest("hex")
    .slice(0, 12);
  const prefix = fullLabel.slice(0, 64 - digest.length - 1).replace(/[._-]+$/gu, "");
  return `${prefix}.${digest}`;
}

function taskOutcomeForState(state: string | undefined): ProgressPhaseOutcome | undefined {
  return state === "fail" ? "failed" : state === "skip" ? "skipped" : undefined;
}

function outcomeForTaskState(state: string | undefined): ProgressPhaseOutcome {
  return taskOutcomeForState(state) ?? "passed";
}

export const test = base.extend<E2ETargetFixtures>({
  secrets: async ({ skip }, use) => {
    await use(new SecretStore(process.env, skip));
  },
  artifacts: async ({ task, secrets }, use) => {
    const artifacts = createArtifactSink(task.name, process.cwd(), secrets.redactionValues());
    await artifacts.ensureRoot();
    try {
      await use(artifacts);
    } finally {
      await artifacts.writeJson("artifact-summary.json", {
        test: task.name,
        rootDir: artifacts.rootDir,
      });
    }
  },
  progress: [
    async ({ artifacts, onTestFinished, secrets, task }, use) => {
      const targetId = process.env.E2E_TARGET_ID || process.env.GITHUB_JOB;
      const shardId = process.env.NEMOCLAW_E2E_SHARD;
      const baselinePath = process.env.E2E_RESOURCE_PHASE_BASELINES_FILE;
      const phasePlan = task.meta.e2ePhases;
      assert.ok(
        task.file.projectName !== "e2e-live" || phasePlan,
        `live E2E test is missing semantic phase metadata: ${task.name}`,
      );
      const declaredPhasePlan = phasePlan ?? SUPPORT_PHASES;
      const declaredFinalPhase = declaredPhasePlan.at(-1) as string;
      const progress = startTestProgress(task.name, declaredPhasePlan, {
        targetId,
        terminalPhase: E2E_TEARDOWN_PHASE,
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
                // Keep fixture and support tests quiet; live runs need phase progress.
              },
        ...(targetId && baselinePath
          ? {
              sampleResourceEvidence: (phase: string) =>
                renderSnapshotLine(collectResourceSnapshot(resourcePhaseLabel(targetId, phase))),
              recordResourceBaseline: (phase: string) =>
                appendResourcePhaseBaseline(baselinePath, resourcePhaseLabel(targetId, phase)),
            }
          : {}),
      });
      const completeSupportPlan = phasePlan
        ? () => undefined
        : () => {
            if (!progress.isComplete()) progress.phase(SUPPORT_PHASES[1]);
          };
      let finalized = false;
      onTestFinished(async () => {
        if (finalized) return;
        finalized = true;
        const outcome = outcomeForTaskState(task.result?.state);
        completeSupportPlan();
        const completedPhasePlan = !phasePlan || progress.hasReached(declaredFinalPhase);
        if (!progress.isComplete()) progress.phase(E2E_TEARDOWN_PHASE);
        const phaseOutcome = outcome === "passed" && !completedPhasePlan ? "failed" : outcome;
        progress.stop(phaseOutcome);
        await artifacts.writeJson("test-progress.json", {
          ...progress.summary(),
          ...(targetId ? { targetId } : {}),
          ...(shardId ? { shardId } : {}),
        });
        assert.ok(
          outcome !== "passed" || completedPhasePlan,
          `live E2E test did not reach its final semantic phase: ${task.name}`,
        );
      });
      await use(progress);
    },
    { auto: true },
  ],
  docker: async ({ artifacts, cleanup, progress, secrets, skip }, use) => {
    const probe = new DockerProbe(
      artifacts,
      (text, extra) => secrets.redact(text, extra),
      undefined,
      progress,
      () => cleanup.currentSignal(),
    );
    await use(new DockerPrerequisite(probe, skip));
  },
  cleanup: async ({ artifacts, progress, secrets, signal }, use) => {
    const cleanup = new CleanupRegistry((text) => secrets.redact(text), progress, {
      testSignal: signal,
    });
    try {
      await use(cleanup);
    } finally {
      progress.phase(E2E_TEARDOWN_PHASE);
      const result = await cleanup.runAll();
      await artifacts.writeJson("cleanup.json", result);
      assertCleanupPassed(result);
    }
  },
  shellProbe: async ({ artifacts, cleanup, progress, secrets }, use) => {
    await use(
      new ShellProbe({
        artifacts,
        progress,
        redact: (text, extraValues) => secrets.redact(text, extraValues),
        signal: () => cleanup.currentSignal(),
      }),
    );
  },
  host: async ({ shellProbe }, use) => {
    await use(new HostCliClient(shellProbe));
  },
  sandbox: async ({ shellProbe }, use) => {
    await use(new SandboxClient(shellProbe));
  },
  gateway: async ({ host, sandbox }, use) => {
    // GatewayClient depends on `sandbox` for in-sandbox probes
    // (guard-chain inspection, log tailing, gateway-PID polling).
    // The fixture chain is sandbox → gateway so the dependency stays acyclic.
    await use(new GatewayClient(host, sandbox));
  },
  provider: async ({ shellProbe }, use) => {
    await use(new ProviderClient(shellProbe));
  },
  inference: async ({ artifacts, progress, provider, secrets }, use) => {
    const inference = await createE2EInferenceAdapter({ artifacts, progress, provider, secrets });
    try {
      await use(inference);
    } finally {
      await inference.close();
    }
  },
  state: async ({}, use) => {
    await use(new StateClient());
  },
  environment: async ({ artifacts, host }, use) => {
    await use(new EnvironmentPhaseFixture(host, artifacts));
  },
  onboard: async ({ artifacts, cleanup, host, secrets }, use) => {
    await use(new OnboardingPhaseFixture(host, secrets, cleanup, artifacts));
  },
  lifecycle: async ({ cleanup, gateway, host, sandbox }, use) => {
    await use(new LifecyclePhaseFixture(host, sandbox, cleanup, gateway));
  },
  runtime: async ({ provider, sandbox }, use) => {
    await use(new RuntimePhaseFixture(sandbox, provider));
  },
  stateValidation: async ({ artifacts, host, gateway, sandbox }, use) => {
    await use(new StateValidationPhaseFixture(host, gateway, sandbox, {}, artifacts));
  },
});

export { expect };
