// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type CoordinationCheckRun,
  classifyCoordinationCheck,
  coordinationExternalId,
  findCoordinationCheck,
  type RequiredGateIdentity,
  waitForRequiredGate,
} from "../tools/e2e/pr-e2e-required.mts";
import { createGitHubFetchRouter, githubFetchRoute } from "./support/github-fetch-router.ts";

const HEAD_SHA = "a".repeat(40);
const BASE_SHA = "b".repeat(40);
const SCRIPT = fileURLToPath(new URL("../tools/e2e/pr-e2e-required.mts", import.meta.url));

const identity: RequiredGateIdentity = {
  repository: "NVIDIA/NemoClaw",
  token: "token",
  prNumber: 42,
  headSha: HEAD_SHA,
  baseSha: BASE_SHA,
};

afterEach(() => {
  vi.restoreAllMocks();
});

function githubResponse(value: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  } as Response;
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    state: "open",
    head: { sha: HEAD_SHA },
    base: { sha: BASE_SHA },
    ...overrides,
  };
}

function check(
  name = "E2E / PR Gate Coordination",
  overrides: Partial<CoordinationCheckRun> = {},
): CoordinationCheckRun {
  return {
    id: 17,
    name,
    head_sha: HEAD_SHA,
    external_id: coordinationExternalId(42, HEAD_SHA, BASE_SHA),
    status: "completed",
    conclusion: "success",
    details_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/99",
    output: { title: "All selected E2E jobs passed" },
    app: { id: 15368 },
    ...overrides,
  };
}

function listing(checks: CoordinationCheckRun[]) {
  return { total_count: checks.length, check_runs: checks };
}

describe("native PR E2E required job", () => {
  it("loads under the workflow Node runtime", () => {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", SCRIPT, "--pr", "42"],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--head is required");
    expect(result.stderr).not.toContain("ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX");
  });

  it("classifies fork-skip approval failures as pending", () => {
    expect(
      classifyCoordinationCheck(
        check("E2E / PR Gate", {
          conclusion: "failure",
          output: { title: "Maintainer approval required to skip credentialed E2E" },
        }),
      ),
    ).toEqual({
      state: "waiting",
      description: "Maintainer approval required to skip credentialed E2E",
    });
  });

  it("returns terminal trusted conclusions and drops untrusted detail links", () => {
    expect(
      classifyCoordinationCheck(
        check(undefined, {
          conclusion: "failure",
          details_url: "https://example.com/untrusted",
          output: { title: "Selected E2E jobs failed" },
        }),
      ),
    ).toEqual({
      state: "complete",
      result: { conclusion: "failure", title: "Selected E2E jobs failed" },
    });
  });

  it("prefers the renamed coordination check without querying the legacy name", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      urls.push(url);
      return githubResponse(listing([check()]));
    });

    await expect(findCoordinationCheck(identity)).resolves.toMatchObject({ id: 17 });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("E2E%20%2F%20PR%20Gate%20Coordination");
  });

  it("uses the old required-name check during the native-job migration", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return githubResponse(
        url.includes("Coordination") ? listing([]) : listing([check("E2E / PR Gate")]),
      );
    });

    await expect(findCoordinationCheck(identity)).resolves.toMatchObject({
      name: "E2E / PR Gate",
    });
  });

  it("rejects an exact-diff identity claimed by another app", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      githubResponse(listing([check(undefined, { app: { id: 1 } })])),
    );

    await expect(findCoordinationCheck(identity)).rejects.toThrow("unexpected GitHub App");
  });

  it("waits through pending authorization and running states before passing", async () => {
    let coordinationQueries = 0;
    let clock = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url }) => url.includes("/pulls/42"),
          () => githubResponse(pullRequest()),
        ),
        githubFetchRoute(
          ({ url }) => url.includes("Coordination"),
          () => {
            coordinationQueries += 1;
            return githubResponse(
              listing([
                coordinationQueries === 1
                  ? check(undefined, {
                      status: "in_progress",
                      conclusion: null,
                      output: { title: "Maintainer authorization required to run E2E" },
                    })
                  : coordinationQueries === 2
                    ? check(undefined, {
                        status: "in_progress",
                        conclusion: null,
                        output: { title: "Running 3 E2E jobs" },
                      })
                    : check(),
              ]),
            );
          },
        ),
      ]),
    );

    await expect(
      waitForRequiredGate(identity, {
        timeoutMs: 100,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).resolves.toMatchObject({ conclusion: "success" });
    expect(coordinationQueries).toBe(3);
  });

  it("fails closed when the PR head changes before a terminal verdict is accepted", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      return githubResponse(
        url.includes("/pulls/42")
          ? pullRequest({ head: { sha: "c".repeat(40) } })
          : listing([check()]),
      );
    });

    await expect(
      waitForRequiredGate(identity, { timeoutMs: 100, pollIntervalMs: 10 }),
    ).rejects.toThrow("no longer matches the exact head and base revision");
  });
});
