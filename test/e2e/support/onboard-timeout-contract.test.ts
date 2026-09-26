// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { getDockerGpuSupervisorReconnectTimeoutSecs } from "../../../src/lib/onboard/docker-gpu-supervisor-reconnect.ts";
import {
  CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
  CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS,
  CONFIG_EXPORT_POLICY_TIMEOUT_MS,
  DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS,
  DCODE_TYPED_TARGET_TEST_TIMEOUT_MS,
  DCODE_TYPED_TARGET_TIMEOUT_MINUTES,
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
import { validateE2eWorkflow } from "../../../tools/e2e/workflow-boundary.mts";
import { buildE2eWorkflowPlan } from "../../../tools/e2e/workflow-plan.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract.ts";
import { DEFAULT_CLEANUP_TIMEOUT_MS } from "../fixtures/cleanup.ts";
import { listTargets } from "../registry/registry.ts";
import { CONFIG_EXPORT_EXPECTATIONS, type ConfigExportExpectation } from "../registry/types.ts";

const MINUTE_MS = 60_000;
const finalHandoffTimeoutMs = getDockerGpuSupervisorReconnectTimeoutSecs(1, {}) * 1_000;
const affectedTargetIds = ["inference-routing", "onboard-resume"] as const;
const timeoutContractPath = "tools/e2e/onboard-timeout-contract.mts";
const commandDiagnosticHeadroomMs = 10 * MINUTE_MS;
const testHeadroomMs = 10 * MINUTE_MS;
const jobHeadroomMs = 20 * MINUTE_MS;
const workflowFinalizationHeadroomMs = 10 * MINUTE_MS;
const dcodeRoutePollOperationCeilingMs = 8 * 25_000 + 7 * 2_000;
const dcodeLifecycleOperationCeilingMs =
  8 * 30_000 + 2 * 15_000 + 3 * dcodeRoutePollOperationCeilingMs + 3 * MINUTE_MS;
const dcodeExpectedRefusalTimeout = liveTargetTimeoutContract(
  "dcode-rebuild-invalid-credential",
  "expected-refusal",
);

afterEach(() => vi.unstubAllEnvs());

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

  it("contains every bounded pinned config consumer operation", () => {
    expect(CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS).toBeGreaterThanOrEqual(
      30_000 + 30_000 + 8 * MINUTE_MS + 30_000,
    );
  });

  it("reserves job headroom after the Deep Agents Code lifecycle and export refusal", () => {
    expect(dcodeExpectedRefusalTimeout.testTimeoutMs).toBe(
      DCODE_TYPED_TARGET_TEST_TIMEOUT_MS + CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
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
      configExportPinnedV1ConsumerMinutes: CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS / MINUTE_MS,
      configExportPolicyMinutes: CONFIG_EXPORT_POLICY_TIMEOUT_MS / MINUTE_MS,
      dcodeLifecycleMinutes: DCODE_INVALID_CREDENTIAL_LIFECYCLE_BUDGET_MS / MINUTE_MS,
      dcodeExpectedRefusalTestMinutes: dcodeExpectedRefusalTimeout.testTimeoutMs! / MINUTE_MS,
      dcodeExpectedRefusalTargetMinutes: dcodeExpectedRefusalTimeout.targetTimeoutMinutes,
      onboardResumeTestMinutes: ONBOARD_RESUME_TEST_TIMEOUT_MS / MINUTE_MS,
      onboardResumeTargetMinutes: ONBOARD_RESUME_TARGET_TIMEOUT_MINUTES,
      dcodeTypedTargetTestMinutes: DCODE_TYPED_TARGET_TEST_TIMEOUT_MS / MINUTE_MS,
      dcodeTypedTargetMinutes: DCODE_TYPED_TARGET_TIMEOUT_MINUTES,
    }).toEqual({
      finalHandoffCommandMinutes: 40,
      singleFinalHandoffTestMinutes: 50,
      singleFinalHandoffTargetMinutes: 75,
      noRecreateCommandMinutes: 15,
      configExportCommandMinutes: 2,
      configExportPinnedV1ConsumerMinutes: 10,
      configExportPolicyMinutes: 1,
      dcodeLifecycleMinutes: 20,
      dcodeExpectedRefusalTestMinutes: 132,
      dcodeExpectedRefusalTargetMinutes: 152,
      onboardResumeTestMinutes: 150,
      onboardResumeTargetMinutes: 170,
      dcodeTypedTargetTestMinutes: 130,
      dcodeTypedTargetMinutes: 150,
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

  it("reserves job headroom after the ordered Deep Agents target plan", () => {
    expect(
      liveTargetTimeoutContract("dcode-rebuild-invalid-credential", "no-usable-sandbox"),
    ).toEqual({
      testTimeoutMs: DCODE_TYPED_TARGET_TEST_TIMEOUT_MS,
      targetTimeoutMinutes: DCODE_TYPED_TARGET_TIMEOUT_MINUTES,
    });
    expect(DCODE_TYPED_TARGET_TIMEOUT_MINUTES * MINUTE_MS).toBeGreaterThanOrEqual(
      DCODE_TYPED_TARGET_TEST_TIMEOUT_MS + jobHeadroomMs,
    );
  });

  it("selects retained typed targets when the export timeout contract changes", () => {
    const plan = buildE2eWorkflowPlan({}, { changedFiles: [timeoutContractPath] });

    expect(plan.matrix.map((row) => row.id)).toEqual([
      "ubuntu-policy-custom-missing-presets-negative",
      "ubuntu-repo-cloud-langchain-deepagents-code",
      "ubuntu-repo-cloud-openclaw",
    ]);
  });

  it.each(CONFIG_EXPORT_EXPECTATIONS)("assigns an explicit timeout to %s", (expectation) => {
    const expected = {
      required: { testTimeoutMs: 43 * MINUTE_MS, targetTimeoutMinutes: 63 },
      "expected-refusal": { testTimeoutMs: 32 * MINUTE_MS, targetTimeoutMinutes: 52 },
      "no-usable-sandbox": { targetTimeoutMinutes: 45 },
    };

    expect(liveTargetTimeoutContract(undefined, expectation)).toEqual(expected[expectation]);
  });

  it("rejects an unknown export classification instead of assigning no export budget", () => {
    expect(() =>
      liveTargetTimeoutContract(undefined, "unrecognized" as ConfigExportExpectation),
    ).toThrow("Unknown config export expectation");
  });

  it.each([
    { lifecycle: undefined, expectation: "required", minimumMinutes: 43 },
    { lifecycle: undefined, expectation: "expected-refusal", minimumMinutes: 32 },
    {
      lifecycle: "dcode-rebuild-invalid-credential",
      expectation: "expected-refusal",
      minimumMinutes: 132,
    },
  ] as const)(
    "preserves timeout overrides and job headroom for $lifecycle/$expectation",
    ({ lifecycle, expectation, minimumMinutes }) => {
      const overrideMs = (minimumMinutes + 30) * MINUTE_MS + 1;
      vi.stubEnv("NEMOCLAW_TEST_TIMEOUT", String(overrideMs));

      const extended = liveTargetTimeoutContract(lifecycle, expectation);
      expect(extended.testTimeoutMs).toBe(overrideMs);
      expect(extended.targetTimeoutMinutes).toBe(minimumMinutes + 51);

      vi.stubEnv("NEMOCLAW_TEST_TIMEOUT", "1");
      const bounded = liveTargetTimeoutContract(lifecycle, expectation);
      expect(bounded.testTimeoutMs).toBe(minimumMinutes * MINUTE_MS);
      expect(bounded.targetTimeoutMinutes).toBe(minimumMinutes + 20);
    },
  );

  it.each(
    listTargets().filter((target) => target.configExport.expectation !== "no-usable-sandbox"),
  )("includes automatic config-export ceilings for registry target $id", (target) => {
    const expectation = target.configExport.expectation;
    const configExportBudgetMs =
      CONFIG_EXPORT_COMMAND_TIMEOUT_MS +
      (expectation === "required"
        ? CONFIG_EXPORT_POLICY_TIMEOUT_MS + CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS
        : 0);
    const contract = liveTargetTimeoutContract(target.environment.lifecycle, expectation);
    const lifecycleTestBudgetMs =
      target.environment.lifecycle === "dcode-rebuild-invalid-credential"
        ? DCODE_TYPED_TARGET_TEST_TIMEOUT_MS
        : LIVE_TARGET_BASE_TEST_TIMEOUT_MS;

    expect(contract.testTimeoutMs).toBe(lifecycleTestBudgetMs + configExportBudgetMs);
    expect(contract.targetTimeoutMinutes * MINUTE_MS).toBeGreaterThanOrEqual(
      contract.testTimeoutMs! + jobHeadroomMs,
    );
  });

  it("derives the registry job timeout from its test and post-test headroom", () => {
    const contract = liveTargetTimeoutContract(undefined, "required");

    expect(jobHeadroomMs).toBe(DEFAULT_CLEANUP_TIMEOUT_MS + workflowFinalizationHeadroomMs);
    expect(contract.targetTimeoutMinutes * MINUTE_MS).toBe(contract.testTimeoutMs! + jobHeadroomMs);
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
    DCODE_TYPED_TARGET_TEST_TIMEOUT_MS,
    DCODE_TYPED_TARGET_TIMEOUT_MINUTES,
    ONBOARD_FINAL_HANDOFF_COMMAND_TIMEOUT_MS,
    ONBOARD_NO_RECREATE_COMMAND_TIMEOUT_MS,
    CONFIG_EXPORT_COMMAND_TIMEOUT_MS,
    CONFIG_EXPORT_PINNED_V1_CONSUMER_TIMEOUT_MS,
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
