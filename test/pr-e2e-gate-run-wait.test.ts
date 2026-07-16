// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadChildRunEvidence, waitForChildRun } from "../tools/e2e/pr-e2e-gate.mts";
import { createGitHubFetchRouter, githubFetchRoute } from "./support/github-fetch-router.ts";

type DownloadEvidenceDeps = NonNullable<Parameters<typeof downloadChildRunEvidence>[2]>;
type EvidenceSpawnFn = NonNullable<DownloadEvidenceDeps["spawn"]>;

class FakeEvidenceChild extends EventEmitter {
  kill = vi.fn((_signal?: NodeJS.Signals | number) => true);
}

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
          { status: "queued", conclusion: null },
          { status: "in_progress", conclusion: null },
          { status: "in_progress", conclusion: null },
          { status: "completed", conclusion: "success" },
        ]),
      ]),
    );

    await waitForChildRun(23, { sleep: async () => {} });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(logs).toEqual([
      `Run 23 status=queued url=${CHILD_RUN_URL}`,
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

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(logs).toEqual([
      `Run 23 status=in_progress url=${CHILD_RUN_URL}`,
      `Run 23 did not complete within 0 minutes; finalization will cancel it and report the PR gate outcome. ${CHILD_RUN_URL}`,
    ]);
  });
});

describe("PR E2E evidence download", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("downloads evidence into the private destination", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const child = new FakeEvidenceChild();
    const spawnCalls: {
      command: string;
      args: readonly string[];
      options: Record<string, unknown>;
    }[] = [];
    const spawnMock: EvidenceSpawnFn = (command, args, options) => {
      spawnCalls.push({ command, args, options: options as Record<string, unknown> });
      return child;
    };

    const promise = downloadChildRunEvidence(23, "/private/work/evidence", { spawn: spawnMock });
    child.emit("close", 0);
    await promise;

    expect(spawnCalls).toEqual([
      {
        command: "gh",
        args: [
          "run",
          "download",
          "23",
          "--repo",
          "NVIDIA/NemoClaw",
          "--dir",
          "/private/work/evidence",
        ],
        options: expect.objectContaining({ stdio: "inherit" }),
      },
    ]);
  });

  it("sends SIGTERM then escalates to SIGKILL when the download exceeds its bounded timeout", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const child = new FakeEvidenceChild();

    const assertion = expect(
      downloadChildRunEvidence(23, "/private/work/evidence", { spawn: () => child }),
    ).rejects.toThrow(/exceeded 10 minutes/u);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(30_000);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.kill).toHaveBeenLastCalledWith("SIGKILL");

    child.emit("close", null);
    await assertion;
  });

  it("fails when the evidence download exits non-zero, and clears the timeout timer on close", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const child = new FakeEvidenceChild();

    const assertion = expect(
      downloadChildRunEvidence(23, "/private/work/evidence", { spawn: () => child }),
    ).rejects.toThrow(/exited with status 2/u);
    child.emit("close", 2);
    await assertion;

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("propagates a spawn error", async () => {
    vi.stubEnv("GITHUB_TOKEN", "token");
    vi.stubEnv("GITHUB_REPOSITORY", "NVIDIA/NemoClaw");
    const child = new FakeEvidenceChild();
    const spawnError = new Error("spawn gh ENOENT");

    const assertion = expect(
      downloadChildRunEvidence(23, "/private/work/evidence", { spawn: () => child }),
    ).rejects.toThrow(spawnError);
    child.emit("error", spawnError);
    await assertion;
  });
});
