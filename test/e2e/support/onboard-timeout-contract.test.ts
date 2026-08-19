// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

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

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
const MINUTE_MS = 60_000;
const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";
const commandDiagnosticHeadroomMs = 10 * MINUTE_MS;
const testHeadroomMs = 10 * MINUTE_MS;
const jobHeadroomMs = 20 * MINUTE_MS;

function sourceUsageCount(file: string, usage: string): number {
  return fs.readFileSync(path.join(REPO_ROOT, file), "utf8").split(usage).length - 1;
}

describe("onboard final-handoff timeout contract", () => {
  it("keeps the command alive through both reconnect waits and the failure diagnostic", () => {
    expect(ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffTimeoutMs * 2 + commandDiagnosticHeadroomMs,
    );
  });

  it("binds the inference-routing callers to the single-command deadline", () => {
    expect(
      sourceUsageCount(
        "test/e2e/live/inference-routing.test.ts",
        "ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
      ),
    ).toBe(4);
    expect(
      sourceUsageCount(
        "test/e2e/live/inference-routing.test.ts",
        "timeout: INFERENCE_ROUTING_TEST_TIMEOUT_MS",
      ),
    ).toBe(3);
    expect(INFERENCE_ROUTING_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS + testHeadroomMs,
    );
  });

  it("encloses all six sequential onboard-resume command deadlines", () => {
    const finalHandoffCommands = sourceUsageCount(
      "test/e2e/live/onboard-resume.test.ts",
      "timeoutMs: ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS",
    );
    const noRecreateCommands = sourceUsageCount(
      "test/e2e/live/onboard-resume.test.ts",
      "timeoutMs: ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS",
    );

    expect(finalHandoffCommands).toBe(2);
    expect(noRecreateCommands).toBe(4);
    expect(
      sourceUsageCount(
        "test/e2e/live/onboard-resume.test.ts",
        "timeout: ONBOARD_RESUME_TEST_TIMEOUT_MS",
      ),
    ).toBe(1);
    expect(ONBOARD_RESUME_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffCommands * ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS +
        noRecreateCommands * ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS +
        testHeadroomMs,
    );
  });

  it.each([
    ["inference-routing", INFERENCE_ROUTING_TEST_TIMEOUT_MS],
    ["onboard-resume", ONBOARD_RESUME_TEST_TIMEOUT_MS],
  ] as const)("keeps the %s job alive through test cleanup", (targetId, testTimeoutMs) => {
    expect(catalogueTarget(targetId).timeoutMinutes * 60_000).toBeGreaterThanOrEqual(
      testTimeoutMs + jobHeadroomMs,
    );
    expect(catalogueTarget(targetId).timeoutMinutes).toBe(
      targetId === "inference-routing"
        ? INFERENCE_ROUTING_TARGET_TIMEOUT_MINUTES
        : ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    );
  });

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
