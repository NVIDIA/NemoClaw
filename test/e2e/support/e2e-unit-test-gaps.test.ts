// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  buildUnitGapReport,
  classifyFailureSignature,
  extractJobSignatures,
  formatUnitGapReport,
  normalizeFailureSignature,
  type E2ERunRecord,
  type RunLogEvidence,
} from "../../../tools/e2e/unit-test-gaps-core.mts";
import {
  classifyGitHubEvidenceReadError,
  collectEvidence,
  failedRunLogArgs,
  listRunsArgs,
  main,
  requireCompleteRunSelection,
  rollingRange,
} from "../../../tools/e2e/unit-test-gaps.mts";

const execFileAsync = promisify(execFile);

function evidence(overrides: Partial<RunLogEvidence> = {}): RunLogEvidence {
  return {
    log: "job\tstep\t2026-08-12T10:00:00.0000000Z AssertionError: expected UPGRADE, received 400\n",
    run: {
      attempt: 1,
      conclusion: "failure",
      createdAt: "2026-08-12T10:00:00Z",
      databaseId: 12345678,
      event: "push",
      headBranch: "main",
      headSha: "1234567890abcdef1234567890abcdef12345678",
      name: "E2E main",
      status: "completed",
      url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
    },
    ...overrides,
  };
}

function failedRun(databaseId: number, attempt = 1): E2ERunRecord {
  return {
    ...evidence().run,
    attempt,
    databaseId,
    url: `https://github.com/NVIDIA/NemoClaw/actions/runs/${String(databaseId)}`,
  };
}

function withTemporaryDirectory<T>(action: (directory: string) => Promise<T>): Promise<T> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-unit-gaps-test-"));
  return action(directory).finally(() => fs.rmSync(directory, { force: true, recursive: true }));
}

async function expectDeferredEvidenceBatches(
  runs: E2ERunRecord[],
  cacheDir: string,
  runGh: Parameters<typeof collectEvidence>[2],
): Promise<void> {
  for (const deferredRuns of [250, 200, 150, 100, 50]) {
    await expect(collectEvidence(runs, cacheDir, runGh)).rejects.toEqual(
      expect.objectContaining({ deferredRuns }),
    );
  }
}

describe("weekly E2E unit-test gap analysis", () => {
  it("redacts volatile identifiers, paths, URLs, sandboxes, and durations", () => {
    const signature = normalizeFailureSignature(
      "Error: sandbox e2e-sbx-a at /home/runner/work/NemoClaw failed after 180000ms for 1234567890abcdef1234567890abcdef12345678 via https://example.test/path?token=secret",
    );

    expect(signature).toBe(
      "Error: sandbox <sandbox> at <path> failed after <duration> for <sha> via <url>",
    );
    expect(signature).not.toContain("secret");
  });

  it("redacts credential-shaped values before writing a cause candidate", () => {
    const signature = normalizeFailureSignature(
      "Error: Authorization: Bearer ghp_EXAMPLE012345678901234 AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE session=eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl",
    );

    expect(signature).toBe(
      "Error: Authorization: Bearer <REDACTED> AWS_ACCESS_KEY_ID=<REDACTED> session=<REDACTED>",
    );
    expect(signature).not.toContain("EXAMPLE");
  });

  it("uses an exact rolling window for --days", () => {
    expect(rollingRange(7, new Date("2026-08-16T19:30:00.000Z"))).toEqual({
      from: "2026-08-09T19:30:00.000Z",
      to: "2026-08-16T19:30:00.000Z",
    });
  });

  it("rejects a run selection that may have reached the collection limit", () => {
    expect(() => requireCompleteRunSelection("e2e.yaml", 999)).not.toThrow();
    expect(() => requireCompleteRunSelection("e2e.yaml", 1000)).toThrow(
      "e2e.yaml reached the 1000-run collection limit, so the selected range may be incomplete. Narrow --since or --days and retry.",
    );
  });

  it("binds workflow and failed-log reads to the canonical repository", () => {
    expect(
      listRunsArgs("e2e.yaml", {
        from: "2026-08-09T20:00:00.000Z",
        to: "2026-08-16T20:00:00.000Z",
      }),
    ).toEqual([
      "run",
      "list",
      "--repo",
      "NVIDIA/NemoClaw",
      "--workflow",
      "e2e.yaml",
      "--branch",
      "main",
      "--event",
      "push",
      "--created",
      "2026-08-09T20:00:00.000Z..2026-08-16T20:00:00.000Z",
      "--limit",
      "1000",
      "--json",
      "attempt,conclusion,createdAt,databaseId,event,headBranch,headSha,name,status,url",
    ]);
    expect(failedRunLogArgs(12345678)).toEqual([
      "run",
      "view",
      "12345678",
      "--repo",
      "NVIDIA/NemoClaw",
      "--log-failed",
    ]);
  });

  it("groups volatile BuildKit references under the missing build-input contract", () => {
    expect(
      normalizeFailureSignature(
        'ERROR: failed to build: failed to solve: failed to compute cache key: failed to calculate checksum of ref 12345678-1234-4234-9234-123456789abc::sztmu18osbm95fj41qvxlgdie: "/tools/mcp-tool-discovery-runtime/reviewed-runtime-bundle/mcp-tool-discovery/mcp-tool-discovery.bundle": not found',
      ),
    ).toBe("ERROR: reviewed runtime bundle is missing from the image build context");
  });

  it("uses the earliest high-specificity causal line and ignores wrappers and echoed shell", () => {
    const signatures = extractJobSignatures(
      [
        "portable-launch\tstep\t2026-08-12T10:00:00.0000000Z ##[error]Process completed with exit code 1.",
        'portable-launch\tstep\t2026-08-12T10:00:00.5000000Z echo "::error::a shell guard failed"',
        "portable-launch\tstep\t2026-08-12T10:00:01.0000000Z Error: Portable Podman readiness failed at service activation",
        "rootless-linux\tstep\t2026-08-12T10:00:02.0000000Z npm error code EAI_AGAIN",
      ].join("\n"),
    );

    expect(signatures).toEqual([
      {
        job: "portable-launch",
        signature: "Error: Portable Podman readiness failed at service activation",
      },
      { job: "rootless-linux", signature: "npm error code EAI_AGAIN" },
    ]);
  });

  it("strips terminal controls after a timestamp and preserves an unprefixed message", () => {
    expect(
      extractJobSignatures(
        [
          "online\tstep\t2026-08-12T10:00:00.0000000Z \u001b[31mError: colored failure\u001b[0m",
          "offline\tstep\tError: offline evidence failed",
        ].join("\n"),
      ),
    ).toEqual([
      { job: "online", signature: "Error: colored failure" },
      { job: "offline", signature: "Error: offline evidence failed" },
    ]);
  });

  it("keeps a failed job in the queue when its causal line needs manual review", () => {
    expect(
      extractJobSignatures(
        "job\tstep\t2026-08-12T10:00:00.0000000Z ##[error]Process completed with exit code 1.\n",
      ),
    ).toEqual([{ job: "job", signature: "Failed job log requires manual causal-line review" }]);
  });

  it.each([
    ["AssertionError: expected UPGRADE, received 400", "deterministic"],
    ["npm error code EAI_AGAIN", "external"],
    ["Error: E2E cleanup failed: gateway unavailable", "harness"],
    ["Error: Local BuildKit build failed", "needs-triage"],
  ] as const)("classifies %s as %s", (signature, classification) => {
    expect(classifyFailureSignature(signature)).toBe(classification);
  });

  it("groups the same normalized cause across runs and keeps the required test action", () => {
    const first = evidence();
    const second = evidence({
      run: {
        ...evidence().run,
        databaseId: 23456789,
        url: "https://github.com/NVIDIA/NemoClaw/actions/runs/23456789",
      },
    });
    const report = buildUnitGapReport(
      [first, second],
      { from: "2026-08-09", to: "2026-08-16" },
      "2026-08-16T20:00:00.000Z",
    );

    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]).toMatchObject({
      classification: "deterministic",
      regressionTest: null,
      reviewStatus: "open",
      runCount: 2,
      runIds: [12345678, 23456789],
    });
    expect(report.groups[0]!.requiredAction).toContain("unit or package-contract regression test");
  });

  it("fails the evidence ledger visibly when a failed log is unavailable", () => {
    const report = buildUnitGapReport(
      [evidence({ error: "too many API requests needed to fetch logs", log: undefined })],
      { from: "2026-08-09", to: "2026-08-16" },
      "2026-08-16T20:00:00.000Z",
    );
    const markdown = formatUnitGapReport(report);

    expect(report.incompleteRuns).toEqual([
      {
        error: "too many API requests needed to fetch logs",
        runId: 12345678,
        url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
      },
    ]);
    expect(markdown).toContain("The report is incomplete.");
  });

  it("keeps a run active at the cutoff from producing a complete ledger", () => {
    const active = evidence({
      log: undefined,
      run: { ...evidence().run, conclusion: "", status: "in_progress" },
    });
    const report = buildUnitGapReport(
      [active],
      { from: "2026-08-09T20:00:00.000Z", to: "2026-08-16T20:00:00.000Z" },
      "2026-08-16T20:00:00.000Z",
    );

    expect(report.incompleteRuns).toEqual([
      {
        error: "run was in_progress at the collection cutoff",
        runId: 12345678,
        url: "https://github.com/NVIDIA/NemoClaw/actions/runs/12345678",
      },
    ]);
  });

  it.each([
    ["HTTP 403: API rate limit exceeded", "rate-limit"],
    ["HTTP 429: secondary rate limit", "rate-limit"],
    ["HTTP 401: Requires authentication", "access"],
    ["HTTP 403: Resource not accessible by integration", "access"],
    ["HTTP 502: upstream failure", null],
  ] as const)("classifies GitHub read failure %s as %s", (message, classification) => {
    expect(
      classifyGitHubEvidenceReadError(Object.assign(new Error(message), { stderr: message })),
    ).toBe(classification);
  });

  it("reuses normalized signatures only for the same run attempt", async () => {
    await withTemporaryDirectory(async (directory) => {
      const cacheDir = path.join(directory, "evidence");
      const run = failedRun(34567890, 2);
      const plans: Array<{ cachedRuns: number; deferredRuns: number; failedLogReads: number }> = [];
      let reads = 0;
      const runGh = async (): Promise<string> => {
        reads += 1;
        return "job\tstep\t2026-08-16T10:00:00Z Error: Authorization: Bearer ghp_EXAMPLE012345678901234\n";
      };

      const first = await collectEvidence([run], cacheDir, runGh, 1, (plan) => plans.push(plan));
      const cacheFile = path.join(cacheDir, "34567890-attempt-2.json");
      const cached = fs.readFileSync(cacheFile, "utf8");
      expect(first[0]!.log).toContain("Authorization: Bearer <REDACTED>");
      expect(first[0]!.log).not.toContain("ghp_EXAMPLE");
      expect(cached).toContain("Authorization: Bearer <REDACTED>");
      expect(cached).not.toContain("ghp_EXAMPLE");
      expect(fs.statSync(cacheDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(cacheFile).mode & 0o777).toBe(0o600);

      const second = await collectEvidence(
        [run],
        cacheDir,
        async () => {
          throw new Error("cached evidence must prevent this GitHub read");
        },
        1,
        (plan) => plans.push(plan),
      );

      expect(second).toEqual(first);
      expect(reads).toBe(1);

      await collectEvidence([failedRun(34567890, 3)], cacheDir, runGh, 1, (plan) =>
        plans.push(plan),
      );
      expect(reads).toBe(2);
      expect(fs.existsSync(path.join(cacheDir, "34567890-attempt-3.json"))).toBe(true);
      expect(plans).toEqual([
        { cachedRuns: 0, deferredRuns: 0, failedLogReads: 1 },
        { cachedRuns: 1, deferredRuns: 0, failedLogReads: 0 },
        { cachedRuns: 0, deferredRuns: 0, failedLogReads: 1 },
      ]);
    });
  });

  it.each([
    ["rate-limit", "HTTP 403: API rate limit exceeded"],
    ["access", "HTTP 403: Resource not accessible by integration"],
  ] as const)("stops new failed-log reads after a GitHub %s failure", async (kind, message) => {
    await withTemporaryDirectory(async (directory) => {
      const runs = [failedRun(45678901), failedRun(45678902), failedRun(45678903)];
      let reads = 0;
      const result = collectEvidence(
        runs,
        path.join(directory, "evidence"),
        async () => {
          reads += 1;
          throw Object.assign(new Error(message), { stderr: message });
        },
        1,
      );

      await expect(result).rejects.toEqual(expect.objectContaining({ kind, runId: 45678901 }));
      expect(reads).toBe(1);
    });
  });

  it("collects 300 failures in 50-log batches and then reuses the cache", async () => {
    await withTemporaryDirectory(async (directory) => {
      const cacheDir = path.join(directory, "evidence");
      const runs = Array.from({ length: 300 }, (_, index) => failedRun(50000000 + index));
      let reads = 0;
      const runGh = async (): Promise<string> => {
        reads += 1;
        return "job\tstep\tError: cached high-volume failure\n";
      };

      await expectDeferredEvidenceBatches(runs, cacheDir, runGh);

      await collectEvidence(runs, cacheDir, runGh);
      expect(reads).toBe(300);
      reads = 0;
      let plan: { cachedRuns: number; deferredRuns: number; failedLogReads: number } | undefined;
      const result = await collectEvidence(runs, cacheDir, runGh, 2, (value) => {
        plan = value;
      });

      expect(result).toHaveLength(300);
      expect(reads).toBe(0);
      expect(plan).toEqual({ cachedRuns: 300, deferredRuns: 0, failedLogReads: 0 });
    });
  }, 30_000);

  it("rejects cached evidence for another run before a GitHub read", async () => {
    await withTemporaryDirectory(async (directory) => {
      const cacheDir = path.join(directory, "evidence");
      fs.mkdirSync(cacheDir, { mode: 0o700 });
      fs.writeFileSync(
        path.join(cacheDir, "56789012-attempt-1.json"),
        '{"attempt":1,"runId":99999999,"signatures":[],"version":1}\n',
        { mode: 0o600 },
      );
      let reads = 0;

      await expect(
        collectEvidence([failedRun(56789012)], cacheDir, async () => {
          reads += 1;
          return "";
        }),
      ).rejects.toThrow("Cached evidence for run 56789012 does not match the run.");
      expect(reads).toBe(0);
    });
  });

  it("rejects a cached job name that can create another log row", async () => {
    await withTemporaryDirectory(async (directory) => {
      const cacheDir = path.join(directory, "evidence");
      fs.mkdirSync(cacheDir, { mode: 0o700 });
      fs.writeFileSync(
        path.join(cacheDir, "56789013-attempt-1.json"),
        '{"attempt":1,"runId":56789013,"signatures":[{"job":"job\\tforged","signature":"Error: failure"}],"version":1}\n',
        { mode: 0o600 },
      );

      await expect(
        collectEvidence([failedRun(56789013)], cacheDir, async () => ""),
      ).rejects.toThrow("Cached evidence for run 56789013 does not match the run.");
    });
  });

  it("rejects cached evidence that is a symbolic link", async () => {
    await withTemporaryDirectory(async (directory) => {
      const cacheDir = path.join(directory, "evidence");
      fs.mkdirSync(cacheDir, { mode: 0o700 });
      const target = path.join(directory, "outside.json");
      fs.writeFileSync(target, '{"attempt":1,"runId":56789014,"signatures":[],"version":1}\n', {
        mode: 0o600,
      });
      fs.symlinkSync(target, path.join(cacheDir, "56789014-attempt-1.json"));
      let reads = 0;

      await expect(
        collectEvidence([failedRun(56789014)], cacheDir, async () => {
          reads += 1;
          return "";
        }),
      ).rejects.toThrow("Cached evidence for run 56789014 is not a bounded regular file.");
      expect(reads).toBe(0);
    });
  });

  it("stops workflow-run listing when GitHub reports a rate limit", async () => {
    await withTemporaryDirectory(async (directory) => {
      const markdownFile = path.join(directory, "report.md");
      const jsonFile = path.join(directory, "report.json");
      let reads = 0;
      const result = main(
        [
          "--days",
          "7",
          "--cache-dir",
          path.join(directory, "evidence"),
          "--output",
          markdownFile,
          "--json-output",
          jsonFile,
        ],
        {
          now: new Date("2026-08-16T20:00:00.000Z"),
          runGh: async () => {
            reads += 1;
            throw Object.assign(new Error("HTTP 403: API rate limit exceeded"), {
              stderr: "HTTP 403: API rate limit exceeded",
            });
          },
        },
      );

      await expect(result).rejects.toEqual(
        expect.objectContaining({ kind: "rate-limit", runId: null }),
      );
      expect(reads).toBe(1);
      expect(fs.existsSync(markdownFile)).toBe(false);
      expect(fs.existsSync(jsonFile)).toBe(false);
    });
  });

  it("runs the npm collector entry point with offline evidence", async () => {
    await withTemporaryDirectory(async (directory) => {
      const logsDir = path.join(directory, "logs");
      const runsFile = path.join(directory, "runs.json");
      const markdownFile = path.join(directory, "report.md");
      const jsonFile = path.join(directory, "report.json");
      fs.mkdirSync(logsDir, { mode: 0o700 });
      fs.writeFileSync(runsFile, `${JSON.stringify([failedRun(67890123)])}\n`, {
        mode: 0o600,
      });
      fs.writeFileSync(
        path.join(logsDir, "67890123.log"),
        "job\tstep\tError: offline entry-point failure\n",
        { mode: 0o600 },
      );

      const { stdout } = await execFileAsync(
        "npm",
        [
          "run",
          "e2e:unit-gaps",
          "--",
          "--runs-file",
          runsFile,
          "--logs-dir",
          logsDir,
          "--output",
          markdownFile,
          "--json-output",
          jsonFile,
        ],
        { cwd: process.cwd(), encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
      );

      expect(stdout).toContain("Wrote 1 cause candidates from 1 runs");
      expect(fs.existsSync(markdownFile)).toBe(true);
      expect(JSON.parse(fs.readFileSync(jsonFile, "utf8"))).toMatchObject({
        incompleteRuns: [],
        runCounts: { failure: 1 },
      });
    });
  }, 90_000);
});
