// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { convertShellCheckJson1 } from "../scripts/shellcheck-json1-to-sarif.mts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HELPER_PATH = join(REPO_ROOT, "scripts", "shellcheck-json1-to-sarif.mts");
const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "nemoclaw-shellcheck-sarif-"));
  tempRoots.push(root);
  return root;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("ShellCheck JSON1 to SARIF conversion", () => {
  it("preserves findings while sorting and de-duplicating rules (#6959)", () => {
    const sarif = convertShellCheckJson1({
      comments: [
        {
          file: "scripts/z-last.sh",
          line: 4,
          endLine: 4,
          column: 7,
          endColumn: 13,
          level: "warning",
          code: 2086,
          message: "Double quote to prevent globbing and word splitting.",
        },
        {
          file: "scripts/a-first.sh",
          line: 1,
          endLine: null,
          column: 1,
          endColumn: null,
          level: "error",
          code: 1090,
          message: "ShellCheck can't follow a non-constant source.",
        },
        {
          file: "scripts/duplicate.sh",
          line: 8,
          column: 3,
          level: "warning",
          code: 2086,
          message: "Double quote this expansion.",
        },
        {
          file: "scripts/style.sh",
          line: 2,
          column: 5,
          level: "style",
          code: 2250,
          message: "Prefer putting braces around variable references.",
        },
      ],
    });

    expect(sarif.version).toBe("2.1.0");
    expect(sarif.$schema).toBe("https://json.schemastore.org/sarif-2.1.0.json");
    expect(sarif.runs).toHaveLength(1);
    const run = sarif.runs[0];
    expect(run.tool.driver).toMatchObject({
      name: "ShellCheck",
      informationUri: "https://www.shellcheck.net/",
    });
    expect(run.tool.driver.rules).toEqual([
      { id: "SC1090", name: "SC1090", shortDescription: { text: "error" } },
      { id: "SC2086", name: "SC2086", shortDescription: { text: "warning" } },
      { id: "SC2250", name: "SC2250", shortDescription: { text: "style" } },
    ]);
    expect(run.results.map((result) => result.level)).toEqual([
      "warning",
      "error",
      "warning",
      "note",
    ]);
    expect(run.results.map((result) => result.ruleId)).toEqual([
      "SC2086",
      "SC1090",
      "SC2086",
      "SC2250",
    ]);
    expect(
      run.results.map((result) => result.locations[0].physicalLocation.artifactLocation.uri),
    ).toEqual([
      "scripts/z-last.sh",
      "scripts/a-first.sh",
      "scripts/duplicate.sh",
      "scripts/style.sh",
    ]);
    expect(run.results[0]?.locations[0].physicalLocation).toEqual({
      artifactLocation: { uri: "scripts/z-last.sh" },
      region: { startLine: 4, startColumn: 7, endLine: 4, endColumn: 13 },
    });
    expect(run.results[1]?.locations[0].physicalLocation.region).toEqual({
      startLine: 1,
      startColumn: 1,
    });
    expect(run.results.map((result) => result.message.text)).toEqual([
      "Double quote to prevent globbing and word splitting.",
      "ShellCheck can't follow a non-constant source.",
      "Double quote this expansion.",
      "Prefer putting braces around variable references.",
    ]);
  });

  it("keeps a valid empty ShellCheck report as one empty SARIF run (#6959)", () => {
    const sarif = convertShellCheckJson1({ comments: [] });

    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver.rules).toEqual([]);
    expect(sarif.runs[0].results).toEqual([]);
  });

  it("rejects structurally invalid ShellCheck reports (#6959)", () => {
    expect(() => convertShellCheckJson1({})).toThrow(
      "ShellCheck json1 input.comments must be an array",
    );
    expect(() => convertShellCheckJson1({ comments: null })).toThrow(
      "ShellCheck json1 input.comments must be an array",
    );
    expect(() =>
      convertShellCheckJson1({
        comments: [
          {
            file: "install.sh",
            line: "10",
            column: 2,
            level: "warning",
            code: 2046,
            message: "Quote this to prevent word splitting.",
          },
        ],
      }),
    ).toThrow("ShellCheck json1 comments[0].line must be an integer");
  });

  it("rejects a source region whose end line precedes its start line (#6959)", () => {
    expect(() =>
      convertShellCheckJson1({
        comments: [
          {
            file: "install.sh",
            line: 10,
            endLine: 9,
            column: 2,
            endColumn: 3,
            level: "warning",
            code: 2046,
            message: "Quote this to prevent word splitting.",
          },
        ],
      }),
    ).toThrow(
      "ShellCheck json1 comments[0].endLine must be greater than or equal to ShellCheck json1 comments[0].line",
    );
  });

  it("rejects a same-line source region whose end column precedes its start column (#6959)", () => {
    expect(() =>
      convertShellCheckJson1({
        comments: [
          {
            file: "install.sh",
            line: 10,
            endLine: 10,
            column: 5,
            endColumn: 4,
            level: "warning",
            code: 2046,
            message: "Quote this to prevent word splitting.",
          },
        ],
      }),
    ).toThrow(
      "ShellCheck json1 comments[0].endColumn must be greater than or equal to ShellCheck json1 comments[0].column for a same-line region",
    );
  });

  it("writes valid JSON through the command-line entrypoint (#6959)", () => {
    const root = makeTempRoot();
    const inputPath = join(root, "shellcheck.json");
    const outputPath = join(root, "shellcheck.sarif");
    writeFileSync(
      inputPath,
      JSON.stringify({
        comments: [
          {
            file: "install.sh",
            line: 10,
            column: 2,
            level: "warning",
            code: 2046,
            message: "Quote this to prevent word splitting.",
          },
        ],
      }),
      "utf-8",
    );

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", HELPER_PATH, inputPath, outputPath],
      { encoding: "utf-8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(readFileSync(outputPath, "utf-8")) as {
      version?: string;
      runs?: unknown[];
    };
    expect(output.version).toBe("2.1.0");
    expect(output.runs).toHaveLength(1);
  });

  it("fails malformed input without writing a SARIF file (#6959)", () => {
    const root = makeTempRoot();
    const inputPath = join(root, "shellcheck.json");
    const outputPath = join(root, "shellcheck.sarif");
    writeFileSync(inputPath, "{ not-json", "utf-8");

    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", HELPER_PATH, inputPath, outputPath],
      { encoding: "utf-8" },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ShellCheck json1 input is not valid JSON");
    expect(existsSync(outputPath)).toBe(false);
  });
});
