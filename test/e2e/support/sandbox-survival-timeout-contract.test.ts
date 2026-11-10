// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { SANDBOX_REPAIR_READY_TIMEOUT_SEC } from "../../../src/lib/actions/sandbox/connect";
import { OPENCLAW_GATEWAY_STARTUP_WAIT_SECONDS } from "../../../src/lib/actions/sandbox/process-recovery";

import {
  SANDBOX_SURVIVAL_FINAL_DESTROY_TIMEOUT_MS,
  SANDBOX_SURVIVAL_FINAL_VALIDATION_BUDGET_MS,
  SANDBOX_SURVIVAL_INSTALL_TIMEOUT_MS,
  SANDBOX_SURVIVAL_LIFECYCLE_BUDGET_MS,
  SANDBOX_SURVIVAL_LIFECYCLE_WORST_CASE_MS,
  SANDBOX_SURVIVAL_MARKER_PATHS,
  SANDBOX_SURVIVAL_POST_DESTROY_LIST_TIMEOUT_MS,
  SANDBOX_SURVIVAL_POST_TEST_CLEANUP_BUDGET_MS,
  SANDBOX_SURVIVAL_PREPARATION_BUDGET_MS,
  SANDBOX_SURVIVAL_PREPARATION_WORST_CASE_MS,
  SANDBOX_SURVIVAL_READINESS_BUDGET_MS,
  SANDBOX_SURVIVAL_READINESS_WORST_CASE_MS,
  SANDBOX_SURVIVAL_RECOVER_TIMEOUT_MS,
  SANDBOX_SURVIVAL_TARGET_TIMEOUT_MINUTES,
  SANDBOX_SURVIVAL_TEST_HEADROOM_MS,
  SANDBOX_SURVIVAL_TEST_TIMEOUT_MS,
  SANDBOX_SURVIVAL_WORKFLOW_FINALIZATION_BUDGET_MS,
} from "../../../tools/e2e/sandbox-survival-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "../fixtures/cleanup.ts";
import { SANDBOX_MARKER_COMMAND_TIMEOUT_MS } from "../fixtures/phases/state-validation.ts";

const MINUTE_MS = 60_000;

describe("sandbox-survival timeout contract", () => {
  it.each([
    "src/lib/actions/sandbox/connect.ts",
    "src/lib/actions/sandbox/process-recovery.ts",
    "src/lib/actions/sandbox/start.ts",
  ])("selects both native runtime variants for changes to %s", (file) => {
    const target = catalogueTargetsForChangedFiles([file]).find(
      (candidate) => candidate.id === "sandbox-survival",
    );
    expect(target?.gatewayRuntimes).toEqual(["docker", "podman"]);
  });

  it("lets recovery finish both readiness waits and startup before the command deadline", () => {
    const sequentialWaitsMs =
      (2 * SANDBOX_REPAIR_READY_TIMEOUT_SEC + OPENCLAW_GATEWAY_STARTUP_WAIT_SECONDS) * 1_000;
    expect(SANDBOX_SURVIVAL_RECOVER_TIMEOUT_MS).toBeGreaterThan(sequentialWaitsMs);
  });

  it("contains every bounded phase and leaves explicit test headroom", () => {
    expect(SANDBOX_SURVIVAL_PREPARATION_WORST_CASE_MS).toBeGreaterThanOrEqual(
      SANDBOX_SURVIVAL_INSTALL_TIMEOUT_MS,
    );
    expect(SANDBOX_SURVIVAL_PREPARATION_BUDGET_MS).toBeGreaterThanOrEqual(
      SANDBOX_SURVIVAL_PREPARATION_WORST_CASE_MS,
    );
    expect(SANDBOX_SURVIVAL_READINESS_BUDGET_MS).toBeGreaterThanOrEqual(
      SANDBOX_SURVIVAL_READINESS_WORST_CASE_MS,
    );
    expect(SANDBOX_SURVIVAL_LIFECYCLE_BUDGET_MS).toBeGreaterThanOrEqual(
      SANDBOX_SURVIVAL_LIFECYCLE_WORST_CASE_MS,
    );
    expect(SANDBOX_SURVIVAL_FINAL_VALIDATION_BUDGET_MS).toBeGreaterThanOrEqual(
      SANDBOX_SURVIVAL_FINAL_DESTROY_TIMEOUT_MS +
        SANDBOX_SURVIVAL_POST_DESTROY_LIST_TIMEOUT_MS +
        SANDBOX_SURVIVAL_MARKER_PATHS.length * 3 * SANDBOX_MARKER_COMMAND_TIMEOUT_MS,
    );
    expect(SANDBOX_SURVIVAL_TEST_TIMEOUT_MS).toBe(
      SANDBOX_SURVIVAL_PREPARATION_BUDGET_MS +
        SANDBOX_SURVIVAL_READINESS_BUDGET_MS +
        SANDBOX_SURVIVAL_LIFECYCLE_BUDGET_MS +
        SANDBOX_SURVIVAL_FINAL_VALIDATION_BUDGET_MS +
        SANDBOX_SURVIVAL_TEST_HEADROOM_MS,
    );
  });

  it("keeps the catalogue deadline outside test cleanup and finalization", () => {
    expect(SANDBOX_SURVIVAL_POST_TEST_CLEANUP_BUDGET_MS).toBe(DEFAULT_CLEANUP_TIMEOUT_MS);
    expect(catalogueTarget("sandbox-survival").timeoutMinutes).toBe(
      SANDBOX_SURVIVAL_TARGET_TIMEOUT_MINUTES,
    );
    expect(SANDBOX_SURVIVAL_TARGET_TIMEOUT_MINUTES * MINUTE_MS).toBe(
      SANDBOX_SURVIVAL_TEST_TIMEOUT_MS +
        SANDBOX_SURVIVAL_POST_TEST_CLEANUP_BUDGET_MS +
        SANDBOX_SURVIVAL_WORKFLOW_FINALIZATION_BUDGET_MS,
    );
    expect(
      catalogueTargetsForChangedFiles(["tools/e2e/sandbox-survival-timeout-contract.mts"]).map(
        (target) => target.id,
      ),
    ).toContain("sandbox-survival");
  });
});
