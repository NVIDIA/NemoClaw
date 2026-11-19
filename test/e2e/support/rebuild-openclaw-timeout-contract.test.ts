// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { expect, it } from "vitest";
import { REBUILD_OPENCLAW_TEST_TIMEOUT_MS } from "../../../tools/e2e/rebuild-openclaw-timeout-contract.mts";
import { FULL_E2E_STANDARD_PROFILE_PRE_TEST_MINUTES } from "../../../tools/e2e/full-e2e-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "../fixtures/cleanup.ts";

it("selects OpenClaw recovery when its deadlines change and reserves workflow setup and cleanup", () => {
  const target = catalogueTarget("rebuild-openclaw");
  expect(
    catalogueTargetsForChangedFiles(["tools/e2e/rebuild-openclaw-timeout-contract.mts"]).map(
      (target) => target.id,
    ),
  ).toContain("rebuild-openclaw");
  expect(target.timeoutMinutes * 60_000).toBeGreaterThanOrEqual(
    FULL_E2E_STANDARD_PROFILE_PRE_TEST_MINUTES * 60_000 +
      REBUILD_OPENCLAW_TEST_TIMEOUT_MS +
      DEFAULT_CLEANUP_TIMEOUT_MS +
      10 * 60_000,
  );
});
