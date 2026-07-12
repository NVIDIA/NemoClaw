// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { readFreeStandingJobsInventory } from "../tools/e2e/workflow-boundary.mts";
import {
  applyDeterministicRecommendations,
  buildPromptTurn,
  buildSystemPrompt,
  requiresCloudOnboardE2e,
} from "../tools/e2e-advisor/analyze.mts";
import { validateE2eAdvisorEventBoundary } from "../tools/e2e-advisor/workflow-boundary.mts";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const E2E_ADVISOR_TARGET_DIR = "/tmp/e2e-advisor-target";

interface WorkflowStep {
  env?: Record<string, string>;
  name?: string;
  run?: string;
  uses?: string;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  permissions?: Record<string, string>;
  jobs?: Record<string, WorkflowJob | undefined>;
}

function readAdvisorWorkflow(): Workflow {
  return YAML.parse(
    fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/e2e-advisor.yaml"), "utf8"),
  ) as Workflow;
}

function advisorWorkflowActionUses(): string[] {
  return Object.values(readAdvisorWorkflow().jobs ?? {})
    .flatMap((job) => job?.steps ?? [])
    .map((step) => step.uses)
    .filter((uses): uses is string => typeof uses === "string");
}

function prepareTargetCheckoutScript(): string {
  const workflow = readAdvisorWorkflow();
  const step = workflow.jobs?.advise?.steps?.find(
    (entry) => entry.name === "Prepare target PR checkout",
  );
  expect(step?.run).toEqual(expect.any(String));
  return step?.run as string;
}

function runPrepareTargetCheckout(env: {
  EXPECTED_HEAD_SHA?: string;
  FAKE_HEAD_SHA?: string;
  TARGET_REPO: string;
  TARGET_PR: string;
  TARGET_BASE: string;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-advisor-workflow-"));
  const binDir = path.join(tmp, "bin");
  const gitLog = path.join(tmp, "git.log");
  const githubEnv = path.join(tmp, "github-env");
  fs.mkdirSync(binDir);
  fs.writeFileSync(
    path.join(binDir, "git"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$*" >> "$FAKE_GIT_LOG"\nif [[ "$*" == *"rev-parse HEAD" ]]; then\n  printf \'%s\\n\' "$FAKE_HEAD_SHA"\nfi\n',
    { mode: 0o755 },
  );
  const targetDir = path.join(tmp, "target");
  const workflowScript = prepareTargetCheckoutScript();
  expect(workflowScript).toContain(E2E_ADVISOR_TARGET_DIR);
  const result = spawnSync(
    "bash",
    ["-c", workflowScript.replaceAll(E2E_ADVISOR_TARGET_DIR, targetDir)],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ...env,
        FAKE_GIT_LOG: gitLog,
        GITHUB_ENV: githubEnv,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    },
  );
  return {
    ...result,
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
    gitCalls: fs.existsSync(gitLog) ? fs.readFileSync(gitLog, "utf8").trim().split(/\r?\n/u) : [],
    githubEnv: fs.existsSync(githubEnv) ? fs.readFileSync(githubEnv, "utf8") : "",
    targetDir,
  };
}

describe("E2E recommendation advisor prompt", () => {
  it("limits the trusted advisor token to PR-comment writes", () => {
    expect(readAdvisorWorkflow().permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
    });
  });

  it("gates privileged fork events and isolates their concurrency", () => {
    expect(validateE2eAdvisorEventBoundary()).toEqual([]);
  });

  it("requires cloud-onboard for timing-sensitive infrastructure changes", () => {
    for (const file of [
      "src/lib/onboard/command.ts",
      "src/lib/trace.ts",
      "scripts/scorecard/analyze-trace-timing.ts",
      "ci/onboard-performance-budget.json",
      ".github/workflows/e2e.yaml",
      "test/e2e/live/cloud-onboard.test.ts",
    ]) {
      expect(requiresCloudOnboardE2e([file]), file).toBe(true);
    }
    expect(requiresCloudOnboardE2e(["docs/index.mdx"])).toBe(false);
  });

  it("adds the canonical cloud-onboard recommendation once", () => {
    const baseResult = {
      version: 1 as const,
      baseRef: "main",
      headRef: "feature",
      changedFiles: ["ci/onboard-performance-budget.json"],
      classifiedDomains: [],
      requiredTests: [],
      optionalTests: [],
      newE2eRecommendations: [],
      noE2eReason: "No E2E needed",
      confidence: "low" as const,
    };

    const once = applyDeterministicRecommendations(baseResult);
    const twice = applyDeterministicRecommendations(once);

    expect(once.requiredTests).toEqual([
      expect.objectContaining({ id: "cloud-onboard", workflow: "e2e.yaml", job: "cloud-onboard" }),
    ]);
    expect(once.noE2eReason).toBeNull();
    expect(once.confidence).toBe("medium");
    expect(twice.requiredTests).toHaveLength(1);
  });

  it("adds risk-plan jobs and domains exactly once when the model misses them", () => {
    const baseResult = {
      version: 1 as const,
      baseRef: "main",
      headRef: "feature",
      changedFiles: ["src/lib/actions/upgrade-sandboxes.ts"],
      classifiedDomains: [],
      requiredTests: [],
      optionalTests: [
        {
          id: "model-alias",
          reason: "model marked this optional",
          workflow: "e2e.yaml",
          job: "upgrade-stale-sandbox",
        },
      ],
      newE2eRecommendations: [],
      noE2eReason: "No E2E needed",
      confidence: "low" as const,
    };

    const once = applyDeterministicRecommendations(baseResult);
    const twice = applyDeterministicRecommendations(once);

    expect(once.requiredTests.map((test) => test.id)).toEqual([
      "state-backup-restore",
      "upgrade-stale-sandbox",
    ]);
    expect(once.optionalTests).toEqual([]);
    expect(once.classifiedDomains.map((domain) => domain.domain)).toContain("upgrade-rebuild");
    expect(once.noE2eReason).toBeNull();
    expect(once.confidence).toBe("medium");
    expect(twice.requiredTests).toHaveLength(2);
    expect(twice.classifiedDomains).toHaveLength(1);
  });

  it("injects the deterministic risk plan as trusted prompt context", () => {
    const turn = buildPromptTurn({
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: ["src/lib/messaging/applier/agent-config.ts"],
      diff: "+change",
      schema: { type: "object" },
    });

    expect(turn.contextToolResults?.map((result) => result.toolName)).toEqual([
      "e2e_advisor_metadata",
      "e2e_advisor_changed_files",
      "e2e_advisor_risk_plan",
      "e2e_advisor_git_diff",
      "e2e_advisor_response_schema",
    ]);
    expect(turn.contextToolResults?.[2]?.content).toContain("messaging-lifecycle");
    for (const result of turn.contextToolResults ?? []) {
      expect(turn.prompt).toContain(`\`${result.toolName}\``);
    }
    expect(turn.prompt).toContain("deterministic risk plan");
  });

  it("requires resume and repair E2E for onboarding machine compatibility changes", () => {
    const prompt = buildSystemPrompt();
    const inventory = readFreeStandingJobsInventory();
    const expectedSelectors = ["onboard-resume", "onboard-repair", "cloud-onboard"];

    expect(prompt).toContain("Onboarding resume rule");
    expect(prompt).toContain("src/lib/onboard/machine");
    for (const selector of expectedSelectors) {
      expect(prompt).toContain(`\`${selector}\``);
      expect(inventory.allowedJobs).toContain(selector);
      expect(inventory.targetToJob.get(selector)).toBe(selector);
    }
    expect(prompt).not.toMatch(/`(?:onboard-resume|onboard-repair|cloud-onboard)-e2e`/u);
  });

  it("pins advisor workflow actions to full commit SHAs", () => {
    const actionUses = advisorWorkflowActionUses();

    expect(actionUses).toEqual(
      expect.arrayContaining(["actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e"]),
    );
    expect(actionUses).toEqual(
      actionUses.map(() => expect.stringMatching(/^[^@\s]+@[0-9a-f]{40}$/u)),
    );
  });

  it("validates manual target checkout inputs before git fetch", () => {
    const invalidCases = [
      {
        TARGET_REPO: "NVIDIA/NemoClaw --upload-pack=x",
        TARGET_PR: "5756",
        TARGET_BASE: "main",
      },
      { TARGET_REPO: "NVIDIA/NemoClaw", TARGET_PR: "12:refs/heads/x", TARGET_BASE: "main" },
      {
        TARGET_REPO: "NVIDIA/NemoClaw",
        TARGET_PR: "5756",
        TARGET_BASE: "main:refs/heads/x",
      },
      { TARGET_REPO: "NVIDIA/NemoClaw", TARGET_PR: "5756", TARGET_BASE: "../main" },
      { TARGET_REPO: "NVIDIA/NemoClaw", TARGET_PR: "5756", TARGET_BASE: "-main" },
    ];

    for (const invalidEnv of invalidCases) {
      const result = runPrepareTargetCheckout(invalidEnv);
      try {
        expect(result.status).toBe(1);
        expect(result.gitCalls).toEqual([]);
      } finally {
        result.cleanup();
      }
    }

    const valid = runPrepareTargetCheckout({
      TARGET_REPO: "NVIDIA/NemoClaw",
      TARGET_PR: "5756",
      TARGET_BASE: "main",
    });
    try {
      expect(valid.status).toBe(0);
      expect(valid.gitCalls).toEqual([
        `-C ${valid.targetDir} init`,
        `-C ${valid.targetDir} remote add target https://github.com/NVIDIA/NemoClaw.git`,
        `-C ${valid.targetDir} fetch --no-tags target refs/heads/main:refs/remotes/target/main`,
        `-C ${valid.targetDir} fetch --no-tags target pull/5756/head:refs/remotes/target/pr-5756`,
        `-C ${valid.targetDir} checkout --detach refs/remotes/target/pr-5756`,
      ]);
      expect(valid.githubEnv).toBe(`ADVISOR_WORKDIR=${valid.targetDir}\nPR_NUMBER=5756\n`);
    } finally {
      valid.cleanup();
    }

    const mismatchedHead = runPrepareTargetCheckout({
      EXPECTED_HEAD_SHA: "a".repeat(40),
      FAKE_HEAD_SHA: "b".repeat(40),
      TARGET_REPO: "NVIDIA/NemoClaw",
      TARGET_PR: "5756",
      TARGET_BASE: "main",
    });
    try {
      expect(mismatchedHead.status).toBe(1);
      expect(mismatchedHead.stdout).toContain(
        "Fetched pull ref does not match the triggering PR head SHA",
      );
      expect(mismatchedHead.gitCalls).toContain(`-C ${mismatchedHead.targetDir} rev-parse HEAD`);
      expect(mismatchedHead.githubEnv).toBe("");
    } finally {
      mismatchedHead.cleanup();
    }
  });

  it("strips untrusted symlinks before secret-bearing advisor steps", () => {
    const steps = readAdvisorWorkflow().jobs?.advise?.steps ?? [];
    const removeSymlinksIndex = steps.findIndex(
      (step) => step.name === "Remove symlinks from analysis workspace",
    );
    expect(removeSymlinksIndex).toBeGreaterThanOrEqual(0);

    const removeSymlinks = steps[removeSymlinksIndex];
    expect(removeSymlinks?.run).toContain('find "$ADVISOR_WORKDIR" -type l -print0');
    expect(removeSymlinks?.run).toContain('rm -- "$link"');

    const secretConsumingSteps = steps
      .map((step, index) => ({ index, step }))
      .filter(({ step }) => JSON.stringify(step).includes("secrets."));
    expect(secretConsumingSteps.length).toBeGreaterThan(0);

    for (const { index, step } of secretConsumingSteps) {
      expect(index, step.name ?? `workflow step ${index}`).toBeGreaterThan(removeSymlinksIndex);
    }
  });
});
