// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import {
  assertWindowsInstallerWorkflow,
  readWindowsInstallerWorkflowSources,
  type WindowsInstallerWorkflowSources,
  type WorkflowJob,
  type WorkflowStep,
} from "../../../tools/windows-installer/workflow-boundary.mts";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
function step(job: WorkflowJob, name: string): WorkflowStep {
  const found = job.steps?.find((item) => item.name === name);
  expect(found, "Missing fixture step: " + name).toBeDefined();
  return found!;
}
type Mutation = { name: string; mutate: (value: WindowsInstallerWorkflowSources) => void };
const mutations: Mutation[] = [
  ...[
    "windows-finished-installer",
    "windows-finished-installed-startup",
    "windows-finished-runtime-qualification",
    "windows-finished-reviewed-installer",
    "windows-finished-candidate-migration",
    "windows-finished-trusted-qualification",
    "windows-compiled-application",
  ].map((name) => ({
    name: "cancelled run starts " + name,
    mutate: (value: WindowsInstallerWorkflowSources) => {
      const job = value.workflow.jobs[name];
      job.if = job.if!.replace("!cancelled() && ", "");
    },
  })),
  {
    name: "Hermes bootstrap silently selects OpenClaw",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-runtime-qualification"].with!.agent = "openclaw";
    },
  },
  {
    name: "reviewed package loses selected-agent binding",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-reviewed-installer"].env!.SELECTED_AGENT = "openclaw";
    },
  },
  {
    name: "Hermes migration falls back to unreviewed installer",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-candidate-migration"].env!.INSTALLER_MANIFEST =
        "${{ needs.windows-finished-installer.outputs.installer_manifest_sha256 }}";
    },
  },
  {
    name: "final acceptance falls back to unreviewed installer",
    mutate: (value) => {
      value.workflow.jobs["windows-finished-trusted-qualification"].with!.installer_cache_key =
        "${{ needs.windows-finished-installer.outputs.installer_cache_key }}";
    },
  },
  {
    name: "availability reviewer loses selected-agent input",
    mutate: (value) => {
      delete step(
        value.trusted.jobs["review-runtime-availability"],
        "Bind reviewed availability to exact successful runtime evidence",
      ).env!.SELECTED_AGENT;
    },
  },
  {
    name: "installed qualification loses its selected phase",
    mutate: (value) => {
      value.trusted.jobs["full-installed-acceptance"].env!.QUALIFICATION_PHASE =
        "runtime-bootstrap";
    },
  },
  {
    name: "final qualification silently uses runtime bootstrap",
    mutate: (value) => {
      const invocation = step(
        value.trusted.jobs["full-installed-acceptance"],
        "Exercise installed preview, real inference and owned cleanup",
      );
      invocation.run = invocation.run!.replace(
        "-RuntimeBootstrap:($env:SELECTED_AGENT -ceq 'hermes' -and $env:QUALIFICATION_PHASE -ceq 'runtime-bootstrap')",
        "-RuntimeBootstrap",
      );
    },
  },
  {
    name: "availability artifact loses selected-agent identity",
    mutate: (value) => {
      step(
        value.trusted.jobs["review-runtime-availability"],
        "Preserve reviewed availability decision only",
      ).with!.name = "reviewed-openclaw";
    },
  },
];

it.each(mutations)("rejects bootstrap workflow mutation: $name", ({ mutate }) => {
  const value = readWindowsInstallerWorkflowSources(repoRoot);
  mutate(value);
  expect(() => assertWindowsInstallerWorkflow(value)).toThrow();
});

// Local command doubles only; no installer or provider executes.
function runReviewer(scenario: { agent: string; controlsExit: number; reviewExit: number }) {
  const root = mkdtempSync(join(tmpdir(), "availability-selection-"));
  const output = join(root, "output");
  const trace = join(root, "trace");
  const run = step(
    readWindowsInstallerWorkflowSources(repoRoot).trusted.jobs["review-runtime-availability"],
    "Bind reviewed availability to exact successful runtime evidence",
  ).run!;
  try {
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
git() { printf '%s\\n' "$CONTROLLER_SHA"; }
node() {
  printf '%s\\n' "$*" >> "$TRACE"
  [[ "$1" == '--experimental-strip-types' && "$2" == '--no-warnings' ]] || return 97
  if [[ "$3" == '--test' ]]; then
    [[ "$4" == "$EXPECTED_CONTROLS" && "$#" == 4 ]] || return 98
    return "$CONTROLS_EXIT"
  fi
  [[ "$3" == "$EXPECTED_REVIEWER" ]] || return 99
  printf '%s\\n' "$EXPECTED_SHA"
  return "$REVIEW_EXIT"
}
${run}`,
      ],
      {
        encoding: "utf8",
        timeout: 10000,
        env: {
          ...process.env,
          SELECTED_AGENT: scenario.agent,
          CONTROLLER_SHA: "a".repeat(40),
          CANDIDATE_SHA: "b".repeat(40),
          EVIDENCE_SHA256: "c".repeat(64),
          EXPECTED_SHA: "d".repeat(64),
          GITHUB_RUN_ID: "123",
          GITHUB_RUN_ATTEMPT: "1",
          RUNNER_TEMP: root,
          GITHUB_OUTPUT: output,
          TRACE: trace,
          EXPECTED_CONTROLS:
            "packaging/windows/installer/" +
            (scenario.agent === "hermes"
              ? "review-hermes-availability.test.mts"
              : "qualify-installed-openclaw.test.mts"),
          EXPECTED_REVIEWER: `packaging/windows/installer/review-${scenario.agent}-availability.mts`,
          CONTROLS_EXIT: String(scenario.controlsExit),
          REVIEW_EXIT: String(scenario.reviewExit),
        },
      },
    );
    return {
      result,
      output: existsSync(output) ? readFileSync(output, "utf8") : null,
      calls: existsSync(trace) ? readFileSync(trace, "utf8").trim().split("\n") : [],
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
it.skipIf(process.platform === "win32").each(["openclaw", "hermes"])(
  "selects the protected reviewer for %s",
  (agent) => {
    const { result, output, calls } = runReviewer({ agent, controlsExit: 0, reviewExit: 0 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(output).toBe("sha256=" + "d".repeat(64) + "\n");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("--controller-run 123:1");
    expect(calls[1]).toContain("--source-revision " + "b".repeat(40));
    expect(calls[1]).toContain("--controller-source-revision " + "a".repeat(40));
  },
);
it.skipIf(process.platform === "win32").each([
  { agent: "hermes", controlsExit: 1, reviewExit: 0, calls: 1 },
  { agent: "hermes", controlsExit: 0, reviewExit: 1, calls: 2 },
  { agent: "other", controlsExit: 0, reviewExit: 0, calls: 0 },
])("rejects protected reviewer failure: $agent / $controlsExit / $reviewExit", (scenario) => {
  const { result, output, calls } = runReviewer(scenario);
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(1);
  expect(output).toBeNull();
  expect(calls).toHaveLength(scenario.calls);
});
