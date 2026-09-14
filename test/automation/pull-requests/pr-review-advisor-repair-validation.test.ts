// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenShellTools } from "../../../tools/openshell-agent/runtime.mts";
import {
  assertValidatedRepair,
  attemptKey,
  candidateDigest,
  parseValidationReceipt,
  readJson,
  repairValidationPlan,
  type RepairSelection,
  validationReceipt,
} from "../../../tools/pr-review-advisor/repair-contract.mts";
import {
  reconstructAndSealRepair,
  runRepairValidationInSandbox,
} from "../../../tools/pr-review-advisor/repair-validate.mts";
import { ADVISOR_INTERESTS } from "../../../tools/pr-review-advisor/specialist-catalog.mts";

const temporaryDirectories: string[] = [];
const git = (repository: string, args: string[]): string =>
  execFileSync("git", args, {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function selection(sourceHeadSha: string): RepairSelection {
  const findingIds = ["F-documentation-standard-work-example"];
  const key = attemptKey({
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    sourceHeadSha,
    baseSha: sourceHeadSha,
    advisorRunId: 77,
    advisorRunAttempt: 2,
    findingIds,
  });
  return {
    version: 1,
    attemptKey: key,
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    sourceHeadSha,
    baseSha: sourceHeadSha,
    headRef: "fix/example",
    repositoryId: "R_repo",
    author: "contributor",
    actor: "maintainer",
    triggeringActor: "maintainer",
    workflowSha: "c".repeat(40),
    advisor: {
      runId: 77,
      runAttempt: 2,
      workflowSha: "d".repeat(40),
      artifactIds: Array.from({ length: 10 }, (_, index) => index + 1),
      ledgerDigest: `sha256:${"e".repeat(64)}`,
    },
    stateDigest: `sha256:${"f".repeat(64)}`,
    reviewDigest: `sha256:${"0".repeat(64)}`,
    findingIds,
    selectedFindings: [
      {
        id: findingIds[0],
        interest: "documentation-standard-work",
        severity: "P1",
        kind: "documentation",
        summary: "The documented command is wrong.",
        path: "docs/example.mdx",
        line: 10,
        impact: "Users run the wrong command.",
        smallestSafeFix: "Correct the command.",
        regressionTest: "Build the documentation.",
        exclusions: [],
      },
    ],
    selectedPaths: ["docs/example.mdx"],
    decisions: [{ id: findingIds[0], selected: true, reason: "eligible" }],
    productScope: "accepted:#10791",
    optIn: "manual-exact-head",
  };
}

describe("PR Review Advisor trusted validation", () => {
  it("keeps validation artifact cardinality aligned with the specialist catalog (#10791)", () => {
    const schema = JSON.parse(
      fs.readFileSync(
        path.join(process.cwd(), "tools/pr-review-advisor/repair-validation.schema.json"),
        "utf8",
      ),
    ) as {
      properties: {
        advisor: { properties: { artifactIds: { minItems: number; maxItems: number } } };
      };
    };
    const artifactIds = schema.properties.advisor.properties.artifactIds;

    expect(artifactIds.minItems).toBe(ADVISOR_INTERESTS.length + 1);
    expect(artifactIds.maxItems).toBe(ADVISOR_INTERESTS.length + 1);
  });

  it("documents candidate execution as a credential-free manual-repair exception (#10791)", () => {
    const readme = fs.readFileSync(
      path.join(process.cwd(), "tools/pr-review-advisor/README.md"),
      "utf8",
    );
    expect(readme).toContain("Normal Advisor review is static analysis only");
    expect(readme).toContain(
      "Manual repair validation is a separate credential-free OpenShell boundary",
    );
    expect(readme).toContain("PR-derived tests through `npm run test:changed`");
    expect(readme).toContain("remain disabled by `npm ci --ignore-scripts`");
    expect(readme).toContain("only the public npm registry is");
    expect(readme).toContain("runner teardown is the terminal");
    expect(readme).toContain("normal Advisor review workflow posts advisory comments only");
    expect(readme).toContain("manual repair publisher can update");
    const validator = fs.readFileSync(
      path.join(process.cwd(), "tools/pr-review-advisor/repair-validate.mts"),
      "utf8",
    );
    expect(validator).toContain("repair-validation-policy.yaml");
    expect(readme).toContain("records a bounded `blocked`");
    expect(readme).toContain("sandbox-cleanup receipt independently");
  });

  it("reconstructs, runs a secret-free plan, and seals an immutable receipt (#10791)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-validation-test-"));
    temporaryDirectories.push(root);
    const source = path.join(root, "source");
    const patchRepository = path.join(root, "patch-source");
    const validated = path.join(root, "validated");
    const output = path.join(root, "sealed");
    fs.mkdirSync(source);
    git(source, ["init", "--initial-branch=main"]);
    git(source, ["config", "user.name", "Repair Test"]);
    git(source, ["config", "user.email", "repair@example.test"]);
    fs.mkdirSync(path.join(source, "docs"));
    fs.writeFileSync(path.join(source, "docs/example.mdx"), "before\n");
    git(source, ["add", "."]);
    git(source, ["commit", "-m", "test: add repair source"]);
    const headSha = git(source, ["rev-parse", "HEAD"]);
    execFileSync("git", ["clone", "--quiet", source, patchRepository]);
    fs.writeFileSync(path.join(patchRepository, "docs/example.mdx"), "after\n");
    const patchFile = path.join(root, "repair.patch");
    fs.writeFileSync(
      patchFile,
      execFileSync("git", ["diff", "--binary"], { cwd: patchRepository }),
    );
    const selected = selection(headSha);
    const proposalFile = path.join(root, "proposal.json");
    fs.writeFileSync(
      proposalFile,
      JSON.stringify({
        version: 1,
        findingIds: selected.findingIds,
        unresolvedFindingIds: [],
        changedPaths: selected.selectedPaths,
        summary: "Corrected the documented command.",
        outcome: "proposed",
      }),
    );
    const executed: string[] = [];
    const candidate = await reconstructAndSealRepair({
      selection: selected,
      sourceCheckout: source,
      candidateDirectory: validated,
      patchFile,
      proposalFile,
      outputDirectory: output,
      execute: async (commands) => {
        executed.push(...commands.map(({ command }) => command));
        return commands.map(({ command }) => ({ command, exitCode: 0 }));
      },
    });

    expect(executed).toEqual(repairValidationPlan(selected).map(({ command }) => command));
    const receipt = parseValidationReceipt(readJson(path.join(output, "validation.json")));
    expect(() => assertValidatedRepair(selected, receipt, candidate)).not.toThrow();
    expect(fs.readFileSync(path.join(output, "repair.patch"))).toEqual(fs.readFileSync(patchFile));

    fs.writeFileSync(path.join(candidate.repository, "docs/example.mdx"), "mutated\n");
    expect(() =>
      validationReceipt({
        selection: selected,
        candidate,
        candidateDigestAfter: candidateDigest(candidate.repository, selected.sourceHeadSha),
        commands: repairValidationPlan(selected).map(({ command }) => ({ command, exitCode: 0 })),
      }),
    ).toThrow("validation changed");
  });

  it("executes every candidate command inside credential-free OpenShell (#10791)", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-sandbox-validation-"));
    temporaryDirectories.push(root);
    const candidateDirectory = path.join(root, "workspace", "repo");
    const sdkArtifactDirectory = path.join(root, "sdk");
    fs.mkdirSync(candidateDirectory, { recursive: true });
    fs.mkdirSync(sdkArtifactDirectory);
    const sandboxName = "advisor-repair-validation-456-1";
    const run = vi.fn<OpenShellTools["run"]>((command, arguments_) => {
      switch (`${command}:${arguments_[0] ?? ""}:${arguments_[1] ?? ""}`) {
        case "which:openshell-sandbox:":
          return "/trusted/bin/openshell-sandbox";
        case "openshell:sandbox:list":
          return `${sandboxName}\n`;
        default:
          return "";
      }
    });
    const stop = vi.fn(async () => undefined);
    const tools: OpenShellTools = {
      run,
      runAsync: () => ({ cancel: () => {}, completion: Promise.resolve() }),
      start: () => stop,
      wait: async () => {},
    };
    const prepareDependencies = vi.fn(async () => undefined);
    const selected = selection("a".repeat(40));
    const plan = repairValidationPlan(selected);

    const result = await runRepairValidationInSandbox(
      {
        candidateDirectory,
        commands: plan,
        env: {
          GITHUB_RUN_ID: "456",
          GITHUB_TOKEN: "github-secret",
          HOME: root,
          NODE_AUTH_TOKEN: "package-secret",
          OPENAI_API_KEY: "model-secret",
          OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
          PATH: "/usr/bin",
          PI_IMAGE: "example.invalid/pi@sha256:" + "a".repeat(64),
          PR_REVIEW_ADVISOR_API_KEY: "advisor-secret",
          RUNNER_TEMP: root,
          SANDBOX_NAME: sandboxName,
        },
        sdkArtifactDirectory,
        trustedCheckout: "/trusted",
      },
      { prepareDependencies, tools },
    );

    expect(result).toEqual(plan.map(({ command }) => ({ command, exitCode: 0 })));
    expect(prepareDependencies).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactDirectory: sdkArtifactDirectory,
        mode: "artifact",
        targetRoot: candidateDirectory,
      }),
    );
    const sandboxExecs = run.mock.calls.filter(
      ([command, arguments_]) =>
        command === "openshell" && arguments_[0] === "sandbox" && arguments_[1] === "exec",
    );
    expect(sandboxExecs).toHaveLength(plan.length);
    expect(
      sandboxExecs.map(([, arguments_]) => arguments_[arguments_.lastIndexOf("--") + 1]),
    ).toEqual(plan.map(({ executable }) => executable));
    expect(run.mock.calls.some(([command]) => command === "npm")).toBe(false);
    const commandEnvironments = JSON.stringify(run.mock.calls.map(([, , options]) => options.env));
    expect(commandEnvironments).not.toContain("github-secret");
    expect(commandEnvironments).not.toContain("package-secret");
    expect(commandEnvironments).not.toContain("model-secret");
    expect(commandEnvironments).not.toContain("advisor-secret");
    expect(stop).toHaveBeenCalledOnce();
  });
});
