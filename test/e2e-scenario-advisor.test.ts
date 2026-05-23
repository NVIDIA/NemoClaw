// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildScenarioComment } from "../tools/e2e-advisor/scenario-comment.mts";
import {
  analyzeScenarioRecommendations,
  renderScenarioSummary,
} from "../tools/e2e-advisor/scenarios.mts";

const ROOT = new URL("../", import.meta.url).pathname;

function analyze(changedFiles: string[]) {
  return analyzeScenarioRecommendations({
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFiles,
    root: ROOT,
  });
}

describe("E2E scenario advisor", () => {
  it("requires all scenario E2E when the all-scenarios workflow changes", () => {
    const result = analyze([".github/workflows/e2e-scenarios-all.yaml"]);

    expect(result.required).toEqual([
      expect.objectContaining({
        id: "e2e-scenarios-all",
        workflow: "e2e-scenarios-all.yaml",
        dispatchCommand:
          "gh workflow run e2e-scenarios-all.yaml --ref <pr-head-ref>",
      }),
    ]);
    expect(result.noScenarioE2eReason).toBeNull();
  });

  it("requires targeted scenario E2E when a validation suite changes", () => {
    const result = analyze([
      "test/e2e/validation_suites/messaging/telegram/00-telegram-injection-safety.sh",
    ]);

    expect(result.required).toContainEqual(
      expect.objectContaining({
        id: "ubuntu-repo-docker__cloud-nvidia-openclaw-telegram:messaging-telegram",
        workflow: "e2e-scenarios.yaml",
        scenario: "ubuntu-repo-docker__cloud-nvidia-openclaw-telegram",
        suiteFilter: "messaging-telegram",
      }),
    );
  });

  it("requires all scenario E2E and targeted follow-up when suite metadata changes", () => {
    const result = analyze([
      "test/e2e/validation_suites/suites.yaml",
      "test/e2e/validation_suites/messaging/telegram/00-telegram-injection-safety.sh",
    ]);

    expect(result.required).toContainEqual(
      expect.objectContaining({ id: "e2e-scenarios-all" }),
    );
    expect(result.required).toContainEqual(
      expect.objectContaining({
        id: "ubuntu-repo-docker__cloud-nvidia-openclaw-telegram:messaging-telegram",
        scenario: "ubuntu-repo-docker__cloud-nvidia-openclaw-telegram",
        suiteFilter: "messaging-telegram",
      }),
    );
  });

  it("does not recommend scenario E2E for unrelated files", () => {
    const result = analyze(["docs/reference/commands.mdx"]);

    expect(result.required).toEqual([]);
    expect(result.optional).toEqual([]);
    expect(result.noScenarioE2eReason).toMatch(/No scenario workflow/);
  });

  it("renders a summary and second sticky scenario comment", () => {
    const result = analyze([".github/workflows/e2e-scenarios.yaml"]);
    const summary = renderScenarioSummary(result);
    const comment = buildScenarioComment({
      summary,
      result,
      runUrl: "https://example.invalid/run",
    });

    expect(summary).toContain("# E2E Scenario Advisor");
    expect(comment).toContain("<!-- nemoclaw-e2e-scenario-advisor -->");
    expect(comment).toContain("## E2E Scenario Advisor Recommendation");
    expect(comment).toContain("`e2e-scenarios-all`");
    expect(comment).toContain("https://example.invalid/run");
  });
});
