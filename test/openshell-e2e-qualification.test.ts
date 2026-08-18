// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  classifyQualification,
  extractOpenShellVersion,
  type GitHubReader,
  isOpenShellQualificationSensitivePath,
  loadPullRequestFiles,
  REQUIRED_PROOF_CHECKS,
  validateDispatchReceipt,
  validatePullRequestFile,
  validateRequiredChecks,
  validateSuccessfulJobs,
  verifyOpenShellE2EQualification,
} from "../scripts/checks/verify-openshell-e2e-qualification.mts";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const REPOSITORY = "NVIDIA/NemoClaw";
const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const RUN_ID = 12345;
const WORKFLOW_ID = 77;
const ARTIFACT_ID = 88;
const tempRoots: string[] = [];
const OPEN_SHELL_VERSION_SURFACES = [
  "scripts/install-openshell.sh",
  "scripts/brev-launchable-ci-cpu.sh",
  "nemoclaw-blueprint/blueprint.yaml",
] as const;

function writeOpenShellVersionFixture(
  root: string,
  replacements: ReadonlyMap<string, readonly [string, string]>,
): void {
  for (const relativePath of OPEN_SHELL_VERSION_SURFACES) {
    const target = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const source = fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
    const replacement = replacements.get(relativePath);
    fs.writeFileSync(target, replacement ? source.replace(...replacement) : source);
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});

function prFile(filename: string, status = "modified") {
  return { filename, status };
}

function validReceipt(overrides: Record<string, unknown> = {}) {
  return {
    allowDgxSparkRunnerQueue: false,
    allowJetsonDispatch: false,
    allowJetsonRunnerQueue: false,
    baseSha: BASE_SHA,
    candidateRepository: REPOSITORY,
    candidateSha: HEAD_SHA,
    emptySelectors: true,
    eventName: "workflow_dispatch",
    includeStagingBrevLaunchable: false,
    jobs: "",
    kind: "nemoclaw-e2e-dispatch-v2",
    prNumber: 8583,
    repository: REPOSITORY,
    targets: "",
    workflowRunAttempt: 1,
    workflowRunId: String(RUN_ID),
    workflowSha: BASE_SHA,
    ...overrides,
  };
}

function validJob(name: string, id: number, conclusion: string | null = "success") {
  return {
    conclusion,
    id,
    name,
    runAttempt: 1,
    runId: RUN_ID,
    status: "completed",
    url: `https://github.com/${REPOSITORY}/actions/runs/${RUN_ID}/job/${id}`,
  };
}

function requiredJobs() {
  return [
    validJob("base-image-publication", 1),
    validJob("generate-matrix", 2),
    validJob("OpenShell gateway upgrade (legacy-v1)", 3),
    validJob("live (ubuntu-policy-custom-missing-presets-negative, runner)", 4),
    validJob("live (ubuntu-repo-cloud-langchain-deepagents-code, runner)", 5),
    validJob("live (ubuntu-repo-cloud-openclaw, runner)", 6),
    validJob("live (ubuntu-repo-docker-post-reboot-recovery, runner)", 7),
    validJob("Shared E2E (onboard-managed-image-buildless-e2e)", 8),
    validJob("Shared E2E (vllm-docker-storage)", 9),
  ];
}

function workflowRun(id: number, status = "completed", conclusion: string | null = "success") {
  return {
    conclusion,
    event: "workflow_dispatch",
    head_sha: BASE_SHA,
    html_url: `https://github.com/${REPOSITORY}/actions/runs/${id}`,
    id,
    path: ".github/workflows/e2e.yaml",
    repository: { full_name: REPOSITORY },
    run_attempt: 1,
    status,
    workflow_id: WORKFLOW_ID,
  };
}

function createBaseRoot(fixtureVersion = "0.0.85"): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-qualification-"));
  tempRoots.push(root);
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github/workflows/e2e.yaml"),
    [
      "jobs:",
      "  generate-matrix:",
      "    steps:",
      "      - id: controller_matrix",
      "        run: |",
      "          test_matrix='[]'",
      '          test_matrix=\'[{"id":"onboard-managed-image-buildless-e2e","file":"test/onboard-managed-image-buildless-e2e.test.ts","project":"integration"},{"id":"vllm-docker-storage","file":"test/vllm-docker-storage.test.ts","project":"integration"}]\'',
      "      - id: runner_routing",
      "        run: true",
      "  openshell-gateway-upgrade:",
      "    strategy:",
      "      matrix:",
      "        include:",
      "          - id: legacy-v1",
      `            openshell_version: ${fixtureVersion}`,
      "    env:",
      "      E2E_JOB: '1'",
      "",
    ].join("\n"),
  );
  return root;
}

function qualificationInput(baseRoot: string) {
  return {
    baseRoot,
    baseSha: BASE_SHA,
    candidateRoot: "/candidate",
    candidateSha: HEAD_SHA,
    prNumber: 8583,
    repository: REPOSITORY,
    workflowSha: BASE_SHA,
  };
}

function fullApi(files = [prFile("scripts/install-openshell.sh")]): GitHubReader {
  let pullReads = 0;
  const routes: Array<[(apiPath: string) => boolean, () => unknown]> = [
    [
      (apiPath) => apiPath === `repos/${REPOSITORY}/pulls/8583`,
      () => {
        pullReads += 1;
        return {
          base: { repo: { full_name: REPOSITORY }, sha: BASE_SHA },
          head: { repo: { full_name: REPOSITORY }, sha: HEAD_SHA },
          number: 8583,
          state: "open",
          pullReads,
        };
      },
    ],
    [(apiPath) => apiPath.includes("/pulls/8583/files?"), () => files],
    [
      (apiPath) => apiPath === `repos/${REPOSITORY}/actions/workflows/e2e.yaml`,
      () => ({ id: WORKFLOW_ID, path: ".github/workflows/e2e.yaml", state: "active" }),
    ],
    [
      (apiPath) => apiPath.includes("/actions/workflows/e2e.yaml/runs?"),
      () => ({ total_count: 1, workflow_runs: [workflowRun(RUN_ID)] }),
    ],
    [
      (apiPath) => apiPath.includes(`/actions/runs/${RUN_ID}/artifacts?`),
      () => ({
        artifacts: [
          {
            archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${ARTIFACT_ID}/zip`,
            expired: false,
            id: ARTIFACT_ID,
            name: `e2e-dispatch-${RUN_ID}-1`,
            workflow_run: { head_sha: BASE_SHA, id: RUN_ID },
          },
        ],
        total_count: 1,
      }),
    ],
    [
      (apiPath) => apiPath.includes(`/actions/runs/${RUN_ID}/jobs?`),
      () => {
        const jobs = requiredJobs().map((job) => ({
          conclusion: job.conclusion,
          html_url: job.url,
          id: job.id,
          name: job.name,
          run_attempt: job.runAttempt,
          run_id: job.runId,
          status: job.status,
        }));
        return { jobs, total_count: jobs.length };
      },
    ],
    [
      (apiPath) => apiPath.includes(`/commits/${HEAD_SHA}/check-runs?`),
      () => {
        const names = [REQUIRED_PROOF_CHECKS.managed, REQUIRED_PROOF_CHECKS.rootless];
        return {
          check_runs: names.map((name, index) => ({
            conclusion: "success",
            head_sha: HEAD_SHA,
            html_url: `https://github.com/${REPOSITORY}/actions/runs/${900 + index}`,
            id: 900 + index,
            name,
            status: "completed",
          })),
          total_count: names.length,
        };
      },
    ],
  ];
  return {
    async getBytes() {
      throw new Error("receipt loader is injected in tests");
    },
    async getJson(apiPath) {
      const route = routes.find(([matches]) => matches(apiPath));
      expect(route, `unexpected API request: ${apiPath}`).toBeDefined();
      return route![1]();
    },
  };
}

function apiWithWorkflowRuns(runs: ReturnType<typeof workflowRun>[]): GitHubReader {
  const fallback = fullApi();
  return {
    getBytes: fallback.getBytes,
    async getJson(apiPath) {
      const artifactRunId = /\/actions\/runs\/([0-9]+)\/artifacts\?/u.exec(apiPath)?.[1];
      const runId = Number(artifactRunId);
      const artifactId = ARTIFACT_ID + runId - RUN_ID;
      return apiPath.includes("/actions/workflows/e2e.yaml/runs?")
        ? { total_count: runs.length, workflow_runs: runs }
        : artifactRunId
          ? {
              artifacts: [
                {
                  archive_download_url: `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifactId}/zip`,
                  expired: false,
                  id: artifactId,
                  name: `e2e-dispatch-${runId}-1`,
                  workflow_run: { head_sha: BASE_SHA, id: runId },
                },
              ],
              total_count: 1,
            }
          : fallback.getJson(apiPath);
    },
  };
}

describe("OpenShell qualification-sensitive path detection", () => {
  it.each(
    [
        "nemoclaw-blueprint/blueprint.yaml",
        "scripts/install-openshell.sh",
        "scripts/checks/extract-installer-pins.mts",
        "agents/hermes/manifest.yaml",
        "agents/langchain-deepagents-code/managed-dcode-runtime.py",
        "src/lib/onboard/docker-driver-gateway-runtime.ts",
        "src/lib/actions/sandbox/supervisor-relaunch.ts",
        "src/lib/actions/sandbox/openshell-child-visible-credentials.v0.0.101.json",
        "nemoclaw/src/blueprint/runner.ts",
        "src/lib/sandbox/version.ts",
        "src/lib/onboard/openshell-version.ts",
        "src/lib/adapters/sandbox/command-transport.ts",
        ".github/workflows/podman-cpu-proof.yaml",
        ".github/actions/ci-installer-hash-check/action.yaml",
        "scripts/checks/verify-openshell-e2e-qualification.mts",
      ],
  )(
    "covers selectors, trust inputs, runtime artifacts, manifests, proofs, and gate surfaces [%s]",
    (candidatePath) => {
      expect(isOpenShellQualificationSensitivePath(candidatePath), candidatePath).toBe(true);

      expect(isOpenShellQualificationSensitivePath("docs/index.mdx")).toBe(false);
    },
  );

  it("uses both sides of a rename and aligns separate proof requirements with workflow filters", () => {
    const renamed = validatePullRequestFile({
      filename: "docs/retired.mdx",
      previous_filename: "scripts/install-openshell.sh",
      status: "renamed",
    });
    expect(classifyQualification([renamed])).toEqual({
      required: true,
      requiredProofChecks: [REQUIRED_PROOF_CHECKS.managed, REQUIRED_PROOF_CHECKS.rootless],
      sensitivePaths: ["scripts/install-openshell.sh"],
    });
    expect(
      classifyQualification([validatePullRequestFile(prFile("agents/hermes/manifest.yaml"))])
        .requiredProofChecks,
    ).toEqual([REQUIRED_PROOF_CHECKS.managed]);
    expect(
      classifyQualification([
        validatePullRequestFile(prFile("scripts/checks/verify-openshell-e2e-qualification.mts")),
      ]).requiredProofChecks,
    ).toEqual([REQUIRED_PROOF_CHECKS.managed]);
  });

  it.each([
    [{ filename: "a", status: "mystery" }, "unknown status"],
    [{ filename: "a", status: "renamed" }, "previous_filename"],
    [{ filename: "a", previous_filename: "b", status: "modified" }, "unexpectedly"],
    [{ filename: "../escape", status: "modified" }, "canonical"],
  ])("rejects malformed PR file metadata %#", (value, message) => {
    expect(() => validatePullRequestFile(value)).toThrow(message);
  });

  it("paginates PR files and rejects an incomplete full final page", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => prFile(`docs/${index}.md`));
    const api: GitHubReader = {
      async getBytes() {
        return Buffer.alloc(0);
      },
      async getJson(apiPath) {
        const page = Number(new URL(`https://api.invalid/${apiPath}`).searchParams.get("page"));
        return page <= 30 ? firstPage.map((file, index) => prFile(`${page}-${index}.md`)) : [];
      },
    };
    await expect(loadPullRequestFiles(api, REPOSITORY, 1)).rejects.toThrow(
      "pagination is incomplete",
    );
  });
});

describe("trusted dispatch and result validation", () => {
  const expected = {
    baseSha: BASE_SHA,
    candidateRepository: REPOSITORY,
    candidateSha: HEAD_SHA,
    number: 8583,
    repository: REPOSITORY,
    runAttempt: 1,
    runId: RUN_ID,
    workflowSha: BASE_SHA,
  };

  it("accepts only the exact v2, current-head, empty-selector receipt", () => {
    expect(validateDispatchReceipt(validReceipt(), expected)).toMatchObject({
      candidateSha: HEAD_SHA,
      emptySelectors: true,
      kind: "nemoclaw-e2e-dispatch-v2",
    });
    expect(() => validateDispatchReceipt(validReceipt({ jobs: "full-e2e" }), expected)).toThrow(
      "selective",
    );
    expect(() =>
      validateDispatchReceipt({ ...validReceipt(), unexpected: true }, expected),
    ).toThrow("unexpected schema");
    expect(() =>
      validateDispatchReceipt(validReceipt({ candidateSha: "c".repeat(40) }), expected),
    ).toThrow("identity-mismatched");
  });

  it("allows only reviewed optional skipped jobs and requires every default matrix child", () => {
    const jobs = [...requiredJobs(), validJob("scorecard", 10, "skipped")];
    expect(
      validateSuccessfulJobs(jobs, { id: RUN_ID, runAttempt: 1 }, [jobs[2]!.name]),
    ).toHaveLength(jobs.length);
    expect(() =>
      validateSuccessfulJobs(
        [...requiredJobs(), validJob("full-e2e", 10, "skipped")],
        { id: RUN_ID, runAttempt: 1 },
        ["OpenShell gateway upgrade (legacy-v1)"],
      ),
    ).toThrow("did not succeed");
    expect(() =>
      validateSuccessfulJobs(
        requiredJobs().filter(
          (job) => !job.name.startsWith("live (ubuntu-repo-docker-post-reboot-recovery,"),
        ),
        { id: RUN_ID, runAttempt: 1 },
        [requiredJobs()[2]!.name],
      ),
    ).toThrow("matrix child");
    expect(() =>
      validateSuccessfulJobs(
        requiredJobs().filter((job) => !job.name.startsWith("Shared E2E (")),
        { id: RUN_ID, runAttempt: 1 },
        [requiredJobs()[2]!.name],
        ["Shared E2E (onboard-managed-image-buildless-e2e)", "Shared E2E (vllm-docker-storage)"],
      ),
    ).toThrow("required E2E job Shared E2E (onboard-managed-image-buildless-e2e) is missing");
  });

  it("rejects duplicate, incomplete, stale, and unsuccessful jobs or proof checks", () => {
    const duplicated = [...requiredJobs(), { ...requiredJobs()[0]!, id: 99 }];
    expect(() =>
      validateSuccessfulJobs(duplicated, { id: RUN_ID, runAttempt: 1 }, [requiredJobs()[2]!.name]),
    ).toThrow("duplicated");
    const incomplete = requiredJobs().map((job, index) =>
      index === 0 ? { ...job, status: "in_progress", conclusion: null } : job,
    );
    expect(() =>
      validateSuccessfulJobs(incomplete, { id: RUN_ID, runAttempt: 1 }, [requiredJobs()[2]!.name]),
    ).toThrow("incomplete");

    const check = {
      conclusion: "success",
      headSha: HEAD_SHA,
      id: 1,
      name: REQUIRED_PROOF_CHECKS.rootless,
      status: "completed",
      url: "https://github.com/check/1",
    };
    expect(validateRequiredChecks([check], HEAD_SHA, [check.name])).toEqual([
      { conclusion: "success", name: check.name, url: check.url },
    ]);
    expect(() =>
      validateRequiredChecks([{ ...check, headSha: "c".repeat(40) }], HEAD_SHA, [check.name]),
    ).toThrow("stale");
    expect(() =>
      validateRequiredChecks([check, { ...check, id: 2 }], HEAD_SHA, [check.name]),
    ).toThrow("duplicated");
  });
});

describe("qualification orchestration", () => {
  it("uses the highest predecessor fixture when base and target pins match", async () => {
    const baseRoot = createBaseRoot();
    const evidence = await verifyOpenShellE2EQualification(qualificationInput(baseRoot), {
      api: fullApi(),
      async loadReceipt() {
        return validReceipt();
      },
      readVersion() {
        return "0.0.99";
      },
    });
    expect(evidence).toMatchObject({
      baselineVersion: "0.0.99",
      baseSha: BASE_SHA,
      candidateSha: HEAD_SHA,
      exercisedUpgradeVersion: "0.0.85",
      qualificationRequired: true,
      status: "qualified",
      targetVersion: "0.0.99",
    });
    expect(evidence.e2e?.runId).toBe(RUN_ID);
    expect(evidence.proofChecks.map((check) => check.name)).toEqual([
      REQUIRED_PROOF_CHECKS.managed,
      REQUIRED_PROOF_CHECKS.rootless,
    ]);
  });

  it("rejects an OpenShell version segment that no longer orders exactly (#8292)", async () => {
    // 9007199254740993 exceeds Number.MAX_SAFE_INTEGER, so predecessor selection
    // could not order it against 9007199254740992.
    await expect(
      verifyOpenShellE2EQualification(qualificationInput(createBaseRoot()), {
        api: fullApi(),
        async loadReceipt() {
          return validReceipt();
        },
        readVersion: () => "9007199254740993.0.0",
      }),
    ).rejects.toThrow("baseline or target OpenShell version is malformed");
  });

  it("rejects an upgrade fixture version segment that no longer orders exactly (#8292)", async () => {
    await expect(
      verifyOpenShellE2EQualification(qualificationInput(createBaseRoot("9007199254740993.0.0")), {
        api: fullApi(),
        readVersion: () => "0.0.99",
      }),
    ).rejects.toThrow("trusted E2E fixture legacy-v1 has a malformed openshell_version");
  });

  it("fails closed when a sensitive change has no current-head v2 receipt", async () => {
    const baseRoot = createBaseRoot();
    const verify = (receipt: Record<string, unknown>) =>
      verifyOpenShellE2EQualification(qualificationInput(baseRoot), {
        api: fullApi(),
        async loadReceipt() {
          return receipt;
        },
        readVersion(root) {
          return root === baseRoot ? "0.0.85" : "0.0.99";
        },
      });

    await expect(verify(validReceipt({ kind: "nemoclaw-e2e-dispatch-v1" }))).rejects.toThrow(
      "no current-head trusted full E2E dispatch receipt",
    );
    await expect(verify(validReceipt({ candidateSha: "d".repeat(40) }))).rejects.toThrow(
      "no current-head trusted full E2E dispatch receipt",
    );
  });

  it("ignores a newer legitimate selective v2 dispatch when choosing full evidence", async () => {
    const baseRoot = createBaseRoot();
    const selectiveRunId = RUN_ID + 1;
    const evidence = await verifyOpenShellE2EQualification(qualificationInput(baseRoot), {
      api: apiWithWorkflowRuns([workflowRun(RUN_ID), workflowRun(selectiveRunId)]),
      async loadReceipt(artifact) {
        return artifact.runId === selectiveRunId
          ? validReceipt({
              emptySelectors: false,
              jobs: "managed-image-protected-runtime",
              workflowRunId: String(selectiveRunId),
            })
          : validReceipt();
      },
      readVersion() {
        return "0.0.99";
      },
    });

    expect(evidence.e2e?.runId).toBe(RUN_ID);
  });

  it.each([
    ["failed", "completed", "failure"],
    ["cancelled", "completed", "cancelled"],
    ["incomplete", "in_progress", null],
  ])(
    "does not let an older success bypass the newest %s full dispatch",
    async (_label, status, conclusion) => {
      const baseRoot = createBaseRoot();
      const newestRunId = RUN_ID + 1;
      await expect(
        verifyOpenShellE2EQualification(qualificationInput(baseRoot), {
          api: apiWithWorkflowRuns([
            workflowRun(RUN_ID),
            workflowRun(newestRunId, status, conclusion),
          ]),
          async loadReceipt(artifact) {
            return validReceipt({ workflowRunId: String(artifact.runId) });
          },
          readVersion() {
            return "0.0.99";
          },
        }),
      ).rejects.toThrow(`newest current-head full E2E run ${newestRunId} is not successful`);
    },
  );

  it("does not require E2E or proof APIs for an unrelated change", async () => {
    const evidence = await verifyOpenShellE2EQualification(
      {
        baseRoot: "/unused",
        baseSha: BASE_SHA,
        candidateRoot: "/unused",
        candidateSha: HEAD_SHA,
        prNumber: 8583,
        repository: REPOSITORY,
        workflowSha: BASE_SHA,
      },
      { api: fullApi([prFile("docs/index.mdx")]) },
    );
    expect(evidence).toMatchObject({
      qualificationRequired: false,
      sensitiveFileCount: 0,
      status: "not-required",
    });
  });

  it("extracts one coherent OpenShell version from the repository trust surfaces", () => {
    expect(extractOpenShellVersion(REPO_ROOT)).toBe("0.0.101");
  });

  it("rejects mismatched OpenShell target-version surfaces", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-e2e-version-mismatch-"));
    tempRoots.push(root);
    const replacements = new Map<string, [string, string]>([
      [
        "nemoclaw-blueprint/blueprint.yaml",
        ['max_openshell_version: "0.0.101"', 'max_openshell_version: "0.0.100"'],
      ],
    ]);

    writeOpenShellVersionFixture(root, replacements);

    expect(() => extractOpenShellVersion(root)).toThrow("OpenShell version surfaces disagree");
  });
});
