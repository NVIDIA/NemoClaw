// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, it, vi } from "vitest";

const foreground = (stdout = "", stderr = "") => ({
  kind: "foreground",
  exitCode: 0,
  stdout: { text: stdout },
  stderr: { text: stderr },
});

describe("NemoClaw CI failure triage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not downgrade a retired advisor failure", async () => {
    const toolUrl = new URL(
      "../../.dsh/tools/triage_nemoclaw_ci_failure/index.ts",
      import.meta.url,
    );
    const { default: triageNemoClawCiFailure } = await import(toolUrl.href);
    const bashResults = new Map([
      ["Create temporary CI log directory", foreground("/tmp/ci-log")],
      ["Bound GitHub Actions job log", foreground("120 1")],
    ]);
    const bash = vi.fn(
      async ({ description }: { description: string }) =>
        bashResults.get(description) ?? foreground(),
    );
    vi.stubGlobal("tools", {
      bash,
      project_diagnostic_text: async ({ lines }: { lines: string[] }) => ({
        text: lines.join("\n"),
        sourceTruncated: false,
        lineClipped: false,
        lineCharacterClipped: false,
      }),
      read: async () => ({
        lines: [{ text: "The Nemotron 3 Ultra second-opinion check failed." }],
        totalLines: 1,
      }),
      run_github_cli: async () => ({
        stdout: JSON.stringify({
          id: 7,
          run_id: 11,
          name: "PR review advisor (Nemotron 3 Ultra)",
          status: "completed",
          conclusion: "failure",
          html_url: "https://github.com/NVIDIA/NemoClaw/actions/runs/11/job/7",
        }),
      }),
    });

    const result = await triageNemoClawCiFailure({ workdir: "/tmp", jobId: "7" });

    expect(result.result).toBe("unclassified");
    expect(result.categories).not.toContain("advisor-second-opinion");
    expect(result.nextActions).not.toContain(
      "Treat it as advisory unless the primary advisor or a maintainer identifies a concrete blocker.",
    );
  });
});
