// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
  evaluateE2eWorkflowDispatchSelectors,
  readFreeStandingJobsInventory,
  validateE2eWorkflowBoundary,
  validateFreeStandingWorkflowInventory,
} from "../../../tools/e2e/workflow-boundary.mts";
import { readWorkflow, removeJobNeed } from "../../helpers/e2e-workflow-contract";
import { testTimeoutOptions } from "../../helpers/timeouts";
import { assertChannelsStopStartSandboxName } from "../live/channels-stop-start-safety.ts";

function generateMatrixScript(): string {
  const workflow = readWorkflow();
  const jobs = workflow.jobs as Record<string, { steps?: Array<Record<string, unknown>> }>;
  const generateStep = jobs["generate-matrix"]?.steps?.find(
    (step) => step.name === "Generate E2E target matrix",
  );
  expect(generateStep?.run).toEqual(expect.any(String));
  return generateStep?.run as string;
}

function generateMatrixForDispatch(env: { JOBS: string; TARGETS: string }): Record<string, string> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-matrix-"));
  const outputPath = path.join(tmp, "github-output");
  const summaryPath = path.join(tmp, "github-summary");
  try {
    const result = spawnSync("bash", ["-c", generateMatrixScript()], {
      cwd: process.cwd(),
      encoding: "utf-8",
      timeout: 120_000,
      killSignal: "SIGKILL",
      env: {
        ...process.env,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        JOBS: env.JOBS,
        TARGETS: env.TARGETS,
      },
    });
    expect(result.signal).toBeNull();
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return Object.fromEntries(
      fs
        .readFileSync(outputPath, "utf-8")
        .trim()
        .split("\n")
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe("e2e workflow boundary", () => {
  it("guards channels-stop-start destructive cleanup to test-owned sandboxes", () => {
    expect(() => assertChannelsStopStartSandboxName("personal-dev")).toThrow(
      /only accepts sandbox names with prefix e2e-channels-stop-start-/,
    );
    expect(() =>
      assertChannelsStopStartSandboxName("e2e-channels-stop-start-openclaw"),
    ).not.toThrow();
    expect(() =>
      assertChannelsStopStartSandboxName("e2e-channels-stop-start-hermes"),
    ).not.toThrow();
  });

  it("keeps the live E2E target workflow scheduled, dispatchable, pinned, and artifact-safe", () => {
    expect(validateE2eWorkflowBoundary()).toEqual([]);
  });

  it("starts hosted OpenClaw proofs in the first wave after matrix generation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { needs?: string | string[] }>;
    };
    const serializedDependencies = {
      "full-e2e": ["generate-matrix", "token-rotation", "channels-stop-start"],
      "openclaw-tui-chat-correlation": [
        "generate-matrix",
        "token-rotation",
        "channels-stop-start",
        "full-e2e",
      ],
    };

    for (const [jobName, dependencies] of Object.entries(serializedDependencies)) {
      expect(workflow.jobs[jobName]?.needs).toBe("generate-matrix");
      workflow.jobs[jobName]!.needs = dependencies;
    }
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "full-e2e job must depend on generate-matrix",
          "openclaw-tui-chat-correlation job must depend on generate-matrix",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects free-standing E2E artifact uploads from raw temp paths", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          steps: Array<{
            name?: string;
            with?: Record<string, unknown>;
          }>;
        }
      >;
    };
    const upload = workflow.jobs["openclaw-inference-switch"].steps.find(
      (step) => step.name === "Upload OpenClaw inference switch artifacts",
    );
    expect(upload?.with).toEqual(expect.any(Object));
    upload!.with!.path =
      `${String(upload!.with!.path)}\n/tmp/nemoclaw-e2e-openclaw-inference-switch-install.log`;
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        "openclaw-inference-switch upload-e2e-artifacts must preserve its explicit name/path contract",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it(
    "evaluates high-risk dispatch selector behavior before secret-bearing jobs run",
    testTimeoutOptions(30_000),
    () => {
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "network-policy,../escape",
        }),
      ).toMatchObject({
        valid: false,
        liveTargetsRun: false,
        selectedFreeStandingJobs: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "network-policy",
          targets: "network-policy",
        }),
      ).toMatchObject({
        valid: false,
        liveTargetsRun: false,
        selectedFreeStandingJobs: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "network-policy",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["network-policy"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "network-policy,ubuntu-repo-cloud-openclaw",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: true,
        selectedFreeStandingJobs: ["network-policy"],
        registryTargets: ["ubuntu-repo-cloud-openclaw"],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "openshell-version-pin",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["openshell-version-pin"],
        registryTargets: [],
      });
      expect(evaluateE2eWorkflowDispatchSelectors({ targets: "skill-agent" })).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["skill-agent"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "skill-agent",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["skill-agent"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "openclaw-skill-cli",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["openclaw-skill-cli"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "openclaw-skill-cli",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["openclaw-skill-cli"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "credential-sanitization",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["credential-sanitization"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "credential-sanitization",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["credential-sanitization"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "sessions-agents-cli",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["sessions-agents-cli"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "sessions-agents-cli",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["sessions-agents-cli"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "messaging-compatible-endpoint",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["messaging-compatible-endpoint"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "messaging-compatible-endpoint",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["messaging-compatible-endpoint"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "inference-routing",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["inference-routing"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "inference-routing",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["inference-routing"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "cloud-inference",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["cloud-inference"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "cloud-inference",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["cloud-inference"],
        registryTargets: [],
      });
      expect(evaluateE2eWorkflowDispatchSelectors({ targets: "hermes-e2e" })).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["hermes-e2e"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "common-egress-agent",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["common-egress-agent"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "common-egress-agent",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["common-egress-agent"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "shields-config",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["shields-config"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "shields-config",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["shields-config"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "rebuild-openclaw",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["rebuild-openclaw"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "rebuild-openclaw",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["rebuild-openclaw"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "rebuild-hermes",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["rebuild-hermes"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "rebuild-hermes",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["rebuild-hermes"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "rebuild-hermes-stale-base",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["rebuild-hermes-stale-base"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "rebuild-hermes-stale-base",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["rebuild-hermes-stale-base"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "state-backup-restore",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["state-backup-restore"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "state-backup-restore",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["state-backup-restore"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "upgrade-stale-sandbox",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["upgrade-stale-sandbox"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "upgrade-stale-sandbox",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["upgrade-stale-sandbox"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "model-router-provider-routed-inference",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["model-router-provider-routed-inference"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "model-router-provider-routed-inference",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["model-router-provider-routed-inference"],
        registryTargets: [],
      });
      expect(evaluateE2eWorkflowDispatchSelectors({ targets: "diagnostics" })).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["diagnostics"],
        registryTargets: [],
      });
      expect(evaluateE2eWorkflowDispatchSelectors({ jobs: "diagnostics" })).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["diagnostics"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "gateway-drift-preflight",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["gateway-drift-preflight"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "gateway-drift-preflight",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["gateway-drift-preflight"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "openclaw-inference-switch",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["openclaw-inference-switch"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "openclaw-inference-switch",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["openclaw-inference-switch"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "bedrock-runtime-compatible-anthropic",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["bedrock-runtime-compatible-anthropic"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "bedrock-runtime-compatible-anthropic",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["bedrock-runtime-compatible-anthropic"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          targets: "issue-2478-crash-loop-recovery",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["issue-2478-crash-loop-recovery"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "issue-2478-crash-loop-recovery",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["issue-2478-crash-loop-recovery"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({ targets: "gateway-health-honest" }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["gateway-health-honest"],
        registryTargets: [],
      });
      expect(evaluateE2eWorkflowDispatchSelectors({ jobs: "gateway-health-honest" })).toMatchObject(
        {
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: ["gateway-health-honest"],
          registryTargets: [],
        },
      );
      expect(
        evaluateE2eWorkflowDispatchSelectors({ targets: "concurrent-gateway-ports" }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["concurrent-gateway-ports"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({ jobs: "concurrent-gateway-ports" }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["concurrent-gateway-ports"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({ targets: "channels-add-remove" }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["channels-add-remove"],
        registryTargets: [],
      });
      expect(
        evaluateE2eWorkflowDispatchSelectors({
          jobs: "channels-add-remove",
        }),
      ).toMatchObject({
        valid: true,
        liveTargetsRun: false,
        selectedFreeStandingJobs: ["channels-add-remove"],
        registryTargets: [],
      });
    },
  );

  it("derives the free-standing inventory from workflow job metadata", { timeout: 60_000 }, () => {
    const inventory = readFreeStandingJobsInventory();
    expect(validateFreeStandingWorkflowInventory()).toEqual([]);
    expect(inventory.allowedJobs).toContain("openshell-version-pin");
    expect(inventory.allowedJobs).toContain("openshell-gateway-auth-contract");
    expect(inventory.allowedJobs).toContain("gateway-guard-recovery");
    expect(inventory.allowedJobs).toContain("upgrade-stale-sandbox");
    expect(inventory.allowedJobs).toContain("openclaw-plugin-runtime-exdev");
    expect(inventory.targetToJob.get("openshell-gateway-auth-contract")).toBe(
      "openshell-gateway-auth-contract",
    );
    expect(inventory.targetToJob.get("openshell-version-pin")).toBe("openshell-version-pin");
    expect(inventory.targetToJob.get("upgrade-stale-sandbox")).toBe("upgrade-stale-sandbox");
    expect(inventory.targetToJob.get("credential-migration")).toBe("credential-migration");
    expect(inventory.targetToJob.get("launchable-smoke")).toBe("launchable-smoke");
    expect(inventory.targetToJob.get("gateway-guard-recovery")).toBe("gateway-guard-recovery");
    expect(inventory.targetToJob.get("openclaw-plugin-runtime-exdev")).toBe(
      "openclaw-plugin-runtime-exdev",
    );
    expect(
      inventory.allowedJobs.every((job) =>
        Object.keys((readWorkflow().jobs as Record<string, unknown>) ?? {}).includes(job),
      ),
    ).toBe(true);
  });

  it("rejects malformed free-standing workflow metadata before matrix generation", {
    timeout: 60_000,
  }, () => {
    const malformedWorkflows = [
      {
        body: `
jobs:
  openshell-version-pin:
    env:
      E2E_JOB: "yes"
      E2E_TARGET_ID: openshell-version-pin
`,
        error: 'openshell-version-pin job E2E_JOB must be "1"',
      },
      {
        body: `
jobs:
  openshell-version-pin:
    env:
      E2E_TARGET_ID: openshell-version-pin
`,
        error: "openshell-version-pin job E2E_TARGET_ID requires E2E_JOB",
      },
      {
        body: `
jobs:
  openshell-version-pin:
    env:
      E2E_JOB: "1"
      E2E_TARGET_ID: "bad:target"
`,
        error: "openshell-version-pin job E2E_TARGET_ID must be a selector id",
      },
      {
        body: `
jobs:
  first:
    env:
      E2E_JOB: "1"
      E2E_TARGET_ID: duplicate-target
  second:
    env:
      E2E_JOB: "1"
      E2E_TARGET_ID: duplicate-target
`,
        error: "free-standing workflow metadata repeats target id: duplicate-target",
      },
    ];

    for (const { body, error } of malformedWorkflows) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-bad-workflow-"));
      const workflowPath = path.join(tmp, "workflow.yaml");
      try {
        fs.writeFileSync(workflowPath, body);
        expect(validateFreeStandingWorkflowInventory(workflowPath)).toContain(error);
        const result = spawnSync(
          "npx",
          ["tsx", "tools/e2e/workflow-inventory.mts", "--shell", "--workflow", workflowPath],
          {
            cwd: process.cwd(),
            encoding: "utf-8",
            timeout: 30_000,
            killSignal: "SIGKILL",
          },
        );
        expect(result.signal).toBeNull();
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(`::error::${error}`);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it(
    "keeps each free-standing selector out of the registry matrix",
    testTimeoutOptions(420_000),
    () => {
      const hermesSelector = "hermes-e2e";
      const inventory = readFreeStandingJobsInventory();
      const nonHermesJobs = inventory.allowedJobs.filter((job) => job !== hermesSelector);
      const nonHermesTargets = [...inventory.targetToJob.keys()].filter(
        (target) => target !== hermesSelector,
      );

      expect(nonHermesJobs).not.toHaveLength(0);
      expect(nonHermesTargets).not.toHaveLength(0);
      expect(inventory.allowedJobs).toContain(hermesSelector);
      expect(inventory.targetToJob.get(hermesSelector)).toBe(hermesSelector);

      expect(
        generateMatrixForDispatch({ JOBS: nonHermesJobs.join(","), TARGETS: "" }),
      ).toMatchObject({
        hermes_selected: "false",
        matrix: "[]",
      });
      expect(generateMatrixForDispatch({ JOBS: hermesSelector, TARGETS: "" })).toMatchObject({
        hermes_selected: "true",
        matrix: "[]",
      });
      expect(
        generateMatrixForDispatch({ JOBS: "", TARGETS: nonHermesTargets.join(",") }),
      ).toMatchObject({
        hermes_selected: "false",
        matrix: "[]",
      });
      expect(generateMatrixForDispatch({ JOBS: "", TARGETS: hermesSelector })).toMatchObject({
        hermes_selected: "true",
        matrix: "[]",
      });

      for (const job of inventory.allowedJobs) {
        expect(evaluateE2eWorkflowDispatchSelectors({ jobs: job })).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [job],
          registryTargets: [],
        });
      }
      for (const [target, job] of inventory.targetToJob) {
        expect(evaluateE2eWorkflowDispatchSelectors({ targets: target })).toMatchObject({
          valid: true,
          liveTargetsRun: false,
          selectedFreeStandingJobs: [job],
          registryTargets: [],
        });
      }
    },
  );

  it("flags direct dispatch-input interpolation and unsafe artifact upload", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    fs.writeFileSync(
      workflowPath,
      `
"on":
  workflow_dispatch:
    inputs:
      test_filter:
        required: false
permissions:
  contents: read
jobs:
  validate-jobs:
    runs-on: macos-latest
    steps:
      - name: Validate free-standing job selector
        env:
          JOBS: bad
        run: |
          echo "::error::Invalid jobs input: \${JOBS}"
  report-to-pr:
    runs-on: ubuntu-latest
    needs: [generate-matrix]
    steps:
      - name: Post E2E target results to PR
        env:
          JOBS: bad
        run: echo "\${{ inputs.pr_number }} \${{ inputs.targets }}"
  live:
    runs-on: ubuntu-latest
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/live
      NEMOCLAW_RUN_LIVE_E2E: "1"
      NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
      - name: Run live E2E tests
        env:
          TEST_FILTER: \${{ inputs.test_filter }}
        run: npx vitest run --project e2e-live "\${{ inputs.test_filter }}"
      - name: Summarize artifacts
        run: echo "\${{ github.event.inputs['test_filter'] }}"
      - name: Upload E2E artifacts
        uses: actions/upload-artifact@v4
        with:
          name: e2e
          path: .e2e/live/
          include-hidden-files: true
          if-no-files-found: ignore
  openshell-version-pin:
    runs-on: ubuntu-latest
    needs: generate-matrix
    if: \${{ inputs.targets != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/openshell-version-pin
      NEMOCLAW_RUN_LIVE_E2E: "0"
      NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
      - name: Install root dependencies
        run: npm install
      - name: Run OpenShell version-pin live test
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
        run: npx vitest run --project e2e-live "\${{ inputs.test_filter }}"
      - name: Upload OpenShell version-pin artifacts
        uses: actions/upload-artifact@v4
        with:
          name: openshell-version-pin
          path: .e2e/openshell-version-pin/
          include-hidden-files: true
          if-no-files-found: error
  onboard-negative-paths:
    runs-on: ubuntu-latest
    needs: generate-matrix
    if: \${{ inputs.targets != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/onboard-negative-paths
      NEMOCLAW_RUN_LIVE_E2E: "0"
      NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
      - name: Install root dependencies
        run: npm install
      - name: Run onboard negative-paths live test
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
        run: npx vitest run --project e2e-live "\${{ inputs.test_filter }}"
      - name: Upload onboard negative-paths artifacts
        uses: actions/upload-artifact@v4
        with:
          name: onboard-negative-paths
          path: .e2e/onboard-negative-paths/
          include-hidden-files: true
          if-no-files-found: error
  network-policy:
    runs-on: macos-latest
    needs: generate-matrix
    if: \${{ inputs.targets != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/network-policy
      NEMOCLAW_CLI_BIN: bin/not-nemoclaw.js
      NEMOCLAW_RUN_LIVE_E2E: "0"
      NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
      DOCKERHUB_USERNAME: \${{ secrets.DOCKERHUB_USERNAME }}
      DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}
      GITHUB_TOKEN: \${{ github.token }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Authenticate to Docker Hub
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: echo "\${{ inputs.jobs }}"
      - name: Set up Node
        uses: actions/setup-node@v4
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
      - name: Install root dependencies
        run: npm install
      - name: Build CLI
        run: echo skip
      - name: Install OpenShell
        env:
          GITHUB_TOKEN: \${{ github.token }}
        run: echo install
      - name: Run network-policy live test
        env:
          NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
        run: npx vitest run --project e2e-live "\${{ inputs.test_filter }}"
      - name: Upload network-policy artifacts
        uses: actions/upload-artifact@v4
        with:
          name: network-policy
          path: .e2e/network-policy/
          include-hidden-files: true
          if-no-files-found: error
          retention-days: 1
  double-onboard:
    runs-on: ubuntu-latest
    needs: generate-matrix
    if: \${{ inputs.targets != '' }}
    env:
      E2E_ARTIFACT_DIR: \${{ github.workspace }}/.e2e/double-onboard
      NEMOCLAW_CLI_BIN: ./bad-cli.js
      NEMOCLAW_RUN_LIVE_E2E: "0"
      NVIDIA_INFERENCE_API_KEY: \${{ secrets.NVIDIA_INFERENCE_API_KEY }}
      DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: true
      - name: Authenticate to Docker Hub
        env:
          DOCKERHUB_USERNAME: plain-user
          DOCKERHUB_TOKEN: plain-token
        run: echo no docker login
      - name: Set up Node
        uses: actions/setup-node@v4
      - name: Install root dependencies
        run: npm install
      - name: Build CLI
        run: echo skip build
      - name: Install OpenShell CLI
        run: echo skip install
      - name: Run double-onboard live Vitest test
        env:
          DOCKERHUB_TOKEN: \${{ secrets.DOCKERHUB_TOKEN }}
        run: npx vitest run --project e2e-live "\${{ inputs.test_filter }}"
      - name: Upload double-onboard Vitest artifacts
        uses: actions/upload-artifact@v4
        with:
          name: double-onboard
          path: .e2e/double-onboard/
          include-hidden-files: true
          if-no-files-found: error

`,
    );

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "workflow_dispatch missing input: targets",
          "workflow_dispatch missing input: jobs",
          "workflow_dispatch must not expose legacy test_filter input",
          "workflow missing generate-matrix job",
          "live job must run on the matrix runner",
          "live job must enable hosted-compatible inference mode",
          "live job env must not include NVIDIA_INFERENCE_API_KEY",
          "run-target job missing step: Configure live E2E trace directory",
          "step 'Run live E2E tests' run script must not interpolate dispatch inputs directly",
          "live E2E step must receive NVIDIA_INFERENCE_API_KEY from secrets",
          "run-target job missing step: Build trusted live E2E timing summary",
          "run-target job missing step: Delete raw live E2E traces",
          "live trace setup, workspace preparation, Vitest run, sanitizer, and cleanup steps must stay in order",
          "artifact upload path must include e2e-artifacts/live/${{ matrix.id }}/cloud-onboard-trace-timing-summary.json",
          "live must not invoke actions/upload-artifact directly",
          "live must use upload-e2e-artifacts exactly once",
          "openshell-version-pin job must use the shared jobs selector condition",
          "network-policy job env must not include NVIDIA_INFERENCE_API_KEY",
          "network-policy step 'Install OpenShell' env must not include GITHUB_TOKEN",
          "double-onboard job env must not include DOCKERHUB_TOKEN",
          "step 'Run double-onboard live Vitest test' run script must not interpolate dispatch inputs directly",
          "workflow missing hermes-e2e job",
          "workflow missing skill-agent job",
          "workflow missing diagnostics job",
          "workflow missing model-router-provider-routed-inference job",
          "workflow missing snapshot-commands job",
          "report-to-pr job must wait for live",
          "report-to-pr step must pass jobs through JOBS env",
          "step 'Post E2E target results to PR' run script must check selector validation before echoing selectors",
          "step 'Post E2E target results to PR' run script must omit rejected job selectors",
          "step 'Post E2E target results to PR' run script must filter reported entries for selective dispatches",
          "step 'Post E2E target results to PR' run script must report missing requested jobs",
          "step 'Post E2E target results to PR' run script must count cancelled jobs",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects workflow selector drift from the free-standing inventory", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      workflowPath,
      workflow.replace(" || contains(format(',{0},', inputs.targets), ',sandbox-rebuild,')", ""),
    );

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toContain(
        "free-standing inventory mapping sandbox-rebuild:sandbox-rebuild must match the workflow job selector",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires snapshot commands workflow boundary coverage", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e.yaml"),
      "utf8",
    );
    const parsedWorkflow = YAML.parse(workflow) as {
      jobs: Record<
        string,
        {
          env: Record<string, string>;
          steps: Array<Record<string, unknown>>;
          "timeout-minutes"?: number;
        }
      >;
    };
    const snapshotJob = parsedWorkflow.jobs["snapshot-commands"];
    snapshotJob["timeout-minutes"] = 30;
    snapshotJob.env.DOCKER_CONFIG = "${{ github.workspace }}/.docker-config-shared";
    snapshotJob.env.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    for (const step of snapshotJob.steps) {
      if (typeof step.uses === "string" && step.uses.startsWith("actions/checkout@")) {
        step.with = { ...(step.with as Record<string, unknown>), "persist-credentials": true };
      }
      if (step.name === "Run snapshot commands live test") {
        step.run = String(step.run).replace(
          "test/e2e/live/snapshot-commands.test.ts",
          "test/e2e/live/registry-targets.test.ts",
        );
      }
      if (step.name === "Upload snapshot commands artifacts") {
        step.with = {
          ...(step.with as Record<string, unknown>),
          path: "e2e-artifacts/live/",
          "include-hidden-files": true,
        };
      }
    }
    fs.writeFileSync(workflowPath, YAML.stringify(parsedWorkflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "snapshot-commands job must keep a 40 minute timeout",
          "snapshot-commands job must not set DOCKER_CONFIG at job level",
          "snapshot-commands checkout step must set persist-credentials=false",
          "snapshot-commands job env must not include NVIDIA_INFERENCE_API_KEY",
          "snapshot-commands upload-e2e-artifacts invocation must not override its contract",
          "snapshot-commands upload-e2e-artifacts must use the action defaults",
          "step 'Run snapshot commands live test' run script must include test/e2e/live/snapshot-commands.test.ts",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("applies boundary checks to newly marked free-standing jobs", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, Record<string, unknown>>;
    };
    workflow.jobs["ad-hoc-derived"] = {
      "runs-on": "ubuntu-latest",
      needs: "live",
      if: "${{ inputs.targets != '' }}",
      env: {
        E2E_JOB: "1",
        E2E_TARGET_ID: "ad-hoc-derived",
        NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      },
      steps: [
        { uses: "actions/checkout@v4" },
        {
          name: "Run ad hoc",
          run: "echo ${{ inputs.jobs }} && echo ${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
        },
      ],
    };
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      expect(validateE2eWorkflowBoundary(workflowPath)).toEqual(
        expect.arrayContaining([
          "ad-hoc-derived job must depend on generate-matrix",
          "ad-hoc-derived job must use the shared jobs selector condition",
          "ad-hoc-derived job env must not include NVIDIA_INFERENCE_API_KEY",
          "ad-hoc-derived step 'actions/checkout@v4' action must be pinned to a full commit SHA",
          "step 'Run ad hoc' run script must not interpolate dispatch inputs directly",
          "ad-hoc-derived step 'Run ad hoc' run script must not interpolate secrets directly",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects channels stop/start workflow-boundary drift for secret and artifact handling", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        {
          env: Record<string, unknown>;
          steps: Array<Record<string, unknown>>;
          strategy: { matrix: { agent: string[] }; "fail-fast": boolean };
          "timeout-minutes"?: number;
        }
      >;
    };
    const job = workflow.jobs["channels-stop-start"];
    expect(job).toBeDefined();
    job["timeout-minutes"] = 45;
    job.strategy["fail-fast"] = true;
    job.strategy.matrix.agent = ["openclaw"];
    job.env.NEMOCLAW_SANDBOX_NAME = "personal-dev-${{ matrix.agent }}";
    job.env.DOCKER_CONFIG = "${{ github.workspace }}/.docker-config-shared";
    job.env.NVIDIA_INFERENCE_API_KEY = "${{ secrets.NVIDIA_INFERENCE_API_KEY }}";
    const checkoutStep = job.steps.find(
      (step) => typeof step.uses === "string" && step.uses.startsWith("actions/checkout@"),
    );
    expect(checkoutStep).toBeDefined();
    checkoutStep!.with = {
      ...(checkoutStep!.with as Record<string, unknown>),
      "persist-credentials": true,
    };

    const installOpenShellStep = job.steps.find((step) => step.name === "Install OpenShell");
    expect(installOpenShellStep).toBeDefined();
    installOpenShellStep!.run = "bash scripts/install-openshell.sh";

    const runStep = job.steps.find((step) => step.name === "Run channels stop/start live test");
    expect(runStep).toBeDefined();
    runStep!.env = {
      TELEGRAM_BOT_TOKEN: "real-token",
    };
    runStep!.run = String(runStep!.run).replace(
      "test/e2e/live/channels-stop-start.test.ts",
      "test/e2e/live/channels-add-remove.test.ts",
    );

    const uploadStep = job.steps.find(
      (step) => step.name === "Upload channels stop/start artifacts",
    );
    expect(uploadStep).toBeDefined();
    uploadStep!.uses = "actions/upload-artifact@v4";
    uploadStep!.with = {
      ...(uploadStep!.with as Record<string, unknown>),
      name: "channels-stop-start",
      path: "e2e-artifacts/live/channels-stop-start/",
      "include-hidden-files": true,
      "retention-days": 1,
    };

    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "channels-stop-start job must keep the 90 minute timeout",
          "channels-stop-start strategy.fail-fast must be false",
          "channels-stop-start matrix.agent must be openclaw,hermes",
          "channels-stop-start job must derive NEMOCLAW_SANDBOX_NAME from matrix.agent with the e2e-channels-stop-start- prefix",
          "channels-stop-start job env must not include DOCKER_CONFIG",
          "channels-stop-start job env must not include NVIDIA_INFERENCE_API_KEY",
          "channels-stop-start checkout step must set persist-credentials=false",
          "step 'Install OpenShell' run script must include env -u DOCKER_CONFIG",
          "channels-stop-start step must receive NVIDIA_INFERENCE_API_KEY from secrets",
          "channels-stop-start step must set the fake Telegram token",
          "step 'Run channels stop/start live test' run script must include test/e2e/live/channels-stop-start.test.ts",
          "channels-stop-start must not invoke actions/upload-artifact directly",
          "channels-stop-start must use upload-e2e-artifacts exactly once",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("requires messaging-compatible-endpoint workflow and report coverage", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const renamedWorkflowPath = path.join(tmp, "renamed-workflow.yaml");
    const missingReportNeedPath = path.join(tmp, "missing-report-need.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      renamedWorkflowPath,
      workflow.replace(/^  messaging-compatible-endpoint:$/m, "  msg-compatible-missing:"),
    );
    fs.writeFileSync(
      missingReportNeedPath,
      removeJobNeed(workflow, "report-to-pr", "messaging-compatible-endpoint"),
    );

    try {
      expect(validateE2eWorkflowBoundary(renamedWorkflowPath)).toContain(
        "workflow missing messaging-compatible-endpoint job",
      );
      expect(validateE2eWorkflowBoundary(missingReportNeedPath)).toContain(
        "report-to-pr job must wait for messaging-compatible-endpoint",
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects duplicate unguarded Docker Hub auth in messaging-compatible-endpoint", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<string, { steps: Array<Record<string, unknown>> }>;
    };
    const steps = workflow.jobs["messaging-compatible-endpoint"]?.steps;
    expect(steps).toEqual(expect.any(Array));
    const prepareIndex = steps.findIndex((step) => step.name === "Prepare E2E workspace");
    expect(prepareIndex).toBeGreaterThan(0);
    steps.splice(prepareIndex, 0, {
      name: "Authenticate to Docker Hub",
      env: {
        DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
        DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
      },
      run: "docker login docker.io --username user --password ${{ secrets.DOCKERHUB_TOKEN }}",
    });
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "messaging-compatible-endpoint image-consuming job must have exactly one Docker Hub auth step",
          "messaging-compatible-endpoint step 'Authenticate to Docker Hub' env must not include DOCKERHUB_USERNAME",
          "messaging-compatible-endpoint step 'Authenticate to Docker Hub' env must not include DOCKERHUB_TOKEN",
          "messaging-compatible-endpoint step 'Authenticate to Docker Hub' must not authenticate or interpolate Docker Hub secrets",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects diagnostics workflow-boundary drift for secret and Docker auth handling", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = readWorkflow() as {
      jobs: Record<
        string,
        { env?: Record<string, unknown>; steps: Array<Record<string, unknown>> }
      >;
    };
    const job = workflow.jobs["diagnostics"];
    expect(job).toBeDefined();
    expect(job.steps).toEqual(expect.any(Array));
    job.env = {
      ...job.env,
      DOCKER_CONFIG: "${{ github.workspace }}/.docker-config-diagnostics",
      NVIDIA_INFERENCE_API_KEY: "${{ secrets.NVIDIA_INFERENCE_API_KEY }}",
      GITHUB_TOKEN: "${{ github.token }}",
    };
    const prepareIndex = job.steps.findIndex((step) => step.name === "Prepare E2E workspace");
    expect(prepareIndex).toBeGreaterThan(0);
    job.steps.splice(prepareIndex, 0, {
      name: "Authenticate to Docker Hub",
      env: {
        DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
        DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
      },
      run: 'docker login docker.io --username "${DOCKERHUB_USERNAME}" --password-stdin',
    });
    const runStep = job.steps.find((step) => step.name === "Run diagnostics live test");
    expect(runStep).toBeDefined();
    runStep!.run = `${runStep!.run}\necho "\${{ inputs.jobs }}"`;
    const uploadStep = job.steps.find((step) => step.name === "Upload diagnostics artifacts");
    expect(uploadStep).toBeDefined();
    uploadStep!.with = {
      ...((uploadStep!.with as Record<string, unknown>) ?? {}),
      "include-hidden-files": true,
      "retention-days": 1,
    };
    fs.writeFileSync(workflowPath, YAML.stringify(workflow));

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "diagnostics job must not expose Docker auth to branch-controlled steps",
          "diagnostics job env must not include DOCKER_CONFIG",
          "diagnostics job env must not include NVIDIA_INFERENCE_API_KEY",
          "diagnostics job env must not include GITHUB_TOKEN",
          "diagnostics image-consuming job must have exactly one Docker Hub auth step",
          "diagnostics step 'Authenticate to Docker Hub' env must not include DOCKERHUB_USERNAME",
          "diagnostics step 'Authenticate to Docker Hub' env must not include DOCKERHUB_TOKEN",
          "diagnostics step 'Authenticate to Docker Hub' must not authenticate or interpolate Docker Hub secrets",
          "step 'Run diagnostics live test' run script must not interpolate dispatch inputs directly",
          "diagnostics upload-e2e-artifacts invocation must not override its contract",
          "diagnostics upload-e2e-artifacts must use the action defaults",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects raw jobs selector echo from matrix generation", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-workflow-"));
    const workflowPath = path.join(tmp, "workflow.yaml");
    const workflow = fs.readFileSync(
      path.join(process.cwd(), ".github/workflows/e2e.yaml"),
      "utf8",
    );
    fs.writeFileSync(
      workflowPath,
      workflow.replace(
        'echo "::error::Invalid jobs input; use comma-separated job ids" >&2',
        'echo "::error::Invalid jobs input: ${JOBS}" >&2',
      ),
    );

    try {
      const errors = validateE2eWorkflowBoundary(workflowPath);
      expect(errors).toEqual(
        expect.arrayContaining([
          "step 'Generate E2E target matrix' run script must include Invalid jobs input; use comma-separated job ids",
          "step 'Generate E2E target matrix' run script must not include Invalid jobs input: ${JOBS}",
        ]),
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
