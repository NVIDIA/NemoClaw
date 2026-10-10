// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { test } from "node:test";
import { comparisonPlan, summarizeComparison } from "./comparison-plan.mts";
const command = {
  executable: "C:\\tools\\driver.exe",
  sha256: "a".repeat(64),
  source: "b".repeat(40),
  args: ["{{caseDirectory}}", "{{sampleKind}}"],
  timeoutMs: 300000,
};
const variant = { setup: command, launch: command, idle: { ...command, timeoutMs: 120000 } };
const input = {
  baseline: variant,
  candidate: variant,
  artifactDirectory: "C:\\evidence",
  installRoot: "C:\\Program Files\\NVIDIA\\NemoClaw",
  upgradeSupported: false,
};
test("orders exact variants ABBA and preserves cold/warm/idle distinctions", () => {
  const plan = comparisonPlan(input);
  assert.deepEqual(plan.comparisonOrder, ["baseline", "candidate", "candidate", "baseline"]);
  assert.equal(plan.cases.length, 28);
  assert.equal(plan.cases.filter((row) => row.sampleKind === "process-cold").length, 4);
  assert.equal(plan.cases.filter((row) => row.sampleKind === "warm").length, 4);
  assert.equal(plan.cases.filter((row) => row.sampleKind === "warm-repeat").length, 4);
  assert.equal(plan.cases.filter((row) => row.sampleKind === "idle").length, 4);
  assert.deepEqual(plan.cases[1].args, [
    "C:\\evidence\\round1-baseline-process-cold",
    "process-cold",
  ]);
  assert.equal(plan.osCacheColdClaimed, false);
  assert.match(plan.upgradeMetric, /unavailable/u);
});
test("adds only a supported forward upgrade after cleanly uninstalled ABBA rounds", () => {
  const plan = comparisonPlan({ ...input, upgradeSupported: true });
  assert.equal(plan.cases.length, 31);
  assert.deepEqual(
    plan.cases.slice(-3).map((row) => row.action),
    ["install", "upgrade", "uninstall"],
  );
  assert.deepEqual(plan.cases.at(-2)?.args, [
    "/install",
    "/quiet",
    "/norestart",
    "/log",
    "C:\\evidence\\upgrade-candidate\\setup.log",
  ]);
});
test("rejects a driver bound to the wrong installed source", () => {
  assert.throws(
    () =>
      comparisonPlan({
        ...input,
        baseline: { ...variant, launch: { ...command, source: "c".repeat(40) } },
      }),
    /same installed source/u,
  );
});
test("keeps failed and diagnostic observations out of ordinary timing arrays", () => {
  const pass = {
    variant: "baseline",
    action: "launch",
    sampleKind: "warm",
    elapsedMs: 15,
    exitCode: 0,
    timedOut: false,
    instrumentation: { mode: "none" },
    firstConfigurationLog: null,
  };
  const summary = summarizeComparison({
    status: "failed",
    cases: [
      pass,
      { ...pass, exitCode: 23 },
      { ...pass, timedOut: true },
      { ...pass, instrumentation: { mode: "traced" } },
    ],
  });
  assert.deepEqual(summary.groups["baseline/launch/warm"], {
    commandCompletedMs: [15],
    firstConfigurationLogMs: [],
  });
  assert.equal(summary.allCasesCompleted, false);
  assert.equal(summary.original142SecondEndpointReproduced, false);
});
