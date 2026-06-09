// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import { expect, test } from "../framework/e2e-test.ts";
import { listScenarios } from "../scenarios/registry.ts";
import { liveScenarioSupport } from "../scenarios/runtime-support.ts";

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const CLI_DIST_ENTRYPOINT = path.join(REPO_ROOT, "dist", "nemoclaw.js");
process.env.NEMOCLAW_CLI_BIN ??= path.join(REPO_ROOT, "bin", "nemoclaw.js");

for (const scenario of listScenarios()) {
  const support = liveScenarioSupport(scenario);
  if (!support.supported) {
    test.skip(`${scenario.id} [not wired: ${support.reasons.join("; ")}]`, () => {});
    continue;
  }

  test(scenario.id, async ({ artifacts, environment, onboard, secrets, stateValidation }) => {
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

    const ready = await environment.assertReady(scenario.environment);
    const instance = await onboard.from(ready, { sandboxName: `e2e-${scenario.id}` });
    const validation = await stateValidation.from(scenario.expectedStateId, instance);

    await artifacts.writeJson("scenario-result.json", {
      id: scenario.id,
      expectedStateId: validation.state.id,
      probes: validation.probes.map((probe) => probe.id),
      pendingRuntimeSuites: support.pendingRuntimeSuites,
    });
  });
}
