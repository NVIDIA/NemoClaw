// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

import { GitHubApiError, githubApi, githubApiWithResponse } from "../../../tools/advisors/github.mts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub API response identity", () => {
  it("returns successful response status and a safe GitHub request ID when requested", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response('{"workflow_run_id":23}', {
          status: 200,
          headers: { "x-github-request-id": "SUCCESS:1234" },
        }),
      ),
    );

    await expect(
      githubApiWithResponse<{ workflow_run_id: number }>(
        "repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/dispatches",
        "token",
      ),
    ).resolves.toEqual({
      data: { workflow_run_id: 23 },
      status: 200,
      requestId: "SUCCESS:1234",
    });
  });

  it("preserves structured HTTP status and a safe GitHub request ID", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("dispatch unavailable", {
          status: 500,
          headers: { "x-github-request-id": "ABCD:1234:EFGH" },
        }),
      ),
    );

    const request = githubApi(
      "repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/dispatches",
      "token",
      {
        method: "POST",
      },
    );

    await expect(request).rejects.toMatchObject({
      name: "GitHubApiError",
      kind: "http",
      method: "POST",
      apiPath: "repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/dispatches",
      status: 500,
      requestId: "ABCD:1234:EFGH",
      responseExcerpt: "dispatch unavailable",
    });
    await expect(request).rejects.toThrow(
      "GitHub API repos/NVIDIA/NemoClaw/actions/workflows/e2e.yaml/dispatches failed: 500 dispatch unavailable",
    );
  });

  it("rejects unsafe request IDs and bounds single-line response diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`first line\n${"x".repeat(600)}`, {
          status: 503,
          headers: { "x-github-request-id": "unsafe request id" },
        }),
      ),
    );

    const error = await githubApi("repos/NVIDIA/NemoClaw/check-runs", "token").catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({
      kind: "http",
      status: 503,
      requestId: undefined,
    });
    expect((error as GitHubApiError).responseExcerpt).toHaveLength(512);
    expect((error as GitHubApiError).responseExcerpt).not.toMatch(/[\r\n\t]/u);
  });

  it("retains response identity when a successful response contains invalid JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("{", {
          status: 200,
          headers: { "x-github-request-id": "DECODE:1234" },
        }),
      ),
    );

    await expect(githubApi("repos/NVIDIA/NemoClaw/pulls/7593", "token")).rejects.toMatchObject({
      name: "GitHubApiError",
      kind: "decode",
      method: "GET",
      status: 200,
      requestId: "DECODE:1234",
      responseExcerpt: "{",
    });
  });

  it("preserves transport failures without inventing an HTTP response", async () => {
    const transportError = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(transportError));

    await expect(githubApi("repos/NVIDIA/NemoClaw/pulls/7593", "token")).rejects.toBe(
      transportError,
    );
  });
});
