// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type PullRequest,
  parseControllerCommand,
  prGateExternalId,
  resolveControlPlaneGate,
  resolveForkGate,
  startPrGate,
} from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const WORKFLOW_SHA = "d".repeat(40);
const ADVANCED_WORKFLOW_SHA = "e".repeat(40);
const CI_RUN_ID = 99;
const CI_RUN_ATTEMPT = 3;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function githubResponse(value?: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => value,
    text: async () => (value === undefined ? "" : JSON.stringify(value)),
  } as Response;
}

function emptyPrGateCheckRunsRoute() {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 0, check_runs: [] }),
  );
}

function exactPrGateCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    name: "E2E / PR Gate",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    app: { id: 15368 },
    ...overrides,
  };
}

function existingPrGateCheckRunsRoute(overrides: Record<string, unknown> = {}) {
  return githubFetchRoute(
    ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
    () => githubResponse({ total_count: 1, check_runs: [exactPrGateCheck(overrides)] }),
  );
}

function mainWorkflowRefRoute(sha = WORKFLOW_SHA) {
  return githubFetchRoute(
    ({ url }) => url.endsWith("/git/ref/heads/main"),
    () =>
      githubResponse({
        ref: "refs/heads/main",
        object: { type: "commit", sha },
      }),
  );
}

function compatibleMainComparisonRoute(
  files: Array<{ filename: string; previous_filename?: string }>,
  mainSha = ADVANCED_WORKFLOW_SHA,
) {
  return githubFetchRoute(
    ({ url }) => url.includes(`/compare/${WORKFLOW_SHA}...${mainSha}`),
    () =>
      githubResponse({
        status: "ahead",
        ahead_by: 1,
        behind_by: 0,
        base_commit: { sha: WORKFLOW_SHA },
        merge_base_commit: { sha: WORKFLOW_SHA },
        head_commit: { sha: mainSha },
        files,
      }),
  );
}

function pullRequest(changedFiles = 1): PullRequest {
  return {
    number: 42,
    state: "open",
    changed_files: changedFiles,
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
    base: {
      sha: BASE_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
  };
}

function forkPullRequest(changedFiles = 1): PullRequest {
  return {
    ...pullRequest(changedFiles),
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: "contributor/NemoClaw" },
    },
  };
}

function pullRequestListItem(pull = pullRequest()): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pull;
  return item;
}

function startCommand(workDir: string) {
  const command = parseControllerCommand([
    "--mode",
    "start",
    "--head",
    HEAD_SHA,
    "--head-repo",
    "NVIDIA/NemoClaw",
    "--head-branch",
    "feature/pr-e2e-gate",
    "--workflow-sha",
    WORKFLOW_SHA,
    "--ci-conclusion",
    "success",
    "--ci-display-title",
    `CI PR #42 head ${HEAD_SHA} base ${BASE_SHA} gate true`,
    "--ci-run-attempt",
    String(CI_RUN_ATTEMPT),
    "--ci-run-id",
    String(CI_RUN_ID),
    "--pr",
    "42",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

describe("PR E2E controller exception safety", () => {
  it("plans a risky fork without dispatching secret-bearing E2E", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          emptyPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            () => githubResponse({ id: 17 }),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem(forkPullRequest())]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(
        startPrGate({ ...startCommand(workDir), headRepository: "contributor/NemoClaw" }),
      ).resolves.toBeUndefined();
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      const completion = requests
        .filter((request) => request.url.endsWith("/check-runs/17"))
        .at(-1);
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Maintainer fork exception required",
          summary: expect.stringContaining("Fork code was not executed"),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("blocks internal E2E control-plane changes without exposing repository credentials", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-control-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem()]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "test/e2e/risk-signal-reporter.ts" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      const completion = requests
        .filter((request) => request.url.endsWith("/check-runs/17"))
        .at(-1);
      expect(completion?.body).toMatchObject({
        status: "completed",
        conclusion: "failure",
        output: {
          title: "Maintainer control-plane exception required",
          summary: expect.stringContaining(
            "No PR-controlled E2E workflow, test, support code, or evidence reporter was executed",
          ),
        },
      });
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("passes a no-risk fork without executing fork code", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-fork-docs-"));
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          existingPrGateCheckRunsRoute(),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls?state=open&head="),
            () => githubResponse([pullRequestListItem(forkPullRequest())]),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "docs/get-started/quickstart.mdx" }]),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    try {
      await startPrGate({ ...startCommand(workDir), headRepository: "contributor/NemoClaw" });
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(requests.at(-1)?.body).toMatchObject({
        status: "completed",
        conclusion: "success",
        output: { title: "No E2E jobs selected" },
      });
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("records an authorized exact-head/base fork exception after a compatible main advance", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () =>
              githubResponse({
                role_name: "maintain",
                permission: "write",
                user: { login: "maintainer" },
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(forkPullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer fork exception required" },
          }),
          mainWorkflowRefRoute(ADVANCED_WORKFLOW_SHA),
          compatibleMainComparisonRoute([{ filename: "docs/get-started/quickstart.mdx" }]),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    await resolveForkGate({
      mode: "resolve-fork",
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      maintainer: "maintainer",
      reason: "The fork cannot safely receive credential-bearing test secrets.",
    });

    const completion = requests.at(-1);
    expect(completion?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: {
        title: "Fork exception recorded by @maintainer",
        summary: expect.stringContaining("Credential-bearing E2E was not run"),
      },
    });
    expect(JSON.stringify(completion?.body)).not.toContain("tests passed");
  });

  it("records an authorized exact-SHA control-plane exception without claiming E2E ran", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () =>
              githubResponse({
                role_name: "maintain",
                permission: "write",
                user: { login: "maintainer" },
              }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "tools/e2e/pr-e2e-gate.mts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer control-plane exception required" },
          }),
          mainWorkflowRefRoute(),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse({}),
          ),
        ],
        requests,
      ),
    );

    await resolveControlPlaneGate({
      mode: "resolve-control-plane",
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      maintainer: "maintainer",
      reason: "The control-plane change received independent non-secret validation.",
    });

    const completion = requests.at(-1);
    expect(completion?.body).toMatchObject({
      status: "completed",
      conclusion: "success",
      output: {
        title: "Control-plane exception recorded by @maintainer",
        summary: expect.stringContaining(
          "Credential-bearing E2E was not run because this PR controls E2E execution or evidence",
        ),
      },
    });
    expect(JSON.stringify(completion?.body)).not.toContain("tests passed");
    expect(JSON.stringify(completion?.body)).not.toContain("Supporting trusted run");
  });

  it("rejects an E2E exception from a collaborator below maintainer role", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/contributor/permission"),
            () =>
              githubResponse({
                role_name: "write",
                permission: "write",
                user: { login: "contributor" },
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      resolveControlPlaneGate({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "contributor",
        reason: "A write-role collaborator tried to record an exception.",
      }),
    ).rejects.toThrow(/maintainer or administrator/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it.each([
    {
      name: "fork operation for an internal pull request",
      mode: "resolve-fork" as const,
      pull: pullRequest(),
      error: /fork exceptions require a fork pull request/u,
    },
    {
      name: "control-plane operation for a fork pull request",
      mode: "resolve-control-plane" as const,
      pull: forkPullRequest(),
      error: /control-plane exceptions require an internal pull request/u,
    },
  ])("rejects the $name", async ({ mode, pull, error }) => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pull),
          ),
        ],
        requests,
      ),
    );

    const common = {
      prNumber: 42,
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      workflowSha: WORKFLOW_SHA,
      maintainer: "maintainer",
      reason: "The resolver operation must match the pull request origin.",
    };
    const resolution =
      mode === "resolve-fork"
        ? resolveForkGate({ mode, ...common })
        : resolveControlPlaneGate({ mode, ...common });
    await expect(resolution).rejects.toThrow(error);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a control-plane exception for an ordinary internal change", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "src/lib/onboard.ts" }]),
          ),
        ],
        requests,
      ),
    );

    await expect(
      resolveControlPlaneGate({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The ordinary change does not qualify for this exception.",
      }),
    ).rejects.toThrow(/does not change the trusted E2E control plane/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a control-plane exception when the failed gate title does not match", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "tools/e2e/pr-e2e-gate.mts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer fork exception required" },
          }),
        ],
        requests,
      ),
    );

    await expect(
      resolveControlPlaneGate({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The failed gate must match the requested exception type.",
      }),
    ).rejects.toThrow(/matching exception-required failure/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a manual exception after main advances through the E2E control plane", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "tools/e2e/pr-e2e-gate.mts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer control-plane exception required" },
          }),
          mainWorkflowRefRoute(ADVANCED_WORKFLOW_SHA),
          compatibleMainComparisonRoute([{ filename: ".github/workflows/e2e.yaml" }]),
        ],
        requests,
      ),
    );

    await expect(
      resolveControlPlaneGate({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The controller commit must not be followed by control-plane changes.",
      }),
    ).rejects.toThrow(/main advanced through trusted E2E control-plane changes/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a control-plane exception when the internal head changes during review", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => {
              pullReads += 1;
              return githubResponse(
                pullReads === 1
                  ? pullRequest()
                  : {
                      ...pullRequest(),
                      head: { ...pullRequest().head, sha: "c".repeat(40) },
                    },
              );
            },
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "tools/e2e/pr-e2e-gate.mts" }]),
          ),
        ],
        requests,
      ),
    );

    await expect(
      resolveControlPlaneGate({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The internal head changed while the review was being recorded.",
      }),
    ).rejects.toThrow(/PR changed during preparation/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a stale fork exception before changing the gate", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () =>
              githubResponse({
                ...forkPullRequest(),
                head: { ...forkPullRequest().head, sha: "c".repeat(40) },
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      resolveForkGate({
        mode: "resolve-fork",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The reviewed revision has since changed upstream.",
      }),
    ).rejects.toThrow(/no longer matches/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a fork exception after the pull request is retargeted", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () =>
              githubResponse({
                ...forkPullRequest(),
                base: { ...forkPullRequest().base, sha: "f".repeat(40) },
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(
      resolveForkGate({
        mode: "resolve-fork",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The reviewed base revision has since changed upstream.",
      }),
    ).rejects.toThrow(/no longer matches the reviewed exact head and base SHAs/u);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("rejects a manual exception when the base changes immediately before completion", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    let pullReads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url }) => url.endsWith("/collaborators/maintainer/permission"),
            () => githubResponse({ role_name: "maintain", user: { login: "maintainer" } }),
          ),
          githubFetchRoute(
            ({ url }) => url.endsWith("/pulls/42"),
            () => {
              pullReads += 1;
              return githubResponse(
                pullReads < 3
                  ? pullRequest()
                  : {
                      ...pullRequest(),
                      base: { ...pullRequest().base, sha: "f".repeat(40) },
                    },
              );
            },
          ),
          githubFetchRoute(
            ({ url }) => url.includes("/pulls/42/files?"),
            () => githubResponse([{ filename: "tools/e2e/pr-e2e-gate.mts" }]),
          ),
          existingPrGateCheckRunsRoute({
            status: "completed",
            conclusion: "failure",
            output: { title: "Maintainer control-plane exception required" },
          }),
          mainWorkflowRefRoute(),
        ],
        requests,
      ),
    );

    await expect(
      resolveControlPlaneGate({
        mode: "resolve-control-plane",
        prNumber: 42,
        headSha: HEAD_SHA,
        baseSha: BASE_SHA,
        workflowSha: WORKFLOW_SHA,
        maintainer: "maintainer",
        reason: "The exact base must remain current until the exception is recorded.",
      }),
    ).rejects.toThrow(/expected exact head and base/u);
    expect(pullReads).toBe(3);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
  });
});
