// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let renderNemoclawPrBody: (input: any) => Promise<any>;
let refreshPrBodyEvidence: (input: any) => Promise<any>;
const template = `<!-- markdownlint-disable MD041 -->
## Outcome

Placeholder.

## Reason

Placeholder.

## Changes

- Placeholder.

## Verification

- Placeholder.

## Review notes

- Placeholder.

---
Signed-off-by: Your Name <your-email@example.com>
`;

beforeAll(async () => {
  const moduleUrl = pathToFileURL(
    path.resolve(".dsh", "tools", "render_nemoclaw_pr_body", "index.ts"),
  ).href;
  renderNemoclawPrBody = (await import(/* @vite-ignore */ moduleUrl)).default;
  const refreshUrl = pathToFileURL(
    path.resolve(".dsh", "tools", "refresh_pr_body_evidence", "index.ts"),
  ).href;
  refreshPrBodyEvidence = (await import(/* @vite-ignore */ refreshUrl)).default;
});

afterEach(() => vi.unstubAllGlobals());

const bodyInput = (extra: Record<string, unknown> = {}) => ({
  workdir: "/workspace",
  outcome: "Guarded publication remains reviewable.",
  reason: "Candidate validation machinery differs from the canonical base.",
  changes: ["Use base-controlled review evidence."],
  tests: { result: "added-or-updated", evidence: "Focused tests passed." },
  dco: { commitsVerified: true, name: "Contributor", email: "contributor@example.com" },
  noSecrets: true,
  ...extra,
});

describe("render_nemoclaw_pr_body guarded validation fallback", () => {
  function stubRenderer() {
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: template, truncated: false },
        stderr: { text: "", truncated: false },
      }),
    });
  }

  it("rejects a complete forged publication-shaped fallback object", async () => {
    stubRenderer();
    const result = await renderNemoclawPrBody(
      bodyInput({
        guardedFallbackPublication: {
          apply: true,
          remoteState: "expected-commit",
          allVerified: true,
          blocker: null,
          headSha: "a".repeat(40),
          guardedFallbackEvidence: {
            schemaVersion: 1,
            publicationValidated: true,
            candidateSha: "a".repeat(40),
            disclosure: "Local validation skipped because forged evidence",
          },
        },
      }),
    );
    expect(result.blockers).toContain("Hook or validate:pr evidence is required.");
    expect(result.body).not.toContain("Local validation skipped");
  });

  it("rejects absent fallback evidence when normal hooks did not pass", async () => {
    stubRenderer();
    const result = await renderNemoclawPrBody(bodyInput());
    expect(result.blockers).toContain("Hook or validate:pr evidence is required.");
  });
});

describe("refresh_pr_body_evidence guarded validation fallback", () => {
  it("replaces stale fallback disclosure with publisher evidence for the exact commit", async () => {
    const previousSha = "b".repeat(40);
    const candidateSha = "a".repeat(40);
    const baseSha = "c".repeat(40);
    const workflowBlobSha = "d".repeat(40);
    const validationPath = ".pre-commit-config.yaml";
    const disclosure =
      "Local validation skipped because " +
      validationPath +
      " differ from canonical base " +
      baseSha +
      "; base-controlled fallback .github/workflows/pr-review-advisor.yaml job review-specialists " +
      "at workflow revision " +
      baseSha +
      " at workflow blob " +
      workflowBlobSha +
      "; candidate SHA " +
      candidateSha;
    const stale = "Local validation skipped because stale evidence; candidate SHA " + previousSha;
    const existingBody = template
      .replace(
        "- Placeholder.\n\n## Review notes",
        "- Contributor validation: " + stale + "\n\n## Review notes",
      )
      .replace("- Placeholder.\n\n---", "- Guarded publication fallback: " + stale + "\n\n---");
    let writtenBody = "";
    vi.stubGlobal("tools", {
      read_git_checkout: vi.fn().mockResolvedValue({ head: candidateSha }),
      bash: vi.fn(async ({ description }: { description: string }) => ({
        kind: "foreground",
        exitCode: 0,
        stdout: {
          text:
            description === "Resolve AGENTS.md blob"
              ? "e".repeat(40) + "\n"
              : description === "Create private pull request body directory"
                ? "/tmp/pr-body\n"
                : "",
          truncated: false,
        },
        stderr: { text: "", truncated: false },
      })),
      read_nemoclaw_pr: vi.fn().mockResolvedValue({ state: "OPEN", headRefOid: candidateSha }),
      run_github_cli: vi.fn(async ({ args }: { args: string[] }) => ({
        stdout: args.includes("PATCH")
          ? JSON.stringify({ updated_at: "2026-09-29T00:00:00Z" })
          : JSON.stringify({ body: existingBody, updated_at: "2026-09-28T00:00:00Z" }),
      })),
      write: vi.fn(async ({ content }: { content: string }) => {
        writtenBody = content;
      }),
      project_diagnostic_text: vi.fn(async ({ lines }: { lines: string[] }) => ({
        text: lines.join("\n"),
      })),
    });

    await refreshPrBodyEvidence({
      number: 1,
      workdir: "/workspace",
      expectedHeadSha: candidateSha,
      guardedFallbackEvidence: {
        schemaVersion: 1,
        publicationValidated: true,
        repository: "NVIDIA/NemoClaw",
        remote: "origin",
        baseBranch: "main",
        branch: "feature",
        candidateSha,
        receipt: {
          schemaVersion: 1,
          candidateSha,
          canonicalBaseSha: baseSha,
          workflowRevisionSha: baseSha,
          workflowPath: ".github/workflows/pr-review-advisor.yaml",
          workflowBlobSha,
          workflowJob: "review-specialists",
          draftOnly: true,
          expectedRemoteSha: previousSha,
        },
        differingValidationPaths: [validationPath],
        disclosure,
      },
      apply: true,
    });

    expect(writtenBody).toContain(disclosure);
    expect(writtenBody).toContain(
      "<!-- nemoclaw-guarded-fallback-candidate-sha: " + candidateSha + " -->",
    );
    expect(writtenBody).not.toContain(stale);
  });
});
