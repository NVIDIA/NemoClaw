// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { liveTargetTimeoutContract } from "../../../tools/e2e/onboard-timeout-contract.mts";
import { testTimeout } from "../../helpers/timeouts.ts";
import { expect, test } from "../fixtures/e2e-test.ts";
import { HOSTED_INFERENCE_SECRET } from "../fixtures/hosted-inference.ts";
import { CLI_DIST_ENTRYPOINT, CLI_ENTRYPOINT, REPO_ROOT } from "../fixtures/paths.ts";
import {
  dcodeInvalidCredentialRebuildOptionsFromRegistryEntry,
  type LifecycleProfile,
  readRegistrySandboxEntry,
} from "../fixtures/phases/index.ts";
import { liveTargetTestTitle } from "../registry/execution.ts";
import { listTargets, requireTargets } from "../registry/registry.ts";
import { runE2eCloudExperimentalChecks } from "./cloud-experimental-checks.ts";
import {
  captureDcodeBaseImageRuntimeEvidence,
  dcodeBaseImageReferenceForContract,
  loadDcodeBaseImagePublicationEvidence,
} from "./dcode-base-image-runtime-evidence.ts";
import { buildLiveTargetRunPlan } from "./run-plan.ts";

const LIFECYCLE_PROFILES: ReadonlySet<LifecycleProfile> = new Set([
  "dcode-rebuild-invalid-credential",
]);

function isLifecycleProfile(value: string | undefined): value is LifecycleProfile {
  return value !== undefined && LIFECYCLE_PROFILES.has(value as LifecycleProfile);
}

const E2E_CLOUD_EXPERIMENTAL_CHECKS_DIR = path.join(
  REPO_ROOT,
  "test/e2e/e2e-cloud-experimental/checks",
);
process.env.NEMOCLAW_CLI_BIN ??= CLI_ENTRYPOINT;

// The workflow filters by the stable target ID prefix via `-t "^${TARGET_ID}:"`.
const SELECTED_TARGET_ID = process.env.TARGET_ID;
// That selector matches nothing when the ID names no registered target, and an
// empty ID builds the selector `-t "^$"`, which also matches nothing. Vitest
// then filters every test out and the run exits 0, reporting success for a run
// that executed no target. `generate-matrix` already rejects an unknown ID
// before the dispatch reaches here, so this is the last-mile check for a run
// that sets TARGET_ID some other way. Resolve the ID through the registry and
// let it name the registered choices (#8286).
const SELECTED_TARGET_IDS = [SELECTED_TARGET_ID].filter(
  (targetId): targetId is string => targetId !== undefined,
);
requireTargets(SELECTED_TARGET_IDS);
const REGISTRY_TARGET_PHASES = [
  "resolve the target contract and run plan",
  "confirm the target environment is ready",
  "prepare the target lifecycle prerequisites",
  "onboard the registry-selected sandbox",
  "execute the target lifecycle boundary",
  "verify the expected sandbox state",
  "validate the exported sandbox configuration",
  "run target-specific cloud checks",
  "record target completion evidence",
] as const;

for (const [targetIndex, target] of listTargets().entries()) {
  const timeoutContract = liveTargetTimeoutContract(
    target.environment.lifecycle,
    target.configExport.expectation,
  );

  test(
    liveTargetTestTitle(target),
    {
      meta: {
        e2eArtifactRootId: target.id,
        e2ePhases: REGISTRY_TARGET_PHASES,
      },
      ...(timeoutContract.testTimeoutMs === undefined
        ? {}
        : { timeout: testTimeout(timeoutContract.testTimeoutMs) }),
    },
    async ({
      artifacts,
      configExportValidation,
      environment,
      host,
      lifecycle,
      onboard,
      progress,
      secrets,
      stateValidation,
    }) => {
      const dcodeBaseContract = loadDcodeBaseImagePublicationEvidence(
        target.id,
        artifacts.pathFor("dcode-base-image.json"),
      );
      const dcodeBaseImageReference = dcodeBaseContract
        ? dcodeBaseImageReferenceForContract(dcodeBaseContract)
        : undefined;
      target.requiredSecrets.forEach((secret) => secrets.required(secret));

      expect(
        fs.existsSync(CLI_DIST_ENTRYPOINT),
        "run `npm run build:cli` before live repo CLI targets",
      ).toBe(true);
      await artifacts.target.declare({
        id: target.id,
        boundary: "typed-registry",
        pendingRuntimeSuites: target.suiteIds,
      });

      const runPlan = buildLiveTargetRunPlan(target);
      await artifacts.writeJson("run-plan.json", runPlan);

      progress.phase("confirm the target environment is ready");
      const ready = await environment.assertReady(target.environment);
      const profile = target.environment.lifecycle;
      const lifecycleProfile = isLifecycleProfile(profile) ? profile : undefined;
      if (profile && !lifecycleProfile) {
        throw new Error(
          `target '${target.id}' declares lifecycle '${profile}' which is not ` +
            `dispatched by LifecyclePhaseFixture; update the fixture and the ` +
            `SUPPORTED_LIFECYCLES whitelist together.`,
        );
      }
      progress.phase("prepare the target lifecycle prerequisites");
      progress.phase("onboard the registry-selected sandbox");
      const instance = await onboard.from(ready, {
        sandboxName: `e2e-reg-${targetIndex.toString(36)}`,
        dcodeBaseImageReference,
        ...(timeoutContract.commandTimeoutMs === undefined
          ? {}
          : { timeoutMs: timeoutContract.commandTimeoutMs }),
      });

      // Lifecycle phase runs between onboard and state-validation.
      // Targets opt in by setting `environment.lifecycle` to a
      // whitelisted profile. Profiles dispatch through LifecyclePhaseFixture
      // before state validation.
      let lifecycleResult: Awaited<ReturnType<typeof lifecycle.simulate>> | undefined;
      // Every registry target crosses the optional lifecycle boundary before
      // state validation.
      progress.phase("execute the target lifecycle boundary");
      if (lifecycleProfile) {
        lifecycleResult =
          lifecycleProfile === "dcode-rebuild-invalid-credential"
            ? await lifecycle.simulate(
                lifecycleProfile,
                instance,
                dcodeInvalidCredentialRebuildOptionsFromRegistryEntry(
                  readRegistrySandboxEntry(instance.sandboxName),
                  secrets.required(HOSTED_INFERENCE_SECRET),
                ),
              )
            : await lifecycle.simulate(lifecycleProfile, instance);
      }

      progress.phase("verify the expected sandbox state");
      const validation = await stateValidation.from(target.expectedStateId, instance);

      progress.phase("validate the exported sandbox configuration");
      const configExport = await configExportValidation.from(target, instance);

      progress.phase("run target-specific cloud checks");
      const checkScripts = runPlan.e2eCloudExperimentalChecks ?? [];
      expect(fs.existsSync(E2E_CLOUD_EXPERIMENTAL_CHECKS_DIR)).toBe(true);
      await runE2eCloudExperimentalChecks(target.id, instance.sandboxName, checkScripts, {
        artifacts,
        dcodeBaseImageReference,
        host,
        secrets,
      });

      progress.phase("record target completion evidence");
      const dcodeBaseImage = dcodeBaseContract
        ? captureDcodeBaseImageRuntimeEvidence(dcodeBaseContract, instance.sandboxName)
        : undefined;
      await artifacts.target.complete({
        id: target.id,
        expectedStateId: validation.state.id,
        probes: validation.probes.map((probe) => probe.id),
        configExport: {
          expectation: configExport.expectation,
          classification: configExport.classification,
          contract: configExport.contract,
          elapsedMs: configExport.elapsedMs,
        },
        pendingRuntimeSuites: target.suiteIds,
        dcodeBaseImage,
        lifecycle: lifecycleResult
          ? { profile: lifecycleResult.profile, steps: lifecycleResult.steps.map((s) => s.id) }
          : undefined,
      });
    },
  );
}
