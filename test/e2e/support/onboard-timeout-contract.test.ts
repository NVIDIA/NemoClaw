// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import {
  CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
  CONFIG_EXPORT_POLICY_TIMEOUT_MS,
  DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS,
  LIVE_TARGET_BASE_TEST_TIMEOUT_MS,
  liveTargetTimeoutContract,
  ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
  ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
  ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
  ONBOARD_RESUME_TEST_TIMEOUT_MS,
  ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
  ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
} from "../../../tools/e2e/onboard-timeout-contract.mts";
import {
  catalogueTarget,
  catalogueTargetsForChangedFiles,
} from "../../../tools/e2e/target-catalogue.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";
import { listTargets } from "../registry/registry.ts";

const MINUTE_MS = 60_000;
const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";
const commandDiagnosticHeadroomMs = 10 * MINUTE_MS;
const testHeadroomMs = 10 * MINUTE_MS;
const jobHeadroomMs = 20 * MINUTE_MS;
const dcodeRoutePollOperationCeilingMs = 8 * 25_000 + 7 * 2_000;
const dcodeLifecycleOperationCeilingMs =
  8 * 30_000 + 2 * 15_000 + 3 * dcodeRoutePollOperationCeilingMs + 3 * MINUTE_MS;
const dcodeExpectedRefusalTimeout = liveTargetTimeoutContract(
  "dcode-rebuild-invalid-credential",
  "expected-refusal",
);

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

  it("contains every bounded Deep Agents Code credential-rotation lifecycle operation", () => {
    expect(DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS).toBeGreaterThanOrEqual(
      dcodeLifecycleOperationCeilingMs,
    );
  });

  it("reserves job headroom after the Deep Agents Code lifecycle and export refusal", () => {
    expect(dcodeExpectedRefusalTimeout.testTimeoutMs).toBe(
      LIVE_TARGET_BASE_TEST_TIMEOUT_MS +
        DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS +
        CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
    );
    expect(dcodeExpectedRefusalTimeout.targetTimeoutMinutes * MINUTE_MS).toBeGreaterThanOrEqual(
      dcodeExpectedRefusalTimeout.testTimeoutMs! + jobHeadroomMs,
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
      configExportCommandMinutes: CONFIG_EXPORT_COMMAND_TIMEOUT_MS / MINUTE_MS,
      configExportPolicyMinutes: CONFIG_EXPORT_POLICY_TIMEOUT_MS / MINUTE_MS,
      dcodeLifecycleMinutes: DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS / MINUTE_MS,
      dcodeExpectedRefusalTestMinutes: dcodeExpectedRefusalTimeout.testTimeoutMs! / MINUTE_MS,
      dcodeExpectedRefusalTargetMinutes: dcodeExpectedRefusalTimeout.targetTimeoutMinutes,
      onboardResumeTestMinutes: ONBOARD_RESUME_TEST_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTargetMinutes: ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    }).toEqual({
      finalHandoffCommandMinutes: 40,
      singleFinalHandoffTestMinutes: 50,
      singleFinalHandoffTargetMinutes: 75,
      noRecreateCommandMinutes: 15,
      configExportCommandMinutes: 2,
      configExportPolicyMinutes: 1,
      dcodeLifecycleMinutes: 20,
      dcodeExpectedRefusalTestMinutes: 52,
      dcodeExpectedRefusalTargetMinutes: 72,
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

  it("applies lifecycle and config-export budgets to typed registry targets", () => {
    expect(
      liveTargetTimeoutContract("dcode-rebuild-invalid-credential", "expected-refusal"),
    ).toEqual({
      testTimeoutMs: 52 * MINUTE_MS,
      targetTimeoutMinutes: 72,
    });
    expect(liveTargetTimeoutContract(undefined, "required")).toEqual({
      testTimeoutMs: 33 * MINUTE_MS,
      targetTimeoutMinutes: 53,
    });
    expect(liveTargetTimeoutContract(undefined, "no-usable-sandbox")).toEqual({
      targetTimeoutMinutes: 45,
    });
  });

  it.each(
    listTargets().filter((target) => target.configExport.expectation !== "no-usable-sandbox"),
  )("includes automatic config-export ceilings for registry target $id", (target) => {
    const expectation = target.configExport.expectation;
    const configExportBudgetMs =
      CONFIG_EXPORT_COMMAND_TIMEOUT_MS +
      (expectation === "required" ? CONFIG_EXPORT_POLICY_TIMEOUT_MS : 0);
    const contract = liveTargetTimeoutContract(target.environment.lifecycle, expectation);
    const lifecycleTestBudgetMs =
      target.environment.lifecycle === "dcode-rebuild-invalid-credential"
        ? LIVE_TARGET_BASE_TEST_TIMEOUT_MS + DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS
        : LIVE_TARGET_BASE_TEST_TIMEOUT_MS;

    expect(contract.testTimeoutMs).toBe(lifecycleTestBudgetMs + configExportBudgetMs);
    expect(contract.targetTimeoutMinutes * MINUTE_MS).toBeGreaterThanOrEqual(
      contract.testTimeoutMs! + jobHeadroomMs,
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
    CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
    CONFIG_EXPORT_POLICY_TIMEOUT_MS,
    DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS,
    LIVE_TARGET_BASE_TEST_TIMEOUT_MS,
    ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
    ONBOARD_RESUME_TEST_TIMEOUT_MS,
    ONBOARD_SINGLE_FINAL_HANDOFF_TARGET_TIMEOUT_MINUTES,
    ONBOARD_SINGLE_FINAL_HANDOFF_TEST_TIMEOUT_MS,
  ])("uses positive whole numbers for timeout contract values [case %#]", (value) => {
    expect(Number.isSafeInteger(value)).toBe(true);
    expect(value).toBeGreaterThan(0);
  });
});
