// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadChildRunEvidence, waitForChildRun } from "../tools/e2e/pr-e2e-gate.mts";
import { createGitHubFetchRouter, githubFetchRoute } from "./support/github-fetch-router.ts";

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

describe("PR E2E child run wait", () => {
  const CHILD_RUN_URL = "https://github.com/NVIDIA/NemoClaw/actions/runs/23";

  function childRunRoute(states: Array<{ status: string; conclusion: string | null }>) {
    let index = 0;
    return githubFetchRoute(
      ({ url, method }) => method === "GET" && url.endsWith("/actions/runs/23"),
      () => githubResponse(states[Math.min(index++, states.length - 1)]),
    );
  }

  function captureLogs(): string[] {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
      logs.push(String(message));
    });
    return logs;
  }

  it("logs each child state once and returns after a terminal conclusion", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const logs = captureLogs();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        childRunRoute([
          { status: "in_progress", conclusion: null },
          { status: "in_progress", conclusion: null },
          { status: "completed", conclusion: "success" },
        ]),
      ]),
    );

    await waitForChildRun(23, { sleep: async () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(logs).toEqual([
      `Run 23 status=in_progress url=${CHILD_RUN_URL}`,
      `Run 23 status=completed conclusion=success url=${CHILD_RUN_URL}`,
    ]);
  });

  it("leaves a terminal child failure for finalization to report", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const logs = captureLogs();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([childRunRoute([{ status: "completed", conclusion: "failure" }])]),
    );

    await expect(waitForChildRun(23, { sleep: async () => {} })).resolves.toBeUndefined();
    expect(logs).toEqual([`Run 23 status=completed conclusion=failure url=${CHILD_RUN_URL}`]);
  });

  it("fails and reports the child run URL when the status query fails", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([
        githubFetchRoute(
          ({ url, method }) => method === "GET" && url.endsWith("/actions/runs/23"),
          () => githubResponse("simulated GitHub query failure", 500),
        ),
      ]),
    );

    await expect(waitForChildRun(23, { sleep: async () => {} })).rejects.toThrow(
      /Run status query failed:.*actions\/runs\/23/su,
    );
  });

  it("fails closed on an unsupported child state", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    vi.spyOn(globalThis, "fetch").mockImplementation(
      createGitHubFetchRouter([childRunRoute([{ status: "completed", conclusion: "bewildered" }])]),
    );

    await expect(waitForChildRun(23, { sleep: async () => {} })).rejects.toThrow(
      /unsupported status\/conclusion pair/u,
    );
  });

  it("returns after the wait budget is exhausted so finalization can cancel", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const logs = captureLogs();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(
        createGitHubFetchRouter([childRunRoute([{ status: "in_progress", conclusion: null }])]),
      );
    let ticks = 0;

    await waitForChildRun(23, {
      sleep: async () => {},
      now: () => ticks++ * 10_000,
      timeoutMs: 20_000,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logs.some((line) => /did not complete within \d+ minutes/u.test(line))).toBe(true);
    expect(logs.some((line) => line.includes(CHILD_RUN_URL))).toBe(true);
  });
});

describe("PR E2E evidence download", () => {
  it("downloads evidence into the private destination", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const calls: string[][] = [];

    await downloadChildRunEvidence(23, "/private/work/evidence", {
      run: async (args) => {
        calls.push(args);
        return { code: 0, timedOut: false };
      },
    });

    expect(calls).toEqual([
      ["run", "download", "23", "--repo", "NVIDIA/NemoClaw", "--dir", "/private/work/evidence"],
    ]);
  });

  it("fails when the evidence download exceeds its bounded timeout", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");

    await expect(
      downloadChildRunEvidence(23, "/private/work/evidence", {
        run: async () => ({ code: null, timedOut: true }),
      }),
    ).rejects.toThrow(/exceeded 10 minutes/u);
  });

  it("fails when the evidence download exits non-zero", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");

    await expect(
      downloadChildRunEvidence(23, "/private/work/evidence", {
        run: async () => ({ code: 2, timedOut: false }),
      }),
    ).rejects.toThrow(/exited with status 2/u);
  });
});
