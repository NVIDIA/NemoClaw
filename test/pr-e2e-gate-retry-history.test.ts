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
  seedPrGate,
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
const CI_RUN_ID = 99;
const CI_RUN_ATTEMPT = 3;
const GATE_RUN_ID = 77;

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

function exactPrGateCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    name: "E2E / PR Gate Coordination",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    app: { id: 15368 },
    ...overrides,
  };
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

function pullRequestListItem(): Omit<PullRequest, "changed_files"> {
  const { changed_files: _changedFiles, ...item } = pullRequest();
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
    "--gate-run-id",
    String(GATE_RUN_ID),
    "--pr",
    "42",
    "--work-dir",
    workDir,
  ]);
  expect(command.mode).toBe("start");
  return command as Extract<ReturnType<typeof parseControllerCommand>, { mode: "start" }>;
}

describe("PR E2E controller retry history", () => {
  it("leaves a completed stale-base check immutable while selecting the current base (#7052)", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const otherBaseSha = "c".repeat(40);
    const completedStaleCheck = exactPrGateCheck({
      id: 18,
      external_id: prGateExternalId(42, HEAD_SHA, otherBaseSha),
      status: "completed",
      conclusion: "failure",
      output: {
        title: "PR base changed",
        summary: "This check belongs to the earlier base revision.",
      },
    });
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
            () => githubResponse(pullRequest()),
          ),
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () =>
              githubResponse({
                total_count: 2,
                check_runs: [exactPrGateCheck(), completedStaleCheck],
              }),
          ),
        ],
        requests,
      ),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).resolves.toBe(17);
    expect(requests).toHaveLength(2);
    expect(requests.some((request) => request.method === "POST")).toBe(false);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    expect(completedStaleCheck).toMatchObject({
      id: 18,
      status: "completed",
      conclusion: "failure",
      output: { title: "PR base changed" },
    });
  });

  it("creates a fresh check after a marker-backed infrastructure failure before internal PR code can receive E2E credentials (#7052)", async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-pr-e2e-gate-control-"));
    const outputPath = path.join(workDir, "github-output");
    fs.writeFileSync(outputPath, "", { mode: 0o600 });
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.stubEnv("GITHUB_OUTPUT", outputPath);
    const requests: RecordedGitHubRequest[] = [];
    const completedCheck = exactPrGateCheck({
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Hermes security-posture did not pass",
        summary:
          "The selected child was cancelled by external infrastructure.\n\n<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->",
      },
    });
    const checkRuns = [completedCheck];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        [
          githubFetchRoute(
            ({ url, method }) =>
              url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
            () => githubResponse({ total_count: checkRuns.length, check_runs: checkRuns }),
          ),
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
            ({ url, method }) => url.endsWith("/check-runs") && method === "POST",
            (request) => {
              const created = exactPrGateCheck({
                id: 18,
                ...(request.body as Record<string, unknown> | undefined),
              });
              checkRuns.push(created);
              return githubResponse(created);
            },
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/17") && method === "PATCH",
            () => githubResponse(completedCheck),
          ),
          githubFetchRoute(
            ({ url, method }) => url.endsWith("/check-runs/18") && method === "PATCH",
            (request) => {
              const current = checkRuns[1]!;
              checkRuns[1] = {
                ...current,
                ...(request.body as Record<string, unknown> | undefined),
              };
              return githubResponse(checkRuns[1]);
            },
          ),
        ],
        requests,
      ),
    );

    try {
      await expect(startPrGate(startCommand(workDir))).resolves.toBeUndefined();
      expect(requests.some((request) => request.url.endsWith("/dispatches"))).toBe(false);
      expect(
        requests.some(
          (request) => request.url.endsWith("/check-runs/17") && request.method === "PATCH",
        ),
      ).toBe(false);
      const creation = requests.find(
        (request) => request.url.endsWith("/check-runs") && request.method === "POST",
      );
      expect(creation?.body).toMatchObject({
        name: "E2E / PR Gate Coordination",
        head_sha: HEAD_SHA,
        external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
        status: "in_progress",
      });
      const completion = requests
        .filter((request) => request.url.endsWith("/check-runs/18"))
        .at(-1);
      expect(completion?.body).toMatchObject({
        status: "in_progress",
        output: {
          title: "Maintainer authorization required to run E2E",
          summary: expect.stringContaining(
            "No selected E2E job or target ran and no repository secret was exposed",
          ),
        },
      });
      expect(completion?.body).not.toHaveProperty("conclusion");
      expect(checkRuns[0]).toEqual(completedCheck);
      expect(checkRuns[1]).toMatchObject({
        id: 18,
        status: "in_progress",
        conclusion: null,
        output: {
          title: "Maintainer authorization required to run E2E",
          summary: expect.stringContaining(
            "No selected E2E job or target ran and no repository secret was exposed",
          ),
        },
      });
      expect(JSON.stringify(completion?.body)).toContain(
        "run `run-control-plane` with the PR number, PR SHA, base SHA",
      );
      expect(fs.readFileSync(outputPath, "utf8")).not.toContain("fork_skip_mode=");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("check_id=18");
      expect(fs.readFileSync(outputPath, "utf8")).toContain("finalized=true");
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});
