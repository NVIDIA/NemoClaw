// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import {
  liveTargetTimeoutContract,
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
  ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS,
  ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS,
  ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS,
  ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS,
  ONBOARD_POST_REBOOT_TARGET_TIMEOUT_MINUTES,
  ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS,
  ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
  ONBOARD_RESUME_TEST_TIMEOUT_MS,
  ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
  ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "../fixtures/cleanup.ts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";

const MINUTE_MS = 60_000;
const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";
const commandDiagnosticHeadroomMs = 10 * MINUTE_MS;
const testHeadroomMs = 10 * MINUTE_MS;
const jobHeadroomMs = 20 * MINUTE_MS;
const workflowFinalizationHeadroomMs = 10 * MINUTE_MS;
const preparationOperationCeilingMs =
  MINUTE_MS + 30_000 + 30_000 + 10 * MINUTE_MS + 2 * MINUTE_MS;
const dockerRecoveryOperationCeilingMs = 3 * 15_000;
const gatewayRestartOperationCeilingMs =
  30_000 + 30_000 + MINUTE_MS + 30_000 + MINUTE_MS + 35_000 + 2 * MINUTE_MS;
const gatewayReconnectOperationCeilingMs = 60 * 30_000 + 59 * 5_000 + 30_000;
const sandboxReadinessOperationCeilingMs = 30 * 30_000 + 29 * 5_000;
const statusValidationOperationCeilingMs =
  5 * MINUTE_MS + MINUTE_MS + 15_000 + 2 * MINUTE_MS;

describe("onboard final-handoff timeout contract", () => {
  it("keeps the command alive through both reconnect waits and the failure diagnostic", () => {
    expect(ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS).toBeGreaterThanOrEqual(
      finalHandoffTimeoutMs * 2 + commandDiagnosticHeadroomMs,
    );
  });

  it("keeps a single-final-handoff test alive through its command", () => {
    expect(ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS).toBeGreaterThanOrEqual(
      ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS + testHeadroomMs,
    );
  });

  it("derives the post-reboot test timeout from every bounded lifecycle phase", () => {
    expect(ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS).toBe(
      ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS +
        ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS +
        ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS +
        ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS +
        ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS +
        testHeadroomMs,
    );
  });

  it("contains environment probes, optional installation, and service staging", () => {
    expect(ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS).toBeGreaterThanOrEqual(
      preparationOperationCeilingMs,
    );
  });

  it("contains Docker transitions, gateway restart, reconnect polling, and diagnostics", () => {
    expect(ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS).toBeGreaterThanOrEqual(
      dockerRecoveryOperationCeilingMs +
        gatewayRestartOperationCeilingMs +
        gatewayReconnectOperationCeilingMs,
    );
  });

  it("contains every sandbox readiness probe and delay", () => {
    expect(ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS).toBeGreaterThanOrEqual(
      sandboxReadinessOperationCeilingMs,
    );
  });

  it("contains final status, typed state validation, and local completion evidence", () => {
    expect(ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS).toBeGreaterThanOrEqual(
      statusValidationOperationCeilingMs,
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
      singleFinalHandoffTestMinutes: ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS / MINUTE_MS,
      singleFinalHandoffTargetMinutes: ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
      noRecreateCommandMinutes: ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS / MINUTE_MS,
      postRebootPreparationMinutes: ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS / MINUTE_MS,
      postRebootGatewayReconnectMinutes:
        ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS / MINUTE_MS,
      postRebootSandboxReadyMinutes: ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS / MINUTE_MS,
      postRebootStatusValidationMinutes:
        ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS / MINUTE_MS,
      postRebootTestMinutes: ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS / MINUTE_MS,
      postRebootTargetMinutes: ONBOARD_POST_REBOOT_TARGET_TIMEOUT_MINUTES,
      onboardResumeTestMinutes: ONBOARD_RESUME_TEST_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTargetMinutes: ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    }).toEqual({
      finalHandoffCommandMinutes: 40,
      singleFinalHandoffTestMinutes: 50,
      singleFinalHandoffTargetMinutes: 75,
      noRecreateCommandMinutes: 15,
      postRebootPreparationMinutes: 15,
      postRebootGatewayReconnectMinutes: 45,
      postRebootSandboxReadyMinutes: 20,
      postRebootStatusValidationMinutes: 10,
      postRebootTestMinutes: 140,
      postRebootTargetMinutes: 160,
      onboardResumeTestMinutes: 150,
      onboardResumeTargetMinutes: 170,
    });
  });

  it.each([
    [
      "inference-routing",
      ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
      ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
    ],
    ["onboard-resume", ONBOARD_RESUME_TEST_TIMEOUT_MS, ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES],
  ] as const)(
    "reserves at least 20 minutes of catalogue-job headroom after the %s test timeout",
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

  it("selects only post-reboot recovery from the typed registry when the contract changes", () => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [timeoutContractPath] });

    expect(plan.matrix).toEqual([
      expect.objectContaining({
        id: "ubuntu-repo-docker-post-reboot-recovery",
        timeout_minutes: 160,
      }),
    ]);
  });

  it("applies the complete lifecycle timeout contract only to post-reboot recovery", () => {
    expect(liveTargetTimeoutContract("post-reboot-recovery")).toEqual({
      commandTimeoutMs: 40 * MINUTE_MS,
      testTimeoutMs: 140 * MINUTE_MS,
      targetTimeoutMinutes: 160,
    });
    expect(liveTargetTimeoutContract("dcode-rebuild-invalid-credential")).toEqual({
      targetTimeoutMinutes: 45,
    });
    expect(liveTargetTimeoutContract(undefined)).toEqual({ targetTimeoutMinutes: 45 });
  });

  it("derives the registry job timeout from its test and post-test headroom", () => {
    const contract = liveTargetTimeoutContract("post-reboot-recovery");

    expect(jobHeadroomMs).toBe(DEFAULT_CLEANUP_TIMEOUT_MS + workflowFinalizationHeadroomMs);
    expect(contract.targetTimeoutMinutes * MINUTE_MS).toBe(
      ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS + jobHeadroomMs,
    );
  });

  it("rejects a live workflow that ignores its typed job timeout", () => {
    const workflow = readWorkflow() as {
      jobs: { live: { "timeout-minutes"?: unknown } };
    };
    const error = "live job timeout must come from the typed target matrix";

    expect(validateE2eWorkflow(workflow)).not.toContain(error);
    workflow.jobs.live["timeout-minutes"] = 45;
    expect(validateE2eWorkflow(workflow)).toContain(error);
  });

  it.each([
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
    ONBOARD_POST_REBOOT_GATEWAY_RECONNECT_BUDGET_MS,
    ONBOARD_POST_REBOOT_PREPARATION_BUDGET_MS,
    ONBOARD_POST_REBOOT_SANDBOX_READY_BUDGET_MS,
    ONBOARD_POST_REBOOT_STATUS_VALIDATION_BUDGET_MS,
    ONBOARD_POST_REBOOT_TARGET_TIMEOUT_MINUTES,
    ONBOARD_POST_REBOOT_TEST_TIMEOUT_MS,
    ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    ONBOARD_RESUME_TEST_TIMEOUT_MS,
    ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
    ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
  ])("uses positive whole numbers for timeout contract values [case %#]", (value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});
