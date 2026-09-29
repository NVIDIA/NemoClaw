// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let renderNemoclawPrBody: (input: any) => Promise<any>;

const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const workflowBlobSha = "c".repeat(40);
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
});

afterEach(() => vi.unstubAllGlobals());

const receipt = {
  schemaVersion: 1,
  candidateSha,
  canonicalBaseSha: baseSha,
  workflowRevisionSha: baseSha,
  workflowPath: ".github/workflows/pr-review-advisor.yaml",
  workflowBlobSha,
  workflowJob: "review-specialists",
  draftOnly: true,
  expectedRemoteSha: null,
};

const bodyInput = (guardedFallback?: any) => ({
  workdir: "/workspace",
  outcome: "Guarded publication remains reviewable.",
  reason: "Candidate validation machinery differs from the canonical base.",
  changes: ["Use base-controlled review evidence."],
  tests: { result: "added-or-updated", evidence: "Focused tests passed." },
  guardedFallback,
  dco: { commitsVerified: true, name: "Contributor", email: "contributor@example.com" },
  noSecrets: true,
});

describe("render_nemoclaw_pr_body guarded validation fallback", () => {
  it("accepts complete typed fallback evidence and renders its disclosure", async () => {
    vi.stubGlobal("tools", {
      bash: vi.fn().mockResolvedValue({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: template, truncated: false },
        stderr: { text: "", truncated: false },
      }),
    });

    const result = await renderNemoclawPrBody(
      bodyInput({ receipt, differingValidationPaths: [".pre-commit-config.yaml"] }),
    );

    expect(result.blockers).toEqual([]);
    expect(result.body).toContain("Local validation skipped");
    expect(result.body).toContain(".pre-commit-config.yaml");
    expect(result.body).toContain(baseSha);
    expect(result.body).toContain("review-specialists");
  });

  it.each([
    ["absent", undefined, "Hook or validate:pr evidence is required."],
    [
      "incomplete",
      { receipt, differingValidationPaths: [] },
      "Guarded fallback validation evidence is incomplete or invalid.",
    ],
  ])(
    "rejects %s fallback evidence when normal hooks did not pass",
    async (_label, fallback, blocker) => {
      vi.stubGlobal("tools", {
        bash: vi.fn().mockResolvedValue({
          kind: "foreground",
          exitCode: 0,
          stdout: { text: template, truncated: false },
          stderr: { text: "", truncated: false },
        }),
      });

      const result = await renderNemoclawPrBody(bodyInput(fallback));

      expect(result.blockers).toContain(blocker);
    },
  );
});
