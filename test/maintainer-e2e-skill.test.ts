// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const skillDirectory = path.join(process.cwd(), ".agents", "skills", "nemoclaw-maintainer-e2e");
const skill = fs.readFileSync(path.join(skillDirectory, "SKILL.md"), "utf8");
const mainRuns = fs.readFileSync(path.join(skillDirectory, "references", "main-runs.md"), "utf8");
const manualPr = fs.readFileSync(path.join(skillDirectory, "references", "manual-pr.md"), "utf8");
const e2eReadme = fs.readFileSync(path.join(process.cwd(), "test", "e2e", "README.md"), "utf8");

describe("nemoclaw-maintainer-e2e workflow routing", () => {
  it("reports the newest identifiable full run without making a tag decision", () => {
    expect(skill).toContain("[Manual PR Runs](references/manual-pr.md)");
    expect(skill).toContain("[Main Runs](references/main-runs.md)");
    expect(skill).toContain("Inspect the Latest Full Main Run");
    expect(skill).toContain("--event workflow_dispatch --branch main --limit 100");
    expect(skill).toContain('startswith("E2E full main")');
    expect(skill).toContain("displayTitle,attempt,createdAt");
    expect(skill).toContain('.name == "Release qualification"');
    expect(skill).toContain("startedAt,completedAt,url");
    expect(skill).toContain("exact `createdAt`, `startedAt`, and `updatedAt` values");
    expect(skill).toContain("workflow attempt");
    expect(skill).toContain("--attempt <attempt>");
    expect(skill).not.toContain("completion time");
    expect(skill).toContain("state whether the tested commit matches it");
    expect(skill).toMatch(/Do not\s+reject a different commit/u);
    expect(skill).toContain("or decide whether tagging can proceed");
    expect(skill).toContain("The release-tag skill");
    expect(skill).not.toContain("The tagging workflow owns");
    expect(e2eReadme).toMatch(/The\s+release-tag skill records only the general E2E decision/u);
    expect(e2eReadme).not.toContain("The tagging workflow records");
    expect(skill).not.toContain("gh workflow run");
  });

  it("keeps ordinary, focused, Launchable, and strict full dispatches distinct", () => {
    expect(mainRuns).toContain("| “Run the E2E suite” | `ordinary`");
    expect(mainRuns).toContain("| “Run focused E2E” | `focused`");
    expect(mainRuns).toContain("| “Run the Launchable E2E” | `launchable`");
    expect(mainRuns).toContain("| “Run the full E2E suite” | `full`");
    expect(mainRuns).toContain("must not authorize the Brev Launchable path");
    expect(mainRuns).toContain("Exact staging Brev Launchable");
    expect(mainRuns).toContain("every release-required job must succeed");
    expect(mainRuns).toContain('-f "include_staging_brev_launchable=${INCLUDE_LAUNCHABLE}"');
    expect(mainRuns).toContain('RUN_TITLE="E2E full main (${CORRELATION_ID})"');
    expect(mainRuns).toMatch(/Find it with bounded reads:\n\n```bash\nset -euo pipefail/u);
    expect(mainRuns).toContain('test "$RUN_SHA" = "$CANDIDATE_SHA"');
    expect(mainRuns).toContain("It is not a tag-authorization rule");
    expect(mainRuns).toContain("launchable-e2e.json");
    expect(mainRuns).toContain("full-e2e.log");
    expect(mainRuns).toContain("cleanup.json");
    expect(mainRuns).toContain("test/e2e/README.md#push-and-manual-pr-e2e");
    expect(mainRuns).toContain("credential locations, access, lifetimes");
    expect(mainRuns).not.toContain("release_qualification_waived_jobs");
    expect(mainRuns).not.toContain("waiver artifact");
  });

  it("preserves trusted exact-revision PR modes and the dispatch receipt", () => {
    expect(manualPr).toContain("PR_NUMBER=123");
    expect(manualPr).toContain("jobs=inference-routing");
    expect(manualPr).toContain("jobs=managed-image-protected-runtime");
    expect(manualPr).toContain("ci/protected-managed-image-multiarch-activation-v1.json");
    expect(manualPr).toContain("ci/protected-managed-image-runtime-activation-v1.json");
    expect(manualPr).toContain("jobs=native-runtime-qualification-producer");
    expect(manualPr).toContain("NATIVE_RUNTIME_EPHEMERAL_RUNNER_POOL=enabled");
    expect(manualPr).toContain("NATIVE_RUNTIME_ARM64_GPU_RUNNER_LABEL");
    expect(manualPr).toContain("test/e2e/live/native-runtime-qualification-case.test.ts");
    expect(manualPr).toContain("targets=jetson-nvmap-gpu");
    expect(manualPr).toContain("HTTP contract version `1.0.0`");
    expect(manualPr).toContain("`JETSON_DISPATCH_URL` is set to the verified HTTPS origin");
    expect(manualPr).toContain("test/e2e/docs/jetson-dispatch.md");
    expect(manualPr).toContain("checks out the latest PR commit");
    expect(manualPr).not.toContain("current PR head");
    expect(manualPr).toContain('-f "checkout_sha=${HEAD_SHA}"');
    expect(manualPr).toContain('-f "base_sha=${BASE_SHA}"');
    expect(manualPr).toContain('-f "workflow_sha=${WORKFLOW_SHA}"');
    expect(manualPr).toContain("nemoclaw-e2e-dispatch-v2");
    expect(manualPr).toMatch(/## Find and Verify the Run\n\n```bash\nset -euo pipefail/u);
    expect(manualPr).toContain("The Exact staging Brev Launchable path is not available");
  });
});
