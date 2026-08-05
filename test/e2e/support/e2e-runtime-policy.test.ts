// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  assertLiveE2ERuntimePolicy,
  E2E_RUNTIME_POLICY_ERROR_PREFIX,
  readLiveE2ERuntimePolicyInventory,
  validateLiveE2ERuntimePolicy,
} from "../../../tools/e2e/runtime-policy.mts";
import { REPO_ROOT } from "../fixtures/paths.ts";
import { LIVE_E2E_RUNTIME_POLICY, type LiveE2ERuntimePolicy } from "../runtime-policy.ts";

const POLICY_DATE = new Date("2026-07-30T12:00:00Z");

function policyFixture(): LiveE2ERuntimePolicy {
  return structuredClone(LIVE_E2E_RUNTIME_POLICY);
}

function validate(policy: LiveE2ERuntimePolicy): string[] {
  return validateLiveE2ERuntimePolicy(policy, { today: POLICY_DATE });
}

describe("live E2E runtime policy (#7922)", () => {
  it("covers the exact retained registry and workflow inventory within planning goals", () => {
    expect(validate(LIVE_E2E_RUNTIME_POLICY)).toEqual([]);
    expect(LIVE_E2E_RUNTIME_POLICY.coverage).toHaveLength(96);

    const nightly = LIVE_E2E_RUNTIME_POLICY.coverage.filter(
      (entry) => entry.tier === "pr" || entry.tier === "nightly",
    );
    expect(nightly).toHaveLength(15);
    expect(nightly.reduce((total, entry) => total + entry.expectedRunnerMinutes, 0)).toBe(121);
  });

  it("rejects a newly admitted live target without policy metadata", () => {
    const inventory = readLiveE2ERuntimePolicyInventory();
    inventory.workflowTargetIds.push("new-live-boundary");

    expect(
      validateLiveE2ERuntimePolicy(LIVE_E2E_RUNTIME_POLICY, {
        inventory,
        today: POLICY_DATE,
      }),
    ).toContain("live coverage is missing runtime policy metadata: new-live-boundary");
  });

  it("rejects stale, duplicate, and wrongly classified policy entries", () => {
    const policy = policyFixture();
    const duplicate = structuredClone(policy.coverage[0]!);
    duplicate.kind = duplicate.kind === "registry-target" ? "workflow-target" : "registry-target";
    policy.coverage.push(duplicate, { ...duplicate, id: "removed-live-boundary" });

    expect(validate(policy)).toEqual(
      expect.arrayContaining([
        `policy repeats coverage id ${duplicate.id}`,
        `${duplicate.id} must use kind ${
          duplicate.kind === "registry-target" ? "workflow-target" : "registry-target"
        }`,
        "runtime policy contains unknown live coverage: removed-live-boundary",
      ]),
    );
  });

  it("rejects incomplete admission, runtime, evidence, ownership, and review metadata", () => {
    const policy = policyFixture();
    const entry = policy.coverage.find((candidate) => candidate.id === "cloud-inference")!;
    entry.uniqueBoundary = undefined as never;
    entry.expectedRuntimeMinutes = 16;
    entry.budgetMinutes = 15;
    entry.expectedRunnerMinutes = 1;
    entry.runnerClass = "unknown" as never;
    entry.owningFiles = [];
    entry.requiredTelemetry = [];
    entry.requiredArtifacts = [];
    entry.reviewCondition = undefined as never;

    expect(validate(policy)).toEqual(
      expect.arrayContaining([
        "cloud-inference must state one concrete unique live boundary",
        "cloud-inference has an unknown runner class",
        "cloud-inference expected runtime exceeds its budget",
        "cloud-inference expected runner consumption is below wall runtime",
        "cloud-inference must map at least one owning file",
        "cloud-inference required telemetry must declare at least one value",
        "cloud-inference required artifacts must declare at least one value",
        "cloud-inference must declare a review, consolidation, or retirement condition",
      ]),
    );
  });

  it("rejects a live boundary claimed by more than one coverage entry", () => {
    const policy = policyFixture();
    policy.coverage[1]!.uniqueBoundary = policy.coverage[0]!.uniqueBoundary;

    expect(validate(policy)).toContain(
      `multiple coverage entries share the unique boundary: ${policy.coverage[0]!.uniqueBoundary}`,
    );
  });

  it("requires rationale and a live expiry or review condition for exceptions", () => {
    const policy = policyFixture();
    const entry = policy.coverage.find(
      (candidate) => candidate.id === "llama-cpp-dgx-spark-qualification",
    )!;
    entry.exception = {
      rationale: "short",
      expiresOn: "2026-07-01",
      reviewCondition: "short",
    };

    expect(validate(policy)).toEqual(
      expect.arrayContaining([
        "llama-cpp-dgx-spark-qualification exception rationale must explain the deviation",
        "llama-cpp-dgx-spark-qualification exception expired on 2026-07-01",
        "llama-cpp-dgx-spark-qualification exception must declare a concrete review condition",
      ]),
    );
  });

  it("accepts a measured baseline without a provisional exception", () => {
    const policy = policyFixture();
    policy.baseline.status = "measured";
    delete policy.baseline.exception;

    expect(validate(policy)).toEqual([]);
  });

  it("enforces the PR, nightly, weekly, and runner-minute ceilings", () => {
    const policy = policyFixture();
    policy.baseline.goals.prWallMinutes = 16;
    policy.baseline.goals.nightlyWallMinutes = 21;
    policy.baseline.goals.nightlyRunnerMinutes = 300;
    policy.baseline.goals.weeklyWallMinutes = 46;
    const release = policy.coverage.find((entry) => entry.id === "staging-brev-launchable")!;
    release.tier = "nightly";

    expect(validate(policy)).toEqual(
      expect.arrayContaining([
        "PR wall-time goal must be 15 minutes or less",
        "nightly wall-time goal must be 20 minutes or less",
        "nightly runner-minute goal must be below 300",
        "weekly wall-time goal must be 45 minutes or less",
        "staging-brev-launchable nightly budget exceeds 20 minutes",
        "PR and nightly tiers must contain 10 to 15 retained live journeys",
      ]),
    );
  });

  it("labels policy failures separately from live target failures", () => {
    const policy = policyFixture();
    policy.coverage = policy.coverage.filter((entry) => entry.id !== "cloud-onboard");

    expect(() => assertLiveE2ERuntimePolicy(policy, { today: POLICY_DATE })).toThrowError(
      new RegExp(
        `^${E2E_RUNTIME_POLICY_ERROR_PREFIX}:\\n- live coverage is missing runtime policy metadata: cloud-onboard`,
      ),
    );
  });

  it("runs as a dedicated fast repository check without invoking live E2E", () => {
    const result = spawnSync(
      path.join(REPO_ROOT, "node_modules", ".bin", "tsx"),
      [path.join(REPO_ROOT, "tools", "e2e", "runtime-policy.mts")],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        timeout: 30_000,
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "E2E runtime policy validation passed: 96 coverage items, 15 PR/nightly items, 121 planned runner-minutes.",
    );
    expect(result.stdout).not.toContain("RUN  v");
  });
});
