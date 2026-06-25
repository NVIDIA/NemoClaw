// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect, test, type E2EScenarioFixtures } from "../fixtures/e2e-test.ts";
import type { LifecycleProfile } from "../fixtures/phases/index.ts";
import { listScenarios } from "../scenarios/registry.ts";
import { liveScenarioSupport, liveScenarioTestName } from "../scenarios/runtime-support.ts";
import { buildLiveScenarioRunPlan } from "./run-plan.ts";

const LIFECYCLE_PROFILES: ReadonlySet<LifecycleProfile> = new Set(["post-reboot-recovery"]);

function isLifecycleProfile(value: string | undefined): value is LifecycleProfile {
  return value !== undefined && LIFECYCLE_PROFILES.has(value as LifecycleProfile);
}

function commandEnv(sandboxName: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${os.homedir()}/.local/bin:${os.homedir()}/.npm-global/bin:${process.env.PATH ?? ""}`,
    NEMOCLAW_ACCEPT_THIRD_PARTY_SOFTWARE: "1",
    NEMOCLAW_NON_INTERACTIVE: "1",
    NEMOCLAW_SANDBOX_NAME: sandboxName,
    OPENSHELL_GATEWAY: "nemoclaw",
    ...extra,
  };
}

async function runE2eCloudExperimentalChecks(
  scenarioId: string,
  sandboxName: string,
  checkScripts: readonly string[],
  context: Pick<E2EScenarioFixtures, "artifacts" | "host" | "secrets">,
): Promise<void> {
  const apiKey = context.secrets.required("NVIDIA_INFERENCE_API_KEY");
  await context.artifacts.writeJson("e2e-cloud-experimental-checks.json", {
    scenarioId,
    sandboxName,
    checkScripts,
  });
  for (const scriptPath of checkScripts) {
    const result = await context.host.command("bash", [path.join(REPO_ROOT, scriptPath)], {
      artifactName: `cloud-experimental-${path.basename(scriptPath, ".sh")}`,
      cwd: REPO_ROOT,
      env: commandEnv(sandboxName, {
        CLOUD_EXPERIMENTAL_MODEL: process.env.NEMOCLAW_MODEL,
        COMPATIBLE_API_KEY: apiKey,
        NEMOCLAW_E2E_CLOUD_API_KEY_ENV: "COMPATIBLE_API_KEY",
        REPO: REPO_ROOT,
        SANDBOX_NAME: sandboxName,
      }),
      redactionValues: [apiKey],
      timeoutMs: 180_000,
    });
    expect(result.exitCode, `${scriptPath}: ${result.stdout}\n${result.stderr}`).toBe(0);
  }
}

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
const E2E_CLOUD_EXPERIMENTAL_CHECKS_DIR = path.join(
  REPO_ROOT,
  "test/e2e/e2e-cloud-experimental/checks",
);
process.env.NEMOCLAW_CLI_BIN ??= path.join(REPO_ROOT, "bin", "nemoclaw.js");

// The workflow filters by exact scenario id via `-t "^${SCENARIO_ID}$"`.
// When that env is set, surface the structured `[not wired]` reason for the
// targeted unsupported scenario at module load so the job log/summary
// captures it before vitest reports the skipped test by id.
const SELECTED_SCENARIO_ID = process.env.SCENARIO_ID;

for (const scenario of listScenarios()) {
  const support = liveScenarioSupport(scenario);
  if (!support.supported) {
    if (SELECTED_SCENARIO_ID === scenario.id) {
      console.warn(`[not wired] ${scenario.id}: ${support.reasons.join("; ")}`);
    }
    test.skip(liveScenarioTestName(scenario), () => {});
    continue;
  }

  test(
    liveScenarioTestName(scenario),
    async ({ artifacts, environment, host, lifecycle, onboard, secrets, stateValidation }) => {
      for (const secret of scenario.requiredSecrets ?? []) {
        secrets.required(secret);
      }

      expect(
        fs.existsSync(CLI_DIST_ENTRYPOINT),
        "run `npm run build:cli` before live repo CLI scenarios",
      ).toBe(true);
      if (!scenario.environment) {
        throw new Error(`scenario '${scenario.id}' is missing environment`);
      }
      if (!scenario.expectedStateId) {
        throw new Error(`scenario '${scenario.id}' is missing expectedStateId`);
      }

      await artifacts.writeJson("scenario.json", {
        id: scenario.id,
        runner: "vitest",
        boundary: "typed-registry",
        pendingRuntimeSuites: support.pendingRuntimeSuites,
      });

      await artifacts.writeJson("run-plan.json", buildLiveScenarioRunPlan(scenario));

      const ready = await environment.assertReady(scenario.environment);
      const instance = await onboard.from(ready, { sandboxName: `e2e-${scenario.id}` });

      // Lifecycle phase runs between onboard and state-validation.
      // Scenarios opt in by setting `environment.lifecycle` to a
      // whitelisted profile (see SUPPORTED_LIFECYCLES in
      // runtime-support.ts). Today only `post-reboot-recovery` is
      // wired, and it dispatches through `LifecyclePhaseFixture` to
      // `docker stop` the labeled sandbox container and invoke
      // `nemoclaw <name> status` before the state-validation probes
      // assert host-side preservation invariants. The gateway is
      // left healthy; see `scenarios/baseline.ts` and the fixture
      // doc for why a real gateway restart can't be expressed from
      // `ubuntu-latest`.
      let lifecycleResult: Awaited<ReturnType<typeof lifecycle.simulate>> | undefined;
      const profile = scenario.environment.lifecycle;
      if (profile) {
        if (!isLifecycleProfile(profile)) {
          throw new Error(
            `scenario '${scenario.id}' declares lifecycle '${profile}' which is not ` +
              `dispatched by LifecyclePhaseFixture; update the fixture and the ` +
              `SUPPORTED_LIFECYCLES whitelist together.`,
          );
        }
        lifecycleResult = await lifecycle.simulate(profile, instance);
      }

      const validation = await stateValidation.from(scenario.expectedStateId, instance);

      if (scenario.environment.onboarding === "cloud-langchain-deepagents-code") {
        const checkScripts = [
          "test/e2e/e2e-cloud-experimental/checks/05-deepagents-code-landlock-readonly.sh",
          "test/e2e/e2e-cloud-experimental/checks/06-deepagents-code-python-egress.sh",
        ];
        for (const scriptPath of checkScripts) {
          expect(fs.existsSync(path.join(REPO_ROOT, scriptPath))).toBe(true);
        }
        expect(fs.existsSync(E2E_CLOUD_EXPERIMENTAL_CHECKS_DIR)).toBe(true);
        await runE2eCloudExperimentalChecks(scenario.id, instance.sandboxName, checkScripts, {
          artifacts,
          host,
          secrets,
        });
      }

      await artifacts.writeJson("scenario-result.json", {
        id: scenario.id,
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
