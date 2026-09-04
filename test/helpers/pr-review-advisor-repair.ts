// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import type { OpenShellCommandOptions } from "../../tools/openshell-agent/runtime.mts";
import { pullRequestReviewStateDigest } from "../../tools/pr-review-advisor/review-state.mts";
import {
  type FindingInput,
  parseSelectionInput,
  type SelectionBundle,
  selectRepairAttempt,
  sha256,
  type ValidationReceipt,
} from "../../tools/pr-review-advisor-repair/contract.mts";
import {
  GENERATED_HEAD_VALIDATIONS,
  generatedHeadRunTitle,
} from "../../tools/pr-review-advisor-repair/generated-head-validation.mts";

type RequestOptions = { method?: string; body?: unknown };

type TestGitHubRequest = <T>(
  apiPath: string,
  token: string,
  options?: RequestOptions,
) => Promise<T>;

export function asGitHubRequest<T>(request: T): T & TestGitHubRequest {
  return request as T & TestGitHubRequest;
}

type PublicationFixture = {
  bundle: SelectionBundle;
  receipt: ValidationReceipt;
  candidateBlobSha: string;
  candidateTreeSha: string;
};

export function repairFinding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    id: "behavior:001",
    repairClass: "source",
    summary: "Return the normalized value without changing the public contract.",
    path: "src/demo.ts",
    exclusions: [],
    ...overrides,
  };
}

export function repairSelectionInput(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const head =
    typeof overrides.sourceHeadSha === "string" ? overrides.sourceHeadSha : "a".repeat(40);
  const findings = (overrides.findings as FindingInput[] | undefined) ?? [repairFinding()];
  const reviewState = {
    version: 1 as const,
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    headSha: head,
    issueComments: [],
    reviews: [],
    threads: [],
  };
  const defaults = {
    version: 1,
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    pullRequest: {
      state: "open",
      draft: false,
      maintainerCanModify: true,
      author: "cjagwani",
      baseRef: "main",
      headRepository: "NVIDIA/NemoClaw",
      headRef: "fix/demo",
    },
    sourceHeadSha: head,
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
      reviewStateDigest: pullRequestReviewStateDigest(reviewState),
    },
    optIn: {
      kind: "phase1-maintainer-dispatch",
      actor: "maintainer",
      triggeringActor: "maintainer",
      headSha: head,
      findingIds: findings.map(({ id }) => id),
    },
    productScope: { kind: "accepted-issue", identity: "#10791" },
    findings,
  };
  const nested = (key: "pullRequest" | "advisor" | "optIn" | "productScope") => {
    const value = overrides[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  return {
    ...defaults,
    ...overrides,
    pullRequest: { ...defaults.pullRequest, ...nested("pullRequest") },
    advisor: { ...defaults.advisor, ...nested("advisor") },
    optIn: { ...defaults.optIn, ...nested("optIn") },
    productScope: { ...defaults.productScope, ...nested("productScope") },
  };
}

export function repairSelection(overrides: Record<string, unknown> = {}): SelectionBundle {
  return selectRepairAttempt(parseSelectionInput(repairSelectionInput(overrides)));
}

export function repairValidationReceipt(
  selection: SelectionBundle,
  patch: Buffer,
  overrides: Partial<ValidationReceipt> = {},
): ValidationReceipt {
  const candidateDigest = `sha256:${sha256("candidate")}`;
  return {
    version: 1,
    attemptKey: selection.attemptKey,
    repository: "NVIDIA/NemoClaw",
    prNumber: selection.input.prNumber,
    author: selection.input.pullRequest.author,
    headRef: selection.input.pullRequest.headRef,
    sourceHeadSha: selection.input.sourceHeadSha,
    baseSha: selection.input.baseSha,
    advisor: selection.input.advisor,
    findingIds: selection.selectedFindingIds,
    selectedPaths: selection.selectedPaths,
    patchSha256: sha256(patch),
    candidateTreeSha: "f".repeat(40),
    changedPaths: [
      {
        path: "src/demo.ts",
        status: "M",
        mode: "100644",
        type: "blob",
        bytes: 24,
      },
    ],
    validation: {
      candidateDigestBefore: candidateDigest,
      candidateDigestAfter: candidateDigest,
      commands: [{ argv: ["npm", "run", "test:fast"], exitCode: 0 }],
    },
    productScope: selection.input.productScope,
    optIn: selection.input.optIn,
    outcome: "validated",
    reason: null,
    ...overrides,
  };
}

export function fixtureGit(repository: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function writeFixture(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

export function writeJsonFixture(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function requireFixture<T>(value: T | undefined, name: string): T {
  if (value === undefined) throw new Error(`missing ${name} fixture`);
  return value;
}

export async function reconciliationResponder(apiPath: string) {
  if (apiPath.includes("/collaborators/")) {
    return {
      permission: "write",
      role_name: "maintain",
      user: {
        login: "maintainer",
        permissions: { admin: false, maintain: true },
      },
    };
  }
  if (apiPath.includes("/actions/runs/")) {
    return {
      id: 900,
      run_attempt: 1,
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
      name: "Automation / PR Review Advisor Repair",
      path: ".github/workflows/pr-review-advisor-repair.yaml",
      head_branch: "main",
      repository: { full_name: "NVIDIA/NemoClaw" },
    };
  }
  return {
    id: 901,
    name: "pr-review-advisor-repair-phase1-validation-900-1",
    expired: false,
    size_in_bytes: 1024,
    digest: `sha256:${"a".repeat(64)}`,
    workflow_run: { id: 900 },
  };
}

export function mutationAfterFirstCommand() {
  let commands = 0;
  return (repository: string, command: string, args: readonly string[]) => {
    commands += 1;
    if (commands > 1) {
      writeFixture(repository, "ignored-output/proof.txt", "mutated\n");
    }
    return { argv: [command, ...args], exitCode: 0 };
  };
}

export function ownedGatewayResponder(gatewayId: string, endpoint: string, sandboxBinary: string) {
  return (command: string, args: readonly string[], _options: OpenShellCommandOptions) => {
    const invocation = `${command} ${args.join(" ")}`;
    if (invocation === "which openshell-sandbox") return sandboxBinary;
    if (invocation === "openshell status -o json") {
      return JSON.stringify({
        gateway: gatewayId,
        server: endpoint,
        status: "connected",
      });
    }
    return "";
  };
}

export function successfulPublicationResponder(fixture: PublicationFixture, commitSha: string) {
  let checkId = 1000;
  const pullRequest = {
    number: fixture.bundle.input.prNumber,
    state: "open",
    draft: false,
    maintainer_can_modify: true,
    user: { login: "cjagwani" },
    head: {
      sha: fixture.receipt.sourceHeadSha,
      ref: fixture.receipt.headRef,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
    base: {
      sha: fixture.receipt.baseSha,
      ref: "main",
      repo: { full_name: "NVIDIA/NemoClaw", node_id: "R_repo" },
    },
  };
  return async (apiPath: string, _token: string, options?: RequestOptions) => {
    const method = options?.method ?? "GET";
    if (apiPath === "repos/NVIDIA/NemoClaw/pulls/42") return pullRequest;
    if (apiPath.includes("/collaborators/") && apiPath.endsWith("/permission")) {
      const login = apiPath.match(/\/collaborators\/([^/]+)\//u)?.[1] ?? "";
      return {
        permission: "write",
        role_name: "maintain",
        user: { login, permissions: { admin: false, maintain: true } },
      };
    }
    if (/actions\/workflows\/[^/]+$/u.test(apiPath)) {
      return {
        state: "active",
        path: `.github/workflows/${apiPath.split("/").at(-1)}`,
      };
    }
    if (method === "POST" && apiPath.endsWith("/git/blobs")) {
      return { sha: fixture.candidateBlobSha };
    }
    if (method === "POST" && apiPath.endsWith("/git/trees")) {
      return { sha: fixture.candidateTreeSha };
    }
    if (method === "POST" && apiPath.endsWith("/git/commits")) {
      return { sha: commitSha };
    }
    if (apiPath.endsWith(`/git/commits/${commitSha}`)) {
      return {
        sha: commitSha,
        message: `fix(advisor): apply validated review repair\n\nAdvisor-Repair-Attempt: ${fixture.bundle.attemptKey}`,
        tree: { sha: fixture.candidateTreeSha },
        parents: [{ sha: fixture.receipt.sourceHeadSha }],
        verification: { verified: true, reason: "valid" },
      };
    }
    if (apiPath.includes("/actions/artifacts/")) {
      const id = Number(apiPath.split("/").at(-1));
      const index = fixture.bundle.input.advisor.artifactIds.indexOf(id);
      return {
        id,
        expired: false,
        digest: fixture.bundle.input.advisor.artifactDigests[index],
        workflow_run: {
          id: fixture.bundle.input.advisor.runId,
          head_sha: fixture.bundle.input.advisor.workflowSha,
        },
      };
    }
    if (apiPath.includes(`/commits/${commitSha}/check-runs`)) {
      return { total_count: 0, check_runs: [] };
    }
    if (apiPath.includes("/runs?")) {
      return { total_count: 0, workflow_runs: [] };
    }
    if (method === "POST" && apiPath.endsWith("/check-runs")) {
      return { id: checkId++ };
    }
    if (
      (method === "POST" && apiPath.endsWith("/dispatches")) ||
      (method === "PATCH" && apiPath.includes("/check-runs/"))
    ) {
      return {};
    }
    throw new Error(`unexpected GitHub request: ${method} ${apiPath}`);
  };
}

export function generatedHeadEvidenceResponder(
  attemptKey: string,
  commitSha: string,
  options: { failedJob?: string; duplicateWorkflow?: string } = {},
) {
  const runIds = new Map(
    GENERATED_HEAD_VALIDATIONS.map(({ workflow }, index) => [workflow, 2000 + index]),
  );
  return async (apiPath: string, _token: string, requestOptions?: RequestOptions) => {
    const validation = GENERATED_HEAD_VALIDATIONS.find(({ workflow }) =>
      apiPath.includes(`/actions/workflows/${workflow}/runs?`),
    );
    if (validation) {
      const run = {
        id: runIds.get(validation.workflow),
        run_attempt: 1,
        event: "workflow_dispatch",
        head_branch: "main",
        head_sha: "e".repeat(40),
        path: `.github/workflows/${validation.workflow}`,
        status: "completed",
        conclusion: "success",
        display_title: generatedHeadRunTitle(validation.titlePrefix, attemptKey, commitSha),
      };
      const runs =
        options.duplicateWorkflow === validation.workflow
          ? [run, { ...run, id: Number(run.id) + 100 }]
          : [run];
      return { total_count: runs.length, workflow_runs: runs };
    }
    const jobValidation = GENERATED_HEAD_VALIDATIONS.find(({ workflow }) =>
      apiPath.includes(`/actions/runs/${runIds.get(workflow)}/attempts/1/jobs?`),
    );
    if (jobValidation) {
      const runId = requireFixture(runIds.get(jobValidation.workflow), "generated-head run");
      const jobs = jobValidation.requiredChecks.map((required, index) => {
        const jobId = runId * 10 + index;
        return {
          id: jobId,
          name: required.jobName,
          status: "completed",
          conclusion: options.failedJob === required.name ? "failure" : "success",
          html_url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${runId}/job/${jobId}`,
        };
      });
      return { total_count: jobs.length, jobs };
    }
    if (apiPath.includes(`/commits/${commitSha}/check-runs`)) {
      return { total_count: 0, check_runs: [] };
    }
    if (apiPath === "repos/NVIDIA/NemoClaw/check-runs" && requestOptions?.method === "POST") {
      return { id: 3000 };
    }
    throw new Error(`unexpected generated-head request: ${apiPath}`);
  };
}
