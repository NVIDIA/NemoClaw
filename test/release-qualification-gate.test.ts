// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createQualificationReceipt,
  QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
  QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
} from "../scripts/checks/openshell-qualification-contract.mts";
import { QUALIFICATION_FROZEN_AUTHORITY_PATHS } from "../scripts/checks/openshell-qualification-core.mts";
import { artifactZip } from "./helpers/artifact-zip";
import {
  releaseQualificationEnv as env,
  type ReleaseQualificationFixture as Fixture,
  runReleaseQualificationCommand as run,
  writeReleasePlan as writePlan,
} from "./helpers/release-qualification-gate-fixture";
import { testTimeout } from "./helpers/timeouts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const CUT_SCRIPT = path.join(REPO_ROOT, "scripts", "release-cut-tag.sh");
const REPOSITORY = "NVIDIA/NemoClaw";
const RELEASE_SKILL_PATH = ".agents/skills/nemoclaw-maintainer-cut-release-tag/SKILL.md";
const SOURCE_WORKFLOW = ".github/workflows/source-proof.yaml";
const QUALIFICATION_RUNTIME_AUTHORITY_PATHS = [
  "ci/openshell-0.0.101-qualification-v1.json",
  "scripts/checks/openshell-qualification-contract.mts",
  "scripts/checks/openshell-qualification-core.mts",
  "scripts/checks/openshell-qualification-github.mts",
  "scripts/checks/openshell-qualification-io.mts",
  "scripts/checks/openshell-qualification-matrix.mts",
  "scripts/checks/openshell-qualification-schema.mts",
  "scripts/scorecard/read-artifact-zip.mts",
] as const;
// These full publication scenarios create signed repositories and synchronously cross Git,
// the release shell, the TypeScript validator, and the mock GitHub API process boundary.
const PUBLICATION_TEST_TIMEOUT_MS = testTimeout(60_000);
const tempRoots: string[] = [];
let sharedFixture: Fixture;

afterAll(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function artifactProvenance() {
  return [
    "checksum-manifest",
    "cli",
    "gateway",
    "package",
    "sandbox-binary",
    "supervisor-image",
    "virtual-machine-driver",
  ].map((component, index) => ({
    component,
    consumers: ["scripts/install-openshell.sh"],
    name: `${component}-${index}`,
    sha256: String(index + 1).repeat(64),
    url: `https://artifacts.example.test/${component}-${index}`,
  }));
}

function qualificationMatrix() {
  return {
    lanes: [
      {
        agents: ["openclaw"],
        artifactComponents: ["cli"],
        behaviors: ["exact-candidate-base", "real-runtime"],
        expectedOutcome: "pass" as const,
        id: "target",
        paths: ["clean-install"],
        platforms: [
          {
            accelerator: "cpu",
            architecture: "amd64",
            id: "ubuntu-amd64-cpu",
            operatingSystem: "ubuntu",
          },
        ],
        runtimes: ["docker"],
        runtimeVersions: [
          {
            commitSha: "8ddd98c3dff62619a3963f99ba1e055b67650e72",
            version: "0.0.101",
          },
        ],
      },
    ],
  };
}

function qualificationCells(runId: number) {
  return ["exact-candidate-base", "real-runtime"].map((behavior) => ({
    agent: "openclaw",
    artifactComponents: ["cli"],
    behavior,
    evidenceUrl: `https://github.com/${REPOSITORY}/actions/runs/${runId}/job/101`,
    exception: null,
    laneId: "target",
    observedOutcome: "pass" as const,
    path: "clean-install",
    platformId: "ubuntu-amd64-cpu",
    result: "success" as const,
    runtime: "docker",
    runtimeVersion: "0.0.101",
  }));
}

function fixtureContract() {
  const source = {
    aggregation: "all" as const,
    authorityPaths: [".github/workflows/source-proof.yaml"],
    event: "workflow_dispatch" as const,
    jobNames: ["Final proof"],
    workflowId: 77,
    workflowPath: ".github/workflows/source-proof.yaml",
  };
  return {
    artifacts: artifactProvenance(),
    schemaVersion: 1,
    scope: "NVIDIA/NemoClaw#8590",
    repository: REPOSITORY,
    inventoryState: "frozen",
    requiredWorkflowGate: {
      organizationRulesetId: 4242,
      repositoryId: 1182547092,
      sourcePath: ".github/workflows/openshell-0.0.101-pr-gate.yaml",
      sourceRef: "refs/heads/main",
    },
    retirementEvidence: null,
    requiredStatusRulesetId: 15735613,
    nemoclawRepositoryBaselineSha: QUALIFICATION_NEMOCLAW_REPOSITORY_BASELINE_SHA,
    nemoclawUserBaselineTag: QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG,
    nemoclawUserBaselineTagObjectSha: QUALIFICATION_NEMOCLAW_USER_BASELINE_TAG_OBJECT_SHA,
    nemoclawUserBaselineCommitSha: QUALIFICATION_NEMOCLAW_USER_BASELINE_COMMIT_SHA,
    openshellRepositoryBaselineVersion: "0.0.99",
    openshellRepositoryBaselineTag: "v0.0.99",
    openshellRepositoryBaselineCommitSha: "8c7dd148a9e6360c9d5b2830e339a0dc4b3f3032",
    openshellBaselineVersion: "0.0.85",
    openshellBaselineTag: "v0.0.85",
    openshellBaselineCommitSha: "3dee5570a46076a57a3b056f35f35ebc0861ac85",
    openshellTargetVersion: "0.0.101",
    openshellTargetTag: "v0.0.101",
    openshellTargetCommitSha: "8ddd98c3dff62619a3963f99ba1e055b67650e72",
    lifecycle: "final",
    trustedProducerWorkflowPath: ".github/workflows/openshell-0.0.101-qualification.yaml",
    tests: [
      {
        approvedExceptions: [],
        id: "final-proof",
        matrix: qualificationMatrix(),
        ownerIssues: [8601],
        phases: ["selector", "final"],
        requiredCases: ["exact-candidate-base", "real-runtime"],
        requiredDimensions: ["all-registered-agents", "cpu"],
        mappings: {
          selector: { source, status: "active" },
          final: {
            status: "active",
            source,
          },
        },
      },
    ],
  };
}

function createFixture(
  options: { contractMode?: boolean; unlistedValidatorImport?: boolean } = {},
): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-release-qualification-"));
  tempRoots.push(root);
  const remote = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const signingKey = path.join(root, "release-signing-key");
  const planPath = path.join(root, "plan.json");
  const receiptPath = path.join(root, "qualification.json");
  const mockApiRoot = path.join(root, "qualification-api");
  const mockBin = path.join(root, "bin");
  fs.mkdirSync(work);
  run(root, ["git", "init", "--bare", remote]);
  run(root, ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-f", signingKey]);
  run(work, ["git", "init"]);
  run(work, ["git", "config", "user.name", "Release Gate Test"]);
  run(work, ["git", "config", "user.email", "release-gate@example.com"]);
  run(work, ["git", "config", "gpg.format", "ssh"]);
  run(work, ["git", "config", "user.signingkey", signingKey]);
  fs.writeFileSync(path.join(work, "README.md"), "base\n");
  run(work, ["git", "add", "README.md"]);
  run(work, ["git", "commit", "-m", "base"]);
  run(work, ["git", "branch", "-M", "main"]);
  run(work, ["git", "remote", "add", "origin", remote]);
  run(work, ["git", "push", "-u", "origin", "main"]);
  run(work, ["git", "tag", "-a", "v0.0.1", "-m", "v0.0.1"]);
  run(work, ["git", "push", "origin", "refs/tags/v0.0.1"]);

  const contract = fixtureContract();
  const contractMode = options.contractMode ?? true;
  const contractPath = path.join(work, "ci", "openshell-0.0.101-qualification-v1.json");
  const validatorPath = path.join(
    work,
    "scripts",
    "checks",
    "openshell-qualification-contract.mts",
  );
  if (contractMode) {
    fs.mkdirSync(path.dirname(contractPath), { recursive: true });
    fs.writeFileSync(contractPath, `${JSON.stringify(contract, null, 2)}\n`);
  }
  for (const authorityPath of QUALIFICATION_FROZEN_AUTHORITY_PATHS) {
    const sourcePath = path.join(REPO_ROOT, authorityPath);
    const destinationPath = path.join(work, authorityPath);
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    fs.copyFileSync(sourcePath, destinationPath);
    fs.chmodSync(destinationPath, fs.statSync(sourcePath).mode & 0o777);
  }
  const sourceWorkflowPath = path.join(work, SOURCE_WORKFLOW);
  fs.mkdirSync(path.dirname(sourceWorkflowPath), { recursive: true });
  fs.writeFileSync(sourceWorkflowPath, "name: Exact qualification source proof\n");
  if (options.unlistedValidatorImport) {
    const helperPath = path.join(
      work,
      "scripts",
      "checks",
      "openshell-qualification-unlisted-helper.mts",
    );
    fs.writeFileSync(
      helperPath,
      [
        "// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.",
        "// SPDX-License-Identifier: Apache-2.0",
        "",
        "export const unlistedQualificationHelper = true;",
        "",
      ].join("\n"),
    );
    fs.appendFileSync(validatorPath, '\nimport "./openshell-qualification-unlisted-helper.mts";\n');
  }
  run(work, ["git", "add", "--all"]);
  run(work, ["git", "commit", "-m", "add qualification gate"]);
  const baseSha = run(work, ["git", "rev-parse", "HEAD"]).trim();
  fs.appendFileSync(path.join(work, "README.md"), "release candidate\n");
  run(work, ["git", "add", "README.md"]);
  run(work, ["git", "commit", "-m", "release candidate"]);
  run(work, ["git", "push", "origin", "main"]);
  const targetSha = run(work, ["git", "rev-parse", "HEAD"]).trim();
  writePlan(planPath, targetSha);
  const receipt = createQualificationReceipt(contract, {
    baseSha,
    candidateSha: targetSha,
    executionContext: "release",
    phase: "final",
    repository: REPOSITORY,
    tests: [
      {
        id: "final-proof",
        result: "success",
        runs: [
          {
            authorityPaths: [".github/workflows/source-proof.yaml"],
            baseSha,
            candidateSha: targetSha,
            cells: qualificationCells(100),
            controllerSha: targetSha,
            event: "workflow_dispatch",
            executionContext: "release",
            jobs: [
              {
                name: "Final proof",
                result: "success",
                url: `https://github.com/${REPOSITORY}/actions/runs/100/job/101`,
              },
            ],
            openshellCommitSha: "8ddd98c3dff62619a3963f99ba1e055b67650e72",
            openshellVersion: "0.0.101",
            phase: "final",
            prNumber: null,
            requiredCases: ["exact-candidate-base", "real-runtime"],
            requiredDimensions: ["all-registered-agents", "cpu"],
            result: "success",
            runAttempt: 1,
            runId: "100",
            runUrl: `https://github.com/${REPOSITORY}/actions/runs/100/attempts/1`,
            workflowId: 77,
            workflowPath: ".github/workflows/source-proof.yaml",
          },
        ],
      },
    ],
    trustedProducerRunAttempt: 1,
    trustedProducerRunId: "900",
    trustedProducerRunUrl: `https://github.com/${REPOSITORY}/actions/runs/900/attempts/1`,
    trustedProducerWorkflowSha: targetSha,
  });
  const receiptSource = `${JSON.stringify(receipt, null, 2)}\n`;
  fs.writeFileSync(receiptPath, receiptSource);
  fs.mkdirSync(mockApiRoot);
  fs.mkdirSync(mockBin);
  fs.writeFileSync(
    path.join(mockApiRoot, "run.json"),
    `${JSON.stringify({
      conclusion: "success",
      display_title: `OpenShell 0.0.101 release candidate ${targetSha} base ${baseSha}`,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: targetSha,
      html_url: `https://github.com/${REPOSITORY}/actions/runs/900`,
      id: 900,
      path: ".github/workflows/openshell-0.0.101-qualification.yaml",
      repository: { full_name: REPOSITORY },
      run_attempt: 1,
      status: "completed",
      workflow_id: 44,
    })}\n`,
  );
  fs.writeFileSync(
    path.join(mockApiRoot, "artifacts.json"),
    `${JSON.stringify({
      artifacts: [
        {
          archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/901/zip`,
          expired: false,
          id: 901,
          name: "openshell-0.0.101-qualification-release-900-1",
          workflow_run: { head_sha: targetSha, id: 900 },
        },
      ],
      total_count: 1,
    })}\n`,
  );
  fs.writeFileSync(
    path.join(mockApiRoot, "artifact.zip"),
    artifactZip([{ name: "qualification.json", contents: receiptSource }]),
  );
  const sourceRuns = [
    {
      conclusion: "success",
      display_title: `OpenShell 0.0.101 release source candidate ${targetSha} base ${baseSha}`,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: targetSha,
      html_url: `https://github.com/${REPOSITORY}/actions/runs/100`,
      id: 100,
      path: ".github/workflows/source-proof.yaml",
      pull_requests: [],
      repository: { full_name: REPOSITORY },
      run_attempt: 1,
      status: "completed",
      workflow_id: 77,
    },
  ];
  fs.writeFileSync(path.join(mockApiRoot, "source-runs.json"), `${JSON.stringify(sourceRuns)}\n`);
  const sourceReceipt = {
    artifacts: artifactProvenance(),
    schemaVersion: 1,
    scope: "NVIDIA/NemoClaw#8590",
    repository: REPOSITORY,
    phase: "final",
    executionContext: "release",
    event: "workflow_dispatch",
    prNumber: null,
    baseSha,
    candidateSha: targetSha,
    controllerSha: targetSha,
    workflowId: 77,
    workflowPath: ".github/workflows/source-proof.yaml",
    runId: "100",
    runAttempt: 1,
    runUrl: `https://github.com/${REPOSITORY}/actions/runs/100/attempts/1`,
    authorityPaths: [".github/workflows/source-proof.yaml"],
    openshellVersion: "0.0.101",
    openshellCommitSha: "8ddd98c3dff62619a3963f99ba1e055b67650e72",
    result: "success",
    tests: [
      {
        cells: qualificationCells(100),
        id: "final-proof",
        jobs: [
          {
            name: "Final proof",
            result: "success",
            url: `https://github.com/${REPOSITORY}/actions/runs/100/job/101`,
          },
        ],
        requiredCases: ["exact-candidate-base", "real-runtime"],
        requiredDimensions: ["all-registered-agents", "cpu"],
        result: "success",
      },
    ],
  };
  fs.writeFileSync(
    path.join(mockApiRoot, "source-artifact.zip"),
    artifactZip([{ name: "qualification-source.json", contents: JSON.stringify(sourceReceipt) }]),
  );
  const mockGit = path.join(mockBin, "git");
  fs.writeFileSync(
    mockGit,
    [
      "#!/bin/sh",
      'if [ "$1" = "remote" ] && [ "$2" = "get-url" ]; then',
      '  if [ "$3" = "origin" ] || { [ "$3" = "--push" ] && [ "$4" = "origin" ]; }; then',
      '    printf "%s\\n" "${NEMOCLAW_TEST_ORIGIN_URL:-https://github.com/NVIDIA/NemoClaw.git}"',
      "    exit 0",
      "  fi",
      "fi",
      'exec "$NEMOCLAW_QUALIFICATION_TEST_REAL_GIT" "$@"',
      "",
    ].join("\n"),
  );
  fs.chmodSync(mockGit, 0o755);
  const mockGh = path.join(mockBin, "gh");
  fs.writeFileSync(
    mockGh,
    `#!/usr/bin/env node
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.NEMOCLAW_QUALIFICATION_TEST_API_ROOT;
const remote = process.env.NEMOCLAW_QUALIFICATION_TEST_REMOTE;
const work = process.env.NEMOCLAW_QUALIFICATION_TEST_WORK;
const args = process.argv.slice(2);
const endpoint = args.find((value) => value === "graphql" || value.startsWith("repos/")) || "";
const field = (name) => (args.find((value) => value.startsWith(name + "=")) || "").slice(name.length + 1);
if (!root || !remote || !work || args[0] !== "api") process.exit(2);
if (endpoint.endsWith("/actions/workflows/openshell-0.0.101-qualification.yaml")) {
  process.stdout.write(JSON.stringify({
    id: 44,
    path: ".github/workflows/openshell-0.0.101-qualification.yaml",
    state: "active",
  }));
} else if (endpoint.includes("/actions/workflows/openshell-0.0.101-qualification.yaml/runs?")) {
  const value = JSON.parse(fs.readFileSync(path.join(root, "run.json"), "utf8"));
  if (process.env.NEMOCLAW_TEST_PRODUCER_RUN_ID) {
    value.id = Number(process.env.NEMOCLAW_TEST_PRODUCER_RUN_ID);
    value.html_url = "https://github.com/${REPOSITORY}/actions/runs/" + value.id;
  }
  if (process.env.NEMOCLAW_TEST_PRODUCER_RUN_ATTEMPT) {
    value.run_attempt = Number(process.env.NEMOCLAW_TEST_PRODUCER_RUN_ATTEMPT);
  }
  process.stdout.write(JSON.stringify({ total_count: 1, workflow_runs: [value] }));
} else if (endpoint.includes("/actions/runs/900/artifacts?")) {
  const value = JSON.parse(fs.readFileSync(path.join(root, "artifacts.json"), "utf8"));
  if (process.env.NEMOCLAW_TEST_ARTIFACT_RUN_ID) {
    value.artifacts[0].workflow_run.id = Number(process.env.NEMOCLAW_TEST_ARTIFACT_RUN_ID);
  }
  process.stdout.write(JSON.stringify(value));
} else if (endpoint.endsWith("/actions/artifacts/901/zip")) {
  if (process.env.NEMOCLAW_TEST_MOVE_MAIN === "1") {
    const marker = path.join(root, "main-moved");
    if (!fs.existsSync(marker)) {
      const { execFileSync } = require("node:child_process");
      const clone = path.join(root, "race-clone");
      execFileSync("git", ["clone", "--quiet", "--branch", "main", process.env.NEMOCLAW_TEST_REMOTE, clone]);
      execFileSync("git", ["-C", clone, "config", "user.name", "Concurrent Release Test"]);
      execFileSync("git", ["-C", clone, "config", "user.email", "concurrent@example.com"]);
      fs.writeFileSync(path.join(clone, "race.txt"), "main moved during receipt auth\\n");
      execFileSync("git", ["-C", clone, "add", "race.txt"]);
      execFileSync("git", ["-C", clone, "commit", "--quiet", "-m", "concurrent main update"]);
      execFileSync("git", ["-C", clone, "push", "--quiet", "origin", "main"]);
      fs.writeFileSync(marker, "moved\\n");
    }
  }
  process.stdout.write(fs.readFileSync(path.join(root, "artifact.zip")));
} else if (endpoint === "repos/${REPOSITORY}/git/ref/heads/main") {
  const candidateSha = execFileSync("git", ["--git-dir", remote, "rev-parse", "refs/heads/main"], {
    encoding: "utf8",
  }).trim();
  process.stdout.write(JSON.stringify({ object: { sha: candidateSha } }));
} else if (endpoint.startsWith("repos/${REPOSITORY}/commits/")) {
  const candidateSha = endpoint.slice("repos/${REPOSITORY}/commits/".length);
  const baseSha = execFileSync("git", ["--git-dir", remote, "rev-parse", candidateSha + "^1"], {
    encoding: "utf8",
  }).trim();
  process.stdout.write(JSON.stringify({ parents: [{ sha: baseSha }] }));
} else if (endpoint.startsWith("repos/${REPOSITORY}/git/trees/") && endpoint.endsWith("?recursive=1")) {
  process.stdout.write(JSON.stringify({
    truncated: false,
    tree: [
      {
        mode: "100644",
        path: ".github/workflows/source-proof.yaml",
        sha: "1".repeat(40),
        type: "blob",
      },
    ],
  }));
} else if (endpoint === "repos/${REPOSITORY}/actions/workflows/77") {
  process.stdout.write(JSON.stringify({
    id: 77,
    path: ".github/workflows/source-proof.yaml",
    state: "active",
  }));
} else if (endpoint.includes("/actions/workflows/77/runs?")) {
  const runs = JSON.parse(fs.readFileSync(path.join(root, "source-runs.json"), "utf8"));
  process.stdout.write(JSON.stringify({ workflow_runs: runs }));
} else if (endpoint.includes("/actions/runs/100/jobs?filter=latest")) {
  const sourceRuns = JSON.parse(fs.readFileSync(path.join(root, "source-runs.json"), "utf8"));
  const sourceRun = sourceRuns.find((run) => run.id === 100);
  process.stdout.write(JSON.stringify({
    jobs: [
      {
        conclusion: "success",
        head_sha: sourceRun.head_sha,
        html_url: "https://github.com/${REPOSITORY}/actions/runs/100/job/101",
        id: 101,
        name: "Final proof",
        run_attempt: 1,
        run_id: 100,
        status: "completed",
      },
    ],
  }));
} else if (endpoint === "repos/${REPOSITORY}/actions/runs/100/artifacts?per_page=100&page=1") {
  const sourceRuns = JSON.parse(fs.readFileSync(path.join(root, "source-runs.json"), "utf8"));
  const sourceRun = sourceRuns.find((run) => run.id === 100);
  process.stdout.write(JSON.stringify({
    artifacts: [
      {
        archive_download_url: "https://api.github.com/repos/${REPOSITORY}/actions/artifacts/601/zip",
        expired: false,
        id: 601,
        name: "openshell-0.0.101-qualification-source-release-100-" + sourceRun.run_attempt,
        workflow_run: { head_sha: sourceRun.head_sha, id: 100 },
      },
    ],
    total_count: 1,
  }));
} else if (endpoint.endsWith("/actions/artifacts/601/zip")) {
  process.stdout.write(fs.readFileSync(path.join(root, "source-artifact.zip")));
} else if (endpoint === "repos/${REPOSITORY}/git/tags") {
  const payload = JSON.parse(fs.readFileSync(0, "utf8"));
  const rawTag = execFileSync("git", ["-C", work, "cat-file", "tag", "refs/tags/" + payload.tag], {
    encoding: "utf8",
  });
  const offset = /([+-])([0-9]{2}):([0-9]{2})$/.exec(payload.tagger.date);
  const epoch = Date.parse(payload.tagger.date) / 1000;
  if (!offset || !Number.isSafeInteger(epoch)) process.exit(4);
  const uploadedRawTag =
    "object " + payload.object + "\\n" +
    "type " + payload.type + "\\n" +
    "tag " + payload.tag + "\\n" +
    "tagger " + payload.tagger.name + " <" + payload.tagger.email + "> " + epoch + " " +
      offset[1] + offset[2] + offset[3] + "\\n\\n" +
    payload.message;
  if (uploadedRawTag !== rawTag) process.exit(4);
  const upload = spawnSync(
    "git",
    ["--git-dir", remote, "hash-object", "-t", "tag", "-w", "--stdin"],
    { encoding: "utf8", input: uploadedRawTag },
  );
  if (upload.status !== 0) process.exit(upload.status || 4);
  const tagObject = upload.stdout.trim();
  fs.writeFileSync(path.join(root, "tag-object-uploaded"), tagObject + "\\n");
  if (process.env.NEMOCLAW_TEST_SUPERSEDE_RECEIPT_DURING_TAG_UPLOAD === "1") {
    const supersedingRun = JSON.parse(fs.readFileSync(path.join(root, "run.json"), "utf8"));
    supersedingRun.id = 901;
    supersedingRun.html_url = "https://github.com/${REPOSITORY}/actions/runs/901";
    supersedingRun.status = "completed";
    supersedingRun.conclusion = "failure";
    fs.writeFileSync(path.join(root, "run.json"), JSON.stringify(supersedingRun) + "\\n");
  }
  if (process.env.NEMOCLAW_TEST_SUPERSEDE_SOURCE_DURING_TAG_UPLOAD === "1") {
    const sourceRuns = JSON.parse(fs.readFileSync(path.join(root, "source-runs.json"), "utf8"));
    sourceRuns.push({
      ...sourceRuns[0],
      conclusion: "failure",
      html_url: "https://github.com/${REPOSITORY}/actions/runs/101",
      id: 101,
      status: "completed",
    });
    fs.writeFileSync(path.join(root, "source-runs.json"), JSON.stringify(sourceRuns) + "\\n");
  }
  if (process.env.NEMOCLAW_TEST_RERUN_SOURCE_DURING_TAG_UPLOAD === "1") {
    const sourceRuns = JSON.parse(fs.readFileSync(path.join(root, "source-runs.json"), "utf8"));
    sourceRuns[0].run_attempt = 2;
    fs.writeFileSync(path.join(root, "source-runs.json"), JSON.stringify(sourceRuns) + "\\n");
  }
  process.stdout.write(JSON.stringify({
    sha: tagObject,
    verification: {
      reason: process.env.NEMOCLAW_TEST_TAG_VERIFICATION_REASON || "valid",
      verified: process.env.NEMOCLAW_TEST_TAG_VERIFICATION_VERIFIED !== "false",
    },
  }) + "\\n");
} else if (endpoint === "repos/${REPOSITORY}") {
  process.stdout.write("R_test_repository\\n");
} else if (endpoint === "graphql") {
  fs.writeFileSync(path.join(root, "tag-publication-attempted"), "attempted\\n");
  if (process.env.NEMOCLAW_TEST_FAIL_TAG_PUBLICATION === "1") process.exit(5);
  const normalizedQuery = field("query").replace(/\\s+/g, " ").trim();
  const expectedQuery = [
    "mutation($repositoryId: ID!, $target: GitObjectID!, $tagRef: GitRefname!,",
    "$tagObject: GitObjectID!, $zero: GitObjectID!) { updateRefs(input: {",
    "repositoryId: $repositoryId, refUpdates: [",
    '{ name: "refs/heads/main", beforeOid: $target, afterOid: $target },',
    "{ name: $tagRef, beforeOid: $zero, afterOid: $tagObject }",
    "] }) { clientMutationId } }",
  ].join(" ");
  const target = field("target");
  const tagRef = field("tagRef");
  const tagObject = field("tagObject");
  const zero = field("zero");
  if (
    normalizedQuery !== expectedQuery ||
    field("repositoryId") !== "R_test_repository" ||
    !/^[0-9a-f]{40}$/.test(target) ||
    !/^refs\\/tags\\/v[0-9]+\\.[0-9]+\\.[0-9]+$/.test(tagRef) ||
    !/^[0-9a-f]{40}$/.test(tagObject) ||
    zero !== "0".repeat(40)
  ) {
    process.exit(6);
  }
  if (process.env.NEMOCLAW_TEST_MOVE_MAIN_BEFORE_GRAPHQL_CAS === "1") {
    execFileSync("git", [
      "--git-dir",
      remote,
      "update-ref",
      "refs/heads/main",
      process.env.NEMOCLAW_TEST_RACE_SHA,
      process.env.NEMOCLAW_TEST_TARGET_SHA,
    ]);
  }
  execFileSync("git", ["--git-dir", remote, "update-ref", "--stdin"], {
    encoding: "utf8",
    input: [
      "start",
      "verify refs/heads/main " + target,
      "create " + tagRef + " " + tagObject,
      "prepare",
      "commit",
      "",
    ].join("\\n"),
  });
  if (process.env.NEMOCLAW_TEST_REPLACE_TAG_OBJECT_AFTER_PUBLICATION === "1") {
    const rawTag = execFileSync("git", ["-C", work, "cat-file", "tag", tagObject], {
      encoding: "utf8",
    });
    const replacementObject = execFileSync(
      "git",
      ["--git-dir", remote, "hash-object", "-t", "tag", "-w", "--stdin"],
      { encoding: "utf8", input: rawTag + "\\npost-publication replacement\\n" },
    ).trim();
    execFileSync("git", [
      "--git-dir",
      remote,
      "update-ref",
      tagRef,
      replacementObject,
      tagObject,
    ]);
    fs.writeFileSync(path.join(root, "tag-object-replaced"), replacementObject + "\\n");
  }
  if (process.env.NEMOCLAW_TEST_APPLY_THEN_FAIL_TAG_PUBLICATION === "1") process.exit(5);
  process.stdout.write(JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }));
} else {
  process.exit(3);
}
`,
  );
  fs.chmodSync(mockGh, 0o755);
  return {
    baseSha,
    contract,
    mockApiRoot,
    mockBin,
    planPath,
    receiptPath,
    remote,
    root,
    targetSha,
    work,
  };
}

function preflight(
  fixture: Fixture,
  receiptPath = fixture.receiptPath,
  extraEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    "bash",
    [
      CUT_SCRIPT,
      "--plan",
      fixture.planPath,
      "--qualification-receipt",
      receiptPath,
      "--preflight-only",
    ],
    { cwd: fixture.work, encoding: "utf8", env: env(fixture, extraEnv) },
  );
}

function cut(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    [
      CUT_SCRIPT,
      "--plan",
      fixture.planPath,
      "--qualification-receipt",
      fixture.receiptPath,
      "--confirm",
      `CONFIRM RELEASE v0.0.2 ${fixture.targetSha}`,
    ],
    { cwd: fixture.work, encoding: "utf8", env: env(fixture, extraEnv) },
  );
}

function cutLegacy(fixture: Fixture, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(
    "bash",
    [
      CUT_SCRIPT,
      "--plan",
      fixture.planPath,
      "--confirm",
      `CONFIRM RELEASE v0.0.2 ${fixture.targetSha}`,
    ],
    { cwd: fixture.work, encoding: "utf8", env: env(fixture, extraEnv) },
  );
}

function writeReceipt(fixture: Fixture, value: unknown, name: string): string {
  const filePath = path.join(fixture.root, name);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
  return filePath;
}

function releaseTagExists(fixture: Fixture): boolean {
  return (
    spawnSync("git", ["show-ref", "--verify", "--quiet", "refs/tags/v0.0.2"], {
      cwd: fixture.work,
      env: env(),
    }).status === 0
  );
}

function qualificationRuntimeExists(fixture: Fixture): boolean {
  return fs
    .readdirSync(fixture.root)
    .some((name) => name.startsWith("nemoclaw-release-qualification."));
}

describe("release final qualification gate (#8590)", () => {
  beforeAll(() => {
    sharedFixture = createFixture();
  }, 30_000);

  it("requires the explicit receipt interface in preflight and cut help", () => {
    const result = spawnSync("bash", [CUT_SCRIPT, "--help"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: env(),
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--qualification-receipt PATH --preflight-only");
    expect(result.stdout).toContain("both modes require its exact final qualification receipt");
  });

  it("allows a valid exact-main final receipt through signing preflight without creating a tag", () => {
    const fixture = sharedFixture;

    const result = preflight(fixture, fixture.receiptPath, { TMPDIR: fixture.root });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('"phase":"final"');
    expect(result.stdout).toContain("signing preflight passed for v0.0.2");
    expect(releaseTagExists(fixture)).toBe(false);
    expect(qualificationRuntimeExists(fixture)).toBe(false);
  });

  it(
    "preserves legacy signed-tag publication when the contract is absent from both commits",
    () => {
      const fixture = createFixture({ contractMode: false });

      const result = cutLegacy(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(releaseTagExists(fixture)).toBe(true);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2"]).trim(),
      ).toBe(run(fixture.work, ["git", "rev-parse", "v0.0.2"]).trim());
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2^{}"]).trim(),
      ).toBe(fixture.targetSha);
      expect(fs.existsSync(path.join(fixture.root, "cut-result.json"))).toBe(true);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it("removes the signed local release tag when atomic publication fails", () => {
    const fixture = sharedFixture;
    try {
      const result = cut(fixture, { NEMOCLAW_TEST_FAIL_TAG_PUBLICATION: "1" });

      expect(result.status).not.toBe(0);
      expect(releaseTagExists(fixture)).toBe(false);
      expect(
        spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", "v0.0.2"], {
          cwd: fixture.work,
          env: env(),
        }).status,
      ).not.toBe(0);
    } finally {
      if (releaseTagExists(fixture)) run(fixture.work, ["git", "tag", "-d", "v0.0.2"]);
    }
  });

  it(
    "publishes the exact signed tag only after GitHub reports valid verification",
    () => {
      const fixture = createFixture();

      const result = cut(fixture);

      expect(result.status, result.stderr).toBe(0);
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-uploaded"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted"))).toBe(true);
      expect(releaseTagExists(fixture)).toBe(true);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2"]).trim(),
      ).toBe(run(fixture.work, ["git", "rev-parse", "v0.0.2"]).trim());
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2^{}"]).trim(),
      ).toBe(fixture.targetSha);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
      ).toBe(fixture.targetSha);
      const cutResult = JSON.parse(
        fs.readFileSync(path.join(fixture.root, "cut-result.json"), "utf8"),
      );
      const retirementEvidence = cutResult.qualificationRetirementEvidence;
      expect(retirementEvidence).toMatchObject({
        releaseBaseSha: fixture.baseSha,
        releaseCandidateSha: fixture.targetSha,
        releaseTag: "v0.0.2",
        releaseTagObjectSha: run(fixture.work, ["git", "rev-parse", "v0.0.2"]).trim(),
        schemaVersion: 1,
        scope: "NVIDIA/NemoClaw#8590",
        trustedProducerRunAttempt: 1,
        trustedProducerRunId: "900",
        trustedProducerWorkflowSha: fixture.targetSha,
      });
      expect(retirementEvidence.finalContractSha256).toBe(
        crypto
          .createHash("sha256")
          .update(
            fs.readFileSync(
              path.join(fixture.work, "ci", "openshell-0.0.101-qualification-v1.json"),
            ),
          )
          .digest("hex"),
      );
      expect(retirementEvidence.finalReceiptSha256).toBe(
        crypto.createHash("sha256").update(fs.readFileSync(fixture.receiptPath)).digest("hex"),
      );
      const { releaseTagObjectSha: _releaseTagObjectSha, ...tagMetadata } = retirementEvidence;
      const rawTag = run(fixture.work, ["git", "cat-file", "tag", "v0.0.2"]);
      const messageStart = rawTag.indexOf("\n\n") + 2;
      const signatureStart = rawTag.indexOf("-----BEGIN ", messageStart);
      expect(signatureStart).toBeGreaterThan(messageStart);
      expect(rawTag.slice(messageStart, signatureStart).trimEnd()).toBe(
        `v0.0.2\n\nNemoClaw-Qualification-Retirement-Evidence: ${JSON.stringify(tagMetadata)}`,
      );
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it(
    "continues after a lost GraphQL response only when exact publication can be reconciled",
    () => {
      const fixture = createFixture();

      const result = cut(fixture, {
        NEMOCLAW_TEST_APPLY_THEN_FAIL_TAG_PUBLICATION: "1",
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toContain("recovered from a lost atomic publication response");
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted"))).toBe(true);
      expect(releaseTagExists(fixture)).toBe(true);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2"]).trim(),
      ).toBe(run(fixture.work, ["git", "rev-parse", "v0.0.2"]).trim());
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2^{}"]).trim(),
      ).toBe(fixture.targetSha);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
      ).toBe(fixture.targetSha);
      expect(fs.existsSync(path.join(fixture.root, "cut-result.json"))).toBe(true);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it(
    "rejects a different remote annotated tag object even when it peels to the plan target",
    () => {
      const fixture = createFixture();

      const result = cut(fixture, {
        NEMOCLAW_TEST_REPLACE_TAG_OBJECT_AFTER_PUBLICATION: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("expected exact signed object");
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-uploaded"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-replaced"))).toBe(true);
      expect(releaseTagExists(fixture)).toBe(true);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2^{}"]).trim(),
      ).toBe(fixture.targetSha);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "v0.0.2"]).trim(),
      ).not.toBe(run(fixture.work, ["git", "rev-parse", "v0.0.2"]).trim());
      expect(fs.existsSync(path.join(fixture.root, "cut-result.json"))).toBe(false);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it("rejects an unverified uploaded tag object before any ref publication", () => {
    const fixture = createFixture();

    const result = cut(fixture, {
      NEMOCLAW_TEST_TAG_VERIFICATION_REASON: "unknown_key",
      NEMOCLAW_TEST_TAG_VERIFICATION_VERIFIED: "false",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("GitHub did not verify the signed tag object (unknown_key)");
    expect(result.stderr).toContain(
      "uploaded signed tag object response did not prove GitHub verification",
    );
    expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-uploaded"))).toBe(true);
    expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted"))).toBe(false);
    expect(releaseTagExists(fixture)).toBe(false);
    expect(
      run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
    ).toBe(fixture.targetSha);
    expect(
      spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", "v0.0.2"], {
        cwd: fixture.work,
        env: env(),
      }).status,
    ).not.toBe(0);
  });

  it(
    "does not publish the release tag when remote main advances during publication",
    () => {
      const fixture = createFixture();
      const raceWork = path.join(fixture.root, "race-work");
      run(fixture.root, ["git", "clone", "--quiet", "--branch", "main", fixture.remote, raceWork]);
      run(raceWork, ["git", "config", "user.name", "Concurrent Release Test"]);
      run(raceWork, ["git", "config", "user.email", "concurrent@example.com"]);
      fs.writeFileSync(path.join(raceWork, "race.txt"), "main moved during release push\n");
      run(raceWork, ["git", "add", "race.txt"]);
      run(raceWork, ["git", "commit", "--quiet", "-m", "concurrent main update"]);
      const raceSha = run(raceWork, ["git", "rev-parse", "HEAD"]).trim();
      run(raceWork, ["git", "push", "--quiet", "origin", "HEAD:refs/heads/release-race"]);

      const result = cut(fixture, {
        NEMOCLAW_TEST_MOVE_MAIN_BEFORE_GRAPHQL_CAS: "1",
        NEMOCLAW_TEST_RACE_SHA: raceSha,
        NEMOCLAW_TEST_TARGET_SHA: fixture.targetSha,
      });

      expect(result.status).not.toBe(0);
      expect(
        fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-uploaded")),
        result.stderr,
      ).toBe(true);
      expect(
        fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted")),
        result.stderr,
      ).toBe(true);
      expect(releaseTagExists(fixture)).toBe(false);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
      ).toBe(raceSha);
      expect(
        spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", "v0.0.2"], {
          cwd: fixture.work,
          env: env(),
        }).status,
      ).not.toBe(0);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it("rejects a stale checkout even when origin/main still matches the plan target", () => {
    const fixture = sharedFixture;
    run(fixture.work, ["git", "switch", "--detach", fixture.baseSha]);
    try {
      const result = preflight(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Local HEAD");
      expect(result.stderr).toContain("does not match plan target");
      expect(releaseTagExists(fixture)).toBe(false);
    } finally {
      run(fixture.work, ["git", "switch", "--detach", fixture.targetSha]);
    }
  });

  it.each(QUALIFICATION_FROZEN_AUTHORITY_PATHS)(
    "rejects a target that changes frozen qualification authority %s",
    (authorityPath) => {
      const fixture = createFixture();
      fs.appendFileSync(path.join(fixture.work, authorityPath), "\ntarget-only authority drift\n");
      run(fixture.work, ["git", "add", authorityPath]);
      run(fixture.work, ["git", "commit", "-m", `change ${path.basename(authorityPath)}`]);
      run(fixture.work, ["git", "push", "origin", "main"]);
      fixture.targetSha = run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
      writePlan(fixture.planPath, fixture.targetSha);

      const result = preflight(fixture);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("qualification bootstrap authority differs");
      expect(releaseTagExists(fixture)).toBe(false);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it.each([
    ["fixed mode-only", RELEASE_SKILL_PATH, "mode", "qualification bootstrap authority differs"],
    ["mapped mode-only", SOURCE_WORKFLOW, "mode", "complete qualification authority differs"],
    [
      "fixed symlink",
      RELEASE_SKILL_PATH,
      "symlink",
      "qualification authority is not a regular blob",
    ],
    ["mapped symlink", SOURCE_WORKFLOW, "symlink", "qualification authority is not a regular blob"],
    [
      "fixed gitlink",
      RELEASE_SKILL_PATH,
      "gitlink",
      "qualification authority is not a regular blob",
    ],
    ["mapped gitlink", SOURCE_WORKFLOW, "gitlink", "qualification authority is not a regular blob"],
  ] as const)(
    "rejects a %s authority mutation before receipt authentication (#8600)",
    (_label, authorityPath, mutation, expectedError) => {
      const fixture = createFixture();
      const absolutePath = path.join(fixture.work, authorityPath);
      if (mutation === "mode") {
        fs.chmodSync(absolutePath, fs.statSync(absolutePath).mode | 0o100);
        run(fixture.work, ["git", "add", authorityPath]);
      } else if (mutation === "symlink") {
        fs.rmSync(absolutePath);
        fs.symlinkSync("README.md", absolutePath);
        run(fixture.work, ["git", "add", authorityPath]);
      } else {
        fs.rmSync(absolutePath);
        run(fixture.work, [
          "git",
          "update-index",
          "--add",
          "--cacheinfo",
          `160000,${fixture.baseSha},${authorityPath}`,
        ]);
        fs.mkdirSync(absolutePath);
      }
      run(fixture.work, ["git", "commit", "-m", `${mutation} ${path.basename(authorityPath)}`]);
      run(fixture.work, ["git", "push", "origin", "main"]);
      fixture.targetSha = run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
      writePlan(fixture.planPath, fixture.targetSha);

      const result = preflight(fixture);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedError);
      expect(releaseTagExists(fixture)).toBe(false);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it("rejects a target that changes contract-mapped source authority", () => {
    const fixture = createFixture();
    fs.appendFileSync(
      path.join(fixture.work, SOURCE_WORKFLOW),
      "target-only mapped authority drift\n",
    );
    run(fixture.work, ["git", "add", SOURCE_WORKFLOW]);
    run(fixture.work, ["git", "commit", "-m", "change mapped qualification source"]);
    run(fixture.work, ["git", "push", "origin", "main"]);
    fixture.targetSha = run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
    writePlan(fixture.planPath, fixture.targetSha);

    const result = preflight(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("complete qualification authority differs");
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("rejects mixed qualification contract presence between target and first parent", () => {
    const fixture = createFixture();
    const contractPath = path.join(fixture.work, "ci", "openshell-0.0.101-qualification-v1.json");
    fs.rmSync(contractPath);
    run(fixture.work, ["git", "add", contractPath]);
    run(fixture.work, ["git", "commit", "-m", "remove qualification contract"]);
    run(fixture.work, ["git", "push", "origin", "main"]);
    fixture.targetSha = run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
    writePlan(fixture.planPath, fixture.targetSha);

    const result = preflight(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "qualification contract presence differs between the plan target and its first parent",
    );
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it.each(
    QUALIFICATION_RUNTIME_AUTHORITY_PATHS.filter(
      (authorityPath) => authorityPath !== "ci/openshell-0.0.101-qualification-v1.json",
    ),
  )("rejects a plan target that omits private runtime authority %s", (relative) => {
    const fixture = createFixture();
    fs.rmSync(path.join(fixture.work, relative));
    run(fixture.work, ["git", "add", relative]);
    run(fixture.work, ["git", "commit", "-m", `remove ${path.basename(relative)}`]);
    run(fixture.work, ["git", "push", "origin", "main"]);
    fixture.targetSha = run(fixture.work, ["git", "rev-parse", "HEAD"]).trim();
    writePlan(fixture.planPath, fixture.targetSha);

    const result = preflight(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      `qualification authority is missing from the plan target: ${relative}`,
    );
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("fails closed when the validator gains a local import outside the explicit private closure", () => {
    const fixture = createFixture({ unlistedValidatorImport: true });

    const result = preflight(fixture);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ERR_MODULE_NOT_FOUND");
    expect(result.stderr).toContain(
      "could not derive the complete base-trusted qualification authority",
    );
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("rejects release consumer bytes that are not the first-parent authority", () => {
    const fixture = createFixture();
    const alteredConsumer = path.join(fixture.root, "altered-release-cut-tag.sh");
    fs.writeFileSync(
      alteredConsumer,
      `${fs.readFileSync(CUT_SCRIPT, "utf8")}\n# candidate-controlled indirection\n`,
    );
    fs.chmodSync(alteredConsumer, 0o755);

    const result = spawnSync(
      "bash",
      [
        alteredConsumer,
        "--plan",
        fixture.planPath,
        "--qualification-receipt",
        fixture.receiptPath,
        "--preflight-only",
      ],
      { cwd: fixture.work, encoding: "utf8", env: env(fixture) },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "release consumer does not match the target first-parent authority",
    );
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("rejects a matching-SHA origin that is not the canonical NVIDIA repository", () => {
    const fixture = createFixture();

    const result = preflight(fixture, fixture.receiptPath, {
      NEMOCLAW_TEST_ORIGIN_URL: "https://github.com/example/NemoClaw.git",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "release origin does not resolve to the canonical NVIDIA/NemoClaw repository",
    );
    expect(releaseTagExists(fixture)).toBe(false);
    expect(
      run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
    ).toBe(fixture.targetSha);
  });

  it(
    "rejects hidden working-tree mutations to every locally consumed qualification authority",
    () => {
      const fixture = createFixture();
      const authorities = [
        {
          hide: "--assume-unchanged",
          label: "qualification contract",
          relative: "ci/openshell-0.0.101-qualification-v1.json",
          unhide: "--no-assume-unchanged",
        },
        {
          hide: "--skip-worktree",
          label: "qualification validator",
          relative: "scripts/checks/openshell-qualification-contract.mts",
          unhide: "--no-skip-worktree",
        },
        {
          hide: "--assume-unchanged",
          label: "qualification core",
          relative: "scripts/checks/openshell-qualification-core.mts",
          unhide: "--no-assume-unchanged",
        },
        {
          hide: "--skip-worktree",
          label: "qualification GitHub authenticator",
          relative: "scripts/checks/openshell-qualification-github.mts",
          unhide: "--no-skip-worktree",
        },
        {
          hide: "--assume-unchanged",
          label: "qualification I/O validator",
          relative: "scripts/checks/openshell-qualification-io.mts",
          unhide: "--no-assume-unchanged",
        },
        {
          hide: "--assume-unchanged",
          label: "qualification matrix validator",
          relative: "scripts/checks/openshell-qualification-matrix.mts",
          unhide: "--no-assume-unchanged",
        },
        {
          hide: "--skip-worktree",
          label: "qualification schema",
          relative: "scripts/checks/openshell-qualification-schema.mts",
          unhide: "--no-skip-worktree",
        },
        {
          hide: "--assume-unchanged",
          label: "qualification archive reader",
          relative: "scripts/scorecard/read-artifact-zip.mts",
          unhide: "--no-assume-unchanged",
        },
      ];

      for (const authority of authorities) {
        const authorityPath = path.join(fixture.work, authority.relative);
        run(fixture.work, ["git", "update-index", authority.hide, authority.relative]);
        fs.appendFileSync(authorityPath, "\n# hidden local authority mutation\n");
        expect(run(fixture.work, ["git", "status", "--short"]).trim()).toBe("");

        const result = preflight(fixture);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(
          `${authority.label} does not match the target first-parent authority`,
        );
        expect(releaseTagExists(fixture)).toBe(false);

        fs.writeFileSync(
          authorityPath,
          run(fixture.work, ["git", "show", `HEAD:${authority.relative}`]),
        );
        run(fixture.work, ["git", "update-index", authority.unhide, authority.relative]);
      }
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it(
    "reauthenticates the newest release receipt immediately before atomic ref publication",
    () => {
      const fixture = createFixture();

      const result = cut(fixture, {
        NEMOCLAW_TEST_SUPERSEDE_RECEIPT_DURING_TAG_UPLOAD: "1",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "trusted release producer workflow run is stale, unsuccessful, or identity-mismatched",
      );
      expect(result.stderr).toContain("final qualification receipt is invalid");
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-uploaded"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted"))).toBe(
        false,
      );
      expect(releaseTagExists(fixture)).toBe(false);
      expect(
        spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", "v0.0.2"], {
          cwd: fixture.work,
          env: env(),
        }).status,
      ).not.toBe(0);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
      ).toBe(fixture.targetSha);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it.each([
    [
      "a newer failed source run",
      { NEMOCLAW_TEST_SUPERSEDE_SOURCE_DURING_TAG_UPLOAD: "1" },
      "newest qualification source run",
    ],
    ["a rerun source attempt", { NEMOCLAW_TEST_RERUN_SOURCE_DURING_TAG_UPLOAD: "1" }, "source job"],
  ])(
    "reauthenticates live source evidence and rejects %s before atomic ref publication",
    (_label, extraEnv, message) => {
      const fixture = createFixture();

      const result = cut(fixture, { ...extraEnv, TMPDIR: fixture.root });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stderr).toContain("final qualification receipt is invalid");
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-object-uploaded"))).toBe(true);
      expect(fs.existsSync(path.join(fixture.mockApiRoot, "tag-publication-attempted"))).toBe(
        false,
      );
      expect(qualificationRuntimeExists(fixture)).toBe(false);
      expect(releaseTagExists(fixture)).toBe(false);
      expect(
        spawnSync("git", ["ls-remote", "--exit-code", "--tags", "origin", "v0.0.2"], {
          cwd: fixture.work,
          env: env(),
        }).status,
      ).not.toBe(0);
      expect(
        run(fixture.root, ["git", "--git-dir", fixture.remote, "rev-parse", "main"]).trim(),
      ).toBe(fixture.targetSha);
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );

  it("rejects a concurrent origin/main update after live receipt authentication", () => {
    const fixture = createFixture();

    const result = preflight(fixture, fixture.receiptPath, {
      NEMOCLAW_TEST_MOVE_MAIN: "1",
      NEMOCLAW_TEST_REMOTE: fixture.remote,
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "release receipt candidate is not the exact current main commit",
    );
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("rejects locally valid receipt claims that do not match authenticated artifact bytes", () => {
    const fixture = sharedFixture;
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf8"));
    receipt.tests[0].runs[0].runId = "777";
    receipt.tests[0].runs[0].runUrl = `https://github.com/${REPOSITORY}/actions/runs/777/attempts/1`;
    receipt.tests[0].runs[0].jobs[0].url = `https://github.com/${REPOSITORY}/actions/runs/777/job/778`;
    for (const cell of receipt.tests[0].runs[0].cells) {
      cell.evidenceUrl = `https://github.com/${REPOSITORY}/actions/runs/777/job/778`;
    }
    const rewrittenPath = writeReceipt(fixture, receipt, "rewritten-qualification.json");

    const result = preflight(fixture, rewrittenPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("do not match the authenticated Actions artifact");
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it.each([
    ["producer run", { NEMOCLAW_TEST_PRODUCER_RUN_ID: "999" }, "workflow run"],
    ["producer attempt", { NEMOCLAW_TEST_PRODUCER_RUN_ATTEMPT: "2" }, "workflow run"],
    ["artifact run", { NEMOCLAW_TEST_ARTIFACT_RUN_ID: "999" }, "receipt artifact"],
  ])("rejects a wrong authenticated %s", (_label, extraEnv, message) => {
    const fixture = sharedFixture;
    const result = preflight(fixture, fixture.receiptPath, extraEnv);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("final qualification receipt is invalid");
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("rejects a structurally valid local-only receipt with no matching producer run", () => {
    const fixture = sharedFixture;
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf8"));
    receipt.trustedProducerRunId = "999";
    receipt.trustedProducerRunUrl = `https://github.com/${REPOSITORY}/actions/runs/999/attempts/1`;
    const localOnlyPath = writeReceipt(fixture, receipt, "local-only-qualification.json");

    const result = preflight(fixture, localOnlyPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("workflow run");
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it("rejects a missing receipt before any signing tag can be created", () => {
    const fixture = sharedFixture;
    const result = spawnSync("bash", [CUT_SCRIPT, "--plan", fixture.planPath, "--preflight-only"], {
      cwd: fixture.work,
      encoding: "utf8",
      env: env(fixture),
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("--qualification-receipt is required");
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it.each([
    ["unknown schema", (receipt: any) => (receipt.schemaVersion = 2), "schemaVersion"],
    [
      "wrong candidate",
      (receipt: any) => (receipt.candidateSha = "c".repeat(40)),
      "candidate, or base",
    ],
    ["wrong base", (receipt: any) => (receipt.baseSha = "c".repeat(40)), "candidate, or base"],
    [
      "wrong baseline",
      (receipt: any) => (receipt.openshellBaselineCommitSha = "c".repeat(40)),
      "not approved",
    ],
    [
      "wrong target",
      (receipt: any) => (receipt.openshellTargetCommitSha = "c".repeat(40)),
      "not approved",
    ],
    ["skipped test", (receipt: any) => (receipt.tests[0].result = "skipped"), "not successful"],
    [
      "canceled run",
      (receipt: any) => (receipt.tests[0].runs[0].result = "cancelled"),
      "not successful",
    ],
    [
      "failed job",
      (receipt: any) => (receipt.tests[0].runs[0].jobs[0].result = "failure"),
      "not successful",
    ],
    ["missing test", (receipt: any) => (receipt.tests = []), "required test set"],
    [
      "extra test",
      (receipt: any) => receipt.tests.push({ ...receipt.tests[0], id: "extra-proof" }),
      "active source",
    ],
    ["duplicate test", (receipt: any) => receipt.tests.push(receipt.tests[0]), "duplicated"],
    ["mismatched run", (receipt: any) => (receipt.tests[0].runs[0].runId = "999"), "run metadata"],
  ])("keeps the release gate closed for a %s receipt", (_label, mutate, message) => {
    const fixture = sharedFixture;
    const receipt = JSON.parse(fs.readFileSync(fixture.receiptPath, "utf8"));
    mutate(receipt);
    const invalidPath = writeReceipt(fixture, receipt, "invalid-qualification.json");
    const result = preflight(fixture, invalidPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(result.stderr).toContain("final qualification receipt is invalid");
    expect(releaseTagExists(fixture)).toBe(false);
  });

  it(
    "rejects malformed, linked, and oversized receipt files without creating a tag",
    () => {
      const fixture = sharedFixture;
      const malformedPath = path.join(fixture.root, "malformed.json");
      fs.writeFileSync(malformedPath, '{"schemaVersion":1,"schemaVersion":2}\n');
      const linkedPath = path.join(fixture.root, "linked.json");
      fs.symlinkSync(fixture.receiptPath, linkedPath);
      const oversizedPath = path.join(fixture.root, "oversized.json");
      fs.writeFileSync(oversizedPath, `{"padding":"${"x".repeat(70_000)}"}\n`);
      for (const receiptPath of [malformedPath, linkedPath, oversizedPath]) {
        const result = preflight(fixture, receiptPath);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("final qualification receipt is invalid");
        expect(releaseTagExists(fixture)).toBe(false);
      }
    },
    PUBLICATION_TEST_TIMEOUT_MS,
  );
});
