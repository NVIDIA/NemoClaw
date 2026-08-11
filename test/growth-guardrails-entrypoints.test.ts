// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const ENTRYPOINT_ENV = {
  BASE_SHA: "base",
  GH_TOKEN: "token",
  HEAD_REPO: "fork/repo",
  HEAD_SHA: "head",
  PR_NUMBER: "1",
  REPO: "NVIDIA/NemoClaw",
} as const;
const CLEAN_TEST_BUDGET = '{"defaultMaxLines":1500,"legacyMaxLines":{}}';

const FETCH_PRELOAD = `
const responses = JSON.parse(process.env.MOCK_RESPONSES ?? "[]");
globalThis.fetch = async () => new Response(JSON.stringify(responses.shift()), {
  status: 200,
  headers: { "content-type": "application/json" },
});
`;

function blobPayload(text: string | null): unknown {
  return {
    data: {
      repository: {
        f0:
          text === null ? null : { __typename: "Blob", text, isBinary: false, isTruncated: false },
      },
    },
  };
}

function runEntrypoint(responses: readonly unknown[]): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(join(tmpdir(), "growth-guardrail-entrypoint-"));
  const preload = join(directory, "fetch-preload.mjs");
  writeFileSync(preload, FETCH_PRELOAD);
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(preload).href,
      resolve(REPO_ROOT, "tools/growth-guardrails/check-pr.mts"),
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        ...ENTRYPOINT_ENV,
        MOCK_RESPONSES: JSON.stringify(responses),
      },
    },
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

describe("codebase growth trusted assertion", () => {
  it("prints the consolidated PASS diagnostic", () => {
    const result = runEntrypoint([[], blobPayload(CLEAN_TEST_BUDGET)]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS: this PR preserves the codebase growth policies.");
  });

  it("prints an increased test-file if-statement count in the consolidated failure", () => {
    const baseSource = "it('a', () => { expect(1).toBe(1); });";
    const headSource = "it('a', () => { if (condition) expect(1).toBe(1); });";
    const result = runEntrypoint([
      [{ filename: "test/a.test.ts", status: "modified", additions: 1, deletions: 0 }],
      blobPayload(CLEAN_TEST_BUDGET),
      blobPayload(headSource),
      blobPayload(baseSource),
      blobPayload(headSource),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL: codebase growth policies rejected this PR.");
    expect(result.stderr).toContain("test/a.test.ts: 1 if statement(s), up from 0");
  });

  it("reports an increased default test-file line budget in the consolidated failure", () => {
    const result = runEntrypoint([
      [{ filename: "ci/test-file-size-budget.json", status: "added", additions: 1, deletions: 0 }],
      blobPayload(null),
      blobPayload('{"defaultMaxLines":2000,"legacyMaxLines":{}}'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("defaultMaxLines increased from 1500 to 2000");
  });

  it.each([
    "js",
    "cjs",
    "mjs",
    "jsx",
  ])("prints a new .%s JavaScript file in the consolidated failure", (extension) => {
    const filename = `scripts/new.${extension}`;
    const result = runEntrypoint([
      [{ filename, status: "added", additions: 1, deletions: 0 }],
      blobPayload(CLEAN_TEST_BUDGET),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${filename}: new JavaScript files must use TypeScript`);
  });

  it("prints net growth in the onboarding entry point in the consolidated failure", () => {
    const result = runEntrypoint([
      [
        {
          filename: "src/lib/onboard.ts",
          status: "modified",
          additions: 3,
          deletions: 1,
        },
      ],
      blobPayload(CLEAN_TEST_BUDGET),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/lib/onboard.ts: grew by 2 line(s) (+3/-1)");
  });
});
