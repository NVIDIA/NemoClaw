// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { buildTargetComment } from "../tools/e2e-advisor/target-comment.mts";
import {
  buildPrompt,
  buildSystemPrompt,
  buildTargetPromptTurn,
  canonicalDispatchCommand,
  E2E_TARGET_ADVISOR_WORKFLOWS,
  type E2eTargetAdvisorResult,
  extractFreeStandingE2eJobs,
  normalizeE2eTargetAdvisorResult,
  renderTargetSummary,
} from "../tools/e2e-advisor/targets.mts";

// Tests target observable behavior of the target advisor pipeline:
//   raw model output -> normalizeE2eTargetAdvisorResult -> render/comment.
// Schema and prompt text are implementation details; only the contract that
// downstream consumers (sticky comment, CI loop dispatch) depend on is
// asserted here.

const E2E_WORKFLOW = "e2e.yaml";

function metadata(
  overrides: Partial<{ baseRef: string; headRef: string; changedFiles: string[] }> = {},
) {
  return {
    baseRef: "origin/main",
    headRef: "HEAD",
    changedFiles: ["test/e2e/registry/runtime-support.ts"],
    ...overrides,
  };
}

describe("E2E target advisor — prompt construction", () => {
  it("user prompt refers to context tools instead of embedding bulky metadata", () => {
    const prompt = buildPrompt({
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: ["test/e2e/fixtures/phases/onboarding.ts"],
      diff: "+ echo ok",
    });
    // Caller of normalizeE2eTargetAdvisorResult re-injects metadata; the prompt
    // now points at turn-scoped context tools instead of embedding bulky context.
    expect(prompt).toContain("context tools");
    expect(prompt).not.toContain("origin/main");
    expect(prompt).not.toContain("test/e2e/fixtures/phases/onboarding.ts");
    expect(prompt).not.toContain("+ echo ok");

    const turn = buildTargetPromptTurn({
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: ["test/e2e/fixtures/phases/onboarding.ts"],
      diff: "+ echo ok",
      schema: { $id: "test-schema", type: "object" },
    });
    expect(turn.contextToolResults?.map((result) => result.toolName)).toEqual([
      "e2e_target_metadata",
      "e2e_target_changed_files",
      "e2e_target_risk_plan",
      "e2e_target_git_diff",
      "e2e_target_response_schema",
    ]);
    expect(turn.contextToolResults?.[0]?.content).toContain("origin/main");
    expect(turn.contextToolResults?.[1]?.content).toContain(
      "test/e2e/fixtures/phases/onboarding.ts",
    );
    expect(turn.contextToolResults?.[2]?.content).toContain('"version":1');
    expect(turn.contextToolResults?.[3]?.content).toContain("+ echo ok");
    expect(turn.contextToolResults?.[4]?.content).toContain("test-schema");
    for (const result of turn.contextToolResults ?? []) {
      expect(turn.prompt).toContain(`\`${result.toolName}\``);
    }
  });

  it("system prompt is non-empty and points JSON schema lookup at a context tool", () => {
    // The model receives the schema through a turn-scoped context tool; the system
    // prompt still routes target recommendations to the E2E workflow rather
    // than the legacy typed-shell dispatch surfaces.
    const systemPrompt = buildSystemPrompt({ $id: "test-schema", type: "object" });
    expect(systemPrompt.length).toBeGreaterThan(0);
    expect(systemPrompt).not.toContain("test-schema");
    expect(systemPrompt).toContain("e2e_target_response_schema");
    expect(systemPrompt).toContain(E2E_WORKFLOW);
    expect(systemPrompt).toContain("trusted advisor checkout");
    expect(systemPrompt).toContain("recommend the `e2e-all` fan-out");
    expect(systemPrompt).toContain("single NemoClaw E2E system");
    expect(systemPrompt).toContain("onboard-resume");
    expect(systemPrompt).toContain("onboard-repair");
    expect(systemPrompt).not.toContain("non-target E2E");
    expect(systemPrompt).not.toContain("e2e-all.yaml");
    expect(systemPrompt).not.toContain("made-up-e2e.yaml");
  });

  it("exports the E2E target workflow for both targeted and fan-out recommendations", () => {
    expect(E2E_TARGET_ADVISOR_WORKFLOWS).toEqual({
      single: E2E_WORKFLOW,
      all: E2E_WORKFLOW,
    });
  });
});

describe("E2E target advisor — normalization contract", () => {
  it("enforces deterministic risk-plan jobs when the model recommends none", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [],
        optional: [],
        noTargetE2eReason: "No E2E needed",
        confidence: "low",
      },
      metadata({ changedFiles: ["src/lib/actions/upgrade-sandboxes.ts"] }),
    );

    expect(normalized.required.map((item) => item.id)).toEqual([
      "state-backup-restore",
      "upgrade-stale-sandbox",
    ]);
    expect(normalized.required.every((item) => item.required)).toBe(true);
    expect(normalized.noTargetE2eReason).toBeNull();
    expect(normalized.confidence).toBe("medium");
  });

  it("does not let a model downgrade a deterministic risk-plan job", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [],
        optional: [
          {
            id: "upgrade-stale-sandbox",
            workflow: E2E_WORKFLOW,
            selectorType: "job",
            reason: "model called the regression optional",
          },
        ],
        confidence: "high",
      },
      metadata({ changedFiles: ["src/lib/actions/upgrade-sandboxes.ts"] }),
    );

    expect(normalized.required.map((item) => item.id)).toContain("upgrade-stale-sandbox");
    expect(normalized.optional.map((item) => item.id)).not.toContain("upgrade-stale-sandbox");
  });

  it("preserves indirectly selected Hermes jobs in the deterministic risk floor", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      { required: [], optional: [], confidence: "low" },
      metadata({ changedFiles: ["src/lib/actions/sandbox/agents/apply.ts"] }),
    );

    expect(normalized.required.map((item) => item.id)).toEqual([
      "full-e2e",
      "hermes-e2e",
      "onboard-repair",
      "onboard-resume",
    ]);
    expect(normalized.required.every((item) => item.selectorType === "job")).toBe(true);
    expect(normalized.confidence).toBe("medium");
  });

  it("preserves valid recommendations and canonicalizes the dispatch command", () => {
    const raw = {
      version: 1,
      relevantChangedFiles: ["test/e2e/registry/runtime-support.ts"],
      required: [
        {
          id: "e2e-all",
          workflow: E2E_WORKFLOW,
          selectorType: "all",
          required: true,
          reason: "shared target runtime changed",
          // Model returns a non-canonical command; sanitizer must overwrite it.
          dispatchCommand: "gh workflow run e2e-all.yaml --ref main",
        },
      ],
      optional: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          target: "ubuntu-repo-cloud-openclaw",
          required: false,
          reason: "smoke confirmation on the canonical target",
          // Old (singular, with non-existent suite_filter input) shape.
          dispatchCommand:
            "gh workflow run made-up-e2e.yaml --ref main -f target=ubuntu-repo-cloud-openclaw -f suite_filter=smoke",
        },
      ],
      noTargetE2eReason: null,
      confidence: "high",
    };

    const normalized = normalizeE2eTargetAdvisorResult(raw, metadata());
    expect(normalized.required).toHaveLength(1);
    expect(normalized.optional).toHaveLength(1);
    expect(normalized.required[0]?.dispatchCommand).toBe(
      canonicalDispatchCommand(E2E_WORKFLOW, "e2e-all"),
    );
    expect(normalized.optional[0]?.dispatchCommand).toBe(
      canonicalDispatchCommand(E2E_WORKFLOW, "ubuntu-repo-cloud-openclaw"),
    );
    // Canonical fan-out command must not contain a targets field.
    expect(normalized.required[0]?.dispatchCommand).not.toContain("--field targets=");
    // Canonical single-target command must use plural --field targets=<id>
    // and must never contain the legacy suite_filter input.
    expect(normalized.optional[0]?.dispatchCommand).toContain(
      "--field targets=ubuntu-repo-cloud-openclaw",
    );
    expect(normalized.optional[0]?.dispatchCommand).not.toContain("suite_filter");
  });

  it("rejects unknown workflows", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: "made-up-e2e-targeted.yaml", // hallucinated workflow
            reason: "model invented a workflow",
            dispatchCommand: "gh workflow run made-up-e2e-targeted.yaml --ref main",
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
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: "made-up-e2e.yaml",
            reason: "legacy single-target workflow",
            dispatchCommand: "gh ...",
          },
          {
            id: "e2e-all",
            workflow: "e2e-all.yaml",
            reason: "legacy fan-out workflow",
            dispatchCommand: "gh ...",
          },
          {
            id: "e2e-all",
            workflow: E2E_WORKFLOW,
            selectorType: "all",
            reason: "valid Vitest fan-out",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [],
        confidence: "medium",
      },
      metadata(),
    );
    expect(normalized.required.map((item) => item.id)).toEqual(["e2e-all"]);
  });

  it("forces the required flag from the array position, ignoring the model's value", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: E2E_WORKFLOW,
            selectorType: "target",
            // Model claims this required item is actually optional.
            required: false,
            reason: "in required[] but model marked optional",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [
          {
            id: "ubuntu-repo-docker-post-reboot-recovery",
            workflow: E2E_WORKFLOW,
            selectorType: "target",
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
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "ubuntu;rm -rf /",
            workflow: E2E_WORKFLOW,
            selectorType: "target",
            reason: "shell injection attempt",
            dispatchCommand: "gh ...",
          },
          {
            id: "Ubuntu_Repo_Cloud", // not kebab
            workflow: E2E_WORKFLOW,
            selectorType: "target",
            reason: "non-canonical id",
            dispatchCommand: "gh ...",
          },
          {
            id: "ubuntu-repo-cloud-openclaw",
            workflow: E2E_WORKFLOW,
            selectorType: "target",
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
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          reason: "ok",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          reason: "dup",
          dispatchCommand: "gh ...",
        },
        {
          id: "valid-kebab-but-not-in-registry",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          reason: "unknown target",
          dispatchCommand: "gh ...",
        },
        { id: "missing-reason", workflow: E2E_WORKFLOW, dispatchCommand: "gh ..." },
        { workflow: E2E_WORKFLOW, reason: "no id", dispatchCommand: "gh ..." },
      ],
      optional: [],
      noTargetE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeE2eTargetAdvisorResult(raw, metadata());
    expect(normalized.required.map((item) => item.id)).toEqual(["ubuntu-repo-cloud-openclaw"]);
  });

  it("drops unknown or unsupported registry ids while preserving live-supported ids and fan-out", () => {
    const raw = {
      required: [
        {
          id: "valid-kebab-but-not-in-registry",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          reason: "model invented a target",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-hermes",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          reason: "registry target not wired for live Vitest fixtures",
          dispatchCommand: "gh ...",
        },
        {
          id: "e2e-all",
          workflow: E2E_WORKFLOW,
          selectorType: "all",
          reason: "shared target runtime changed",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          reason: "known target",
          dispatchCommand: "gh ...",
        },
      ],
      optional: [],
      noTargetE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeE2eTargetAdvisorResult(raw, metadata());
    expect(normalized.required.map((item) => item.id)).toEqual([
      "e2e-all",
      "ubuntu-repo-cloud-openclaw",
    ]);
  });

  it("suppresses fan-out for a new free-standing live test that is not workflow-wired", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "e2e-all",
            workflow: E2E_WORKFLOW,
            selectorType: "all",
            reason: "model tried to fan out for an unwired free-standing test",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [],
        noTargetE2eReason: null,
        confidence: "high",
      },
      metadata({ changedFiles: ["test/e2e/live/rebuild-openclaw.test.ts"] }),
      { e2eWorkflowText: "jobs:\n  live-targets:\n    steps: []\n" },
    );

    expect(normalized.required).toEqual([]);
    expect(normalized.optional).toEqual([]);
    expect(normalized.noTargetE2eReason).toContain("not wired into `.github/workflows/e2e.yaml`");
    expect(normalized.noTargetE2eReason).toContain("test/e2e/live/rebuild-openclaw.test.ts");
  });

  it("keeps the deterministic floor while suppressing unwired-test fan-out", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "e2e-all",
            workflow: E2E_WORKFLOW,
            selectorType: "all",
            reason: "model tried to fan out for an unwired free-standing test",
          },
        ],
        optional: [],
        confidence: "low",
      },
      metadata({
        changedFiles: [
          "src/lib/actions/sandbox/agents/apply.ts",
          "test/e2e/live/new-unwired-agent-proof.test.ts",
        ],
      }),
      { e2eWorkflowText: "jobs:\n  live-targets:\n    steps: []\n" },
    );

    expect(normalized.required.map((item) => item.id)).toEqual([
      "full-e2e",
      "hermes-e2e",
      "onboard-repair",
      "onboard-resume",
    ]);
    expect(normalized.noTargetE2eReason).toBeNull();
    expect(normalized.confidence).toBe("medium");
  });

  it("extracts free-standing E2E jobs from workflow job selectors", () => {
    expect(
      extractFreeStandingE2eJobs(String.raw`
jobs:
  live-targets:
    if: \${{ inputs.jobs == '' }}
    steps:
      - run: npx vitest run --project e2e-live test/e2e/live/registry-targets.test.ts
  token-rotation:
    if: \${{ (inputs.jobs == '' && inputs.targets == '') || contains(format(',{0},', inputs.jobs), ',token-rotation,') }}
    steps:
      - run: npx vitest run --project e2e-live test/e2e/live/token-rotation.test.ts
`),
    ).toEqual([
      {
        id: "token-rotation",
        liveTestFiles: ["test/e2e/live/token-rotation.test.ts"],
      },
    ]);
  });

  it("prefers a focused free-standing job over fan-out once workflow wiring is present", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "e2e-all",
            workflow: E2E_WORKFLOW,
            selectorType: "all",
            reason: "model tried to fan out for a workflow-wired free-standing test",
            dispatchCommand: "gh ...",
          },
        ],
        optional: [],
        noTargetE2eReason: null,
        confidence: "high",
      },
      metadata({
        changedFiles: [".github/workflows/e2e.yaml", "test/e2e/live/token-rotation.test.ts"],
      }),
      {
        e2eWorkflowText: String.raw`
jobs:
  token-rotation:
    if: \${{ (inputs.jobs == '' && inputs.targets == '') || contains(format(',{0},', inputs.jobs), ',token-rotation,') }}
    steps:
      - run: npx vitest run --project e2e-live test/e2e/live/token-rotation.test.ts
`,
      },
    );

    expect(normalized.required.map((item) => [item.selectorType, item.id])).toEqual([
      ["job", "cloud-onboard"],
      ["job", "token-rotation"],
    ]);
    expect(normalized.required.find((item) => item.id === "token-rotation")?.dispatchCommand).toBe(
      "gh workflow run e2e.yaml --ref <pr-head-ref> --field jobs=token-rotation",
    );
    expect(normalized.noTargetE2eReason).toBeNull();
  });

  it("accepts a model-provided free-standing job recommendation when the job is workflow-wired", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        required: [
          {
            id: "token-rotation",
            workflow: E2E_WORKFLOW,
            selectorType: "job",
            reason: "focused job covers the changed live test",
            dispatchCommand: "malicious non-canonical command",
          },
        ],
        optional: [],
        noTargetE2eReason: null,
        confidence: "high",
      },
      metadata({ changedFiles: ["test/e2e/live/token-rotation.test.ts"] }),
      {
        e2eWorkflowText: String.raw`
jobs:
  token-rotation:
    if: \${{ contains(format(',{0},', inputs.jobs), ',token-rotation,') }}
    steps:
      - run: npx vitest run --project e2e-live test/e2e/live/token-rotation.test.ts
`,
      },
    );

    expect(normalized.required.map((item) => [item.selectorType, item.id])).toEqual([
      ["job", "token-rotation"],
    ]);
    expect(normalized.required[0]?.dispatchCommand).toBe(
      "gh workflow run e2e.yaml --ref <pr-head-ref> --field jobs=token-rotation",
    );
  });

  it("removes optional recommendations whose id duplicates a required one", () => {
    const raw = {
      required: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          required: true,
          reason: "primary",
          dispatchCommand: "gh ...",
        },
      ],
      optional: [
        {
          id: "ubuntu-repo-cloud-openclaw",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          required: false,
          reason: "duplicate fallback",
          dispatchCommand: "gh ...",
        },
        {
          id: "ubuntu-repo-docker-post-reboot-recovery",
          workflow: E2E_WORKFLOW,
          selectorType: "target",
          required: false,
          reason: "adjacent",
          dispatchCommand: "gh ...",
        },
      ],
      noTargetE2eReason: null,
      confidence: "medium",
    };
    const normalized = normalizeE2eTargetAdvisorResult(raw, metadata());
    expect(normalized.optional.map((item) => item.id)).toEqual([
      "ubuntu-repo-docker-post-reboot-recovery",
    ]);
  });

  it("filters relevantChangedFiles to the metadata changedFiles set", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      {
        relevantChangedFiles: ["test/e2e/registry/runtime-support.ts", "fabricated/file.txt"],
        required: [],
        optional: [],
        noTargetE2eReason: "no impact",
        confidence: "low",
      },
      metadata({ changedFiles: ["test/e2e/registry/runtime-support.ts"] }),
    );
    expect(normalized.relevantChangedFiles).toEqual(["test/e2e/registry/runtime-support.ts"]);
  });

  it("supplies a default noTargetE2eReason when none provided and there are no recommendations", () => {
    const normalized = normalizeE2eTargetAdvisorResult(
      { required: [], optional: [], confidence: "low" },
      metadata({ changedFiles: ["docs/foo.md"] }),
    );
    expect(normalized.noTargetE2eReason).toMatch(/no E2E target impact/i);
  });

  it("rejects non-object advisor output", () => {
    expect(() => normalizeE2eTargetAdvisorResult("nope", metadata())).toThrow(/non-object/);
    expect(() => normalizeE2eTargetAdvisorResult([], metadata())).toThrow(/non-object/);
  });
});

describe("E2E target advisor — summary and comment rendering", () => {
  function sampleResult(): E2eTargetAdvisorResult {
    return {
      version: 1,
      baseRef: "origin/main",
      headRef: "HEAD",
      changedFiles: [".github/workflows/e2e.yaml"],
      relevantChangedFiles: [".github/workflows/e2e.yaml"],
      required: [
        {
          id: "e2e-all",
          workflow: E2E_WORKFLOW,
          selectorType: "all",
          required: true,
          reason: "target workflow changed",
          dispatchCommand: canonicalDispatchCommand(E2E_WORKFLOW, "e2e-all"),
        },
      ],
      optional: [],
      noTargetE2eReason: null,
      confidence: "high",
    };
  }

  it("renders a summary that surfaces required targets with their dispatch line", () => {
    const summary = renderTargetSummary(sampleResult());
    expect(summary).toContain("# E2E Target Advisor");
    expect(summary).toContain("Required E2E targets");
    expect(summary).toContain("e2e-all");
    expect(summary).toContain(canonicalDispatchCommand(E2E_WORKFLOW, "e2e-all"));
  });

  it("builds a sticky target comment with the marker and run url", () => {
    const result = sampleResult();
    const summary = renderTargetSummary(result);
    const comment = buildTargetComment({
      summary,
      result,
      runUrl: "https://example.invalid/run",
    });
    expect(comment).toContain("<!-- nemoclaw-e2e-target-advisor -->");
    expect(comment).toContain("## E2E Target Recommendation");
    expect(comment).toContain("Dispatch required E2E targets");
    expect(comment).toContain("https://example.invalid/run");
  });
});
