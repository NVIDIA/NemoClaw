// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenShellTools } from "../../../tools/openshell-agent/runtime.mts";

import {
  attemptKey,
  type RepairSelection,
} from "../../../tools/pr-review-advisor/repair-contract.mts";
import {
  exportAdvisorRepairPatch,
  materializeAdvisorRepairWorkspace,
  prepareAdvisorRepairInputs,
  reconcilePreviousAdvisorRepairSandboxes,
  recoverAdvisorRepairSandboxes,
  runAdvisorRepairTask,
} from "../../../tools/pr-review-advisor/repair-resolve.mts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories)
    fs.rmSync(directory, { recursive: true, force: true });
  temporaryDirectories.length = 0;
});

function selection(sourceHeadSha = "a".repeat(40)): RepairSelection {
  const baseSha = "b".repeat(40);
  const findingIds = ["F-documentation-standard-work-example"];
  const key = attemptKey({
    repository: "NVIDIA/NemoClaw",
    prNumber: 42,
    sourceHeadSha,
    baseSha,
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
    baseSha,
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

describe("PR Review Advisor two-turn resolver", () => {
  it("recovers the PR-scoped sandbox across fresh dispatches before model work (#10791)", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-recovery-"));
    temporaryDirectories.push(directory);
    const stopGateway = vi.fn(async () => undefined);
    const sandboxNames = "advisor-repair-pr-42\n";
    const run = vi
      .fn<OpenShellTools["run"]>()
      .mockReturnValueOnce("/trusted/bin/openshell-sandbox")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce("")
      .mockReturnValueOnce(sandboxNames)
      .mockReturnValueOnce("")
      .mockReturnValueOnce(sandboxNames)
      .mockReturnValueOnce("")
      .mockReturnValueOnce(sandboxNames)
      .mockReturnValueOnce("");
    const tools: OpenShellTools = {
      run,
      runAsync: () => ({ cancel: () => {}, completion: Promise.resolve() }),
      start: () => stopGateway,
      wait: async () => {},
    };
    const receiptFile = path.join(directory, "reconciliation.json");
    const env = {
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_RUN_ID: "456",
      GITHUB_TOKEN: "must-not-cross-boundary",
      HOME: directory,
      OPENAI_API_KEY: "must-not-cross-boundary",
      OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
      PATH: "/usr/bin",
      PR_NUMBER: "42",
      PR_REVIEW_ADVISOR_API_KEY: "must-not-cross-boundary",
      RUNNER_TEMP: directory,
      SANDBOX_NAME: "advisor-repair-pr-42",
    };

    const receipt = await recoverAdvisorRepairSandboxes(env, receiptFile, tools);

    expect(receipt).toEqual({
      version: 1,
      sandboxNames: ["advisor-repair-pr-42"],
      reconciledSandboxNames: ["advisor-repair-pr-42"],
      outcome: "success",
      error: null,
    });
    expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toEqual(receipt);
    expect(
      run.mock.calls
        .filter(([, args]) => args[0] === "sandbox" && args[1] === "delete")
        .map(([, args]) => args.at(-1)),
    ).toEqual(["advisor-repair-pr-42"]);
    const commandEnvironments = JSON.stringify(run.mock.calls.map(([, , options]) => options.env));
    expect(commandEnvironments).not.toContain("GITHUB_TOKEN");
    expect(commandEnvironments).not.toContain("OPENAI_API_KEY");
    expect(commandEnvironments).not.toContain("PR_REVIEW_ADVISOR_API_KEY");
    expect(stopGateway).toHaveBeenCalledOnce();
  });

  it("fails closed with a partial receipt when retry recovery cannot finish (#10791)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-recovery-"));
    temporaryDirectories.push(directory);
    const receiptFile = path.join(directory, "reconciliation.json");
    const sandboxNames = "advisor-repair-pr-42\n";
    const run = vi
      .fn<OpenShellTools["run"]>()
      .mockReturnValueOnce(sandboxNames)
      .mockImplementationOnce(() => {
        throw new Error("delete failed");
      });
    const tools: OpenShellTools = {
      run,
      runAsync: () => ({ cancel: () => {}, completion: Promise.resolve() }),
      start: () => {},
      wait: async () => {},
    };

    expect(() =>
      reconcilePreviousAdvisorRepairSandboxes(
        {
          GITHUB_RUN_ATTEMPT: "1",
          GITHUB_RUN_ID: "456",
          HOME: directory,
          PATH: "/usr/bin",
          PR_NUMBER: "42",
          SANDBOX_NAME: "advisor-repair-pr-42",
        },
        receiptFile,
        tools,
      ),
    ).toThrow("Failed to delete OpenShell sandbox advisor-repair-pr-42");
    expect(
      run.mock.calls
        .filter(([, args]) => args[0] === "sandbox" && args[1] === "delete")
        .map(([, args]) => args.at(-1)),
    ).toEqual(["advisor-repair-pr-42"]);
    expect(JSON.parse(fs.readFileSync(receiptFile, "utf8"))).toMatchObject({
      sandboxNames: ["advisor-repair-pr-42"],
      reconciledSandboxNames: [],
      outcome: "failure",
    });
  });

  it("runs exactly two ordered bounded turns in the repair sandbox (#10791)", () => {
    const calls: Array<{ args: readonly string[]; options: { env: NodeJS.ProcessEnv } }> = [];
    const tools: OpenShellTools = {
      run: (command, args, options) => {
        expect(command).toBe("openshell");
        calls.push({ args, options });
        return "";
      },
      runAsync: () => ({ cancel: () => {}, completion: Promise.resolve() }),
      start: () => {},
      wait: async () => {},
    };

    runAdvisorRepairTask(
      {
        GITHUB_TOKEN: "must-not-cross-boundary",
        HOME: "/tmp/advisor-repair-test-home",
        PATH: "/usr/bin",
        PR_REVIEW_ADVISOR_API_KEY: "must-not-cross-boundary",
        SANDBOX_NAME: "advisor-repair-123-1",
      },
      tools,
    );

    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(
      expect.arrayContaining([
        "sandbox",
        "exec",
        "--name",
        "advisor-repair-123-1",
        "--timeout",
        "600",
        "--workdir",
        "/sandbox/repo",
        "@/sandbox/pi-config/turn-1.txt",
      ]),
    );
    expect(calls[1]?.args).toEqual(
      expect.arrayContaining([
        "sandbox",
        "exec",
        "--name",
        "advisor-repair-123-1",
        "--timeout",
        "600",
        "--workdir",
        "/sandbox/repo",
        "@/sandbox/pi-config/turn-2.txt",
      ]),
    );
    expect(calls[0]?.args.join(" ")).toContain("read,edit,write,grep,find,ls");
    expect(calls[1]?.args.join(" ")).toContain("read,edit,write,grep,find,ls");
    expect(calls[0]?.options.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(calls[1]?.options.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(calls[0]?.options.env).not.toHaveProperty("PR_REVIEW_ADVISOR_API_KEY");
    expect(calls[1]?.options.env).not.toHaveProperty("PR_REVIEW_ADVISOR_API_KEY");
  });

  it("materializes exact blobs without candidate attributes or symlinks (#10791)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-materialize-"));
    temporaryDirectories.push(directory);
    const repository = path.join(directory, "source");
    fs.mkdirSync(repository);
    const git = (arguments_: string[]) =>
      execFileSync("git", arguments_, {
        cwd: repository,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
        },
      })
        .toString("utf8")
        .trim();
    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Repair Test"]);
    git(["config", "user.email", "repair@example.test"]);
    fs.mkdirSync(path.join(repository, "docs"));
    fs.writeFileSync(path.join(repository, "docs", "example.mdx"), "before\n");
    fs.writeFileSync(path.join(repository, "script.sh"), "#!/bin/sh\n");
    fs.chmodSync(path.join(repository, "script.sh"), 0o755);
    fs.symlinkSync("docs/example.mdx", path.join(repository, "link"));
    fs.writeFileSync(path.join(repository, ".gitattributes"), "docs/example.mdx export-subst\n");
    git(["add", "."]);
    git(["commit", "-m", "test: create source tree"]);
    const headSha = git(["rev-parse", "HEAD"]);
    const selectionFile = path.join(directory, "selection.json");
    fs.writeFileSync(selectionFile, JSON.stringify(selection(headSha)));

    const baseDirectory = path.join(directory, "base");
    const workDirectory = path.join(directory, "work");
    materializeAdvisorRepairWorkspace({
      baseDirectory,
      selectionFile,
      sourceRepository: repository,
      workDirectory,
    });

    expect(fs.readFileSync(path.join(baseDirectory, "docs", "example.mdx"), "utf8")).toBe(
      "before\n",
    );
    expect(fs.existsSync(path.join(baseDirectory, "link"))).toBe(false);
    expect(fs.statSync(path.join(baseDirectory, "script.sh")).mode & 0o777).toBe(0o755);
    const materializedWorktree = path.join(workDirectory, "repo");
    expect(fs.readFileSync(path.join(materializedWorktree, "docs", "example.mdx"), "utf8")).toBe(
      "before\n",
    );
    expect(fs.existsSync(path.join(materializedWorktree, "link"))).toBe(false);
    expect(fs.statSync(path.join(materializedWorktree, "script.sh")).mode & 0o777).toBe(0o755);
  });

  it("creates exactly two commit-blind prompts and bounded model input (#10791)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-resolver-"));
    temporaryDirectories.push(directory);
    const selectionFile = path.join(directory, "selection.json");
    const modelContextFile = path.join(directory, "context.json");
    const configDirectory = path.join(directory, "pi-config");
    fs.writeFileSync(selectionFile, JSON.stringify(selection()));
    fs.writeFileSync(
      modelContextFile,
      JSON.stringify({ title: "Correct the documented command." }),
    );

    prepareAdvisorRepairInputs({ selectionFile, modelContextFile, configDirectory });

    expect(fs.readdirSync(configDirectory).sort()).toEqual([
      "models.json",
      "proposal-template.json",
      "repair-input.json",
      "turn-1.txt",
      "turn-2.txt",
    ]);
    expect(fs.readFileSync(path.join(configDirectory, "turn-1.txt"), "utf8")).toContain(
      "Turn 1 of exactly 2",
    );
    expect(fs.readFileSync(path.join(configDirectory, "turn-2.txt"), "utf8")).toContain(
      "Turn 2 of exactly 2",
    );
    const serialized = fs.readFileSync(path.join(configDirectory, "repair-input.json"), "utf8");
    expect(serialized).not.toContain("NVIDIA/NemoClaw");
    expect(serialized).not.toContain("a".repeat(40));
    expect(serialized).not.toContain("sha256:");
  });

  it("exports a bounded blocked outcome without inventing an empty patch (#10791)", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-blocked-"));
    temporaryDirectories.push(directory);
    const source = path.join(directory, "source");
    const base = path.join(directory, "base");
    const candidate = path.join(directory, "candidate");
    const artifact = path.join(directory, "artifact");
    fs.mkdirSync(source);
    fs.mkdirSync(path.join(base, "docs"), { recursive: true });
    fs.mkdirSync(path.join(candidate, "docs"), { recursive: true });
    fs.writeFileSync(path.join(base, "docs/example.mdx"), "before\n");
    fs.writeFileSync(path.join(candidate, "docs/example.mdx"), "before\n");
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: source });
    execFileSync("git", ["config", "user.name", "Repair Test"], { cwd: source });
    execFileSync("git", ["config", "user.email", "repair@example.test"], { cwd: source });
    fs.mkdirSync(path.join(source, "docs"));
    fs.writeFileSync(path.join(source, "docs/example.mdx"), "before\n");
    execFileSync("git", ["add", "."], { cwd: source });
    execFileSync("git", ["commit", "-m", "test: add source"], { cwd: source });
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: source,
      encoding: "utf8",
    }).trim();
    const selected = selection(headSha);
    const selectionFile = path.join(directory, "selection.json");
    const proposalFile = path.join(directory, "proposal.json");
    fs.writeFileSync(selectionFile, JSON.stringify(selected));
    fs.writeFileSync(
      proposalFile,
      JSON.stringify({
        version: 1,
        findingIds: selected.findingIds,
        unresolvedFindingIds: selected.findingIds,
        changedPaths: [],
        summary: "No safe bounded repair was available.",
        outcome: "blocked",
      }),
    );

    expect(
      exportAdvisorRepairPatch({
        artifactDirectory: artifact,
        baseDirectory: base,
        candidateDirectory: candidate,
        proposalFile,
        selectionFile,
        sourceRepository: source,
      }),
    ).toBe("blocked");
    expect(fs.readdirSync(artifact)).toEqual(["proposal.json"]);
  });

  it.each(["9".repeat(40), `sha256:${"9".repeat(64)}`])(
    "rejects unredacted authority identity %s before upload (#10791)",
    (identity) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-resolver-"));
      temporaryDirectories.push(directory);
      const selectionFile = path.join(directory, "selection.json");
      const modelContextFile = path.join(directory, "context.json");
      fs.writeFileSync(selectionFile, JSON.stringify(selection()));
      fs.writeFileSync(modelContextFile, JSON.stringify({ text: identity }));

      expect(() =>
        prepareAdvisorRepairInputs({
          selectionFile,
          modelContextFile,
          configDirectory: path.join(directory, "pi-config"),
        }),
      ).toThrow("revision or digest identity");
    },
  );
});
