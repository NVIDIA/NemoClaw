// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseCliTestTimingHints } from "../../scripts/checks/cli-test-timing-hints.mts";
import {
  findCliTestTimingDrift,
  formatCliTestTimingDriftSummary,
} from "../../scripts/checks/report-cli-test-timing-drift.mts";

const repoRoot = path.resolve("/workspace/repository");

function report(files: Record<string, number>): object {
  return {
    testResults: Object.entries(files).map(([file, duration]) => ({
      name: path.join(repoRoot, file),
      startTime: 1_000,
      endTime: 1_000 + duration,
    })),
  };
}

const hints = {
  schemaVersion: 2,
  defaultDurationMs: 5_000,
  sources: [
    {
      runId: 1,
      artifactId: 1,
      headSha: "0123456789abcdef0123456789abcdef01234567",
      recordedAt: "2026-09-09T00:00:00Z",
    },
  ],
  files: {
    "test/faster.test.ts": 50_000,
    "test/slower.test.ts": 10_000,
    "test/stable.test.ts": 20_000,
  },
};

describe("CLI test timing drift", () => {
  it("finds material slow, fast, and unprofiled files without flagging normal noise", () => {
    expect(
      findCliTestTimingDrift(
        report({
          "test/faster.test.ts": 20_000,
          "test/slower.test.ts": 25_000,
          "test/stable.test.ts": 25_000,
          "test/unprofiled.test.ts": 15_000,
          "test/ordinary.test.ts": 14_999,
        }),
        hints,
        repoRoot,
      ),
    ).toEqual([
      { file: "test/slower.test.ts", hintMs: 10_000, kind: "slower", observedMs: 25_000 },
      { file: "test/faster.test.ts", hintMs: 50_000, kind: "faster", observedMs: 20_000 },
      { file: "test/unprofiled.test.ts", kind: "unprofiled", observedMs: 15_000 },
    ]);
  });

  it("ignores report entries outside the repository and keeps the largest duplicate duration", () => {
    const value = report({ "test/slower.test.ts": 22_000 }) as {
      testResults: Array<{ name: string; startTime: number; endTime: number }>;
    };
    value.testResults.push(
      { name: path.join(repoRoot, "test/slower.test.ts"), startTime: 1_000, endTime: 31_000 },
      { name: "/outside/repository.test.ts", startTime: 1_000, endTime: 101_000 },
    );

    expect(findCliTestTimingDrift(value, hints, repoRoot)).toEqual([
      { file: "test/slower.test.ts", hintMs: 10_000, kind: "slower", observedMs: 30_000 },
    ]);
  });

  it("rejects malformed file results instead of reporting a false normal state", () => {
    const value = report({ "test/stable.test.ts": 20_000 }) as {
      testResults: unknown[];
    };
    value.testResults.push({ name: "test/malformed.test.ts", startTime: 1_000 });

    expect(() => findCliTestTimingDrift(value, hints, repoRoot)).toThrow(
      /Invalid Vitest timing report entry at index 1/u,
    );
  });

  it("renders a concise advisory summary", () => {
    const summary = formatCliTestTimingDriftSummary([
      { file: "test/new.test.ts", kind: "unprofiled", observedMs: 16_000 },
    ]);

    expect(summary).toContain("1 file(s) need a timing-hint refresh");
    expect(summary).toContain("`test/new.test.ts`");
    expect(summary).toContain("16.0s");
    expect(formatCliTestTimingDriftSummary([])).toContain("No material timing-hint drift");
  });

  it.each([
    { name: "schema version", value: { ...hints, schemaVersion: 1 } },
    { name: "source metadata", value: { ...hints, sources: [] } },
  ])("rejects invalid $name through the shared parser and reporter", ({ value }) => {
    expect(() => parseCliTestTimingHints(value)).toThrow(/schemaVersion 2|source metadata/u);
    expect(() => findCliTestTimingDrift(report({}), value, repoRoot)).toThrow(
      /schemaVersion 2|source metadata/u,
    );
  });
});
