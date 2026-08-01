// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTerminologyLedger,
  createTerminologyToolController,
  TERMINOLOGY_READ_TOOL,
  TERMINOLOGY_TRACE_TOOL,
  TERMINOLOGY_UPDATE_TOOL,
  traceTerminology,
} from "../tools/pr-review-advisor/terminology.mts";

const ROOT = path.resolve(import.meta.dirname, "..");
const temporaryDirectories: string[] = [];

type CallableTool = ToolDefinition & {
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    context: never,
  ): Promise<{
    content: Array<{ type: string; text?: string }>;
    details: unknown;
    terminate?: boolean;
  }>;
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function fixtureRepository(): { directory: string; base: string; head: string } {
  const directory = fs.mkdtempSync(path.join(ROOT, ".tmp-pr-advisor-terminology-"));
  temporaryDirectories.push(directory);
  git(directory, ["init", "--quiet"]);
  git(directory, ["config", "user.name", "Terminology Test"]);
  git(directory, ["config", "user.email", "terminology@example.invalid"]);
  fs.writeFileSync(
    path.join(directory, "guide.md"),
    "# Guide\n\nThe PR SHA identifies the revision under review.\n",
  );
  git(directory, ["add", "guide.md"]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  fs.writeFileSync(
    path.join(directory, "guide.md"),
    "# Guide\n\nThe PR SHA identifies the revision under review.\nReview-bound evidence is required.\nAn ordinary well-known phrase stays ordinary.\n",
  );
  git(directory, ["add", "guide.md"]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "head"]);
  return { directory, base, head: git(directory, ["rev-parse", "HEAD"]) };
}

function tool(tools: ToolDefinition[], name: string): CallableTool {
  const match = tools.find((candidate) => candidate.name === name);
  expect(match, `Missing tool ${name}`).toBeDefined();
  return match as CallableTool;
}

function contentJson(result: { content: Array<{ type: string; text?: string }> }) {
  return JSON.parse(result.content[0]?.text ?? "null") as Record<string, unknown>;
}

describe("PR review advisor terminology evidence", () => {
  it("traces only a model-selected term and binds hyphen variants to the PR SHA", () => {
    const fixture = fixtureRepository();
    const trace = traceTerminology({
      term: "review-bound",
      baseRef: fixture.base,
      headRef: fixture.head,
      cwd: fixture.directory,
    });

    expect(trace.headSha).toBe(fixture.head);
    expect(trace.baseSha).toBe(fixture.base);
    expect(trace.variants).toEqual(["review-bound", "review bound"]);
    expect(trace.baseOccurrences).toBe(0);
    expect(trace.headOccurrences).toBe(1);
    expect(trace.changedLocations).toEqual([
      { file: "guide.md", line: 4, text: "Review-bound evidence is required." },
    ]);
    expect(trace.headSamples[0]).toContain("guide.md:4:Review-bound evidence is required.");
    expect(trace.firstCommitSha).toBe(fixture.head);
    expect(trace.headSamples.join("\n")).not.toContain("well-known");
  });

  it("commits traced semantic decisions and rejects an unsupported justified modifier", async () => {
    const fixture = fixtureRepository();
    const ledger = createTerminologyLedger(fixture.head);
    const controller = createTerminologyToolController({
      ledger,
      baseRef: fixture.base,
      headRef: fixture.head,
      cwd: fixture.directory,
    });
    controller.setStage("terminology-review-analysis");
    const traced = await tool(controller.tools, TERMINOLOGY_TRACE_TOOL).execute(
      "trace-1",
      { term: "review-bound" },
      undefined,
      undefined,
      undefined as never,
    );
    const trace = contentJson(traced) as { id: string; changedLocations: Array<{ line: number }> };
    controller.setStage("terminology-review");
    const update = tool(controller.tools, TERMINOLOGY_UPDATE_TOOL);
    const decision = {
      term: "review-bound",
      change: "introduced",
      disposition: "justified",
      meaning: "Evidence for the PR SHA.",
      contrast: null,
      existingTerm: null,
      semanticImpact: "evidence",
      recommendation: "Use PR SHA.",
      traceId: trace.id,
      source: { file: "guide.md", line: trace.changedLocations[0]?.line },
    };

    await expect(
      update.execute(
        "update-invalid",
        { decisions: [decision], noChangesReason: null },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("requires a concrete contrast");

    const updated = await update.execute(
      "update-valid",
      {
        decisions: [
          {
            ...decision,
            disposition: "replace",
            existingTerm: "PR SHA",
          },
        ],
        noChangesReason: null,
      },
      undefined,
      undefined,
      undefined as never,
    );
    expect(updated.terminate).toBe(true);
    expect(ledger.snapshot().review).toMatchObject({
      status: "candidates",
      decisions: [
        {
          id: "T-001",
          disposition: "replace",
          existingTerm: "PR SHA",
          source: { file: "guide.md", line: 4, headSha: fixture.head },
        },
      ],
    });

    controller.setStage("synthesize-json");
    const receipt = await tool(controller.tools, TERMINOLOGY_READ_TOOL).execute(
      "read-1",
      {},
      undefined,
      undefined,
      undefined as never,
    );
    expect(contentJson(receipt)).toMatchObject({ version: 1, revision: 1, headSha: fixture.head });
  });

  it("records an explicit clear receipt without scraping for candidates", async () => {
    const fixture = fixtureRepository();
    const ledger = createTerminologyLedger(fixture.head);
    const controller = createTerminologyToolController({
      ledger,
      baseRef: fixture.base,
      headRef: fixture.head,
      cwd: fixture.directory,
    });
    controller.setStage("terminology-review");
    await tool(controller.tools, TERMINOLOGY_UPDATE_TOOL).execute(
      "update-clear",
      {
        decisions: [],
        noChangesReason: "No changed explanatory term introduced a new or conflicting meaning.",
      },
      undefined,
      undefined,
      undefined as never,
    );

    expect(ledger.snapshot().review).toEqual({
      status: "clear",
      decisions: [],
      noChangesReason: "No changed explanatory term introduced a new or conflicting meaning.",
    });
  });
});
