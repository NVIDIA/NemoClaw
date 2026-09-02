// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { canonicalRepoReadPath } from "../../../tools/advisors/repo-read-only-tools.mts";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { TERMINOLOGY_TRACE_TOOL } from "../../../tools/pr-review-advisor/terminology.mts";
import { runSpecialistAdvisor, writeSpecialistSummary } from "../../../tools/pr-review-advisor/run-specialist.mts";
import { writeSpecialistDiff } from "../../../tools/pr-review-advisor/specialist-context.mts";
import type { RunAdvisorResult, RunReadOnlyAdvisorOptions } from "../../../tools/advisors/session.mts";
import {
  ADVISOR_INTERESTS,
  buildSpecialistInvestigateTurn,
  parseAdvisorInterest,
  readAdvisorSpecialists,
  type AdvisorInterest,
} from "../../../tools/pr-review-advisor/specialists.mts";
import type { InvestigateTurnContext } from "../../../tools/pr-review-advisor/investigate-turn.mts";

type CallableTool = ToolDefinition & {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{ content: Array<{ type: string; text?: string }> }>;
};

const context: InvestigateTurnContext = {
  scopeRisk: { riskPlan: { invariants: ["preserve identity"] } },
  diffPath: ".pr-review-advisor-context/diff.patch",
  controlledWords: "controlled words",
  terminology: { candidates: [] },
  correctness: { state: "context" },
  security: { riskyAreas: [] },
  tests: { testDepth: "unit" },
  operations: { workflowSignals: [] },
  reconciliation: { linkedIssues: [] },
  metadata: "baseRef=origin/main",
};

describe("PR review advisor specialist prompts", () => {
  it("writes readable diff evidence in the prepared advisor context", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specialist-context-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const expected = path.join(directory, "diff.patch");

    const file = writeSpecialistDiff(directory, "diff evidence");

    expect(file).toBe(expected);
    await expect(canonicalRepoReadPath(directory, "diff.patch")).resolves.toBe(expected);
    expect(fs.readFileSync(file, "utf8")).toBe("diff evidence");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("tightens an existing specialist diff path", () => {
    const configDir = fs.mkdtempSync(path.join(process.cwd(), ".tmp-specialist-config-"));
    onTestFinished(() => fs.rmSync(configDir, { recursive: true, force: true }));
    const directory = configDir;
    const expected = path.join(directory, "diff.patch");
    fs.chmodSync(directory, 0o755);
    fs.writeFileSync(expected, "stale", { mode: 0o644 });

    writeSpecialistDiff(directory, "diff evidence");

    expect(fs.readFileSync(expected, "utf8")).toBe("diff evidence");
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
    expect(fs.statSync(expected).mode & 0o777).toBe(0o600);
  });

  it("rejects a symbolic-link specialist diff file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specialist-context-"));
    const target = path.join(directory, "outside.patch");
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(target, "unchanged");
    fs.symlinkSync(target, path.join(directory, "diff.patch"));

    expect(() => writeSpecialistDiff(directory, "diff evidence")).toThrow(
      "Specialist diff file must not be a symbolic link",
    );
    expect(fs.readFileSync(target, "utf8")).toBe("unchanged");
  });

  it("rejects a dangling symbolic-link specialist diff file", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specialist-context-"));
    const targetDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "specialist-target-"));
    const target = path.join(targetDirectory, "missing.patch");
    onTestFinished(() => {
      fs.rmSync(directory, { recursive: true, force: true });
      fs.rmSync(targetDirectory, { recursive: true, force: true });
    });
    fs.symlinkSync(target, path.join(directory, "diff.patch"));

    expect(() => writeSpecialistDiff(directory, "diff evidence")).toThrow(
      "Specialist diff file must not be a symbolic link",
    );
    expect(fs.existsSync(target)).toBe(false);
  });

  it("parses every discovered specialist interest (#9949)", () => {
    expect(ADVISOR_INTERESTS.map(parseAdvisorInterest)).toEqual(ADVISOR_INTERESTS);
    expect(() => parseAdvisorInterest("missing-specialist")).toThrowError(
      `interest must be one of: ${ADVISOR_INTERESTS.join(", ")}`,
    );
  });

  it("renders the workflow matrix without installed packages", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specialist-renderer-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    expect(() =>
      execFileSync(process.execPath, ["--eval", "import('@earendil-works/pi-coding-agent')"], {
        cwd: directory,
        stdio: "ignore",
      }),
    ).toThrow();
    const sourceDirectory = path.join(process.cwd(), "tools/pr-review-advisor");
    fs.copyFileSync(
      path.join(sourceDirectory, "render-specialist-matrix.mts"),
      path.join(directory, "render-specialist-matrix.mts"),
    );
    fs.copyFileSync(
      path.join(sourceDirectory, "specialist-catalog.mts"),
      path.join(directory, "specialist-catalog.mts"),
    );
    fs.cpSync(path.join(sourceDirectory, "specialists"), path.join(directory, "specialists"), {
      recursive: true,
    });

    const output = execFileSync(
      process.execPath,
      ["--experimental-strip-types", "render-specialist-matrix.mts"],
      { cwd: directory, encoding: "utf8", env: { PATH: process.env.PATH } },
    );
    const matrix = JSON.parse(output) as Array<{ interest: string; model: string }>;

    expect(matrix.map(({ interest }) => interest)).toEqual(ADVISOR_INTERESTS);
    expect(matrix.map(({ model }) => model)).toEqual(
      ADVISOR_INTERESTS.map((_, index) =>
        index % 2 === 0 ? "openai/gpt-5.6-terra" : "azure/openai/gpt-5.6-terra",
      ),
    );
    expect(matrix.every((entry) => !("sandbox_name" in entry))).toBe(true);
  });

  it("discovers a specialist from one Markdown prompt file", () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-specialist-prompts-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(
      path.join(directory, "reliability.md"),
      "Decide whether the change remains reliable.\n",
    );

    expect(readAdvisorSpecialists(directory)).toEqual([
      {
        interest: "reliability",
        label: "Reliability",
        prompt: "Decide whether the change remains reliable.",
      },
    ]);
  });

  it("rejects an empty specialist prompt", () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-specialist-prompts-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, "reliability.md"), "\n");

    expect(() => readAdvisorSpecialists(directory)).toThrowError(
      "Specialist prompt is empty: reliability",
    );
  });

  it.each(ADVISOR_INTERESTS)(
    "builds an investigation-only %s turn with the full deterministic context (#9949)",
    (interest) => {
      const turn = buildSpecialistInvestigateTurn(interest, context);
      const contextToolNames = turn.contextToolResults?.map(({ toolName }) => toolName) ?? [];

      expect(turn.name).toBe(`investigate-${interest}`);
      expect(contextToolNames).toEqual([
        "pr_review_scope_risk_context",
        "pr_review_diff_path",
        "pr_review_controlled_words",
        "pr_review_terminology_pr_context",
        "pr_review_correctness_state_context",
        "pr_review_security_trust_context",
        "pr_review_tests_regressions_context",
        "pr_review_ci_operations_context",
        "pr_review_reconciliation_context",
        "pr_review_metadata",
      ]);
      expect(turn.requiredToolNames).toEqual(contextToolNames);
      expect(turn.requireToolsBeforeText).toEqual(contextToolNames);
      expect(turn.requireAssistantText).toBe(true);
      expect(turn.atomicTerminalToolName).toBeUndefined();
      expect(turn.terminalSubmitToolName).toBeUndefined();
    },
  );

  it("keeps large specialist context in ordinary-read-sized Pi trace lines (#9986)", () => {
    const largeWords = "word\n".repeat(20_000) + "a".repeat(16_376) + "🦀";
    const turn = buildSpecialistInvestigateTurn("behavior", {
      ...context,
      controlledWords: largeWords,
    });
    const results = turn.contextToolResults ?? [];

    expect(
      results.filter(({ toolName }) => toolName.startsWith("pr_review_controlled_words_part_"))
        .length,
    ).toBeGreaterThan(1);
    expect(
      results.every(({ content }) => Buffer.byteLength(JSON.stringify(content)) <= 16 * 1024),
    ).toBe(true);
    const wordChunks = results.filter(({ toolName }) =>
      toolName.startsWith("pr_review_controlled_words_part_"),
    );
    expect(wordChunks.map(({ content }) => content).join("")).toBe(largeWords);
    expect(wordChunks.every(({ content }) => !/[\uD800-\uDBFF]$/u.test(content))).toBe(true);
    const toolNames = results.map(({ toolName }) => toolName);
    expect(turn.requiredToolNames).toEqual(toolNames);
    expect(turn.requireToolsBeforeText).toEqual(toolNames);
  });

  it("writes the completed specialist analysis as Markdown", () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-specialist-summary-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const artifact = writeSpecialistSummary(
      directory,
      "design-architecture",
      "## Findings\n\nConcrete reduction.",
    );

    const expected = fs.readFileSync(artifact, "utf8");
    expect(path.basename(artifact)).toBe("pr-review-design-architecture-summary.md");
    expect(expected).toContain("PR Review Advisor — Design / Architecture specialist");
    expect(expected).toContain("Complete specialist review for maintainers and review agents.");
    expect(expected).toContain("Concrete reduction.");
  });

  it("passes terminology tracing only to the documentation specialist runner (#9968)", async () => {
    const directory = fs.mkdtempSync(path.join(process.cwd(), ".tmp-specialist-runner-"));
    onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
    git(["init", "--quiet"]);
    git(["config", "user.name", "Specialist Test"]);
    git(["config", "user.email", "specialist@example.invalid"]);
    fs.writeFileSync(path.join(directory, "guide.md"), "# Guide\n");
    git(["add", "guide.md"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base"]);
    const baseRef = git(["rev-parse", "HEAD"]);
    fs.appendFileSync(path.join(directory, "guide.md"), "Checkout-bound terminology.\n");
    git(["add", "guide.md"]);
    git(["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "head"]);
    const headRef = git(["rev-parse", "HEAD"]);
    const captured: Array<[AdvisorInterest, ToolDefinition[]]> = [];
    const result: RunAdvisorResult = {
      text: "",
      raw: "",
      turnTexts: [],
      turnErrors: [],
      turnCallbackErrors: [],
    };
    const options: Omit<RunReadOnlyAdvisorOptions, "customTools"> = {
      cwd: directory,
      promptTurns: [],
      systemPrompt: "system",
      configDir: "/tmp/advisor-config",
      htmlExportPath: "/tmp/advisor.html",
      timeoutMs: 1,
      heartbeatMs: 1,
      maxCaptureBytes: 1,
      credentialEnv: "ADVISOR_TEST_KEY",
      logPrefix: "test",
      logProgress: vi.fn(),
    };

    await Promise.all(
      ADVISOR_INTERESTS.map((interest) =>
        runSpecialistAdvisor(interest, { baseRef, headRef }, options, async (runnerOptions) => {
          captured.push([interest, runnerOptions.customTools ?? []]);
          return result;
        }),
      ),
    );

    expect(
      Object.fromEntries(
        captured.map(([interest, tools]) => [interest, tools.map(({ name }) => name)]),
      ),
    ).toEqual(
      Object.fromEntries(
        ADVISOR_INTERESTS.map((interest) => [
          interest,
          interest === "documentation" ? [TERMINOLOGY_TRACE_TOOL] : [],
        ]),
      ),
    );
    const documentationTools =
      captured.find(([interest]) => interest === "documentation")?.[1] ?? [];
    const trace = documentationTools[0] as CallableTool;
    const evidence = await trace.execute(
      "trace-1",
      { term: "checkout-bound" },
      undefined,
      undefined,
      undefined as never,
    );
    const evidenceText = evidence.content.find((item) => item.type === "text")?.text;
    expect(evidenceText).toContain("Checkout-bound terminology.");
  });

  it.each(ADVISOR_INTERESTS)(
    "limits %s tools and reserves terminology tracing for documentation (#9949)",
    (interest) => {
      const turn = buildSpecialistInvestigateTurn(interest, context);
      const expected =
        interest === "documentation"
          ? ["read", "grep", "find", "ls", TERMINOLOGY_TRACE_TOOL]
          : ["read", "grep", "find", "ls"];

      expect(turn.activeToolNames).toEqual(expected);
      expect(turn.activeToolNames).not.toContain("record_findings");
      expect(turn.activeToolNames).not.toContain("record_review_receipt");
      expect(turn.activeToolNames).not.toContain("recommend_e2e");
      expect(turn.activeToolNames).not.toContain("submit_review");
    },
  );
});
