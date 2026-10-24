// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  REBUILD_OPENCLAW_POST_TEST_CLEANUP_BUDGET_MS,
  REBUILD_OPENCLAW_TARGET_TIMEOUT_MINUTES,
  REBUILD_OPENCLAW_TEST_TIMEOUT_MS,
  REBUILD_OPENCLAW_WORKFLOW_FINALIZATION_BUDGET_MS,
} from "../../../tools/e2e/rebuild-openclaw-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "../fixtures/cleanup.ts";

const MINUTE_MS = 60_000;

describe("rebuild-openclaw timeout contract", () => {
  it("budgets the test flow and cleanup headroom in its target deadline", () => {
    const targetTimeoutMinutes = catalogueTarget("rebuild-openclaw").timeoutMinutes;

    expect(REBUILD_OPENCLAW_POST_TEST_CLEANUP_BUDGET_MS).toBe(DEFAULT_CLEANUP_TIMEOUT_MS);
    expect(targetTimeoutMinutes).toBe(REBUILD_OPENCLAW_TARGET_TIMEOUT_MINUTES);
    expect(targetTimeoutMinutes * MINUTE_MS).toBe(
      REBUILD_OPENCLAW_TEST_TIMEOUT_MS +
        REBUILD_OPENCLAW_POST_TEST_CLEANUP_BUDGET_MS +
        REBUILD_OPENCLAW_WORKFLOW_FINALIZATION_BUDGET_MS,
    );
    expect(
      catalogueTargetsForChangedFiles(["tools/e2e/rebuild-openclaw-timeout-contract.mts"]).map(
        (target) => target.id,
      ),
    ).toContain("rebuild-openclaw");
  });
});
