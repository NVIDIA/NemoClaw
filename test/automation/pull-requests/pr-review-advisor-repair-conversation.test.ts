// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  parseSelectionInput,
  selectRepairAttempt,
  type SelectionBundle,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  createRepairSandbox,
  repairPrompt,
  repairTurnCommand,
  reviewRepairPrompt,
  runRepairTask,
  type ResolverTools,
} from "../../../tools/pr-review-advisor-repair/resolve.mts";
import { buildRepairModelContext } from "../../../tools/pr-review-advisor-repair/select.mts";

function selection(): SelectionBundle {
  const sourceHeadSha = "a".repeat(40);
  return selectRepairAttempt(
    parseSelectionInput({
      version: 1,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      pullRequest: {
        state: "open",
        draft: false,
        author: "contributor",
        baseRef: "main",
        headRepository: "NVIDIA/NemoClaw",
        headRef: "fix/demo",
        maintainerCanModify: true,
      },
      sourceHeadSha,
      baseSha: "b".repeat(40),
      advisor: {
        workflowSha: "c".repeat(40),
        runId: 700,
        runAttempt: 2,
        artifactIds: Array.from({ length: 10 }, (_value, index) => index + 100),
        artifactDigests: Array.from(
          { length: 10 },
          (_value, index) => `sha256:${String(index).padStart(64, "0")}`,
        ),
        findingLedgerDigest: `sha256:${"d".repeat(64)}`,
        reviewStateDigest: `sha256:${"e".repeat(64)}`,
      },
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha: sourceHeadSha,
        findingIds: ["behavior:001"],
      },
      productScope: { kind: "accepted-issue", identity: "#10791" },
      findings: [
        {
          id: "behavior:001",
          repairClass: "source",
          summary: "Return the normalized value without changing the public contract.",
          path: "src/demo.ts",
          exclusions: [],
        },
      ],
    }),
  );
}

function resolverTools(): ResolverTools {
  return {
    run: vi.fn(() => ""),
    runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
    start: vi.fn(),
    wait: vi.fn(async () => undefined),
  };
}

function expectRestrictedTurn(runArgs: readonly string[]): void {
  expect(runArgs).toContain("read,edit,write,grep,find,ls");
  expect(runArgs).not.toContain("read,bash,edit,write,grep,find,ls");
  expect(runArgs[runArgs.lastIndexOf("--") + 1]).toBe("/usr/bin/node");
  expect(runArgs).not.toContain("/usr/bin/bash");
  expect(runArgs).not.toContain("/usr/bin/git");
  expect(runArgs).not.toContain("/usr/bin/curl");
  expect(runArgs).not.toContain("/usr/bin/npm");
}

function expectSecretFree(environment: NodeJS.ProcessEnv): void {
  expect(environment).not.toHaveProperty("GH_TOKEN");
  expect(environment).not.toHaveProperty("GITHUB_TOKEN");
  expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  expect(environment).not.toHaveProperty("PR_REVIEW_ADVISOR_API_KEY");
}

describe("PR Review Advisor disposable repair conversation", () => {
  it("keeps commit and run identity outside the Pi context (#10791)", () => {
    const bundle = selection();
    const context = buildRepairModelContext({
      selection: bundle,
      context: {
        pullRequest: { head: { sha: bundle.input.sourceHeadSha, ref: "fix/demo" } },
        reviewState: { headSha: bundle.input.sourceHeadSha },
        quotedText: `old revision ${bundle.input.sourceHeadSha}; head 9bed1d74`,
      },
      ledgers: [],
      summaries: {
        behavior: `workflow ${bundle.input.advisor.workflowSha} digest ${bundle.attemptKey}`,
      },
    });
    const serialized = JSON.stringify(context);

    expect(serialized).not.toContain(bundle.input.sourceHeadSha);
    expect(serialized).not.toContain(bundle.input.baseSha);
    expect(serialized).not.toContain(bundle.input.advisor.workflowSha);
    expect(serialized).not.toContain(bundle.attemptKey);
    expect(serialized).not.toContain("9bed1d74");
    expect(serialized).not.toContain("headSha");
    expect(serialized).toContain("[revision-redacted]");
    expect(serialized).toContain("[digest-redacted]");
    expect(context).toMatchObject({
      conversation: { turns: 2, persistentMemory: false, commitMetadataVisible: false },
      selectedFindingIds: bundle.selectedFindingIds,
      selectedPaths: bundle.selectedPaths,
    });
  });

  it("runs two restricted turns in one ephemeral Pi session (#10791)", () => {
    const tools = resolverTools();
    const env = {
      GH_TOKEN: "gh-secret",
      GITHUB_TOKEN: "github-secret",
      HOME: "/home/test",
      OPENAI_API_KEY: "model-secret",
      PATH: "/usr/bin",
      PI_IMAGE: "pinned-image",
      PR_REVIEW_ADVISOR_API_KEY: "advisor-secret",
      REPAIR_CONFIG_DIR: "/config",
      REPAIR_EXPORT_DIR: "/export",
      REPAIR_OUTPUT_DIR: "/output",
      SANDBOX_NAME: "repair-test",
      TRUSTED_CHECKOUT: "/trusted",
    };

    createRepairSandbox(env, tools);
    runRepairTask(env, tools);

    const calls = vi.mocked(tools.run).mock.calls;
    expect(calls[0]![1]).toContain("/trusted/tools/pr-review-advisor-repair/policy.yaml");
    expectRestrictedTurn(calls[1]![1]);
    expectRestrictedTurn(calls[2]![1]);
    expect(repairTurnCommand(1)).toContain("@/sandbox/pi-config/turn-1.txt");
    expect(repairTurnCommand(2)).toContain("@/sandbox/pi-config/turn-2.txt");
    expect(repairTurnCommand(1)).toContain("--session-id");
    expect(repairTurnCommand(1)).not.toContain("--no-session");
    expectSecretFree(calls[0]![2].env);
    expectSecretFree(calls[1]![2].env);
    expectSecretFree(calls[2]![2].env);
    expect(repairPrompt(selection())).toContain("turn 1 of 2");
    expect(repairPrompt(selection())).toContain("Do not create a commit or attempt to publish");
    expect(reviewRepairPrompt(selection())).toContain("turn 2 of 2");
  });
});
