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
  formatRequiredGateOutcome,
  isRetryableGithubReadError,
  type RequiredGateIdentity,
  type RequiredGateResult,
  retryableGithubRead,
  waitForRequiredGate,
} from "../tools/e2e/pr-e2e-required.mts";
import {
  dispatchNotObservedReceiptMarker,
  retryableFailureMarker,
} from "../tools/e2e/pr-e2e-retry-receipt.mts";
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

  it("treats completed authorization failures as terminal", () => {
    expect(
      classifyCoordinationCheck(
        check("E2E / PR Gate", {
          conclusion: "failure",
          output: { title: "E2E reviewer authorization failed" },
        }),
        identity.repository,
      ),
    ).toEqual({
      state: "complete",
      result: {
        conclusion: "failure",
        title: "E2E reviewer authorization failed",
        detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/99",
        logUrls: ["https://github.com/NVIDIA/NemoClaw/actions/runs/99"],
      },
    });
  });

  it("returns terminal trusted conclusions and drops untrusted detail links", () => {
    expect(
      classifyCoordinationCheck(
        check(undefined, {
          conclusion: "failure",
          details_url: "https://github.com/attacker/repo/runs/17",
          output: {
            summary:
              "[logs](https://github.com/attacker/repo/actions/runs/23/job/77)\n\n<!-- nemoclaw-pr-e2e-retry:v1:unknown -->",
            title: "Selected E2E jobs failed",
          },
        }),
        identity.repository,
      ),
    ).toEqual({
      state: "complete",
      result: { conclusion: "failure", title: "Selected E2E jobs failed" },
    });
  });

  it("carries direct failed-job links into the terminal error message", () => {
    const jobUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/23/job/77";
    const reflectedUrl = "https://github.com/NVIDIA/NemoClaw/actions/runs/23/job/88";
    const classified = classifyCoordinationCheck(
      check(undefined, {
        conclusion: "failure",
        details_url: "https://github.com/NVIDIA/NemoClaw/runs/17",
        output: {
          summary: [
            "[Selected E2E run 23](https://github.com/NVIDIA/NemoClaw/actions/runs/23) concluded `failure`.",
            "Jobs that did not pass:",
            `- [hermes-e2e ${reflectedUrl}](${jobUrl}) — concluded \`failure\`.`,
            `Reflected prose must not become a link: ${reflectedUrl}`,
            "[untrusted](https://example.com/actions/runs/23/job/88)",
          ].join("\n"),
          title: "hermes-e2e failed",
        },
      }),
      identity.repository,
    );

    expect(classified).toEqual({
      state: "complete",
      result: {
        conclusion: "failure",
        detailsUrl: "https://github.com/NVIDIA/NemoClaw/runs/17",
        logUrls: [jobUrl],
        title: "hermes-e2e failed",
      },
    });
    const result = classified as { state: "complete"; result: RequiredGateResult };
    expect(formatRequiredGateOutcome(result.result)).toBe(
      `conclusion=failure title=hermes-e2e failed logs=${jobUrl}`,
    );
  });

  it("links waiting messages to the trusted coordination job", () => {
    expect(
      classifyCoordinationCheck(
        check(undefined, {
          status: "in_progress",
          conclusion: null,
          details_url: "https://github.com/NVIDIA/NemoClaw/runs/17",
          output: { title: "Running 3 E2E jobs" },
        }),
        identity.repository,
      ),
    ).toEqual({
      state: "waiting",
      description: "Running 3 E2E jobs",
      detailsUrl: "https://github.com/NVIDIA/NemoClaw/runs/17",
      logUrls: ["https://github.com/NVIDIA/NemoClaw/runs/17"],
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

  it("selects the newest PR/base SHA check after marker-backed immutable history", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      githubResponse(
        listing([
          check(undefined, {
            status: "completed",
            conclusion: "failure",
            output: {
              title: "Selected E2E did not pass",
              summary:
                "The child run was cancelled.\n\n<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->",
            },
          }),
          check(undefined, {
            id: 18,
            status: "in_progress",
            conclusion: null,
            output: { title: "E2E reviewer authorization required to run E2E" },
          }),
        ]),
      ),
    );

    await expect(findCoordinationCheck(identity)).resolves.toMatchObject({ id: 18 });
  });

  it("waits only for a dispatch-not-observed failure with a validated receipt", () => {
    const receipt = dispatchNotObservedReceiptMarker({
      correlationId: "123e4567-e89b-42d3-a456-426614174000",
      workflowSha: "d".repeat(40),
      sentAtMs: 1_785_050_400_000,
      deadlineAtMs: 1_785_050_445_000,
      result: "not-observed",
      failureKind: "http",
      status: 500,
      requestId: "ABCD:1234",
    });
    const valid = check(undefined, {
      conclusion: "failure",
      output: {
        title: "Workflow dispatch was not observed",
        summary: `No child was observed.\n\n${receipt}\n\n${retryableFailureMarker("dispatch-not-observed")}`,
      },
    });
    const missingReceipt = check(undefined, {
      conclusion: "failure",
      output: {
        title: "Workflow dispatch was not observed",
        summary: `No child was observed.\n\n${retryableFailureMarker("dispatch-not-observed")}`,
      },
    });

    expect(classifyCoordinationCheck(valid, identity.repository)).toMatchObject({
      state: "waiting",
    });
    expect(classifyCoordinationCheck(missingReceipt, identity.repository)).toMatchObject({
      state: "complete",
      result: { conclusion: "failure" },
    });
  });

  it.each([
    { label: "the source marker is removed before reservation", replacement: false },
    { label: "the reserved replacement is closed after create response loss", replacement: true },
  ])("observes a terminal retry-controller failure when $label", async ({ replacement }) => {
    const older = check(undefined, {
      id: 16,
      conclusion: "failure",
      output: {
        title: "PR prerequisite CI did not pass",
        summary: "Prerequisite CI failed.\n\n<!-- nemoclaw-pr-e2e-retry:v1:prerequisite-ci -->",
      },
    });
    const source = check(undefined, {
      id: 17,
      conclusion: "failure",
      output: {
        title: replacement ? "Selected E2E did not pass" : "Runner-loss retry could not start",
        summary: replacement
          ? "Runner disappeared.\n\n<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->"
          : "Runner disappeared. The automatic retry controller could not start.",
      },
    });
    const replacementCheck = check(undefined, {
      id: 18,
      conclusion: "failure",
      output: {
        title: "Runner-loss retry could not start",
        summary: "The reserved replacement was terminalized without a retry marker.",
      },
    });
    const checks = replacement ? [older, source, replacementCheck] : [older, source];
    vi.spyOn(globalThis, "fetch").mockResolvedValue(githubResponse(listing(checks)));

    const current = await findCoordinationCheck(identity);
    expect(classifyCoordinationCheck(current, identity.repository)).toEqual({
      state: "complete",
      result: {
        conclusion: "failure",
        title: "Runner-loss retry could not start",
        detailsUrl: "https://github.com/NVIDIA/NemoClaw/actions/runs/99",
        logUrls: ["https://github.com/NVIDIA/NemoClaw/actions/runs/99"],
      },
    });
  });

  it.each([
    {
      label: "an older unmarked terminal check",
      checks: [
        check(undefined, {
          status: "completed",
          conclusion: "failure",
          output: { title: "Unknown controller failure", summary: "No retry marker." },
        }),
        check(undefined, { id: 18, status: "in_progress", conclusion: null }),
      ],
      expectedError: "history contains a non-retryable older check",
    },
    {
      label: "multiple active current candidates",
      checks: [
        check(undefined, { status: "in_progress", conclusion: null }),
        check(undefined, { id: 18, status: "in_progress", conclusion: null }),
      ],
      expectedError: "Multiple active coordination checks exist for one PR/base SHA pair",
    },
  ])("rejects PR/base SHA coordination history with $label", async ({ checks, expectedError }) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(githubResponse(listing(checks)));

    await expect(findCoordinationCheck(identity)).rejects.toThrow(expectedError);
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

  it("rejects a PR/base SHA identity claimed by another app", async () => {
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
                      output: { title: "E2E reviewer authorization required to run E2E" },
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

  it("waits for a replacement after a retryable coordination failure", async () => {
    let coordinationQueries = 0;
    let clock = 0;
    const retryableFailure = check(undefined, {
      conclusion: "failure",
      output: {
        title: "Selected E2E did not pass",
        summary:
          "The child run was cancelled.\n\n<!-- nemoclaw-pr-e2e-retry:v1:child-cancelled -->",
      },
    });
    const coordinationListings = [
      listing([retryableFailure]),
      listing([
        retryableFailure,
        check(undefined, {
          id: 18,
          status: "in_progress",
          conclusion: null,
          output: { title: "Running selected E2E jobs" },
        }),
      ]),
      listing([
        retryableFailure,
        check(undefined, {
          id: 18,
          output: { title: "All selected E2E jobs passed" },
        }),
      ]),
    ];
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
            return githubResponse(coordinationListings.shift());
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

  it("includes the trusted coordination link when polling times out", async () => {
    let clock = 0;
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url }) => url.includes("/pulls/42"),
          () => githubResponse(pullRequest()),
        ),
        githubFetchRoute(
          ({ url }) => url.includes("Coordination"),
          () =>
            githubResponse(
              listing([
                check(undefined, {
                  status: "in_progress",
                  conclusion: null,
                  details_url: "https://github.com/NVIDIA/NemoClaw/runs/17",
                  output: { title: "Running E2E jobs" },
                }),
              ]),
            ),
        ),
      ]),
    );

    await expect(
      waitForRequiredGate(identity, {
        timeoutMs: 10,
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).rejects.toThrow("https://github.com/NVIDIA/NemoClaw/runs/17");
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
    ).rejects.toThrow("not the expected open PR with the observed PR SHA and base SHA");
  });

  describe("bounded GitHub read retries (#7207)", () => {
    it("classifies only network, rate-limit, and server failures as retryable", () => {
      expect(isRetryableGithubReadError(new TypeError("fetch failed"))).toBe(true);
      expect(
        isRetryableGithubReadError(new Error("GitHub API repos/x/pulls/1 failed: 429 limited")),
      ).toBe(true);
      expect(
        isRetryableGithubReadError(new Error("GitHub API repos/x/pulls/1 failed: 503 unavailable")),
      ).toBe(true);
      expect(
        isRetryableGithubReadError(new Error("GitHub API repos/x/pulls/1 failed: 404 missing")),
      ).toBe(false);
      expect(
        isRetryableGithubReadError(new Error("GitHub API repos/x/pulls/1 failed: 401 denied")),
      ).toBe(false);
      expect(
        isRetryableGithubReadError(new Error("GitHub API repos/x/pulls/1 failed: 403 denied")),
      ).toBe(false);
      expect(isRetryableGithubReadError(new Error("fetch failed"))).toBe(false);
    });

    it("retries a transient read with deterministic bounded delay", async () => {
      const sleepCalls: number[] = [];
      const read = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValue("success");

      await expect(
        retryableGithubRead("coordination checks", read, null, {
          baseDelayMs: 100,
          random: () => 0,
          sleep: async (milliseconds) => {
            sleepCalls.push(milliseconds);
          },
        }),
      ).resolves.toBe("success");

      expect(read).toHaveBeenCalledTimes(2);
      expect(sleepCalls).toEqual([50]);
    });

    it("preserves the first retryable failure as the exhaustion cause", async () => {
      let calls = 0;
      const error = await retryableGithubRead(
        "coordination checks",
        async () => {
          calls += 1;
          throw new TypeError(`fetch failed attempt ${calls}`);
        },
        null,
        { baseDelayMs: 1, random: () => 0, sleep: async () => {} },
      ).catch((caught: unknown) => caught);

      expect(calls).toBe(3);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe(
        "E2E / PR Gate [coordination checks] attempt 3/3: network",
      );
      expect((error as Error & { cause?: Error }).cause?.message).toBe("fetch failed attempt 1");
    });

    it("does not retry or expose a non-retryable response body", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      let calls = 0;

      const error = await retryableGithubRead(
        "coordination checks",
        async () => {
          calls += 1;
          throw new Error("GitHub API repos/x/pulls/1 failed: 404 secret response");
        },
        null,
        { sleep: async () => {} },
      ).catch((caught: unknown) => caught);

      expect(calls).toBe(1);
      expect((error as Error).message).toBe(
        "E2E / PR Gate [coordination checks] attempt 1/3: http",
      );
      expect((error as Error).message).not.toContain("secret response");
      expect((error as Error & { cause?: Error }).cause?.message).toContain("secret response");
      expect(log).not.toHaveBeenCalled();
    });

    it("uses a later terminal failure as the cause after a transient failure", async () => {
      const read = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockRejectedValueOnce(
          new Error("GitHub API repos/x/pulls/1 failed: 404 terminal response"),
        );

      const error = await retryableGithubRead("coordination checks", read, null, {
        baseDelayMs: 1,
        random: () => 0,
        sleep: async () => {},
      }).catch((caught: unknown) => caught);

      expect(read).toHaveBeenCalledTimes(2);
      expect((error as Error).message).toBe(
        "E2E / PR Gate [coordination checks] attempt 2/3: http",
      );
      expect((error as Error & { cause?: Error }).cause?.message).toBe(
        "GitHub API repos/x/pulls/1 failed: 404 terminal response",
      );
    });

    it("logs a retry class without reflecting the GitHub response body", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
      const read = vi
        .fn()
        .mockRejectedValueOnce(
          new Error("GitHub API repos/x/check-runs failed: 503 credential-like-body"),
        )
        .mockResolvedValue("success");

      await retryableGithubRead("coordination checks", read, null, {
        baseDelayMs: 1,
        random: () => 0,
        sleep: async () => {},
      });

      expect(log).toHaveBeenCalledWith("E2E / PR Gate [coordination checks] attempt 1/3: http");
      expect(log.mock.calls.flat().join(" ")).not.toContain("credential-like-body");
    });

    it("does not expose a retryable response body after exhaustion", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

      const error = await retryableGithubRead(
        "coordination checks",
        async () => {
          throw new Error("GitHub API repos/x/check-runs failed: 503 credential-like-body");
        },
        null,
        { baseDelayMs: 1, random: () => 0, sleep: async () => {} },
      ).catch((caught: unknown) => caught);

      expect((error as Error).message).toBe(
        "E2E / PR Gate [coordination checks] attempt 3/3: http",
      );
      expect((error as Error).message).not.toContain("credential-like-body");
      expect(log.mock.calls.flat().join(" ")).not.toContain("credential-like-body");
      expect((error as Error & { cause?: Error }).cause?.message).toContain("credential-like-body");
    });

    it("fails closed when exact PR identity changes before a retry", async () => {
      let calls = 0;
      vi.spyOn(globalThis, "fetch").mockResolvedValue(
        githubResponse(pullRequest({ head: { sha: "c".repeat(40) } })),
      );

      await expect(
        retryableGithubRead(
          "coordination checks",
          async () => {
            calls += 1;
            throw new TypeError("fetch failed");
          },
          identity,
          { baseDelayMs: 1, random: () => 0, sleep: async () => {} },
        ),
      ).rejects.toThrow("not the expected open PR with the observed PR SHA and base SHA");

      expect(calls).toBe(1);
    });

    it("proves exact PR identity through transient revalidation before retrying", async () => {
      const sleepCalls: number[] = [];
      const identityRead = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValueOnce(new TypeError("identity fetch failed"))
        .mockResolvedValue(githubResponse(pullRequest()));
      const coordinationRead = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("coordination fetch failed"))
        .mockResolvedValue("success");

      await expect(
        retryableGithubRead("coordination checks", coordinationRead, identity, {
          baseDelayMs: 100,
          random: () => 0,
          sleep: async (milliseconds) => {
            sleepCalls.push(milliseconds);
          },
        }),
      ).resolves.toBe("success");

      expect(coordinationRead).toHaveBeenCalledTimes(2);
      expect(identityRead).toHaveBeenCalledTimes(2);
      expect(sleepCalls).toEqual([50, 50]);
    });

    it("does not retry the original read when identity cannot be proven", async () => {
      let calls = 0;
      let identityCalls = 0;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        identityCalls += 1;
        throw new TypeError(`identity fetch failed ${identityCalls}`);
      });

      await expect(
        retryableGithubRead(
          "coordination checks",
          async () => {
            calls += 1;
            throw new TypeError("coordination fetch failed");
          },
          identity,
          { baseDelayMs: 1, random: () => 0, sleep: async () => {} },
        ),
      ).rejects.toThrow("E2E / PR Gate [exact PR identity] attempt 3/3: network");

      expect(calls).toBe(1);
      expect(identityCalls).toBe(3);
    });

    it("revalidates identity after the backoff and before the original read", async () => {
      let calls = 0;
      let identityChanged = false;
      vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        githubResponse(
          identityChanged ? pullRequest({ head: { sha: "c".repeat(40) } }) : pullRequest(),
        ),
      );

      await expect(
        retryableGithubRead(
          "coordination checks",
          async () => {
            calls += 1;
            throw new TypeError("coordination fetch failed");
          },
          identity,
          {
            baseDelayMs: 1,
            random: () => 0,
            sleep: async () => {
              identityChanged = true;
            },
          },
        ),
      ).rejects.toThrow("not the expected open PR with the observed PR SHA and base SHA");

      expect(calls).toBe(1);
    });
  });
});
