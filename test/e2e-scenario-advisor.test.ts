// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import path from "node:path";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { buildScenarioComment } from "../tools/e2e-advisor/scenario-comment.mts";
import {
  buildPrompt,
  buildSystemPrompt,
  normalizeScenarioAdvisorResult,
  renderScenarioSummary,
  type ScenarioAdvisorResult,
} from "../tools/e2e-advisor/scenarios.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCHEMA_PATH = path.join(ROOT, "tools/e2e-advisor/scenarios-schema.json");
const SCHEMA = JSON.parse(fs.readFileSync(SCHEMA_PATH, "utf8")) as Record<string, unknown>;

function metadata(overrides: Partial<{ baseRef: string; headRef: string; changedFiles: string[] }> = {}) {
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFiles: ["test/e2e-scenario/runtime/run-scenario.sh"],
    ...overrides,
  };
}

describe("E2E scenario advisor — schema and prompts", () => {
  it("schema requires the canonical scenario advisor result shape", () => {
    expect(SCHEMA).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "version",
        "baseRef",
        "headRef",
        "changedFiles",
        "relevantChangedFiles",
        "required",
        "optional",
        "noScenarioE2eReason",
        "confidence",
      ]),
    });
  });

  it("system prompt instructs the model on scope, sources, and dispatch contract", () => {
    const systemPrompt = buildSystemPrompt(SCHEMA);
    expect(systemPrompt).toContain("NemoClaw E2E Scenario advisor");
    expect(systemPrompt).toContain("test/e2e-scenario/");
    expect(systemPrompt).toContain(".github/workflows/e2e-scenarios.yaml");
    expect(systemPrompt).toContain("ROUTES");
    expect(systemPrompt).toContain(
      "gh workflow run e2e-scenarios.yaml --ref <pr-head-ref> --field scenarios=<id>",
    );
    expect(systemPrompt).toContain("e2e-scenarios-all");
    expect(systemPrompt).toContain("Do not invent IDs");
    // Schema is embedded so the model has the exact contract.
    expect(systemPrompt).toContain('"scenarioRecommendation"');
  });

  it("user prompt includes baseRef, headRef, changedFiles, and diff", () => {
    const prompt = buildPrompt({
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: ["test/e2e-scenario/validation_suites/messaging/telegram/foo.sh"],
      diff: "+++ b/test/e2e-scenario/validation_suites/messaging/telegram/foo.sh\n@@ +1 @@\n+echo ok",
    });
    expect(prompt).toContain('"origin/main"');
    expect(prompt).toContain('"HEAD"');
    expect(prompt).toContain("test/e2e-scenario/validation_suites/messaging/telegram/foo.sh");
    expect(prompt).toContain("```diff");
  });
});

describe("E2E scenario advisor — normalization", () => {
  it("preserves valid recommendations and emits schema-conformant output", () => {
    const raw = {
      version: 1,
      relevantChangedFiles: ["test/e2e-scenario/runtime/run-scenario.sh"],
      required: [
        {
          id: "e2e-scenarios-all",
          workflow: "e2e-scenarios-all.yaml",
          required: true,
          reason: "shared scenario runtime changed",
          dispatchCommand: "gh workflow run e2e-scenarios-all.yaml --ref <pr-head-ref>",
        },
      ],
      optional: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: "e2e-scenarios.yaml",
          scenario: "ubuntu-repo-cloud-openclaw",
          required: false,
          reason: "smoke confirmation on the canonical scenario",
          dispatchCommand:
            "gh workflow run e2e-scenarios.yaml --ref <pr-head-ref> --field scenarios=ubuntu-repo-cloud-openclaw",
        },
      ],
      noScenarioE2eReason: null,
      confidence: "high",
    };

    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.required).toHaveLength(1);
    expect(normalized.optional).toHaveLength(1);
    expect(normalized.required[0]?.required).toBe(true);
    expect(normalized.optional[0]?.required).toBe(false);

    const ajv = new Ajv2020({ strict: false });
    const validate = ajv.compile(SCHEMA);
    expect(validate(normalized)).toBe(true);
  });

  it("drops malformed recommendations and de-duplicates by id", () => {
    const raw = {
      required: [
        { id: "good", workflow: "e2e-scenarios.yaml", reason: "ok", dispatchCommand: "gh ..." },
        { id: "good", workflow: "e2e-scenarios.yaml", reason: "dup", dispatchCommand: "gh ..." },
        { id: "missing-reason", workflow: "e2e-scenarios.yaml", dispatchCommand: "gh ..." },
        { workflow: "e2e-scenarios.yaml", reason: "no id", dispatchCommand: "gh ..." },
      ],
      optional: [],
      noScenarioE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.required.map((item) => item.id)).toEqual(["good"]);
  });

  it("removes optional recommendations whose id duplicates a required one", () => {
    const raw = {
      required: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: "e2e-scenarios.yaml",
          required: true,
          reason: "primary",
          dispatchCommand: "gh ...",
        },
      ],
      optional: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: "e2e-scenarios.yaml",
          required: false,
          reason: "duplicate fallback",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-hermes",
          workflow: "e2e-scenarios.yaml",
          required: false,
          reason: "adjacent",
          dispatchCommand: "gh ...",
        },
      ],
      noScenarioE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeScenarioAdvisorResult(raw, metadata());
    expect(normalized.optional.map((item) => item.id)).toEqual(["ubuntu-repo-cloud-hermes"]);
  });

  it("filters relevantChangedFiles to the metadata changedFiles set", () => {
    const normalized = normalizeScenarioAdvisorResult(
      {
        relevantChangedFiles: [
          "test/e2e-scenario/runtime/run-scenario.sh",
          "fabricated/file.txt",
        ],
        required: [],
        optional: [],
        noScenarioE2eReason: "no impact",
        confidence: "low",
      },
      metadata({ changedFiles: ["test/e2e-scenario/runtime/run-scenario.sh"] }),
    );
    expect(normalized.relevantChangedFiles).toEqual([
      "test/e2e-scenario/runtime/run-scenario.sh",
    ]);
  });

  it("supplies a default noScenarioE2eReason when none provided and there are no recommendations", () => {
    const normalized = normalizeScenarioAdvisorResult(
      { required: [], optional: [], confidence: "low" },
      metadata({ changedFiles: ["docs/foo.md"] }),
    );
    expect(normalized.noScenarioE2eReason).toMatch(/no scenario E2E impact/i);
  });

  it("rejects non-object advisor output", () => {
    expect(() => normalizeScenarioAdvisorResult("nope", metadata())).toThrow(/non-object/);
    expect(() => normalizeScenarioAdvisorResult([], metadata())).toThrow(/non-object/);
  });
});

describe("E2E scenario advisor — summary and comment rendering", () => {
  function sampleResult(): ScenarioAdvisorResult {
    return {
      version: 1,
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: [".github/workflows/e2e-scenarios.yaml"],
      relevantChangedFiles: [".github/workflows/e2e-scenarios.yaml"],
      required: [
        {
          id: "e2e-scenarios-all",
          workflow: "e2e-scenarios-all.yaml",
          required: true,
          reason: "scenario workflow changed",
          dispatchCommand: "gh workflow run e2e-scenarios-all.yaml --ref <pr-head-ref>",
        },
      ],
      optional: [],
      noScenarioE2eReason: null,
      confidence: "high",
    };
  }

  it("renders a summary with the canonical sections", () => {
    const summary = renderScenarioSummary(sampleResult());
    expect(summary).toContain("# E2E Scenario Advisor");
    expect(summary).toContain("## Required scenario E2E");
    expect(summary).toContain("## Optional scenario E2E");
    expect(summary).toContain("## Relevant changed files");
    expect(summary).toContain("e2e-scenarios-all");
  });

  it("builds a sticky scenario comment with the marker, dispatch list, and run url", () => {
    const result = sampleResult();
    const summary = renderScenarioSummary(result);
    const comment = buildScenarioComment({
      summary,
      result,
      runUrl: "https://example.invalid/run",
    });
    expect(comment).toContain("<!-- nemoclaw-e2e-scenario-advisor -->");
    expect(comment).toContain("## E2E Scenario Advisor Recommendation");
    expect(comment).toContain("`e2e-scenarios-all`");
    expect(comment).toContain("https://example.invalid/run");
  });
});
