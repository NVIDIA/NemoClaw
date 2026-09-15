// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0
// @module-tag e2e/credential-free

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { expect } from "vitest";

import {
  inspectCiNpmInstall,
  prepareCiNpmInstall,
} from "../../../scripts/checks/prepare-ci-npm-install.mts";
import {
  assertValidatedRepair,
  attemptKey,
  candidateDigest,
  parseValidationReceipt,
  readJson,
  repairValidationPlan,
  type RepairSelection,
} from "../../../tools/pr-review-advisor/repair-contract.mts";
import {
  runRepairValidationInSandbox,
  validateAndSealRepair,
} from "../../../tools/pr-review-advisor/repair-validate.mts";
import { test } from "../../e2e/fixtures/workflow-e2e-test.ts";

const TARGET = "pr-review-advisor-repair-validation-e2e";
const PI_IMAGE =
  "ghcr.io/nvidia/openshell-community/sandboxes/pi@sha256:00d0c5e9e733f94f6db3eaa2ab70d4fd75bcc4aace6b13a54535cbf2dd20dfcd";
const liveTest = process.env.E2E_TARGET_ID === TARGET ? test : test.skip;

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    timeout: 30_000,
    killSignal: "SIGKILL",
  }).trim();
}

function selection(sourceHeadSha: string): RepairSelection {
  const findingIds = ["F-verification-runtime-proof"];
  return {
    version: 1,
    attemptKey: attemptKey({
      repository: "NVIDIA/NemoClaw",
      prNumber: 10791,
      sourceHeadSha,
      baseSha: sourceHeadSha,
      advisorRunId: 1,
      advisorRunAttempt: 1,
      findingIds,
    }),
    repository: "NVIDIA/NemoClaw",
    prNumber: 10791,
    sourceHeadSha,
    baseSha: sourceHeadSha,
    headRef: "runtime-proof",
    repositoryId: "R_runtime_proof",
    author: "e2e",
    actor: "e2e",
    triggeringActor: "e2e",
    workflowSha: sourceHeadSha,
    advisor: {
      runId: 1,
      runAttempt: 1,
      workflowSha: sourceHeadSha,
      artifactIds: Array.from({ length: 10 }, (_, index) => index + 1),
      ledgerDigest: `sha256:${"1".repeat(64)}`,
    },
    stateDigest: `sha256:${"2".repeat(64)}`,
    reviewDigest: `sha256:${"3".repeat(64)}`,
    findingIds,
    selectedFindings: [
      {
        id: findingIds[0],
        interest: "verification-mistake-proofing",
        severity: "P1",
        kind: "test-design",
        summary: "The runtime validation boundary needs a real proof.",
        path: "fixture.txt",
        line: 1,
        impact: "A mocked gateway cannot prove sandbox execution.",
        smallestSafeFix: "Run the trusted plan in a credential-free sandbox.",
        regressionTest: "Require the sealed runtime receipt.",
        exclusions: [],
      },
    ],
    selectedPaths: ["fixture.txt"],
    decisions: [{ id: findingIds[0], selected: true, reason: "eligible" }],
    productScope: "accepted:#10791",
    optIn: "manual-exact-head",
  };
}

liveTest(
  "runs the trusted plan in a real credential-free OpenShell sandbox (#10791)",
  {
    timeout: 12 * 60_000,
    meta: {
      e2ePhases: [
        "install the reviewed OpenShell runtime",
        "run the trusted validation plan in /sandbox/repo",
        "verify the sealed validation receipt",
        "release the validation sandbox and gateway",
      ],
    },
  },
  async ({ progress }) => {
    const artifactRoot = process.env.E2E_ARTIFACT_DIR;
    assert.ok(artifactRoot, "E2E_ARTIFACT_DIR is required");
    const runnerTemp = process.env.RUNNER_TEMP;
    assert.ok(runnerTemp, "RUNNER_TEMP is required");
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-repair-validation-e2e-"));
    try {
      const candidateDirectory = path.join(root, "workspace", "repo");
      const outputDirectory = path.join(artifactRoot, "repair-validation");
      const sdkArtifactDirectory = path.join(runnerTemp, "openshell-sdk");
      fs.mkdirSync(candidateDirectory, { recursive: true });
      fs.writeFileSync(path.join(candidateDirectory, ".gitignore"), "node_modules/\n");
      const packageManifest = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
      ) as Record<string, unknown> & { scripts: Record<string, string> };
      packageManifest.scripts = {
        "check:diff": "node -e \"if(process.cwd()!=='/sandbox/repo')process.exit(91)\"",
        "test:changed": "node -e \"if(process.cwd()!=='/sandbox/repo')process.exit(92)\"",
      };
      fs.writeFileSync(
        path.join(candidateDirectory, "package.json"),
        `${JSON.stringify(packageManifest)}\n`,
      );
      fs.copyFileSync(
        path.join(process.cwd(), "package-lock.json"),
        path.join(candidateDirectory, "package-lock.json"),
      );
      fs.mkdirSync(path.join(candidateDirectory, "nemoclaw"));
      fs.copyFileSync(
        path.join(process.cwd(), "nemoclaw", "package-lock.json"),
        path.join(candidateDirectory, "nemoclaw", "package-lock.json"),
      );
      const reviewedDependency = inspectCiNpmInstall(candidateDirectory);
      expect(reviewedDependency.required).toBe(true);
      expect(fs.readdirSync(sdkArtifactDirectory)).toEqual([reviewedDependency.artifactName]);
      fs.writeFileSync(path.join(candidateDirectory, "fixture.txt"), "before\n");
      run("git", ["init", "--initial-branch=main"], candidateDirectory);
      run("git", ["config", "user.name", "Repair E2E"], candidateDirectory);
      run("git", ["config", "user.email", "repair-e2e@example.test"], candidateDirectory);
      run("git", ["add", "."], candidateDirectory);
      run("git", ["commit", "-m", "test: seed validation candidate"], candidateDirectory);
      const sourceHeadSha = run("git", ["rev-parse", "HEAD"], candidateDirectory);
      fs.writeFileSync(path.join(candidateDirectory, "fixture.txt"), "after\n");
      run("git", ["add", "fixture.txt"], candidateDirectory);
      const patch = Buffer.from(run("git", ["diff", "--cached", "--binary"], candidateDirectory));
      const patchFile = path.join(root, "repair.patch");
      fs.writeFileSync(patchFile, patch);
      const selected = selection(sourceHeadSha);
      const candidate = {
        repository: candidateDirectory,
        patchSha256: `sha256:${createHash("sha256").update(patch).digest("hex")}`,
        candidateTreeSha: run("git", ["write-tree"], candidateDirectory),
        candidateDigest: candidateDigest(candidateDirectory, sourceHeadSha),
        changedPaths: [
          {
            path: "fixture.txt",
            status: "M" as const,
            mode: "100644" as const,
            type: "blob" as const,
            bytes: 6,
          },
        ],
      };

      progress.phase("install the reviewed OpenShell runtime");
      execFileSync("bash", [path.join(process.cwd(), "scripts/install-openshell.sh")], {
        env: { ...process.env, NEMOCLAW_NON_INTERACTIVE: "1" },
        stdio: "inherit",
        timeout: 4 * 60_000,
        killSignal: "SIGKILL",
      });

      progress.phase("run the trusted validation plan in /sandbox/repo");
      let preparedDependencies = false;
      await validateAndSealRepair({
        selection: selected,
        candidate,
        candidateDirectory,
        patchFile,
        outputDirectory,
        execute: (commands, directory) =>
          runRepairValidationInSandbox(
            {
              candidateDirectory: directory,
              commands,
              env: {
                ...process.env,
                OPENSHELL_GATEWAY_ENDPOINT: "http://127.0.0.1:8080",
                PI_IMAGE,
                SANDBOX_NAME: `advisor-validation-e2e-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`,
              },
              sdkArtifactDirectory,
              trustedCheckout: process.cwd(),
            },
            {
              prepareDependencies: async (request) => {
                await prepareCiNpmInstall(request);
                preparedDependencies = true;
              },
            },
          ),
      });
      expect(preparedDependencies).toBe(true);

      progress.phase("verify the sealed validation receipt");
      const receipt = parseValidationReceipt(
        readJson(path.join(outputDirectory, "validation.json")),
      );
      expect(() => assertValidatedRepair(selected, receipt, candidate)).not.toThrow();
      expect(receipt.commands).toEqual(
        repairValidationPlan(selected).map(({ command }) => ({ command, exitCode: 0 })),
      );
      progress.phase("release the validation sandbox and gateway");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
