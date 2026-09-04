// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type OpenShellProcessExit,
  type OpenShellStop,
  type OpenShellTools,
  startOwnedOpenShellGateway,
} from "../../../tools/openshell-agent/runtime.mts";
import { createAttemptReceipt } from "../../../tools/pr-review-advisor-repair/audit.mts";
import {
  assertRepairContractSchema,
  parseSelectionInput,
  repairClassForPath,
  type SelectionBundle,
  safeRelativePath,
  sanitizeDiagnostic,
  selectRepairAttempt,
  sha256,
} from "../../../tools/pr-review-advisor-repair/contract.mts";
import {
  exportTrustedRepairPatch,
  prepareRepairWorkspace,
  resolverGitEnvironment,
} from "../../../tools/pr-review-advisor-repair/resolve.mts";
import {
  expectedAdvisorArtifactNames,
  validateAdvisorArtifacts,
  validateAdvisorRun,
} from "../../../tools/pr-review-advisor-repair/select.mts";
import {
  assertLivePullRequestIdentity,
  assertLiveReviewStateIdentity,
  createOpenShellValidationRunner,
  validateRepairLocally,
  validationCommands,
  writeValidationArtifacts,
} from "../../../tools/pr-review-advisor-repair/validate.mts";
import {
  asGitHubRequest,
  repairFinding as finding,
  fixtureGit as git,
  mutationAfterFirstCommand,
  ownedGatewayResponder,
  repairValidationReceipt,
  repairSelection as selection,
  repairSelectionInput as selectionInput,
  writeFixture as write,
  writeJsonFixture as writeJson,
} from "../../helpers/pr-review-advisor-repair.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "advisor-repair-"));
  temporaryDirectories.push(directory);
  return directory;
}

function sourceFixture(): {
  repository: string;
  headSha: string;
  bundle: SelectionBundle;
} {
  const repository = temporaryDirectory();
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["config", "user.name", "Advisor Repair Test"]);
  git(repository, ["config", "user.email", "advisor-repair@example.test"]);
  git(repository, ["config", "commit.gpgsign", "false"]);
  write(repository, ".gitignore", "ignored-output/\n");
  write(repository, "src/demo.ts", "export const value = 1;\n");
  write(repository, "docs/example.mdx", "# Example\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add base fixture"]);
  const baseSha = git(repository, ["rev-parse", "HEAD"]);
  write(repository, "src/pr-owned.ts", "export const prOwned = true;\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "test: add PR fixture"]);
  const headSha = git(repository, ["rev-parse", "HEAD"]);
  return {
    repository,
    headSha,
    bundle: selection({ baseSha, sourceHeadSha: headSha, optIn: { headSha } }),
  };
}

function draft(bundle: SelectionBundle, changedPaths = ["src/demo.ts"]) {
  return {
    version: 1,
    findingIds: bundle.selectedFindingIds,
    unresolvedFindingIds: [],
    changedPaths,
    summary: "Updated the selected implementation path.",
    outcome: "proposed",
  };
}

function preparedCandidate(
  input: { fixture?: ReturnType<typeof sourceFixture>; content?: string } = {},
) {
  const fixture = input.fixture ?? sourceFixture();
  const root = temporaryDirectory();
  const selectionFile = path.join(root, "selection.json");
  const exportDirectory = path.join(root, "export");
  writeJson(selectionFile, fixture.bundle);
  writeJson(path.join(root, "context.json"), { bounded: true });
  prepareRepairWorkspace({
    sourceCheckout: fixture.repository,
    selectionFile,
    repairContextFile: path.join(root, "context.json"),
    exportDirectory,
    configDirectory: path.join(root, "config"),
    outputDirectory: path.join(root, "output"),
  });
  const candidate = path.join(root, "candidate");
  fs.cpSync(path.join(exportDirectory, "repo"), candidate, { recursive: true });
  write(candidate, "src/demo.ts", input.content ?? "export const value = 2;\n");
  const proposalFile = path.join(root, "proposal.json");
  writeJson(proposalFile, draft(fixture.bundle));
  return {
    ...fixture,
    root,
    selectionFile,
    baselineExport: path.join(exportDirectory, "repo"),
    candidate,
    proposalFile,
  };
}

function exportedPatch(prepared: ReturnType<typeof preparedCandidate>) {
  const artifactDirectory = path.join(prepared.root, "repair-artifact");
  exportTrustedRepairPatch({
    sourceCheckout: prepared.repository,
    baselineExport: prepared.baselineExport,
    candidateRepository: prepared.candidate,
    proposalFile: prepared.proposalFile,
    selectionFile: prepared.selectionFile,
    artifactDirectory,
    stagingDirectory: path.join(prepared.root, "export-staging"),
  });
  return {
    patchFile: path.join(artifactDirectory, "repair.patch"),
    proposalFile: path.join(artifactDirectory, "proposal.json"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe("PR Review Advisor repair Phase 1", () => {
  it("fails closed at the emergency, rerun, and egress gates (#10791)", () => {
    const base = {
      ADVISOR_RUN_ID: "700",
      FINDING_IDS_JSON: "[]",
      GITHUB_ACTOR: "maintainer",
      GITHUB_RUN_ID: "900",
      GITHUB_TRIGGERING_ACTOR: "maintainer",
      GITHUB_WORKFLOW_SHA: "d".repeat(40),
      PR_NUMBER: "42",
      PRODUCT_SCOPE_IDENTITY: "#10791",
      PRODUCT_SCOPE_KIND: "accepted-issue",
    };
    expect(
      createAttemptReceipt({
        ...base,
        GITHUB_RUN_ATTEMPT: "1",
        PHASE1_ENABLED: "false",
      }),
    ).toMatchObject({
      outcome: "disabled",
      reason: "emergency-switch-disabled",
    });
    expect(
      createAttemptReceipt({
        ...base,
        GITHUB_RUN_ATTEMPT: "2",
        PHASE1_ENABLED: "true",
        REPOSITORY_EGRESS_AUTHORIZED: "true",
      }),
    ).toMatchObject({ outcome: "disabled", reason: "workflow-rerun-disabled" });
    expect(
      createAttemptReceipt({
        ...base,
        GITHUB_RUN_ATTEMPT: "1",
        PHASE1_ENABLED: "true",
        REPOSITORY_EGRESS_AUTHORIZED: "false",
      }),
    ).toMatchObject({
      outcome: "disabled",
      reason: "repository-egress-not-authorized",
    });
  });

  it("keeps each handoff aligned with its committed schema (#10791)", () => {
    const bundle = selection();
    const proposalDraft = draft(bundle);
    const proposalReceipt = {
      attemptKey: bundle.attemptKey,
      sourceHeadSha: bundle.input.sourceHeadSha,
      ...proposalDraft,
    };
    const patch = Buffer.from("patch");
    const receipts = [
      ["selection-input", bundle.input],
      ["proposal-draft", proposalDraft],
      ["proposal-receipt", proposalReceipt],
      ["validation-receipt", repairValidationReceipt(bundle, patch)],
      [
        "publication-receipt",
        {
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
        },
      ],
    ] as const;
    expect(
      receipts.map(([name, receipt]) => assertRepairContractSchema(name, receipt)),
    ).toHaveLength(receipts.length);
  });

  it("selects only an exact-head, safe, opted-in finding (#10791)", () => {
    const input = parseSelectionInput(
      selectionInput({
        findings: [
          finding(),
          finding({ id: "dependency:001", exclusions: ["dependency-change"] }),
          finding({ id: "escape:001", path: "../src/escape.ts" }),
          finding({ id: "class:001", repairClass: "documentation" }),
        ],
        optIn: {
          findingIds: ["behavior:001", "class:001", "dependency:001", "escape:001"],
        },
      }),
    );
    const bundle = selectRepairAttempt(input);
    expect(bundle.selectedFindingIds).toEqual(["behavior:001"]);
    expect(bundle.decisions.map(({ id, reason }) => [id, reason])).toEqual([
      ["behavior:001", null],
      ["class:001", "unsupported:path-class-mismatch"],
      ["dependency:001", "excluded:dependency-change"],
      ["escape:001", "unsupported:path"],
    ]);
    expect(() =>
      parseSelectionInput(selectionInput({ optIn: { headSha: "f".repeat(40) } })),
    ).toThrow("not bound");
    expect(safeRelativePath(".github/workflows/ci.yaml")).toBe(false);
    expect(safeRelativePath("test/e2e/live.test.ts")).toBe(false);
    expect(repairClassForPath("package-lock.json")).toBeNull();
  });

  it("binds one successful canonical Advisor run and its ten artifacts (#10791)", () => {
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
    const names = expectedAdvisorArtifactNames(700, 2);
    const manifest = validateAdvisorArtifacts(
      {
        total_count: names.length,
        artifacts: names.map((name, index) => ({
          id: index + 100,
          name,
          expired: false,
          size_in_bytes: 1024,
          digest: `sha256:${String(index).padStart(64, "0")}`,
          workflow_run: { id: 700, head_sha: "c".repeat(40) },
        })),
      },
      run,
    );
    expect(manifest.artifacts).toHaveLength(10);
  });

  it("redacts diagnostics and strips ambient Git authority (#10791)", () => {
    const diagnostic = sanitizeDiagnostic(
      `token=plain-secret ghp_${"a".repeat(30)} https://operator:url-secret@example.com/failure?access_token=query-secret`,
    );
    expect(diagnostic).not.toMatch(/plain-secret|operator|url-secret|query-secret/u);
    expect(
      resolverGitEnvironment({
        GH_TOKEN: "secret",
        GIT_CONFIG_COUNT: "1",
        GIT_DIR: "/attacker/git",
        HOME: "/attacker/home",
        PATH: "/usr/bin",
      }),
    ).toEqual(
      expect.objectContaining({
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
        HOME: "/nonexistent",
        PATH: "/usr/bin",
      }),
    );
  });

  it("exports only the selected patch and validates it independently (#10791)", () => {
    const prepared = preparedCandidate();
    const files = exportedPatch(prepared);
    const environments: NodeJS.ProcessEnv[] = [];
    const result = validateRepairLocally({
      sourceCheckout: prepared.repository,
      selection: prepared.bundle,
      ...files,
      stagingDirectory: path.join(prepared.root, "validation"),
      env: { GH_TOKEN: "github-secret", OPENAI_API_KEY: "model-secret" },
      commandRunner: (_repository, command, args, env) => {
        environments.push(env);
        return { argv: [command, ...args], exitCode: 0 };
      },
    });
    expect(result.receipt).toMatchObject({
      outcome: "validated",
      changedPaths: [{ path: "src/demo.ts", status: "M", mode: "100644", type: "blob" }],
    });
    expect(result.receipt.validation.candidateDigestAfter).toBe(
      result.receipt.validation.candidateDigestBefore,
    );
    expect(environments).not.toHaveLength(0);
    expect(
      environments.every(
        (environment) =>
          environment.GH_TOKEN === undefined && environment.OPENAI_API_KEY === undefined,
      ),
    ).toBe(true);

    const unresolved = preparedCandidate();
    writeJson(unresolved.proposalFile, {
      ...draft(unresolved.bundle),
      unresolvedFindingIds: unresolved.bundle.selectedFindingIds,
    });
    expect(() => exportedPatch(unresolved)).toThrow("cannot leave selected findings unresolved");
  });

  it("rejects output outside the allowlist, special files, credentials, and validation mutation (#10791)", () => {
    const outside = preparedCandidate();
    write(outside.candidate, "docs/example.mdx", "# unrelated\n");
    expect(() => exportedPatch(outside)).toThrow("outside the selected allowlist");

    const symlink = preparedCandidate();
    fs.rmSync(path.join(symlink.candidate, "src/demo.ts"));
    fs.symlinkSync(symlink.proposalFile, path.join(symlink.candidate, "src/demo.ts"));
    expect(() => exportedPatch(symlink)).toThrow("unsafe path");

    const secret = preparedCandidate({
      content: `export const key = "ghp_${"x".repeat(30)}";\n`,
    });
    const secretFiles = exportedPatch(secret);
    expect(() =>
      validateRepairLocally({
        sourceCheckout: secret.repository,
        selection: secret.bundle,
        ...secretFiles,
        stagingDirectory: path.join(secret.root, "validation"),
        commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
      }),
    ).toThrow("possible credential");

    const mutation = preparedCandidate();
    const mutationFiles = exportedPatch(mutation);
    expect(() =>
      validateRepairLocally({
        sourceCheckout: mutation.repository,
        selection: mutation.bundle,
        ...mutationFiles,
        stagingDirectory: path.join(mutation.root, "validation"),
        commandRunner: (repository, command, args) => {
          write(repository, "src/demo.ts", "export const value = 3;\n");
          return { argv: [command, ...args], exitCode: 0 };
        },
      }),
    ).toThrow("mutated the candidate");

    const ignored = preparedCandidate();
    const ignoredFiles = exportedPatch(ignored);
    expect(() =>
      validateRepairLocally({
        sourceCheckout: ignored.repository,
        selection: ignored.bundle,
        ...ignoredFiles,
        stagingDirectory: path.join(ignored.root, "validation"),
        commandRunner: mutationAfterFirstCommand(),
      }),
    ).toThrow("changed the candidate patch");
  });

  it("rejects PR-controlled dependency inputs and stale live identity (#10791)", async () => {
    const fixture = sourceFixture();
    write(fixture.repository, "package.json", '{"name":"untrusted","version":"1.0.0"}\n');
    git(fixture.repository, ["add", "package.json"]);
    git(fixture.repository, ["commit", "-m", "test: add dependency input"]);
    const headSha = git(fixture.repository, ["rev-parse", "HEAD"]);
    const prepared = preparedCandidate({
      fixture: {
        ...fixture,
        headSha,
        bundle: selection({
          baseSha: fixture.bundle.input.baseSha,
          sourceHeadSha: headSha,
          optIn: { headSha },
        }),
      },
    });
    const files = exportedPatch(prepared);
    expect(() =>
      validateRepairLocally({
        sourceCheckout: prepared.repository,
        selection: prepared.bundle,
        ...files,
        stagingDirectory: path.join(prepared.root, "validation"),
        commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
      }),
    ).toThrow("control surface");

    await expect(
      assertLivePullRequestIdentity(
        selection(),
        "token",
        asGitHubRequest(async () => ({
          number: 42,
          state: "open",
          draft: false,
          maintainer_can_modify: true,
          user: { login: "cjagwani" },
          head: {
            sha: "f".repeat(40),
            ref: "fix/demo",
            repo: { full_name: "NVIDIA/NemoClaw" },
          },
          base: {
            sha: "b".repeat(40),
            ref: "main",
            repo: { full_name: "NVIDIA/NemoClaw" },
          },
        })),
      ),
    ).rejects.toThrow("identity changed");

    const state = {
      version: 1 as const,
      repository: "NVIDIA/NemoClaw",
      prNumber: 42,
      headSha: "a".repeat(40),
      issueComments: [],
      reviews: [],
      threads: [],
    };
    await expect(
      assertLiveReviewStateIdentity(
        selection(),
        "token",
        asGitHubRequest(async () => state),
      ),
    ).resolves.toBeUndefined();
    const body = "New feedback on the selected head.";
    await expect(
      assertLiveReviewStateIdentity(
        selection(),
        "token",
        asGitHubRequest(async () => ({
          ...state,
          issueComments: [
            {
              id: 1,
              author: "reviewer",
              body,
              bodySha256: `sha256:${sha256(body)}`,
              bodyTruncated: false,
              createdAt: "2026-09-01T00:00:00Z",
              updatedAt: "2026-09-01T00:00:00Z",
            },
          ],
        })),
      ),
    ).rejects.toThrow("review-thread state changed");
  });

  it("rejects a selected source path that is a symlink or binary blob (#10791)", () => {
    const symlinkFixture = sourceFixture();
    fs.rmSync(path.join(symlinkFixture.repository, "src/demo.ts"));
    fs.symlinkSync("pr-owned.ts", path.join(symlinkFixture.repository, "src/demo.ts"));
    git(symlinkFixture.repository, ["add", "src/demo.ts"]);
    git(symlinkFixture.repository, ["commit", "-m", "test: add selected symlink"]);
    const symlinkHead = git(symlinkFixture.repository, ["rev-parse", "HEAD"]);
    const symlink = preparedCandidate({
      fixture: {
        ...symlinkFixture,
        headSha: symlinkHead,
        bundle: selection({
          baseSha: symlinkFixture.bundle.input.baseSha,
          sourceHeadSha: symlinkHead,
          optIn: { headSha: symlinkHead },
        }),
      },
    });
    expect(() => exportedPatch(symlink)).toThrow(/unsafe|allowlist/u);

    const repository = temporaryDirectory();
    git(repository, ["init", "--initial-branch=main"]);
    git(repository, ["config", "user.name", "Advisor Repair Test"]);
    git(repository, ["config", "user.email", "advisor-repair@example.test"]);
    git(repository, ["config", "commit.gpgsign", "false"]);
    fs.mkdirSync(path.join(repository, "src"));
    fs.writeFileSync(path.join(repository, "src/demo.ts"), Buffer.from([0, 1, 2, 3]));
    git(repository, ["add", "."]);
    git(repository, ["commit", "-m", "test: add binary source"]);
    const headSha = git(repository, ["rev-parse", "HEAD"]);
    const binary = preparedCandidate({
      fixture: {
        repository,
        headSha,
        bundle: selection({
          baseSha: headSha,
          sourceHeadSha: headSha,
          optIn: { headSha },
        }),
      },
    });
    fs.rmSync(path.join(binary.candidate, "src/demo.ts"));
    const files = exportedPatch(binary);
    expect(() =>
      validateRepairLocally({
        sourceCheckout: repository,
        selection: binary.bundle,
        ...files,
        stagingDirectory: path.join(binary.root, "validation"),
        commandRunner: () => ({ argv: ["unused"], exitCode: 0 }),
      }),
    ).toThrow("binary data");
  });

  it("runs trusted checks in a credential-free OpenShell sandbox (#10791)", () => {
    const candidate = temporaryDirectory();
    fs.mkdirSync(path.join(candidate, ".git"));
    fs.mkdirSync(path.join(candidate, "node_modules"));
    const sandboxName = "phase1-validation-test";
    const tools: OpenShellTools = {
      run: vi.fn((_command, args) =>
        args.slice(0, 3).join(" ") === "sandbox list --names" ? sandboxName : "",
      ),
      runAsync: vi.fn(() => ({
        cancel: vi.fn(),
        completion: Promise.resolve(),
      })),
      start: vi.fn(),
      wait: vi.fn(async () => undefined),
    };
    const runner = createOpenShellValidationRunner(
      {
        GH_TOKEN: "secret",
        HOME: path.join(temporaryDirectory(), "home"),
        OPENAI_API_KEY: "secret",
        OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
        PATH: "/usr/bin",
        RUNNER_TEMP: temporaryDirectory(),
        TRUSTED_CHECKOUT: path.resolve("."),
        VALIDATION_IMAGE: `example.invalid/validation@sha256:${"a".repeat(64)}`,
        VALIDATION_SANDBOX_NAME: sandboxName,
      },
      tools,
    );
    expect(
      runner.commandRunner(candidate, "npm", ["run", "check:diff"], {
        GITHUB_TOKEN: "secret",
      }),
    ).toEqual({ argv: ["npm", "run", "check:diff"], exitCode: 0 });
    const calls = vi.mocked(tools.run).mock.calls;
    expect(
      calls.find(([, args]) => args.slice(0, 2).join(" ") === "sandbox create")?.[1].join(" "),
    ).toContain("--driver-config-json");
    expect(calls.find(([, args]) => args.slice(0, 2).join(" ") === "sandbox exec")?.[1]).toEqual(
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
    expect(JSON.stringify(calls)).not.toMatch(/github-secret|model-secret/u);
    runner.cleanup();
    expect(calls.some(([, args]) => args.join(" ") === `sandbox delete ${sandboxName}`)).toBe(true);
  });

  it("starts an owned bind-mount gateway without a model provider (#10791)", async () => {
    const root = temporaryDirectory();
    const endpoint = "http://127.0.0.1:8080";
    const stop = Object.assign(
      vi.fn(async () => undefined),
      {
        exit: new Promise<OpenShellProcessExit>(() => undefined),
        isRunning: () => true,
      },
    ) satisfies OpenShellStop;
    const tools: OpenShellTools = {
      run: vi.fn(
        ownedGatewayResponder("phase1-validation", endpoint, "/trusted/openshell-sandbox"),
      ),
      runAsync: vi.fn(() => ({
        cancel: vi.fn(),
        completion: Promise.resolve(),
      })),
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
    await gateway.ready;
    expect(fs.readFileSync(path.join(root, "openshell-gateway", "gateway.toml"), "utf8")).toContain(
      "enable_bind_mounts = true",
    );
    expect(vi.mocked(tools.run).mock.calls.flatMap(([, args]) => args)).not.toContain("provider");
    await gateway.stop();
    expect(stop).toHaveBeenCalledOnce();

    const deadStop = Object.assign(
      vi.fn(async () => undefined),
      {
        exit: Promise.resolve({ code: 1, signal: null }),
        isRunning: () => false,
      },
    ) satisfies OpenShellStop;
    const deadTools = { ...tools, start: vi.fn(() => deadStop) };
    const deadRoot = temporaryDirectory();
    const foreign = startOwnedOpenShellGateway(
      {
        HOME: path.join(deadRoot, "home"),
        OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
        PATH: "/usr/bin",
        RUNNER_TEMP: deadRoot,
      },
      { enableBindMounts: true, gatewayId: "phase1-validation" },
      deadTools,
    );
    await expect(foreign.ready).rejects.toThrow("exited before becoming ready");
  });

  it("maps every eligible path class to trusted non-E2E checks (#10791)", () => {
    const sha = "a".repeat(40);
    const changed = (file: string) => [
      {
        path: file,
        status: "M" as const,
        mode: "100644" as const,
        type: "blob" as const,
        bytes: 1,
      },
    ];
    const commands = [
      ...validationCommands(changed("src/demo.ts"), sha),
      ...validationCommands(changed("docs/demo.mdx"), sha),
      ...validationCommands(changed("test/installer-integration/install.test.ts"), sha),
      ...validationCommands(changed("test/package-contract/package.test.ts"), sha),
    ];
    const text = JSON.stringify(commands);
    expect(text).toMatch(/check:diff|docs|installer-integration|package-contract/u);
    expect(text).not.toContain("e2e-support");
  });

  it("records no-change without publishing a patch artifact (#10791)", () => {
    const fixture = sourceFixture();
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
      stagingDirectory: path.join(root, "validation"),
    });
    const artifacts = path.join(root, "artifacts");
    writeValidationArtifacts(artifacts, result.receipt, result.patch);
    expect(result.receipt.outcome).toBe("skipped");
    expect(fs.readdirSync(artifacts)).toEqual(["validation-receipt.json"]);
  });
});
