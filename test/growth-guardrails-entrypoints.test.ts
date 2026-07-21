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

function runEntrypoint(
  relativeToolPath: string,
  responses: readonly unknown[],
): ReturnType<typeof spawnSync> {
  const directory = mkdtempSync(join(tmpdir(), "growth-guardrail-entrypoint-"));
  const preload = join(directory, "fetch-preload.mjs");
  writeFileSync(preload, FETCH_PRELOAD);
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--import",
      pathToFileURL(preload).href,
      resolve(REPO_ROOT, relativeToolPath),
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

describe("growth-guardrails executable entrypoints (#6953)", () => {
  it("prints the conditional guardrail PASS diagnostic", () => {
    const result = runEntrypoint("tools/growth-guardrails/test-conditionals.mts", [[]]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "PASS: changed test files did not add if statements (0 at PR head vs 0 at base).",
    );
  });

  it("prints the conditional guardrail FAIL heading and file detail", () => {
    const result = runEntrypoint("tools/growth-guardrails/test-conditionals.mts", [
      [{ filename: "test/a.test.ts", status: "modified" }],
      blobPayload("it('a', () => { expect(1).toBe(1); });"),
      blobPayload("it('a', () => { if (condition) expect(1).toBe(1); });"),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL: changed test files add if statements.");
    expect(result.stderr).toContain("test/a.test.ts: 1 if statement(s), up from 0");
  });

  it("prints the size-budget guardrail PASS diagnostic", () => {
    const result = runEntrypoint("tools/growth-guardrails/test-size-budget.mts", [
      [],
      blobPayload(null),
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "PASS: test size budget policy is monotonic and 0 changed test file(s) are within budget.",
    );
  });

  it("prints the size-budget guardrail FAIL heading and budget detail", () => {
    const result = runEntrypoint("tools/growth-guardrails/test-size-budget.mts", [
      [{ filename: "ci/test-file-size-budget.json", status: "added" }],
      blobPayload(null),
      blobPayload('{"defaultMaxLines":2000,"legacyMaxLines":{}}'),
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("FAIL: test size budget policy would be weakened or exceeded.");
    expect(result.stderr).toContain("defaultMaxLines increased from 1500 to 2000");
  });
});
