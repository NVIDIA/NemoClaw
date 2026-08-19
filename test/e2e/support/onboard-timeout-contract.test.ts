// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import {
  ONBOARD_COMMAND_TIMEOUT_MS,
  ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS,
  ONBOARD_JOB_CLEANUP_HEADROOM_MS,
  ONBOARD_SUPERVISOR_RECONNECT_WAIT_COUNT,
  ONBOARD_TARGET_TIMEOUT_MINUTES,
  ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS,
  ONBOARD_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";

const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";

describe("onboard final-handoff timeout contract", () => {
  it("keeps the command alive through both reconnect waits and the failure diagnostic", () => {
    expect(ONBOARD_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffTimeoutMs * ONBOARD_SUPERVISOR_RECONNECT_WAIT_COUNT +
        ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS,
    );
  });

  it("keeps the enclosing test alive beyond the command deadline", () => {
    expect(ONBOARD_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ONBOARD_COMMAND_TIMEOUT_MS + ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS,
    );
  });

  it.each(affectedTargetIds)("keeps the %s job alive through test cleanup", (targetId) => {
    expect(catalogueTarget(targetId).timeoutMinutes * 60_000).toBeGreaterThanOrEqual(
      ONBOARD_TEST_TIMEOUT_MS + ONBOARD_JOB_CLEANUP_HEADROOM_MS,
    );
    expect(catalogueTarget(targetId).timeoutMinutes).toBe(ONBOARD_TARGET_TIMEOUT_MINUTES);
  });

  it("selects both affected targets when the shared timeout contract changes", () => {
    expect(
      catalogueTargetsForChangedFiles([timeoutContractPath])
        .map((target) => target.id)
        .sort(),
    ).toEqual([...affectedTargetIds].sort());
  });

  it.each([
    ONBOARD_COMMAND_TIMEOUT_MS,
    ONBOARD_FINAL_HANDOFF_DIAGNOSTIC_HEADROOM_MS,
    ONBOARD_JOB_CLEANUP_HEADROOM_MS,
    ONBOARD_SUPERVISOR_RECONNECT_WAIT_COUNT,
    ONBOARD_TARGET_TIMEOUT_MINUTES,
    ONBOARD_TEST_DIAGNOSTIC_HEADROOM_MS,
    ONBOARD_TEST_TIMEOUT_MS,
  ])("uses positive whole numbers for timeout contract values [case %#]", (value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});
