// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import {
  INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
  INFERENCE_ROUTING_TEST_TIMEOUT_MS,
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
  ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
  ONBOARD_RESUME_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";

const MINUTE_MS = 60_000;
const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";
const commandDiagnosticHeadroomMs = 10 * MINUTE_MS;
const testHeadroomMs = 10 * MINUTE_MS;
const jobHeadroomMs = 20 * MINUTE_MS;

describe("onboard final-handoff timeout contract", () => {
  it("keeps the command alive through both reconnect waits and the failure diagnostic", () => {
    expect(ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffTimeoutMs * 2 + commandDiagnosticHeadroomMs,
    );
  });

  it("keeps the inference-routing test alive through its final-handoff command", () => {
    expect(INFERENCE_ROUTING_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS + testHeadroomMs,
    );
  });

  it("encloses the reviewed onboard-resume command budget", () => {
    expect(ONBOARD_RESUME_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      2 * ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS +
        4 * ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS +
        testHeadroomMs,
    );
  });

  it("pins the reviewed command, test, and target timeout values", () => {
    expect({
      finalHandoffCommandMinutes: ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS / MINUTE_MS,
      inferenceRoutingTestMinutes: INFERENCE_ROUTING_TEST_TIMEOUT_MS / MINUTE_MS,
      inferenceRoutingTargetMinutes: INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
      noRecreateCommandMinutes: ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTestMinutes: ONBOARD_RESUME_TEST_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTargetMinutes: ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    }).toEqual({
      finalHandoffCommandMinutes: 40,
      inferenceRoutingTestMinutes: 50,
      inferenceRoutingTargetMinutes: 75,
      noRecreateCommandMinutes: 15,
      onboardResumeTestMinutes: 150,
      onboardResumeTargetMinutes: 170,
    });
  });

  it.each([
    [
      "inference-routing",
      INFERENCE_ROUTING_TEST_TIMEOUT_MS,
      INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
    ],
    ["onboard-resume", ONBOARD_RESUME_TEST_TIMEOUT_MS, ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES],
  ] as const)(
    "keeps the %s catalogue target alive through test cleanup",
    (targetId, testTimeoutMs, targetTimeoutMinutes) => {
      expect(catalogueTarget(targetId).timeoutMinutes).toBe(targetTimeoutMinutes);
      expect(catalogueTarget(targetId).timeoutMinutes * MINUTE_MS).toBeGreaterThanOrEqual(
        testTimeoutMs + jobHeadroomMs,
      );
    },
  );

  it("selects both affected targets when the shared timeout contract changes", () => {
    expect(
      catalogueTargetsForChangedFiles([timeoutContractPath])
        .map((target) => target.id)
        .sort(),
    ).toEqual([...affectedTargetIds].sort());
  });

  it.each([
    INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES,
    INFERENCE_ROUTING_TEST_TIMEOUT_MS,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
    ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    ONBOARD_RESUME_TEST_TIMEOUT_MS,
  ])("uses positive whole numbers for timeout contract values [case %#]", (value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});
