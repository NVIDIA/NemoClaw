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
  TERMINOLOGY_TRACE_TOOL,
  traceTerminology,
} from "../../../tools/pr-review-advisor/terminology.mts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
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
    "# Guide\n\nThe commit SHA identifies the revision under review.\n",
  );
  git(directory, ["add", "guide.md"]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", "base"]);
  const base = git(directory, ["rev-parse", "HEAD"]);
  fs.writeFileSync(
    path.join(directory, "guide.md"),
    "# Guide\n\nThe commit SHA identifies the revision under review.\nReview-bound evidence is required.\nAn ordinary well-known phrase stays ordinary.\n",
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
  it("traces only a model-selected term and binds hyphen variants to the commit SHA", async () => {
    const fixture = fixtureRepository();
    const trace = await traceTerminology({
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
    expect(trace.baseEvidenceTruncated).toBe(false);
    expect(trace.headEvidenceTruncated).toBe(false);
    expect(trace.changedLocations).toEqual([
      { file: "guide.md", line: 4, text: "Review-bound evidence is required." },
    ]);
    expect(trace.headSamples[0]).toContain("guide.md:4:Review-bound evidence is required.");
    expect(trace.firstCommitSha).toBe(fixture.head);
    expect(trace.headSamples.join("\n")).not.toContain("well-known");
  });

  it("bounds samples while preserving matching-line counts for a frequent selected term", async () => {
    const fixture = fixtureRepository();
    fs.writeFileSync(
      path.join(fixture.directory, "frequent.md"),
      `${Array.from({ length: 5000 }, (_, index) => `review-bound occurrence ${index}`).join("\n")}\n`,
    );
    git(fixture.directory, ["add", "frequent.md"]);
    git(fixture.directory, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "frequent term",
    ]);
    const head = git(fixture.directory, ["rev-parse", "HEAD"]);

    const trace = await traceTerminology({
      term: "review-bound",
      baseRef: fixture.base,
      headRef: head,
      cwd: fixture.directory,
    });

    expect(trace.headOccurrences).toBe(5001);
    expect(trace.headSamples).toHaveLength(20);
    expect(trace.headEvidenceTruncated).toBe(true);
  });

  it("traces a selected location after more than 4 MiB of earlier diff output", async () => {
    const fixture = fixtureRepository();
    const largeDiffPath = path.join(fixture.directory, "large-diff.md");
    const filler = Array.from(
      { length: 60_000 },
      (_, index) => `unchanged filler ${index} ${"x".repeat(80)}`,
    ).join("\n");
    expect(Buffer.byteLength(`${filler}\n`)).toBeGreaterThan(4 * 1024 * 1024);
    fs.writeFileSync(largeDiffPath, `${filler}\nreview-bound location\n`);
    expect(fs.statSync(largeDiffPath).size).toBeGreaterThan(4 * 1024 * 1024);
    git(fixture.directory, ["add", "large-diff.md"]);
    git(fixture.directory, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "large changed-location diff",
    ]);
    const head = git(fixture.directory, ["rev-parse", "HEAD"]);

    const trace = await traceTerminology({
      term: "review-bound",
      baseRef: fixture.base,
      headRef: head,
      cwd: fixture.directory,
    });

    expect(trace.headOccurrences).toBe(2);
    expect(trace.changedLocations).toContainEqual({
      file: "large-diff.md",
      line: 60_001,
      text: "review-bound location",
    });
  });

  it("traces selected terms in non-ASCII paths when Git path quoting is enabled", async () => {
    const fixture = fixtureRepository();
    const filename = "glossary-ä.md";
    fs.writeFileSync(path.join(fixture.directory, filename), "review-bound evidence\n");
    git(fixture.directory, ["add", filename]);
    git(fixture.directory, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "non-ASCII terminology path",
    ]);
    git(fixture.directory, ["config", "core.quotePath", "true"]);
    const head = git(fixture.directory, ["rev-parse", "HEAD"]);

    const trace = await traceTerminology({
      term: "review-bound",
      baseRef: fixture.base,
      headRef: head,
      cwd: fixture.directory,
    });

    expect(trace.changedLocations).toContainEqual({
      file: filename,
      line: 1,
      text: "review-bound evidence",
    });
  });

  it("surfaces a failure when neither changed-line diff can produce evidence", async () => {
    const fixture = fixtureRepository();
    git(fixture.directory, ["config", "diff.external", "false"]);

    await expect(
      traceTerminology({
        term: "review-bound",
        baseRef: fixture.base,
        headRef: fixture.head,
        cwd: fixture.directory,
      }),
    ).rejects.toThrow("Terminology evidence command failed: git diff:");
  });

  it("traces selected terms through the investigation controller", async () => {
    const fixture = fixtureRepository();
    const controller = createTerminologyToolController({
      baseRef: fixture.base,
      headRef: fixture.head,
      cwd: fixture.directory,
    });
    expect(controller.tools.map((candidate) => candidate.name)).toEqual([TERMINOLOGY_TRACE_TOOL]);
    const traced = await tool(controller.tools, TERMINOLOGY_TRACE_TOOL).execute(
      "trace-1",
      { term: "review-bound" },
      undefined,
      undefined,
      undefined as never,
    );
    const trace = contentJson(traced) as { id: string; changedLocations: Array<{ line: number }> };
    expect(controller.traces().get(trace.id)?.changedLocations[0]?.line).toBe(4);
  });

  it("validates provenance before committing a canonical terminology snapshot", async () => {
    const fixture = fixtureRepository();
    const trace = await traceTerminology({
      term: "review-bound",
      baseRef: fixture.base,
      headRef: fixture.head,
      cwd: fixture.directory,
    });
    const ledger = createTerminologyLedger(fixture.head);
    const decision = {
      term: "review-bound",
      change: "introduced" as const,
      disposition: "justified" as const,
      meaning: "Evidence for the commit SHA.",
      contrast: null,
      existingTerm: null,
      semanticImpact: "evidence" as const,
      recommendation: "Use commit SHA.",
      traceId: trace.id,
      source: { file: "guide.md", line: 4 },
    };
    expect(() => ledger.commit({ decisions: [decision], noChangesReason: null }, new Map([[trace.id, trace]]))).toThrow(
      "requires a concrete contrast",
    );
    ledger.commit(
      {
        decisions: [{ ...decision, disposition: "replace", existingTerm: "commit SHA" }],
        noChangesReason: null,
      },
      new Map([[trace.id, trace]]),
    );
    expect(ledger.snapshot()).toMatchObject({
      version: 1,
      revision: 1,
      headSha: fixture.head,
      review: {
        status: "candidates",
        decisions: [{ id: "T-001", source: { file: "guide.md", line: 4, headSha: fixture.head } }],
      },
    });
  });

  it("records an explicit clear canonical receipt", () => {
    const fixture = fixtureRepository();
    const ledger = createTerminologyLedger(fixture.head);
    ledger.commit(
      {
        decisions: [],
        noChangesReason: "No changed explanatory term introduced a new or conflicting meaning.",
      },
      new Map(),
    );
    expect(ledger.snapshot().review).toEqual({
      status: "clear",
      decisions: [],
      noChangesReason: "No changed explanatory term introduced a new or conflicting meaning.",
    });
  });
});
