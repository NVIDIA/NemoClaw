// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

let renderNemoclawPrBody: (input: any) => Promise<any>;
let publishNemoclawPrBranch: (input: any) => Promise<any>;

const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const trustedWorkflowBlobSha = "d7bbfae8fd59660ab146ef1cc52ce69964720146";
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
  const publisherUrl = pathToFileURL(
    path.resolve(".dsh", "tools", "publish_nemoclaw_pr_branch", "index.ts"),
  ).href;
  publishNemoclawPrBranch = (await import(/* @vite-ignore */ publisherUrl)).default;
});

afterEach(() => vi.unstubAllGlobals());

const receipt = {
  schemaVersion: 1,
  candidateSha,
  canonicalBaseSha: baseSha,
  workflowRevisionSha: baseSha,
  workflowPath: ".github/workflows/pr-review-advisor.yaml",
  workflowBlobSha: trustedWorkflowBlobSha,
  workflowJob: "review-specialists",
  draftOnly: true,
  expectedRemoteSha: null,
};

const bodyInput = (guardedFallbackPublication?: any) => ({
  workdir: "/workspace",
  outcome: "Guarded publication remains reviewable.",
  reason: "Candidate validation machinery differs from the canonical base.",
  changes: ["Use base-controlled review evidence."],
  tests: { result: "added-or-updated", evidence: "Focused tests passed." },
  guardedFallbackPublication,
  dco: { commitsVerified: true, name: "Contributor", email: "contributor@example.com" },
  noSecrets: true,
});

describe("render_nemoclaw_pr_body guarded validation fallback", () => {
  async function validatedPublication() {
    const outputs: Record<string, string> = {
      "Verify guarded fallback workflow": trustedWorkflowBlobSha + "\n",
      "Verify guarded fallback action .github/actions/setup-reviewed-npm/action.yaml":
        "5f2e26d63438e2f95c0fcbe948d10793f581c5b9\n",
      "Verify guarded fallback action .github/actions/setup-reviewed-npm/verify-and-install-npm.sh":
        "ced189656ff84d19bc5fdb047ce565d480720859\n",
      "Read changed validation surface": ".pre-commit-config.yaml\0",
      "Read publication push URLs": "git@github.com:NVIDIA/NemoClaw.git\n",
      "Count publication commits": "1\n",
      "List publication commits": candidateSha + "\n",
      "Read publication branch before push": "",
      "Reconcile publication branch": candidateSha + "\trefs/heads/feature\n",
    };
    vi.stubGlobal("tools", {
      bash: vi.fn(async ({ description }: { description: string }) => ({
        kind: "foreground",
        exitCode: 0,
        stdout: { text: outputs[description] ?? "", truncated: false },
        stderr: { text: "", truncated: false },
      })),
      project_diagnostic_text: vi.fn(async () => ({ text: "" })),
      read_git_checkout: vi.fn().mockResolvedValue({
        head: candidateSha,
        clean: true,
        branch: "feature",
      }),
      run_github_cli: vi.fn(async ({ args }: { args: string[] }) => {
        const key =
          args[0] === "repo"
            ? "repo"
            : args[0] === "pr"
              ? "pr"
              : args[1].includes("/git/ref/heads/")
                ? "base"
                : "commit";
        const responses = {
          repo: "main\n",
          pr: "[]",
          base: baseSha + "\n",
          commit: "true\tverified\n",
        };
        return { stdout: responses[key] };
      }),
    });
    return publishNemoclawPrBranch({
      workdir: "/workspace",
      expectedHeadSha: candidateSha,
      hookBypassReceipt: receipt,
      apply: true,
    });
  }

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

  it("accepts publisher-validated fallback evidence and renders its disclosure", async () => {
    const publication = await validatedPublication();
    expect(publication.guardedFallbackEvidence?.publicationValidated).toBe(true);
    stubRenderer();

    const result = await renderNemoclawPrBody(bodyInput(publication));

    expect(result.blockers).toEqual([]);
    expect(result.body).toContain("Local validation skipped");
    expect(result.body).toContain(".pre-commit-config.yaml");
    expect(result.body).toContain(baseSha);
    expect(result.body).toContain("review-specialists");
  });

  it("rejects a forged standalone receipt", async () => {
    stubRenderer();
    const result = await renderNemoclawPrBody(
      bodyInput({ receipt, differingValidationPaths: [".pre-commit-config.yaml"] }),
    );
    expect(result.blockers).toContain(
      "Guarded fallback validation evidence is incomplete or invalid.",
    );
  });

  it("rejects absent fallback evidence when normal hooks did not pass", async () => {
    stubRenderer();
    const result = await renderNemoclawPrBody(bodyInput());
    expect(result.blockers).toContain("Hook or validate:pr evidence is required.");
  });
});
