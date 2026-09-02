// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAttemptReceipt } from "../../../tools/pr-review-advisor-repair/audit.mts";
import { pullRequestReviewStateDigest } from "../../../tools/pr-review-advisor/review-state.mts";
import {
  startOwnedOpenShellGateway,
  type OpenShellTools,
} from "../../../tools/openshell-agent/runtime.mts";
import {
  parseSelectionBundle,
  parseSelectionInput,
  parseProposalDraft,
  parseProposalReceipt,
  parseValidationReceipt,
  repairClassForPath,
  safeRelativePath,
  sanitizeDiagnostic,
  selectRepairAttempt,
  sha256,
  type FindingInput,
  type SelectionBundle,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  exportTrustedRepairPatch,
  prepareRepairWorkspace,
  resolverGitEnvironment,
} from "../../../tools/pr-review-advisor-repair/resolve.mts";
import {
  expectedAdvisorArtifactNames,
  parseArtifactManifest,
  validateAdvisorArtifacts,
  validateAdvisorRun,
  validateMaintainerPermission,
} from "../../../tools/pr-review-advisor-repair/select.mts";
import {
  assertLivePullRequestIdentity,
  assertLiveReviewStateIdentity,
  createOpenShellValidationRunner,
  validateRepairLocally,
  validationCommands,
  writeValidationArtifacts,
} from "../../../tools/pr-review-advisor-repair/validate.mts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-advisor-repair-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function git(repository: string, args: string[]): string {
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

function write(root: string, file: string, content: string): void {
  const target = path.join(root, ...file.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function finding(overrides: Partial<FindingInput> = {}): FindingInput {
  return {
    id: "behavior:001",
    repairClass: "source",
    summary: "Return the normalized value without changing the public contract.",
    path: "src/demo.ts",
    exclusions: [],
    ...overrides,
  };
}

function selectionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const head = "a".repeat(40);
  const defaults = {
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
      reviewStateDigest: `sha256:${"e".repeat(64)}`,
    },
    optIn: {
      kind: "phase1-maintainer-dispatch",
      actor: "maintainer",
      triggeringActor: "maintainer",
      headSha: head,
      findingIds: [finding().id],
    },
    productScope: {
      kind: "accepted-issue",
      identity: "#10791",
    },
    findings: [finding()],
  };
  const nestedOverride = (key: "pullRequest" | "advisor" | "optIn" | "productScope") => {
    const value = overrides[key];
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  };
  return {
    ...defaults,
    ...overrides,
    pullRequest: { ...defaults.pullRequest, ...nestedOverride("pullRequest") },
    advisor: { ...defaults.advisor, ...nestedOverride("advisor") },
    optIn: { ...defaults.optIn, ...nestedOverride("optIn") },
    productScope: { ...defaults.productScope, ...nestedOverride("productScope") },
  };
}

function selection(overrides: Record<string, unknown> = {}): SelectionBundle {
  return selectRepairAttempt(parseSelectionInput(selectionInput(overrides)));
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function expectSchemaValid(schemaName: string, value: unknown): void {
  const schemaFile = path.resolve(
    "tools",
    "pr-review-advisor-repair",
    "schemas",
    `${schemaName}.schema.json`,
  );
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    JSON.parse(fs.readFileSync(schemaFile, "utf8")),
  );
  expect(
    validate(value),
    `${schemaName} schema rejected its runtime value: ${JSON.stringify(validate.errors)}`,
  ).toBe(true);
}

function expectSecretFreeOpenShellEnvironment(environment: NodeJS.ProcessEnv): void {
  expect(environment).not.toHaveProperty("GH_TOKEN");
  expect(environment).not.toHaveProperty("GITHUB_TOKEN");
  expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  expect(environment).not.toHaveProperty("PR_REVIEW_ADVISOR_API_KEY");
}

function expectCredentialFreeValidationEnvironment(environment: NodeJS.ProcessEnv): void {
  expect(environment).not.toHaveProperty("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
  expect(environment).not.toHaveProperty("ACTIONS_RUNTIME_TOKEN");
  expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
  expect(environment).not.toHaveProperty("GH_TOKEN");
  expect(environment).not.toHaveProperty("OPENAI_API_KEY");
  expect(environment.NPM_CONFIG_GLOBALCONFIG).toBe("/dev/null");
  expect(environment.NPM_CONFIG_USERCONFIG).toBe("/dev/null");
}

function expectCredentialFreeOpenShellCalls(
  calls: Array<readonly [string, readonly string[], { env: NodeJS.ProcessEnv }]>,
): void {
  for (const [, , options] of calls) {
    expect(options.env).not.toHaveProperty("ACTIONS_RUNTIME_TOKEN");
    expect(options.env).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
    expectSecretFreeOpenShellEnvironment(options.env);
  }
}

function advisorManifest(runId = 700, runAttempt = 2) {
  const workflowSha = "c".repeat(40);
  const names = expectedAdvisorArtifactNames(runId, runAttempt);
  return validateAdvisorArtifacts(
    {
      total_count: names.length,
      artifacts: names.map((name, index) => ({
        id: index + 100,
        name,
        expired: false,
        size_in_bytes: 1024,
        digest: `sha256:${String(index).padStart(64, "0")}`,
        workflow_run: { id: runId, head_sha: workflowSha },
      })),
    },
    { id: runId, attempt: runAttempt, workflowSha },
  );
}

function createSourceFixture(): { repository: string; headSha: string; bundle: SelectionBundle } {
  const repository = temporaryDirectory();
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Advisor Repair Test"]);
  git(repository, ["config", "user.email", "advisor-repair@example.test"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  write(repository, ".gitignore", "ignored-output/\n");
  write(repository, "src/demo.ts", "export const value = 1;\n");
  write(repository, "docs/example.mdx", "# Example\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add repair base fixture"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  write(repository, "src/pr-owned.ts", "export const prOwned = true;\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add PR-owned fixture"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);
  const bundle = selection({
    baseSha,
    sourceHeadSha: headSha,
    optIn: {
      kind: "phase1-maintainer-dispatch",
      actor: "maintainer",
      triggeringActor: "maintainer",
      headSha,
    },
  });
  return { repository, headSha, bundle };
}

function proposal(bundle: SelectionBundle, changedPaths: string[]) {
  return {
    attemptKey: bundle.attemptKey,
    sourceHeadSha: bundle.input.sourceHeadSha,
    ...proposalDraft(bundle, changedPaths),
  };
}

function proposalDraft(bundle: SelectionBundle, changedPaths: string[]) {
  return {
    version: 1,
    findingIds: bundle.selectedFindingIds,
    unresolvedFindingIds: [],
    changedPaths,
    summary: "Updated the selected implementation path.",
    outcome: "proposed",
  };
}

function expectCredentialPatchRejected(options: {
  root: string;
  suffix: string;
  content: string;
  sourceCheckout: string;
  baselineExport: string;
  selectionFile: string;
  bundle: SelectionBundle;
}): void {
  const candidate = path.join(options.root, `candidate-${options.suffix}`);
  fs.cpSync(options.baselineExport, candidate, { recursive: true });
  write(candidate, "src/demo.ts", options.content);
  const proposalFile = path.join(options.root, `${options.suffix}-proposal.json`);
  writeJson(proposalFile, proposalDraft(options.bundle, ["src/demo.ts"]));
  const artifactDirectory = path.join(options.root, `${options.suffix}-artifact`);
  exportTrustedRepairPatch({
    sourceCheckout: options.sourceCheckout,
    baselineExport: options.baselineExport,
    candidateRepository: candidate,
    proposalFile,
    selectionFile: options.selectionFile,
    artifactDirectory,
    stagingDirectory: path.join(options.root, `${options.suffix}-staging`),
  });
  expect(() =>
    validateRepairLocally({
      sourceCheckout: options.sourceCheckout,
      selection: options.bundle,
      patchFile: path.join(artifactDirectory, "repair.patch"),
      proposalFile: path.join(artifactDirectory, "proposal.json"),
      stagingDirectory: path.join(options.root, `${options.suffix}-validation`),
      commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
    }),
  ).toThrow("possible credential");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("PR Review Advisor repair Phase 1", () => {
  it("records the emergency switch without retaining raw finding text (#10791)", () => {
    const receipt = createAttemptReceipt({
      ADVISOR_RUN_ID: "700",
      FINDING_IDS_JSON: '["F-behavior-untrusted-secret-shaped-text"]',
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PHASE1_ENABLED: "false",
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: "#10791",
      PRODUCT_SCOPE_KIND: "accepted-issue",
    });

    expect(receipt.emergencySwitch).toEqual({
      variable: "ADVISOR_REPAIR_PHASE1_ENABLED",
      enabled: false,
    });
    expect(receipt.outcome).toBe("disabled");
    expect(receipt.reason).toBe("emergency-switch-disabled");
    expect(receipt.dispatch.triggeringActor).toBe("maintainer");
    expect(JSON.stringify(receipt)).not.toContain("untrusted secret-shaped text");
  });

  it("records but disables workflow reruns before a second repair attempt (#10791)", () => {
    const receipt = createAttemptReceipt({
      ADVISOR_RUN_ID: "700",
      FINDING_IDS_JSON: "[]",
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ATTEMPT: "2",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PHASE1_ENABLED: "true",
      REPOSITORY_EGRESS_AUTHORIZED: "true",
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: "#10791",
      PRODUCT_SCOPE_KIND: "accepted-issue",
    });

    expect(receipt.emergencySwitch.enabled).toBe(true);
    expect(receipt.outcome).toBe("disabled");
    expect(receipt.reason).toBe("workflow-rerun-disabled");
  });

  it("keeps every emitted receipt aligned with its checked-in JSON Schema (#10791)", () => {
    const attempt = createAttemptReceipt({
      ADVISOR_RUN_ID: "700",
      FINDING_IDS_JSON: "[]",
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PHASE1_ENABLED: "true",
      REPOSITORY_EGRESS_AUTHORIZED: "true",
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: "#10791",
      PRODUCT_SCOPE_KIND: "accepted-issue",
    });
    const bundle = selection();
    const draft = proposalDraft(bundle, ["src/demo.ts"]);
    const proposalReceipt = proposal(bundle, ["src/demo.ts"]);
    expect(parseProposalDraft(draft, bundle)).toEqual(proposalReceipt);
    const validationReceipt = {
      version: 1,
      attemptKey: bundle.attemptKey,
      repository: "NVIDIA/NemoClaw",
      prNumber: bundle.input.prNumber,
      author: bundle.input.pullRequest.author,
      headRef: bundle.input.pullRequest.headRef,
      sourceHeadSha: bundle.input.sourceHeadSha,
      baseSha: bundle.input.baseSha,
      advisor: bundle.input.advisor,
      findingIds: bundle.selectedFindingIds,
      selectedPaths: bundle.selectedPaths,
      patchSha256: "e".repeat(64),
      candidateTreeSha: "f".repeat(40),
      changedPaths: [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 24 }],
      validation: {
        candidateDigestBefore: `sha256:${"1".repeat(64)}`,
        candidateDigestAfter: `sha256:${"1".repeat(64)}`,
        commands: [{ argv: ["npm", "run", "check:diff"], exitCode: 0 }],
      },
      productScope: bundle.input.productScope,
      optIn: bundle.input.optIn,
      outcome: "validated",
      reason: null,
    };
    const publicationReceipt = {
      version: 1,
      attemptKey: bundle.attemptKey,
      sourceHeadSha: bundle.input.sourceHeadSha,
      candidateTreeSha: "f".repeat(40),
      commitSha: "d".repeat(40),
      headRef: bundle.input.pullRequest.headRef,
      dispatchedWorkflows: [
        "pr.yaml",
        "commit-lint.yaml",
        "dco-check.yaml",
        "installer-hash-check.yaml",
        "code-scanning.yaml",
        "pr-review-advisor.yaml",
      ],
    };

    expectSchemaValid("attempt-receipt", attempt);
    expectSchemaValid("selection-input", bundle.input);
    expectSchemaValid("proposal-draft", draft);
    expectSchemaValid("proposal-receipt", proposalReceipt);
    expectSchemaValid("validation-receipt", validationReceipt);
    expectSchemaValid("publication-receipt", publicationReceipt);
  });

  it("does not treat maintainer permission as model data-egress consent (#10791)", () => {
    const receipt = createAttemptReceipt({
      ADVISOR_RUN_ID: "700",
      FINDING_IDS_JSON: "[]",
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PHASE1_ENABLED: "true",
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: "#10791",
      PRODUCT_SCOPE_KIND: "accepted-issue",
      REPOSITORY_EGRESS_AUTHORIZED: "false",
    });

    expect(receipt.dispatch.repositoryEgressAuthorized).toBe(false);
    expect(receipt.outcome).toBe("disabled");
    expect(receipt.reason).toBe("repository-egress-not-authorized");
  });

  it("redacts credential-shaped diagnostics before logging or receipt storage (#10791)", () => {
    const diagnostic = sanitizeDiagnostic(
      `token=plain-secret ghp_${"a".repeat(30)} github_pat_${"b".repeat(30)} nvapi-${"c".repeat(30)} sk-${"d".repeat(30)} https://operator:url-secret@example.com/failure?access_token=query-secret#fragment-secret`,
    );

    expect(diagnostic).toBe(
      "token=[REDACTED] [REDACTED] [REDACTED] [REDACTED] [REDACTED] https://example.com/failure?access_token=%5BREDACTED%5D",
    );
    expect(diagnostic).not.toContain("plain-secret");
    expect(diagnostic).not.toContain("operator");
    expect(diagnostic).not.toContain("url-secret");
    expect(diagnostic).not.toContain("query-secret");
    expect(diagnostic).not.toContain("fragment-secret");
    const bundle = selection();
    const parsedProposal = parseProposalReceipt(
      {
        ...proposal(bundle, ["src/demo.ts"]),
        summary: `Removed copied token ghp_${"e".repeat(30)}.`,
      },
      bundle,
    );
    expect(parsedProposal.summary).toBe("Removed copied token [REDACTED].");
  });

  it("selects only exact safe paths and records deterministic skip reasons (#10791)", () => {
    const parsed = parseSelectionInput(
      selectionInput({
        optIn: {
          findingIds: ["behavior:001", "class:001", "dependency:001", "escape:001"],
        },
        findings: [
          finding(),
          finding({
            id: "dependency:001",
            path: "src/dependency.ts",
            exclusions: ["dependency-change"],
          }),
          finding({ id: "escape:001", path: "../src/escape.ts" }),
          finding({ id: "class:001", repairClass: "documentation", path: "src/demo.ts" }),
        ],
      }),
    );
    const bundle = selectRepairAttempt(parsed);

    expect(bundle.phase).toBe("phase1-manual-publication");
    expect(bundle.identityStatus).toBe("exact-head-advisor-ledger");
    expect(bundle.selectedFindingIds).toEqual(["behavior:001"]);
    expect(bundle.selectedPaths).toEqual(["src/demo.ts"]);
    expect(bundle.decisions).toEqual([
      expect.objectContaining({ id: "behavior:001", state: "selected", reason: null }),
      expect.objectContaining({
        id: "class:001",
        state: "skipped",
        reason: "unsupported:path-class-mismatch",
      }),
      expect.objectContaining({
        id: "dependency:001",
        state: "skipped",
        reason: "excluded:dependency-change",
      }),
      expect.objectContaining({ id: "escape:001", state: "skipped", reason: "unsupported:path" }),
    ]);
    expect(parseSelectionBundle(JSON.parse(JSON.stringify(bundle)))).toEqual(bundle);
  });

  it("rejects stale opt-in identity and protected control paths (#10791)", () => {
    expect(() =>
      parseSelectionInput(
        selectionInput({
          optIn: {
            kind: "phase1-maintainer-dispatch",
            actor: "maintainer",
            triggeringActor: "maintainer",
            headSha: "f".repeat(40),
          },
        }),
      ),
    ).toThrow("manual opt-in is not bound");
    expect(safeRelativePath(".github/workflows/ci.yaml")).toBe(false);
    expect(safeRelativePath("test/e2e/live.test.ts")).toBe(false);
    expect(repairClassForPath("package-lock.json")).toBeNull();
    expect(repairClassForPath("docs/safe.mdx")).toBe("documentation");
    expect(repairClassForPath("test/safe.test.ts")).toBe("test");
  });

  it("binds the successful canonical Advisor run and exactly ten immutable artifacts (#10791)", () => {
    const run = validateAdvisorRun(
      {
        id: 700,
        run_attempt: 2,
        event: "pull_request_target",
        status: "completed",
        conclusion: "success",
        name: "Automation / PR Review Advisor",
        path: ".github/workflows/pr-review-advisor.yaml",
        head_sha: "c".repeat(40),
        repository: { full_name: "NVIDIA/NemoClaw" },
        head_repository: { full_name: "NVIDIA/NemoClaw" },
        pull_requests: [{ number: 42 }],
      },
      { prNumber: 42, runId: 700 },
    );
    const manifest = advisorManifest();

    expect(run).toEqual({ id: 700, attempt: 2, workflowSha: "c".repeat(40) });
    expect(manifest.artifacts).toHaveLength(10);
    expect(parseArtifactManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
    expect(() =>
      validateMaintainerPermission(
        {
          permission: "write",
          role_name: "write",
          user: { login: "maintainer", permissions: { admin: false, maintain: false } },
        },
        "maintainer",
      ),
    ).toThrow("admin or maintain");
    expect(() =>
      validateMaintainerPermission(
        {
          permission: "write",
          role_name: "maintain",
          user: { login: "maintainer", permissions: { admin: false, maintain: true } },
        },
        "maintainer",
      ),
    ).not.toThrow();
    expect(() =>
      validateAdvisorRun(
        {
          id: 700,
          run_attempt: 2,
          event: "workflow_dispatch",
          status: "completed",
          conclusion: "success",
          name: "Automation / PR Review Advisor",
          path: ".github/workflows/pr-review-advisor.yaml",
          head_sha: "c".repeat(40),
          repository: { full_name: "NVIDIA/NemoClaw" },
          head_repository: { full_name: "NVIDIA/NemoClaw" },
          pull_requests: [{ number: 42 }],
        },
        { prNumber: 42, runId: 700 },
      ),
    ).toThrow("pull_request_target");
  });

  it("constructs resolver Git environments without inheriting host authority (#10791)", () => {
    expect(
      resolverGitEnvironment({
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
        ACTIONS_RUNTIME_TOKEN: "runtime-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        GH_TOKEN: "github-secret",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.sshCommand",
        GIT_CONFIG_VALUE_0: "credential-reader",
        GIT_DIR: "/attacker/git",
        HOME: "/attacker/home",
        LANG: "C.UTF-8",
        OPENAI_API_KEY: "model-secret",
        PATH: "/usr/bin",
        PR_REVIEW_ADVISOR_API_KEY: "advisor-secret",
        TZ: "UTC",
      }),
    ).toEqual({
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      HOME: "/nonexistent",
      LANG: "C.UTF-8",
      PATH: "/usr/bin",
      TZ: "UTC",
    });
  });

  it("turns candidate file differences into a trusted patch and validates it (#10791)", () => {
    const fixture = createSourceFixture();
    const root = temporaryDirectory();
    const selectionFile = path.join(root, "selection.json");
    const contextFile = path.join(root, "repair-context.json");
    const exportDirectory = path.join(root, "export");
    const configDirectory = path.join(root, "config");
    const outputDirectory = path.join(root, "output");
    writeJson(selectionFile, fixture.bundle);
    writeJson(contextFile, { bounded: true });
    prepareRepairWorkspace({
      sourceCheckout: fixture.repository,
      selectionFile,
      repairContextFile: contextFile,
      exportDirectory,
      configDirectory,
      outputDirectory,
    });
    expect(fs.readdirSync(configDirectory).sort()).toEqual([
      "models.json",
      "proposal-template.json",
      "repair-input.json",
      "turn-1.txt",
      "turn-2.txt",
    ]);
    expect(fs.readFileSync(path.join(configDirectory, "repair-input.json"), "utf8")).not.toContain(
      fixture.bundle.input.sourceHeadSha,
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(configDirectory, "proposal-template.json"), "utf8")),
    ).not.toHaveProperty("sourceHeadSha");
    expect(
      JSON.parse(fs.readFileSync(path.join(configDirectory, "proposal-template.json"), "utf8")),
    ).not.toHaveProperty("attemptKey");
    const candidate = path.join(root, "candidate");
    fs.cpSync(path.join(exportDirectory, "repo"), candidate, { recursive: true });
    write(candidate, "src/demo.ts", "export const value = 2;\n");
    const proposalFile = path.join(root, "proposal.json");
    writeJson(proposalFile, proposalDraft(fixture.bundle, ["src/demo.ts"]));
    const repairArtifact = path.join(root, "repair-artifact");

    exportTrustedRepairPatch({
      sourceCheckout: fixture.repository,
      baselineExport: path.join(exportDirectory, "repo"),
      candidateRepository: candidate,
      proposalFile,
      selectionFile,
      artifactDirectory: repairArtifact,
      stagingDirectory: path.join(root, "export-staging"),
    });
    const validationEnvironments: NodeJS.ProcessEnv[] = [];
    const result = validateRepairLocally({
      sourceCheckout: fixture.repository,
      selection: fixture.bundle,
      patchFile: path.join(repairArtifact, "repair.patch"),
      proposalFile: path.join(repairArtifact, "proposal.json"),
      stagingDirectory: path.join(root, "validation-staging"),
      env: {
        ...process.env,
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-secret",
        ACTIONS_RUNTIME_TOKEN: "runtime-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        GH_TOKEN: "github-secret",
        OPENAI_API_KEY: "model-secret",
      },
      commandRunner: (_repository, command, args, env) => {
        validationEnvironments.push(env);
        return { argv: [command, ...args], exitCode: 0 };
      },
    });

    expect(result.receipt.outcome).toBe("validated");
    expect(result.receipt.changedPaths).toEqual([
      { path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 24 },
    ]);
    expect(result.receipt.validation.candidateDigestAfter).toBe(
      result.receipt.validation.candidateDigestBefore,
    );
    expect(result.receipt.validation.commands.map(({ argv }) => argv)).toEqual([
      [
        "npm",
        "ci",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--registry=https://registry.npmjs.org/",
      ],
      ["npm", "run", "check:diff"],
      [
        "npx",
        "--no-install",
        "vitest",
        "run",
        "--project",
        "integration",
        "test/automation/pull-requests/growth-guardrails.test.ts",
      ],
      [
        "npx",
        "--no-install",
        "vitest",
        "run",
        "--changed",
        fixture.headSha,
        "--project",
        "cli",
        "--project",
        "integration",
        "--project",
        "plugin",
      ],
    ]);
    expect(validationEnvironments).toHaveLength(4);
    expectCredentialFreeValidationEnvironment(validationEnvironments[0]!);
    expectCredentialFreeValidationEnvironment(validationEnvironments[1]!);
    expectCredentialFreeValidationEnvironment(validationEnvironments[2]!);
    expectCredentialFreeValidationEnvironment(validationEnvironments[3]!);
  });

  it("refuses to install dependencies selected by the PR head (#10791)", () => {
    const fixture = createSourceFixture();
    write(
      fixture.repository,
      "package.json",
      '{"name":"untrusted-dependency-input","version":"1.0.0"}\n',
    );
    git(fixture.repository, ["add", "package.json"]);
    git(fixture.repository, ["commit", "-m", "test: add PR-controlled dependency input"]);
    const sourceHeadSha = git(fixture.repository, ["rev-parse", "HEAD"]);
    const bundle = selection({
      baseSha: fixture.bundle.input.baseSha,
      sourceHeadSha,
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha: sourceHeadSha,
      },
    });
    const root = temporaryDirectory();
    const selectionFile = path.join(root, "selection.json");
    const contextFile = path.join(root, "repair-context.json");
    const exportDirectory = path.join(root, "export");
    writeJson(selectionFile, bundle);
    writeJson(contextFile, { bounded: true });
    prepareRepairWorkspace({
      sourceCheckout: fixture.repository,
      selectionFile,
      repairContextFile: contextFile,
      exportDirectory,
      configDirectory: path.join(root, "config"),
      outputDirectory: path.join(root, "output"),
    });
    const candidate = path.join(root, "candidate");
    fs.cpSync(path.join(exportDirectory, "repo"), candidate, { recursive: true });
    write(candidate, "src/demo.ts", "export const value = 2;\n");
    const proposalFile = path.join(root, "proposal.json");
    writeJson(proposalFile, proposalDraft(bundle, ["src/demo.ts"]));
    const repairArtifact = path.join(root, "repair-artifact");
    exportTrustedRepairPatch({
      sourceCheckout: fixture.repository,
      baselineExport: path.join(exportDirectory, "repo"),
      candidateRepository: candidate,
      proposalFile,
      selectionFile,
      artifactDirectory: repairArtifact,
      stagingDirectory: path.join(root, "export-staging"),
    });

    expect(() =>
      validateRepairLocally({
        sourceCheckout: fixture.repository,
        selection: bundle,
        patchFile: path.join(repairArtifact, "repair.patch"),
        proposalFile: path.join(repairArtifact, "proposal.json"),
        stagingDirectory: path.join(root, "validation-staging"),
        commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
      }),
    ).toThrow("pull request changes a control surface that Phase 1 cannot validate: package.json");
  });

  it("rejects candidate paths, special files, secrets, and validation mutation (#10791)", () => {
    const fixture = createSourceFixture();
    const root = temporaryDirectory();
    const selectionFile = path.join(root, "selection.json");
    const contextFile = path.join(root, "repair-context.json");
    const exportDirectory = path.join(root, "export");
    writeJson(selectionFile, fixture.bundle);
    writeJson(contextFile, { bounded: true });
    prepareRepairWorkspace({
      sourceCheckout: fixture.repository,
      selectionFile,
      repairContextFile: contextFile,
      exportDirectory,
      configDirectory: path.join(root, "config"),
      outputDirectory: path.join(root, "output"),
    });

    const escapedCandidate = path.join(root, "candidate-escape");
    fs.cpSync(path.join(exportDirectory, "repo"), escapedCandidate, { recursive: true });
    write(escapedCandidate, "docs/example.mdx", "# unrelated\n");
    writeJson(
      path.join(root, "escaped-proposal.json"),
      proposalDraft(fixture.bundle, ["src/demo.ts"]),
    );
    expect(() =>
      exportTrustedRepairPatch({
        sourceCheckout: fixture.repository,
        baselineExport: path.join(exportDirectory, "repo"),
        candidateRepository: escapedCandidate,
        proposalFile: path.join(root, "escaped-proposal.json"),
        selectionFile,
        artifactDirectory: path.join(root, "escaped-artifact"),
        stagingDirectory: path.join(root, "escaped-staging"),
      }),
    ).toThrow("outside the selected allowlist");

    const symlinkCandidate = path.join(root, "candidate-symlink");
    fs.cpSync(path.join(exportDirectory, "repo"), symlinkCandidate, { recursive: true });
    fs.rmSync(path.join(symlinkCandidate, "src/demo.ts"));
    fs.symlinkSync(contextFile, path.join(symlinkCandidate, "src/demo.ts"));
    writeJson(
      path.join(root, "symlink-proposal.json"),
      proposalDraft(fixture.bundle, ["src/demo.ts"]),
    );
    expect(() =>
      exportTrustedRepairPatch({
        sourceCheckout: fixture.repository,
        baselineExport: path.join(exportDirectory, "repo"),
        candidateRepository: symlinkCandidate,
        proposalFile: path.join(root, "symlink-proposal.json"),
        selectionFile,
        artifactDirectory: path.join(root, "symlink-artifact"),
        stagingDirectory: path.join(root, "symlink-staging"),
      }),
    ).toThrow("unsafe path");

    expectCredentialPatchRejected({
      root,
      suffix: "token-secret",
      content: `export const key = "ghp_${"x".repeat(30)}";\n`,
      sourceCheckout: fixture.repository,
      baselineExport: path.join(exportDirectory, "repo"),
      selectionFile,
      bundle: fixture.bundle,
    });
    expectCredentialPatchRejected({
      root,
      suffix: "url-secret",
      content: 'export const endpoint = "https://operator:url-secret@example.test/api";\n',
      sourceCheckout: fixture.repository,
      baselineExport: path.join(exportDirectory, "repo"),
      selectionFile,
      bundle: fixture.bundle,
    });

    const validCandidate = path.join(root, "candidate-mutation");
    fs.cpSync(path.join(exportDirectory, "repo"), validCandidate, { recursive: true });
    write(validCandidate, "src/demo.ts", "export const value = 2;\n");
    const validProposal = path.join(root, "mutation-proposal.json");
    writeJson(validProposal, proposalDraft(fixture.bundle, ["src/demo.ts"]));
    const validArtifact = path.join(root, "mutation-artifact");
    exportTrustedRepairPatch({
      sourceCheckout: fixture.repository,
      baselineExport: path.join(exportDirectory, "repo"),
      candidateRepository: validCandidate,
      proposalFile: validProposal,
      selectionFile,
      artifactDirectory: validArtifact,
      stagingDirectory: path.join(root, "mutation-export"),
    });
    expect(() =>
      validateRepairLocally({
        sourceCheckout: fixture.repository,
        selection: fixture.bundle,
        patchFile: path.join(validArtifact, "repair.patch"),
        proposalFile: path.join(validArtifact, "proposal.json"),
        stagingDirectory: path.join(root, "mutation-validation"),
        commandRunner: (repository, command, args) => {
          write(repository, "src/demo.ts", "export const value = 3;\n");
          return { argv: [command, ...args], exitCode: 0 };
        },
      }),
    ).toThrow();
  });

  it("rejects ignored output created after dependency preparation (#10791)", () => {
    const fixture = createSourceFixture();
    const root = temporaryDirectory();
    const selectionFile = path.join(root, "selection.json");
    const contextFile = path.join(root, "repair-context.json");
    const exportDirectory = path.join(root, "export");
    writeJson(selectionFile, fixture.bundle);
    writeJson(contextFile, { bounded: true });
    prepareRepairWorkspace({
      sourceCheckout: fixture.repository,
      selectionFile,
      repairContextFile: contextFile,
      exportDirectory,
      configDirectory: path.join(root, "config"),
      outputDirectory: path.join(root, "output"),
    });
    const candidate = path.join(root, "candidate-ignored-mutation");
    fs.cpSync(path.join(exportDirectory, "repo"), candidate, { recursive: true });
    write(candidate, "src/demo.ts", "export const value = 2;\n");
    const proposalFile = path.join(root, "ignored-mutation-proposal.json");
    writeJson(proposalFile, proposalDraft(fixture.bundle, ["src/demo.ts"]));
    const repairArtifact = path.join(root, "ignored-mutation-artifact");
    exportTrustedRepairPatch({
      sourceCheckout: fixture.repository,
      baselineExport: path.join(exportDirectory, "repo"),
      candidateRepository: candidate,
      proposalFile,
      selectionFile,
      artifactDirectory: repairArtifact,
      stagingDirectory: path.join(root, "ignored-mutation-export"),
    });
    let commandCount = 0;

    expect(() =>
      validateRepairLocally({
        sourceCheckout: fixture.repository,
        selection: fixture.bundle,
        patchFile: path.join(repairArtifact, "repair.patch"),
        proposalFile: path.join(repairArtifact, "proposal.json"),
        stagingDirectory: path.join(root, "ignored-mutation-validation"),
        commandRunner: (repository, command, args) => {
          commandCount += 1;
          commandCount > 1 && write(repository, "ignored-output/proof.txt", "mutated\n");
          return { argv: [command, ...args], exitCode: 0 };
        },
      }),
    ).toThrow("trusted validation changed the candidate patch");
  });

  it("rejects a committed symlink at an otherwise selected source path (#10791)", () => {
    const fixture = createSourceFixture();
    fs.rmSync(path.join(fixture.repository, "src/demo.ts"));
    fs.symlinkSync("pr-owned.ts", path.join(fixture.repository, "src/demo.ts"));
    git(fixture.repository, ["add", "src/demo.ts"]);
    git(fixture.repository, ["commit", "-m", "test: replace selected fixture with symlink"]);
    const headSha = git(fixture.repository, ["rev-parse", "HEAD"]);
    const bundle = selection({
      baseSha: fixture.bundle.input.baseSha,
      sourceHeadSha: headSha,
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha,
      },
    });
    const root = temporaryDirectory();
    const selectionFile = path.join(root, "selection.json");
    const contextFile = path.join(root, "repair-context.json");
    const exportDirectory = path.join(root, "export");
    writeJson(selectionFile, bundle);
    writeJson(contextFile, { bounded: true });
    prepareRepairWorkspace({
      sourceCheckout: fixture.repository,
      selectionFile,
      repairContextFile: contextFile,
      exportDirectory,
      configDirectory: path.join(root, "config"),
      outputDirectory: path.join(root, "output"),
    });

    const candidate = path.join(root, "candidate");
    fs.cpSync(path.join(exportDirectory, "repo"), candidate, { recursive: true });
    write(candidate, "src/demo.ts", "export const value = 2;\n");
    const proposalFile = path.join(root, "proposal.json");
    writeJson(proposalFile, proposalDraft(bundle, ["src/demo.ts"]));
    expect(() =>
      exportTrustedRepairPatch({
        sourceCheckout: fixture.repository,
        baselineExport: path.join(exportDirectory, "repo"),
        candidateRepository: candidate,
        proposalFile,
        selectionFile,
        artifactDirectory: path.join(root, "artifact"),
        stagingDirectory: path.join(root, "export-staging"),
      }),
    ).toThrow("patch destination is unsafe");

    const patchRepository = path.join(root, "patch-repository");
    git(root, ["clone", "--no-local", fixture.repository, patchRepository]);
    fs.rmSync(path.join(patchRepository, "src/demo.ts"));
    write(patchRepository, "src/demo.ts", "export const value = 2;\n");
    const maliciousPatch = path.join(root, "replace-symlink.patch");
    fs.writeFileSync(
      maliciousPatch,
      execFileSync(
        "git",
        ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", "HEAD", "--"],
        { cwd: patchRepository },
      ),
    );
    const trustedProposalFile = path.join(root, "trusted-proposal.json");
    writeJson(trustedProposalFile, proposal(bundle, ["src/demo.ts"]));
    expect(() =>
      validateRepairLocally({
        sourceCheckout: fixture.repository,
        selection: bundle,
        patchFile: maliciousPatch,
        proposalFile: trustedProposalFile,
        stagingDirectory: path.join(root, "validation-staging"),
        commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
      }),
    ).toThrow("selected source path is not a regular blob");
  });

  it("rejects deletion of binary content hidden behind a source extension (#10791)", () => {
    const repository = temporaryDirectory();
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "Advisor Repair Test"]);
    git(repository, ["config", "user.email", "advisor-repair@example.test"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    fs.mkdirSync(path.join(repository, "src"));
    fs.writeFileSync(path.join(repository, "src/demo.ts"), Buffer.from([0, 1, 2, 3]));
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "test: add binary source fixture"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]);
    const bundle = selection({
      baseSha: headSha,
      sourceHeadSha: headSha,
      optIn: {
        kind: "phase1-maintainer-dispatch",
        actor: "maintainer",
        triggeringActor: "maintainer",
        headSha,
      },
    });
    const root = temporaryDirectory();
    const selectionFile = path.join(root, "selection.json");
    const contextFile = path.join(root, "repair-context.json");
    const exportDirectory = path.join(root, "export");
    writeJson(selectionFile, bundle);
    writeJson(contextFile, { bounded: true });
    prepareRepairWorkspace({
      sourceCheckout: repository,
      selectionFile,
      repairContextFile: contextFile,
      exportDirectory,
      configDirectory: path.join(root, "config"),
      outputDirectory: path.join(root, "output"),
    });
    const candidate = path.join(root, "candidate");
    fs.cpSync(path.join(exportDirectory, "repo"), candidate, { recursive: true });
    fs.rmSync(path.join(candidate, "src/demo.ts"));
    const proposalFile = path.join(root, "proposal.json");
    writeJson(proposalFile, proposalDraft(bundle, ["src/demo.ts"]));
    const artifactDirectory = path.join(root, "artifact");
    exportTrustedRepairPatch({
      sourceCheckout: repository,
      baselineExport: path.join(exportDirectory, "repo"),
      candidateRepository: candidate,
      proposalFile,
      selectionFile,
      artifactDirectory,
      stagingDirectory: path.join(root, "export-staging"),
    });

    expect(() =>
      validateRepairLocally({
        sourceCheckout: repository,
        selection: bundle,
        patchFile: path.join(artifactDirectory, "repair.patch"),
        proposalFile: path.join(artifactDirectory, "proposal.json"),
        stagingDirectory: path.join(root, "validation-staging"),
        commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
      }),
    ).toThrow("binary data");
  });

  it("stops when the live head or base no longer matches selection (#10791)", async () => {
    const bundle = selection();
    const request = async <T>(_apiPath: string, _token: string): Promise<T> =>
      ({
        number: 42,
        state: "open",
        draft: false,
        user: { login: "contributor" },
        head: { sha: "f".repeat(40), ref: "fix/demo", repo: { full_name: "NVIDIA/NemoClaw" } },
        base: { sha: "b".repeat(40), ref: "main", repo: { full_name: "NVIDIA/NemoClaw" } },
      }) as T;

    await expect(assertLivePullRequestIdentity(bundle, "token", request)).rejects.toThrow(
      "identity changed",
    );
  });

  it("stops when exact-head review feedback changes after selection (#10791)", async () => {
    const state = {
      version: 1 as const,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      headSha: "a".repeat(40),
      issueComments: [],
      reviews: [],
      threads: [],
    };
    const bundle = selection({
      advisor: {
        ...selection().input.advisor,
        reviewStateDigest: pullRequestReviewStateDigest(state),
      },
    });
    await expect(
      assertLiveReviewStateIdentity(bundle, "token", async () => state),
    ).resolves.toBeUndefined();

    const changedBody = "The selected head now has new actionable feedback.";
    await expect(
      assertLiveReviewStateIdentity(bundle, "token", async () => ({
        ...state,
        issueComments: [
          {
            id: 1,
            author: "reviewer",
            body: changedBody,
            bodySha256: `sha256:${sha256(changedBody)}`,
            bodyTruncated: false,
            createdAt: "2026-09-01T00:00:00Z",
            updatedAt: "2026-09-01T00:00:00Z",
          },
        ],
      })),
    ).rejects.toThrow("review-thread state changed");
  });

  it("runs repository checks in an offline credential-free OpenShell sandbox (#10791)", () => {
    const candidate = temporaryDirectory();
    fs.mkdirSync(path.join(candidate, ".git"));
    fs.mkdirSync(path.join(candidate, "node_modules"));
    const home = path.join(temporaryDirectory(), "home");
    const runnerTemp = path.join(temporaryDirectory(), "runner");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(runnerTemp, { recursive: true });
    const sandboxName = "phase1-validation-test";
    const tools: OpenShellTools = {
      run: vi.fn((_command, args) =>
        args.slice(0, 3).join(" ") === "sandbox list --names" ? sandboxName : "",
      ),
      runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
      start: vi.fn(),
      wait: vi.fn(async () => undefined),
    };
    const runner = createOpenShellValidationRunner(
      {
        ACTIONS_RUNTIME_TOKEN: "runtime-secret",
        AWS_SECRET_ACCESS_KEY: "cloud-secret",
        GH_TOKEN: "github-secret",
        GITHUB_TOKEN: "github-default-secret",
        HOME: home,
        OPENAI_API_KEY: "model-secret",
        OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
        PATH: "/usr/bin",
        PR_REVIEW_ADVISOR_API_KEY: "advisor-secret",
        RUNNER_TEMP: runnerTemp,
        TRUSTED_CHECKOUT: path.resolve("."),
        VALIDATION_IMAGE: `example.invalid/validation@sha256:${"a".repeat(64)}`,
        VALIDATION_SANDBOX_NAME: sandboxName,
      },
      tools,
    );

    expect(
      runner.commandRunner(candidate, "npm", ["run", "check:diff"], {
        GITHUB_TOKEN: "must-not-cross",
      }),
    ).toEqual({ argv: ["npm", "run", "check:diff"], exitCode: 0 });

    const calls = vi.mocked(tools.run).mock.calls;
    const create = calls.find(
      ([command, args]) =>
        command === "openshell" && args.slice(0, 2).join(" ") === "sandbox create",
    );
    expect(create).toBeDefined();
    const createArgs = create![1];
    const driverConfigIndex = createArgs.indexOf("--driver-config-json");
    expect(JSON.parse(createArgs[driverConfigIndex + 1] as string)).toEqual({
      docker: {
        mounts: [
          {
            type: "bind",
            source: fs.realpathSync(candidate),
            target: "/sandbox/repo",
            read_only: false,
          },
          {
            type: "bind",
            source: fs.realpathSync(path.join(candidate, ".git")),
            target: "/sandbox/repo/.git",
            read_only: true,
          },
          {
            type: "bind",
            source: fs.realpathSync(path.join(candidate, "node_modules")),
            target: "/sandbox/repo/node_modules",
            read_only: true,
          },
        ],
      },
    });
    expect(createArgs).toContain(`example.invalid/validation@sha256:${"a".repeat(64)}`);
    expect(createArgs).toContain(
      path.join(path.resolve("."), "tools", "pr-review-advisor-repair", "validation-policy.yaml"),
    );
    const execute = calls.find(
      ([command, args]) => command === "openshell" && args.slice(0, 2).join(" ") === "sandbox exec",
    );
    expect(execute?.[1]).toEqual(
      expect.arrayContaining([
        "--workdir",
        "/sandbox/repo",
        "--timeout",
        "1800",
        "--",
        "npm",
        "run",
        "check:diff",
      ]),
    );
    expect(execute?.[1].join("\n")).not.toMatch(/secret|TOKEN|AWS_/u);
    expectCredentialFreeOpenShellCalls(calls);

    runner.cleanup();
    expect(
      calls.some(
        ([, args]) => args.slice(0, 3).join(" ") === "sandbox delete phase1-validation-test",
      ),
    ).toBe(true);
  });

  it("starts a bind-mount gateway without configuring a model provider (#10791)", async () => {
    const root = temporaryDirectory();
    const stop = vi.fn(async () => undefined);
    const tools: OpenShellTools = {
      run: vi.fn((command, args, options) => {
        switch (`${command} ${args.join(" ")}`) {
          case "which openshell-sandbox":
            return "/trusted/openshell-sandbox";
          case "openshell gateway info -o json":
            return JSON.stringify({
              gateway: options.env.OPENSHELL_GATEWAY_ENDPOINT,
              server: options.env.OPENSHELL_GATEWAY_ENDPOINT,
              status: "healthy",
            });
          default:
            return "";
        }
      }),
      runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
      start: vi.fn(() => stop),
      wait: vi.fn(async () => undefined),
    };
    const gateway = startOwnedOpenShellGateway(
      {
        GH_TOKEN: "github-secret",
        GITHUB_TOKEN: "github-default-secret",
        HOME: path.join(root, "home"),
        OPENAI_API_KEY: "model-secret",
        OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
        PATH: "/usr/bin",
        RUNNER_TEMP: root,
      },
      { enableBindMounts: true, gatewayId: "phase1-validation" },
      tools,
    );

    await gateway.ready;
    const configuration = fs.readFileSync(
      path.join(root, "openshell-gateway", "gateway.toml"),
      "utf8",
    );
    expect(configuration).toContain("enable_bind_mounts = true");
    expect(vi.mocked(tools.run).mock.calls.flatMap(([, args]) => args)).not.toContain("provider");
    expectCredentialFreeOpenShellCalls(vi.mocked(tools.run).mock.calls);
    await gateway.stop();
    expect(stop).toHaveBeenCalledOnce();
  });

  it("rejects a foreign healthy listener when the owned gateway exits (#10791)", async () => {
    const root = temporaryDirectory();
    const stop = Object.assign(
      vi.fn(async () => undefined),
      {
        exit: Promise.resolve({ code: 1, signal: null }),
        isRunning: () => false,
      },
    );
    const endpoint = "http://127.0.0.1:49152";
    const tools: OpenShellTools = {
      run: vi.fn((command, args) => {
        switch (`${command} ${args.join(" ")}`) {
          case "which openshell-sandbox":
            return "/trusted/openshell-sandbox";
          case "openshell gateway info -o json":
            return JSON.stringify({ gateway: endpoint, server: endpoint, status: "healthy" });
          default:
            return "";
        }
      }),
      runAsync: vi.fn(() => ({ cancel: vi.fn(), completion: Promise.resolve() })),
      start: vi.fn(() => stop),
      wait: vi.fn(async () => undefined),
    };
    const gateway = startOwnedOpenShellGateway(
      {
        HOME: path.join(root, "home"),
        OPENSHELL_GATEWAY_ENDPOINT: endpoint,
        PATH: "/usr/bin",
        RUNNER_TEMP: root,
      },
      { enableBindMounts: true, gatewayId: "phase1-validation" },
      tools,
    );

    await expect(gateway.ready).rejects.toThrow("exited before becoming ready");
    expect(stop).toHaveBeenCalledOnce();
  });

  it("uses trusted non-live validation lanes for source and docs (#10791)", () => {
    expect(
      validationCommands(
        [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 1 }],
        "a".repeat(40),
      ),
    ).toContainEqual([
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "--changed",
        "a".repeat(40),
        "--project",
        "cli",
        "--project",
        "integration",
        "--project",
        "plugin",
      ],
    ]);
    expect(
      validationCommands(
        [{ path: "docs/demo.mdx", status: "M", mode: "100644", type: "blob", bytes: 1 }],
        "a".repeat(40),
      ),
    ).toEqual([
      [
        "npm",
        [
          "ci",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--registry=https://registry.npmjs.org/",
        ],
      ],
      ["npm", ["run", "docs"]],
    ]);
    expect(
      validationCommands(
        [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob", bytes: 1 }],
        "a".repeat(40),
      ).flat(2),
    ).not.toContain("e2e-support");
  });

  it("maps every eligible non-E2E test contract to its trusted project (#10791)", () => {
    const sourceHeadSha = "a".repeat(40);
    const installerCommands = validationCommands(
      [
        {
          path: "test/installer-integration/install.test.ts",
          status: "M",
          mode: "100644",
          type: "blob",
          bytes: 1,
        },
      ],
      sourceHeadSha,
    );
    expect(installerCommands).toContainEqual([
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "--changed",
        sourceHeadSha,
        "--project",
        "installer-integration",
      ],
    ]);

    const packageCommands = validationCommands(
      [
        {
          path: "test/package-contract/package.test.ts",
          status: "M",
          mode: "100644",
          type: "blob",
          bytes: 1,
        },
      ],
      sourceHeadSha,
    );
    expect(packageCommands).toContainEqual(["npm", ["run", "build:cli"]]);
    expect(packageCommands).toContainEqual(["npm", ["--prefix", "nemoclaw", "run", "build"]]);
    expect(packageCommands).toContainEqual([
      "npx",
      [
        "--no-install",
        "vitest",
        "run",
        "--changed",
        sourceHeadSha,
        "--project",
        "package-contract",
      ],
    ]);
    expect([...installerCommands, ...packageCommands].flat(2)).not.toContain("e2e-support");
  });

  it("does not label a no-change proposal as a validated patch artifact (#10791)", () => {
    const fixture = createSourceFixture();
    const root = temporaryDirectory();
    const patchFile = path.join(root, "repair.patch");
    const proposalFile = path.join(root, "proposal.json");
    fs.writeFileSync(patchFile, "");
    writeJson(proposalFile, {
      version: 1,
      attemptKey: fixture.bundle.attemptKey,
      sourceHeadSha: fixture.bundle.input.sourceHeadSha,
      findingIds: fixture.bundle.selectedFindingIds,
      unresolvedFindingIds: fixture.bundle.selectedFindingIds,
      changedPaths: [],
      summary: "Pi reported no safe change.",
      outcome: "no-change",
    });
    const result = validateRepairLocally({
      sourceCheckout: fixture.repository,
      selection: fixture.bundle,
      patchFile,
      proposalFile,
      stagingDirectory: path.join(root, "validation-staging"),
    });
    const artifactDirectory = path.join(root, "validation-artifact");

    writeValidationArtifacts(artifactDirectory, result.receipt, result.patch);

    expect(result.receipt.outcome).toBe("skipped");
    expect(fs.readdirSync(artifactDirectory)).toEqual(["validation-receipt.json"]);
    expect(() => writeValidationArtifacts(artifactDirectory, result.receipt, result.patch)).toThrow(
      "validation artifact destination already exists",
    );
  });
});
