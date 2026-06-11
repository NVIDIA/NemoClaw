// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildScenarioComment } from "../tools/e2e-advisor/scenario-comment.mts";
import {
  buildPrompt,
  buildSystemPrompt,
  canonicalDispatchCommand,
  normalizeScenarioAdvisorResult,
  renderScenarioSummary,
  SCENARIO_ADVISOR_WORKFLOWS,
  type ScenarioAdvisorResult,
} from "../tools/e2e-advisor/scenarios.mts";

// Tests target observable behavior of the scenario advisor pipeline:
//   raw model output -> normalizeScenarioAdvisorResult -> render/comment.
// Schema and prompt text are implementation details; only the contract that
// downstream consumers (sticky comment, CI loop dispatch) depend on is
// asserted here.

const VITEST_SCENARIO_WORKFLOW = "e2e-vitest-scenarios.yaml";

function metadata(
  overrides: Partial<{ baseRef: string; headRef: string; changedFiles: string[] }> = {},
) {
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFiles: ["test/e2e-scenario/scenarios/runtime-support.ts"],
    ...overrides,
  };
}

describe("Vitest E2E scenario advisor — prompt construction", () => {
  it("user prompt embeds the metadata fields the advisor must echo back", () => {
    const prompt = buildPrompt({
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: ["test/e2e-scenario/fixtures/phases/onboarding.ts"],
      diff: "+ echo ok",
    });
    // Caller of normalizeScenarioAdvisorResult re-injects metadata, but the
    // prompt must still surface enough context for the model to reason.
    expect(prompt).toContain("origin/main");
    expect(prompt).toContain("test/e2e-scenario/fixtures/phases/onboarding.ts");
    expect(prompt).toContain("+ echo ok");
  });

  it("system prompt is non-empty and embeds the JSON schema for the model", () => {
    // The model receives the schema inline; we only assert that the prompt
    // exists, includes the schema discriminator, and routes scenario
    // recommendations to the Vitest workflow rather than the legacy
    // typed-shell dispatch surfaces.
    const systemPrompt = buildSystemPrompt({ $id: "test-schema", type: "object" });
    expect(systemPrompt.length).toBeGreaterThan(0);
    expect(systemPrompt).toContain("test-schema");
    expect(systemPrompt).toContain(VITEST_SCENARIO_WORKFLOW);
    expect(systemPrompt).toContain("trusted advisor checkout");
    expect(systemPrompt).toContain("recommend the `e2e-scenarios-all` fan-out");
    expect(systemPrompt).toContain("single NemoClaw E2E system");
    expect(systemPrompt).not.toContain("non-scenario E2E");
    expect(systemPrompt).not.toContain("e2e-scenarios-all.yaml");
    expect(systemPrompt).not.toContain("e2e-scenarios.yaml");
  });

  it("exports the Vitest scenario workflow for both targeted and fan-out recommendations", () => {
    expect(SCENARIO_ADVISOR_WORKFLOWS).toEqual({
      single: VITEST_SCENARIO_WORKFLOW,
      all: VITEST_SCENARIO_WORKFLOW,
    });
  });
});

describe("Vitest E2E scenario advisor — normalization contract", () => {
  it("preserves valid recommendations and canonicalizes the dispatch command", () => {
    const raw = {
      version: 1,
      relevantChangedFiles: ["test/e2e-scenario/scenarios/runtime-support.ts"],
      required: [
        {
          id: "e2e-scenarios-all",
          workflow: VITEST_SCENARIO_WORKFLOW,
          required: true,
          reason: "shared scenario runtime changed",
          // Model returns a non-canonical command; sanitizer must overwrite it.
          dispatchCommand: "gh workflow run e2e-scenarios-all.yaml --ref main",
        },
      ],
      optional: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: VITEST_SCENARIO_WORKFLOW,
          scenario: "ubuntu-repo-cloud-openclaw",
          required: false,
          reason: "smoke confirmation on the canonical scenario",
          // Old (singular, with non-existent suite_filter input) shape.
          dispatchCommand:
            "gh workflow run e2e-scenarios.yaml --ref main -f scenario=ubuntu-repo-cloud-openclaw -f suite_filter=smoke",
        },
      ],
      noScenarioE2eReason: null,
      confidence: "high",
    };

    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.required).toHaveLength(1);
    expect(normalized.optional).toHaveLength(1);
    expect(normalized.required[0]?.dispatchCommand).toBe(
      canonicalDispatchCommand(VITEST_SCENARIO_WORKFLOW, "e2e-scenarios-all"),
    );
    expect(normalized.optional[0]?.dispatchCommand).toBe(
      canonicalDispatchCommand(VITEST_SCENARIO_WORKFLOW, "ubuntu-repo-cloud-openclaw"),
    );
    // Canonical fan-out command must not contain a scenarios field.
    expect(normalized.required[0]?.dispatchCommand).not.toContain("--field scenarios=");
    // Canonical single-scenario command must use plural --field scenarios=<id>
    // and must never contain the legacy suite_filter input.
    expect(normalized.optional[0]?.dispatchCommand).toContain(
      "--field scenarios=ubuntu-repo-cloud-openclaw",
    );
    expect(normalized.optional[0]?.dispatchCommand).not.toContain("suite_filter");
  });

  it("rejects unknown workflows", () => {
    const normalized = normalizeScenarioAdvisorResult(
      {
        required: [
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: "e2e-scenarios-targeted.yaml", // hallucinated workflow
            reason: "model invented a workflow",
            dispatchCommand: "gh workflow run e2e-scenarios-targeted.yaml --ref main",
          },
        ],
        optional: [],
        confidence: "medium",
      },
      metadata(),
    );
    expect(normalized.required).toHaveLength(0);
  });

  it("rejects legacy typed-shell workflows while accepting Vitest fan-out", () => {
    const normalized = normalizeScenarioAdvisorResult(
      {
        required: [
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: "e2e-scenarios.yaml",
            reason: "legacy single-scenario workflow",
            dispatchCommand: "gh ...",
          },
          {
            id: "e2e-scenarios-all",
            workflow: "e2e-scenarios-all.yaml",
            reason: "legacy fan-out workflow",
            dispatchCommand: "gh ...",
          },
          {
            id: "e2e-scenarios-all",
            workflow: VITEST_SCENARIO_WORKFLOW,
            reason: "valid Vitest fan-out",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [],
        confidence: "medium",
      },
      metadata(),
    );
    expect(normalized.required.map((item) => item.id)).toEqual(["e2e-scenarios-all"]);
  });

  it("forces the required flag from the array position, ignoring the model's value", () => {
    const normalized = normalizeScenarioAdvisorResult(
      {
        required: [
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: VITEST_SCENARIO_WORKFLOW,
            // Model claims this required item is actually optional.
            required: false,
            reason: "in required[] but model marked optional",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [
          {
            id: "ubuntu-repo-docker-post-reboot-recovery",
            workflow: VITEST_SCENARIO_WORKFLOW,
            // Model claims this optional item is actually required.
            required: true,
            reason: "in optional[] but model marked required",
            dispatchCommand: "gh ...",
          },
        ],
        confidence: "medium",
      },
      metadata(),
    );
    expect(normalized.required[0]?.required).toBe(true);
    expect(normalized.optional[0]?.required).toBe(false);
  });

  it("rejects ids that contain shell metacharacters or non-kebab tokens", () => {
    const normalized = normalizeScenarioAdvisorResult(
      {
        required: [
          {
            id: "ubuntu;rm -rf /",
            workflow: VITEST_SCENARIO_WORKFLOW,
            reason: "shell injection attempt",
            dispatchCommand: "gh ...",
          },
          {
            id: "Ubuntu_Repo_Cloud", // not kebab
            workflow: VITEST_SCENARIO_WORKFLOW,
            reason: "non-canonical id",
            dispatchCommand: "gh ...",
          },
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: VITEST_SCENARIO_WORKFLOW,
            reason: "valid",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [],
        confidence: "medium",
      },
      metadata(),
    );
    expect(normalized.required.map((item) => item.id)).toEqual(["ubuntu-repo-cloud-openclaw"]);
  });

  it("drops malformed recommendations and de-duplicates by id", () => {
    const raw = {
      required: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "ok",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "dup",
          dispatchCommand: "gh ...",
        },
        {
          id: "valid-kebab-but-not-in-registry",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "unknown scenario",
          dispatchCommand: "gh ...",
        },
        { id: "missing-reason", workflow: VITEST_SCENARIO_WORKFLOW, dispatchCommand: "gh ..." },
        { workflow: VITEST_SCENARIO_WORKFLOW, reason: "no id", dispatchCommand: "gh ..." },
      ],
      optional: [],
      noScenarioE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.required.map((item) => item.id)).toEqual(["ubuntu-repo-cloud-openclaw"]);
  });

  it("drops unknown or unsupported registry ids while preserving live-supported ids and fan-out", () => {
    const raw = {
      required: [
        {
          id: "valid-kebab-but-not-in-registry",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "model invented a scenario",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-hermes",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "registry scenario not wired for live Vitest fixtures",
          dispatchCommand: "gh ...",
        },
        {
          id: "e2e-scenarios-all",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "shared scenario runtime changed",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: VITEST_SCENARIO_WORKFLOW,
          reason: "known scenario",
          dispatchCommand: "gh ...",
        },
      ],
      optional: [],
      noScenarioE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.required.map((item) => item.id)).toEqual([
      "e2e-scenarios-all",
      "ubuntu-repo-cloud-openclaw",
    ]);
  });

  it("removes optional recommendations whose id duplicates a required one", () => {
    const raw = {
      required: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: VITEST_SCENARIO_WORKFLOW,
          required: true,
          reason: "primary",
          dispatchCommand: "gh ...",
        },
      ],
      optional: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: VITEST_SCENARIO_WORKFLOW,
          required: false,
          reason: "duplicate fallback",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-docker-post-reboot-recovery",
          workflow: VITEST_SCENARIO_WORKFLOW,
          required: false,
          reason: "adjacent",
          dispatchCommand: "gh ...",
        },
      ],
      noScenarioE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.optional.map((item) => item.id)).toEqual([
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
  });

  it("filters relevantChangedFiles to the metadata changedFiles set", () => {
    const normalized = normalizeScenarioAdvisorResult(
      {
        relevantChangedFiles: [
          "test/e2e-scenario/scenarios/runtime-support.ts",
          "fabricated/file.txt",
        ],
        required: [],
        optional: [],
        noScenarioE2eReason: "no impact",
        confidence: "low",
      },
      metadata({ changedFiles: ["test/e2e-scenario/scenarios/runtime-support.ts"] }),
    );
    expect(normalized.relevantChangedFiles).toEqual([
      "test/e2e-scenario/scenarios/runtime-support.ts",
    ]);
  });

  it("supplies a default noScenarioE2eReason when none provided and there are no recommendations", () => {
    const normalized = normalizeScenarioAdvisorResult(
      { required: [], optional: [], confidence: "low" },
      metadata({ changedFiles: ["docs/foo.md"] }),
    );
    expect(normalized.noScenarioE2eReason).toMatch(/no Vitest E2E scenario impact/i);
  });

  it("rejects non-object advisor output", () => {
    expect(() => normalizeScenarioAdvisorResult("nope", metadata())).toThrow(/non-object/);
    expect(() => normalizeScenarioAdvisorResult([], metadata())).toThrow(/non-object/);
  });
});

describe("Vitest E2E scenario advisor — summary and comment rendering", () => {
  function sampleResult(): ScenarioAdvisorResult {
    return {
      version: 1,
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: [".github/workflows/e2e-vitest-scenarios.yaml"],
      relevantChangedFiles: [".github/workflows/e2e-vitest-scenarios.yaml"],
      required: [
        {
          id: "e2e-scenarios-all",
          workflow: VITEST_SCENARIO_WORKFLOW,
          required: true,
          reason: "scenario workflow changed",
          dispatchCommand: canonicalDispatchCommand(VITEST_SCENARIO_WORKFLOW, "e2e-scenarios-all"),
        },
      ],
      optional: [],
      noScenarioE2eReason: null,
      confidence: "high",
    };
  }

  it("renders a summary that surfaces required scenarios with their dispatch line", () => {
    const summary = renderScenarioSummary(sampleResult());
    expect(summary).toContain("# Vitest E2E Scenario Advisor");
    expect(summary).toContain("Required Vitest E2E scenarios");
    expect(summary).toContain("e2e-scenarios-all");
    expect(summary).toContain(
      canonicalDispatchCommand(VITEST_SCENARIO_WORKFLOW, "e2e-scenarios-all"),
    );
  });

  it("builds a sticky scenario comment with the marker and run url", () => {
    const result = sampleResult();
    const summary = renderScenarioSummary(result);
    const comment = buildScenarioComment({
      summary,
      result,
      runUrl: "https://example.invalid/run",
    });
    expect(comment).toContain("<!-- nemoclaw-e2e-scenario-advisor -->");
    expect(comment).toContain("## Vitest E2E Scenario Recommendation");
    expect(comment).toContain("Dispatch required Vitest E2E scenarios");
    expect(comment).toContain("https://example.invalid/run");
  });
});
