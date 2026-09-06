// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";

import { validateE2eWorkflowBoundary } from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow } from "../../helpers/e2e-workflow-contract";

type E2eWorkflow = {
  jobs: Record<string, { name?: string; steps: Array<Record<string, unknown>> }>;
};

function validateMutatedWorkflow(mutator: (workflow: E2eWorkflow) => void): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
  const workflowPath = path.join(tmp, "workflow.yaml");
  const workflow = readWorkflow() as E2eWorkflow;
  try {
    mutator(workflow);
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));
    return validateE2eWorkflowBoundary(workflowPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function liveStep(workflow: E2eWorkflow, name: string): Record<string, unknown> {
  const step = workflow.jobs.live.steps.find((entry) => entry.name === name);
  expect(step).toEqual(expect.any(Object));
  return step!;
}

function cloudOnboardStep(workflow: E2eWorkflow, name: string): Record<string, unknown> {
  const step = workflow.jobs["cloud-onboard"]!.steps.find((entry) => entry.name === name);
  expect(step).toEqual(expect.any(Object));
  return step!;
}

function moveCloudOnboardStepAfter(
  workflow: E2eWorkflow,
  stepName: string,
  anchorName: string,
): void {
  const steps = workflow.jobs["cloud-onboard"]!.steps;
  const stepIndex = steps.findIndex((step) => step.name === stepName);
  expect(stepIndex).toBeGreaterThanOrEqual(0);
  const [step] = steps.splice(stepIndex, 1);
  const anchorIndex = steps.findIndex((current) => current.name === anchorName);
  expect(anchorIndex).toBeGreaterThanOrEqual(0);
  steps.splice(anchorIndex + 1, 0, step!);
}

describe("e2e workflow live job boundary", () => {
  it("rejects a live job that hides the semantic matrix label (#9167)", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs.live.name = "Live E2E";
    });

    expect(errors).toContain("live job name must expose the semantic matrix label");
  });

  it.each([
    "Configure live E2E trace directory",
    "Build trusted live E2E timing summary",
    "Delete raw live E2E traces",
  ])("rejects a missing live trace boundary step: %s", (name) => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs.live.steps = workflow.jobs.live.steps.filter((step) => step.name !== name);
    });

    expect(errors).toContain(`run-target job missing step: ${name}`);
  });

  it("rejects live sanitizer and cleanup steps without always guards", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      liveStep(workflow, "Build trusted live E2E timing summary").if = undefined;
      liveStep(workflow, "Delete raw live E2E traces").if = undefined;
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "live trace sanitizer must always run",
        "live raw trace cleanup must always run",
      ]),
    );
  });

  it("rejects live trace setup after workspace preparation", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const steps = workflow.jobs.live.steps;
      const configureIndex = steps.findIndex(
        (step) => step.name === "Configure live E2E trace directory",
      );
      expect(configureIndex).toBeGreaterThanOrEqual(0);
      const [configureStep] = steps.splice(configureIndex, 1);
      const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
      expect(prepareIndex).toBeGreaterThanOrEqual(0);
      steps.splice(prepareIndex + 1, 0, configureStep);
    });

    expect(errors).toContain(
      "live trace setup, workspace preparation, Vitest run, sanitizer, and cleanup steps must stay in order",
    );
  });

  it("rejects live trace sanitizer without the workflow-owned source guard", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run = String(sanitizeStep.run)
        .replace('expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"\n', "")
        .replace(TRACE_SOURCE_GUARD, "");
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "step 'Build trusted live E2E timing summary' run script must include ${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}",
        'step \'Build trusted live E2E timing summary\' run script must include [ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]',
      ]),
    );
  });

  it("rejects live trace sanitizer when the source guard moves after Python reads traces", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run =
        String(sanitizeStep.run).replace(TRACE_SOURCE_ASSIGNMENT + TRACE_SOURCE_GUARD, "") +
        TRACE_SOURCE_ASSIGNMENT +
        TRACE_SOURCE_GUARD;
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "step 'Build trusted live E2E timing summary' run script must include " +
          'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}" before ' +
          "python3 scripts/e2e/sanitize-trace-timing.py",
        "step 'Build trusted live E2E timing summary' run script must include " +
          '[ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ] before ' +
          "python3 scripts/e2e/sanitize-trace-timing.py",
      ]),
    );
  });

  it("rejects live trace sanitizer script path drift", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = liveStep(workflow, "Build trusted live E2E timing summary");
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run = String(sanitizeStep.run).replace(
        "scripts/e2e/sanitize-trace-timing.py",
        "scripts/e2e/renamed-sanitize-trace-timing.py",
      );
    });

    expect(errors).toContain(
      "step 'Build trusted live E2E timing summary' run script must include scripts/e2e/sanitize-trace-timing.py",
    );
  });

  it.each([
    {
      title: "invalid",
      traceSummary: { sandbox_identity_settlement_evidence: "invalid" },
      expectedSummary:
        "Target `channels-add-remove`: `invalid` settlement evidence; inspect lifecycle logs and use a retained recovery record only if the onboarding failure created one.",
    },
    {
      title: "missing",
      traceSummary: { sandbox_identity_settlement_evidence: "missing" },
      expectedSummary:
        "Target `channels-add-remove`: `missing` settlement evidence; inspect lifecycle logs and use a retained recovery record only if the onboarding failure created one.",
    },
    {
      title: "absent",
      traceSummary: { sandbox_identity_settlement_evidence: "absent" },
      expectedSummary:
        "Target `channels-add-remove`: settlement event `absent` after the sandbox phase; inspect lifecycle logs and use a retained recovery record only if the onboarding failure created one.",
    },
    {
      title: "not attempted",
      traceSummary: { sandbox_identity_settlement_evidence: "not_attempted" },
      expectedSummary:
        "Target `channels-add-remove`: sandbox creation `not_attempted`; inspect the target phase plan and lifecycle logs.",
    },
    {
      title: "valid",
      traceSummary: {
        sandbox_identity_settlement: {
          create_operation_state: "ready",
          event_time_unix_nano: "1788724801000000000",
          identity_state: "matched",
          returned_identity_correlation: "8174fa2a5d657551",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      expectedSummary:
        "- Target: `channels-add-remove`\n- Create operation: `ready`\n- Identity state: `matched`\n- Trace ID: `0123456789abcdef0123456789abcdef`\n- Returned identity correlation: `8174fa2a5d657551`",
    },
  ])("surfaces $title settlement evidence in the target workflow summary", (scenario) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-trace-summary-"));
    const targetId = "channels-add-remove";
    const targetRoot = path.join(tmp, targetId);
    const summaryPath = path.join(tmp, "step-summary.md");
    try {
      fs.mkdirSync(targetRoot, { recursive: true });
      fs.writeFileSync(
        path.join(targetRoot, "cloud-onboard-trace-timing-summary.json"),
        JSON.stringify(scenario.traceSummary),
      );
      const workflow = readWorkflow() as E2eWorkflow;
      const run = String(liveStep(workflow, "Summarize artifacts").run ?? "");

      const result = spawnSync("bash", ["-c", run], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          E2E_ARTIFACT_DIR: tmp,
          GITHUB_STEP_SUMMARY: summaryPath,
          TARGET_ID: targetId,
          TARGET_LABEL: "Telegram add/remove",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(fs.readFileSync(summaryPath, "utf8")).toContain(scenario.expectedSummary);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});

describe("e2e workflow cloud-onboard trace boundary", () => {
  it.each([
    "Configure cloud-onboard trace directory",
    "Build trusted cloud-onboard timing summary",
    "Validate cloud-onboard identity settlement evidence",
    "Delete raw cloud-onboard traces",
  ])("rejects a missing cloud-onboard trace boundary step: %s", (name) => {
    const errors = validateMutatedWorkflow((workflow) => {
      workflow.jobs["cloud-onboard"]!.steps = workflow.jobs[
        "cloud-onboard"
      ]!.steps.filter((step) => step.name !== name);
    });

    expect(errors).toContain(`cloud-onboard job missing step: ${name}`);
  });

  it("rejects conditional setup and sanitizer or cleanup steps without always guards", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      cloudOnboardStep(workflow, "Configure cloud-onboard trace directory").if = "false";
      cloudOnboardStep(workflow, "Build trusted cloud-onboard timing summary").if = undefined;
      cloudOnboardStep(workflow, "Validate cloud-onboard identity settlement evidence").if =
        undefined;
      cloudOnboardStep(workflow, "Delete raw cloud-onboard traces").if = undefined;
    });

    expect(errors).toEqual(
      expect.arrayContaining([
        "cloud-onboard trace setup must run without an if condition",
        "cloud-onboard trace sanitizer must always run",
        "cloud-onboard identity settlement validation must always run",
        "cloud-onboard raw trace cleanup must always run",
      ]),
    );
  });

  it.each([
    ["Configure cloud-onboard trace directory", "Prepare E2E workspace"],
    ["Run cloud-onboard live Vitest test", "Build trusted cloud-onboard timing summary"],
    ["Build trusted cloud-onboard timing summary", "Delete raw cloud-onboard traces"],
    ["Validate cloud-onboard identity settlement evidence", "Delete raw cloud-onboard traces"],
  ])("rejects cloud-onboard trace boundary reordering: %s after %s", (step, anchor) => {
    const errors = validateMutatedWorkflow((workflow) => {
      moveCloudOnboardStepAfter(workflow, step, anchor);
    });

    expect(errors).toContain(
      "cloud-onboard trace setup, workspace preparation, Vitest run, sanitizer, identity validation, and cleanup steps must stay in order",
    );
  });

  it("rejects a cloud-onboard source guard that moves after Python reads traces", () => {
    const errors = validateMutatedWorkflow((workflow) => {
      const sanitizeStep = cloudOnboardStep(
        workflow,
        "Build trusted cloud-onboard timing summary",
      );
      expect(sanitizeStep.run).toEqual(expect.any(String));
      sanitizeStep.run =
        String(sanitizeStep.run).replace(
          CLOUD_TRACE_SOURCE_ASSIGNMENT + CLOUD_TRACE_SOURCE_GUARD,
          "",
        ) +
        CLOUD_TRACE_SOURCE_ASSIGNMENT +
        CLOUD_TRACE_SOURCE_GUARD;
    });

    expect(errors).toContain(
      "cloud-onboard trace sanitizer must verify source path before reading traces",
    );
  });

  it.each([
    {
      title: "invalid evidence",
      traceSummary: { sandbox_identity_settlement_evidence: "invalid" },
      expectedStatus: 1,
    },
    {
      title: "missing evidence",
      traceSummary: { sandbox_identity_settlement_evidence: "missing" },
      expectedStatus: 1,
    },
    { title: "no settlement object", traceSummary: {}, expectedStatus: 1 },
    {
      title: "matched settlement",
      traceSummary: {
        sandbox_identity_settlement: {
          create_operation_state: "ready",
          event_time_unix_nano: "1788724801000000000",
          identity_state: "matched",
          returned_identity_correlation: "8174fa2a5d657551",
          trace_id: "0123456789abcdef0123456789abcdef",
        },
      },
      expectedStatus: 0,
    },
  ])("$title has the expected cloud-onboard gate status", (scenario) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-cloud-onboard-settlement-"));
    const summaryPath = path.join(tmp, "cloud-onboard-trace-timing-summary.json");
    try {
      fs.writeFileSync(summaryPath, JSON.stringify(scenario.traceSummary));
      const workflow = readWorkflow() as E2eWorkflow;
      const run = String(
        cloudOnboardStep(workflow, "Validate cloud-onboard identity settlement evidence").run ??
          "",
      );

      const result = spawnSync("bash", ["-c", run], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, E2E_ARTIFACT_DIR: tmp },
      });

      expect(result.status, result.stderr).toBe(scenario.expectedStatus);
    } finally {
      fs.rmSync(tmp, { force: true, recursive: true });
    }
  });
});

const TRACE_SOURCE_ASSIGNMENT =
  'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-e2e-traces/${TARGET_ID}"\n';
const TRACE_SOURCE_GUARD =
  'if [ -z "${RUNNER_TEMP}" ] || [ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]; then\n' +
  '  echo "::error title=E2E trace sanitization refused::NEMOCLAW_TRACE_DIR does not match its workflow-owned RUNNER_TEMP path. No raw traces were read or uploaded. Correct the trace path configuration before rerunning." >&2\n' +
  "  printf 'Expected trace path: %s\\n' \"${expected_trace_dir}\" >&2\n" +
  "  exit 1\n" +
  "fi\n";
const CLOUD_TRACE_SOURCE_ASSIGNMENT =
  'expected_trace_dir="${RUNNER_TEMP}/nemoclaw-cloud-onboard-traces"\n';
const CLOUD_TRACE_SOURCE_GUARD =
  'if [ -z "${RUNNER_TEMP}" ] || [ "${NEMOCLAW_TRACE_DIR}" != "${expected_trace_dir}" ]; then\n' +
  '  echo "::error title=E2E trace sanitization refused::NEMOCLAW_TRACE_DIR does not match its workflow-owned RUNNER_TEMP path. No raw traces were read or uploaded. Correct the trace path configuration before rerunning." >&2\n' +
  "  printf 'Expected trace path: %s\\n' \"${expected_trace_dir}\" >&2\n" +
  "  exit 1\n" +
  "fi\n";
