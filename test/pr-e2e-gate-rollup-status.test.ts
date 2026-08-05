// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";
import { type PullRequest, prGateExternalId, seedPrGate } from "../tools/e2e/pr-e2e-gate.mts";
import {
  createGitHubFetchRouter,
  githubFetchRoute,
  type RecordedGitHubRequest,
} from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);

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

function forkPullRequest(): PullRequest {
  return {
    number: 42,
    state: "open",
    changed_files: 1,
    head: {
      ref: "feature/pr-e2e-gate",
      sha: HEAD_SHA,
      repo: { full_name: "contributor/NemoClaw" },
    },
    base: {
      sha: BASE_SHA,
      repo: { full_name: "NVIDIA/NemoClaw" },
    },
  };
}

function exactPrGateCheck(overrides: Record<string, unknown> = {}) {
  return {
    id: 17,
    name: "E2E / PR Gate",
    head_sha: HEAD_SHA,
    external_id: prGateExternalId(42, HEAD_SHA, BASE_SHA),
    status: "in_progress",
    conclusion: null,
    output: {
      title: "Maintainer approval required to run fork E2E",
      summary: "A maintainer must approve this fork E2E run.",
    },
    app: { id: 15368 },
    ...overrides,
  };
}

function controllerRoutes(statusResponse: (request: RecordedGitHubRequest) => Response) {
  return [
    githubFetchRoute(
      ({ url, method }) => url.endsWith("/pulls/42") && method === "GET",
      () => githubResponse(forkPullRequest()),
    ),
    githubFetchRoute(
      ({ url, method }) => url.includes(`/commits/${HEAD_SHA}/check-runs?`) && method === "GET",
      () => githubResponse({ total_count: 1, check_runs: [exactPrGateCheck()] }),
    ),
    githubFetchRoute(
      ({ url, method }) => url.endsWith(`/statuses/${HEAD_SHA}`) && method === "POST",
      statusResponse,
    ),
  ];
}

describe("PR E2E gate rollup status", () => {
  it("publishes a pending PR rollup status for a fork gate", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_WORKFLOW", "E2E / PR Gate Controller");
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        controllerRoutes((request) => githubResponse(request.body)),
        requests,
      ),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).resolves.toBe(17);
    expect(requests.at(-1)).toMatchObject({
      method: "POST",
      body: {
        state: "pending",
        context: "E2E / PR Gate / Rollup",
        description: "Maintainer approval required to run fork E2E",
        target_url: "https://github.com/NVIDIA/NemoClaw/runs/17",
      },
    });
  });

  it("keeps the authoritative gate usable when rollup publication fails", async () => {
    vi.stubEnv("GITHUB_ACTIONS", "true");
    vi.stubEnv("GITHUB_WORKFLOW", "E2E / PR Gate Controller");
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const requests: RecordedGitHubRequest[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter(
        controllerRoutes(() => githubResponse({ message: "temporary failure" }, 503)),
        requests,
      ),
    );

    await expect(seedPrGate(42, HEAD_SHA, BASE_SHA)).resolves.toBe(17);
    expect(
      requests.filter(
        (request) => request.url.endsWith(`/statuses/${HEAD_SHA}`) && request.method === "POST",
      ),
    ).toHaveLength(2);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("Could not publish E2E / PR Gate / Rollup"),
    );
  });
});
