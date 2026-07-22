// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { REPO_ROOT } from "../fixtures/paths.ts";
import type { ProgressSummary } from "../fixtures/progress.ts";

const VITEST = path.join(REPO_ROOT, "node_modules", "vitest", "vitest.mjs");
const FIXTURE = "test/e2e/support/fixtures/workflow-e2e-progress.fixture.test.ts";
const ARTIFACT_SLUG = "records-shared-job-identity-without-exposing-secrets";

describe("workflow-selected integration progress", () => {
  it("falls back to the job identity and redacts console and artifact output", () => {
    const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-workflow-progress-"));
    const sensitiveTarget = "workflow-fixture-sensitive-target";
    try {
      const result = spawnSync(
        process.execPath,
        [VITEST, "run", "--project", "e2e-support", FIXTURE, "--reporter=default"],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          killSignal: "SIGKILL",
          timeout: 20_000,
          env: {
            ...process.env,
            E2E_ARTIFACT_DIR: artifactRoot,
            E2E_TARGET_ID: "",
            GITHUB_JOB: sensitiveTarget,
            NEMOCLAW_RUN_LIVE_E2E: "1",
            NEMOCLAW_WORKFLOW_PROGRESS_FIXTURE: "redacted-fallback",
            WORKFLOW_FIXTURE_API_KEY: sensitiveTarget,
          },
        },
      );

      const output = `${result.stdout}\n${result.stderr}`;
      expect(result.status, output).toBe(0);
      expect(output).not.toContain(sensitiveTarget);
      expect(output).toContain('target="[REDACTED]"');

      const artifactText = fs.readFileSync(
        path.join(artifactRoot, ARTIFACT_SLUG, "test-progress.json"),
        "utf8",
      );
      const summary = JSON.parse(artifactText) as ProgressSummary;
      expect(artifactText).not.toContain(sensitiveTarget);
      expect(summary).toMatchObject({
        scenario: "records shared-job identity without exposing secrets",
        targetId: "[REDACTED]",
        version: 1,
      });
      expect(summary.phases.at(-1)).toMatchObject({
        label: "release shared workflow fixture",
        outcome: "passed",
      });
    } finally {
      fs.rmSync(artifactRoot, { force: true, recursive: true });
    }
  });
});
