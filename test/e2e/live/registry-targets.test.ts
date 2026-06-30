// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, test } from "../fixtures/e2e-test.ts";
import type { LifecycleProfile } from "../fixtures/phases/index.ts";
import { listTargets } from "../registry/registry.ts";
import { liveTargetSupport, liveTargetTestName } from "../registry/runtime-support.ts";
import { cloudExperimentalChecksForOnboarding } from "./cloud-experimental-check-list.ts";
import { runE2eCloudExperimentalChecks } from "./cloud-experimental-checks.ts";
import { buildLiveTargetRunPlan } from "./run-plan.ts";

const LIFECYCLE_PROFILES: ReadonlySet<LifecycleProfile> = new Set(["post-reboot-recovery"]);

function isLifecycleProfile(value: string | undefined): value is LifecycleProfile {
  return value !== undefined && LIFECYCLE_PROFILES.has(value as LifecycleProfile);
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const E2E_CLOUD_EXPERIMENTAL_CHECKS_DIR = path.join(
  REPO_ROOT,
  "test/e2e/e2e-cloud-experimental/checks",
);
process.env.NEMOCLAW_CLI_BIN ??= path.join(REPO_ROOT, "bin", "nemoclaw.js");

// The workflow filters by exact target id via `-t "^${TARGET_ID}$"`.
// When that env is set, surface the structured `[not wired]` reason for the
// targeted unsupported target at module load so the job log/summary
// captures it before vitest reports the skipped test by id.
const SELECTED_TARGET_ID = process.env.TARGET_ID;

for (const target of listTargets()) {
  const support = liveTargetSupport(target);
  if (!support.supported) {
    if (SELECTED_TARGET_ID === target.id) {
      console.warn(`[not wired] ${target.id}: ${support.reasons.join("; ")}`);
    }
    test.skip(liveTargetTestName(target), () => {});
    continue;
  }

  test(
    liveTargetTestName(target),
    async ({ artifacts, environment, host, lifecycle, onboard, secrets, stateValidation }) => {
      for (const secret of target.requiredSecrets ?? []) {
        secrets.required(secret);
      }

      expect(
        fs.existsSync(CLI_DIST_ENTRYPOINT),
        "run `npm run build:cli` before live repo CLI targets",
      ).toBe(true);
      if (!target.environment) {
        throw new Error(`target '${target.id}' is missing environment`);
      }
      if (!target.expectedStateId) {
        throw new Error(`target '${target.id}' is missing expectedStateId`);
      }

      await artifacts.writeJson("target.json", {
        id: target.id,
        runner: "vitest",
        boundary: "typed-registry",
        pendingRuntimeSuites: support.pendingRuntimeSuites,
      });

      const runPlan = buildLiveTargetRunPlan(target);
      await artifacts.writeJson("run-plan.json", runPlan);

      const ready = await environment.assertReady(target.environment);
      const instance = await onboard.from(ready, { sandboxName: `e2e-${target.id}` });

      // Lifecycle phase runs between onboard and state-validation.
      // Targets opt in by setting `environment.lifecycle` to a
      // whitelisted profile (see SUPPORTED_LIFECYCLES in
      // runtime-support.ts). Today only `post-reboot-recovery` is
      // wired, and it dispatches through `LifecyclePhaseFixture` to
      // `docker stop` the labeled sandbox container and invoke
      // `nemoclaw <name> status` before the state-validation probes
      // assert host-side preservation invariants. The gateway is
      // left healthy; see `definitions/baseline.ts` and the fixture
      // doc for why a real gateway restart can't be expressed from
      // `ubuntu-latest`.
      let lifecycleResult: Awaited<ReturnType<typeof lifecycle.simulate>> | undefined;
      const profile = target.environment.lifecycle;
      if (profile) {
        if (!isLifecycleProfile(profile)) {
          throw new Error(
            `target '${target.id}' declares lifecycle '${profile}' which is not ` +
              `dispatched by LifecyclePhaseFixture; update the fixture and the ` +
              `SUPPORTED_LIFECYCLES whitelist together.`,
          );
        }
        lifecycleResult = await lifecycle.simulate(profile, instance);
      }

      const validation = await stateValidation.from(target.expectedStateId, instance);

      const checkScripts = runPlan.e2eCloudExperimentalChecks ?? [];
      expect(checkScripts).toEqual(
        cloudExperimentalChecksForOnboarding(target.environment.onboarding),
      );
      for (const scriptPath of checkScripts) {
        expect(fs.existsSync(path.join(REPO_ROOT, scriptPath))).toBe(true);
      }
      expect(fs.existsSync(E2E_CLOUD_EXPERIMENTAL_CHECKS_DIR)).toBe(true);
      await runE2eCloudExperimentalChecks(target.id, instance.sandboxName, checkScripts, {
        artifacts,
        host,
        secrets,
      });

      await artifacts.writeJson("target-result.json", {
        id: target.id,
        expectedStateId: validation.state.id,
        probes: validation.probes.map((probe) => probe.id),
        pendingRuntimeSuites: support.pendingRuntimeSuites,
        lifecycle: lifecycleResult
          ? { profile: lifecycleResult.profile, steps: lifecycleResult.steps.map((s) => s.id) }
          : undefined,
      });
    },
  );
}
