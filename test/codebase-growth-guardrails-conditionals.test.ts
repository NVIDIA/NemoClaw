// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { scanTextForTestConditionals } from "../scripts/find-test-conditionals";

const WORKFLOW_PATH = ".github/workflows/codebase-growth-guardrails.yaml";
const STEP_NAME = "Require changed test files not to add if statements";
const NODE_MARKER = "node <<'NODE'\n";
const NODE_END_MARKER = "\n          NODE";
const ENV = {
  BASE_SHA: "base-sha",
  GH_TOKEN: "test-token",
  HEAD_REPO: "fork/repo",
  HEAD_SHA: "head-sha",
  PR_NUMBER: "123",
  REPO: "NVIDIA/NemoClaw",
};

type MockFile = {
  readonly filename: string;
  readonly previous_filename?: string;
  readonly status?: string;
};

type MockContent = {
  readonly repo?: string;
  readonly ref: string;
  readonly file: string;
  readonly text: string;
};

function extractConditionalsNodeScript(): string {
  const workflow = fs.readFileSync(WORKFLOW_PATH, "utf8");
  const step = workflow.slice(workflow.indexOf(STEP_NAME));
  const nodeStart = step.indexOf(NODE_MARKER) + NODE_MARKER.length;
  return step
    .slice(nodeStart, step.indexOf(NODE_END_MARKER, nodeStart))
    .replaceAll("\n          ", "\n");
}

function extractWorkflowCounterScript(): string {
  const script = extractConditionalsNodeScript();
  const counterStart = script.indexOf("function stripTriviaAndLiterals(text)");
  const counterEnd = script.indexOf("async function countAt", counterStart);
  return script.slice(counterStart, counterEnd);
}

function encodeContent(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

function contentsUrl(content: MockContent): string {
  const repo = content.repo ?? ENV.REPO;
  const encodedPath = content.file.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${encodeURIComponent(content.ref)}`;
}

function pullFilesUrl(): string {
  return `https://api.github.com/repos/${ENV.REPO}/pulls/${ENV.PR_NUMBER}/files?per_page=100&page=1`;
}

function astIfCount(sourceText: string): number {
  return scanTextForTestConditionals("test/virtual-workflow-parity.test.ts", sourceText).length;
}

function workflowIfCount(sourceText: string): number {
  const script = `${extractWorkflowCounterScript()}\nconsole.log(countIfStatements(process.argv[1]));\n`;
  const result = spawnSync(process.execPath, ["-e", script, sourceText], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return Number(result.stdout.trim());
}

function runWorkflowConditionalsGuard(input: {
  readonly files: readonly MockFile[];
  readonly contents: readonly MockContent[];
}): ReturnType<typeof spawnSync> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-growth-conditionals-"));
  const scriptPath = path.join(tmpDir, "guardrail.cjs");
  const responses = new Map<string, unknown>([
    [pullFilesUrl(), input.files],
    ...input.contents.map(
      (content) =>
        [
          contentsUrl(content),
          {
            content: encodeContent(content.text),
            encoding: "base64",
            type: "file",
          },
        ] as const,
    ),
  ]);
  const wrapper = [
    `const responses = new Map(${JSON.stringify([...responses])});`,
    "global.fetch = async (url) => {",
    "  const body = responses.get(String(url));",
    "  return {",
    "    ok: body !== undefined,",
    "    status: body === undefined ? 404 : 200,",
    "    json: async () => body ?? {},",
    "  };",
    "};",
    extractConditionalsNodeScript(),
  ].join("\n");

  fs.writeFileSync(scriptPath, wrapper);
  try {
    return spawnSync(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, ...ENV },
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

describe("codebase growth guardrail test conditionals step", () => {
  it.each([
    {
      name: "comments and strings",
      source: [
        "// if (commented) return;",
        "const text = 'if (string)';",
        "expect(text).toContain('if');",
      ].join("\n"),
    },
    {
      name: "regex literals",
      source: "expect(/if \\(regex\\)/.test('if (regex)')).toBe(true);",
    },
    {
      name: "real branches and else-if chains",
      source: "if (first) run(); else if (second) recover();",
    },
    {
      name: "nested template interpolation",
      source: 'const value = `${`${(() => { if (flag) return "yes"; return "no"; })()}`}`;',
    },
    {
      name: "non-statement property tokens",
      source: "const obj = { if: true }; expect(obj.if).toBe(true); type Shape = { if: boolean };",
    },
  ])("matches local scanner count for $name", ({ source }) => {
    expect(workflowIfCount(source)).toBe(astIfCount(source));
  });

  it("fails a per-file increase even when another changed test removes an if", () => {
    const result = runWorkflowConditionalsGuard({
      files: [{ filename: "test/add.test.ts" }, { filename: "test/remove.test.ts" }],
      contents: [
        { file: "test/add.test.ts", ref: ENV.BASE_SHA, text: "expect(true).toBe(true);" },
        {
          file: "test/add.test.ts",
          repo: ENV.HEAD_REPO,
          ref: ENV.HEAD_SHA,
          text: "if (flag) expect(flag).toBe(true);",
        },
        {
          file: "test/remove.test.ts",
          ref: ENV.BASE_SHA,
          text: "if (flag) expect(flag).toBe(true);",
        },
        {
          file: "test/remove.test.ts",
          repo: ENV.HEAD_REPO,
          ref: ENV.HEAD_SHA,
          text: "expect(true).toBe(true);",
        },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/add.test.ts");
  });

  it("does not count non-statement if property tokens", () => {
    const result = runWorkflowConditionalsGuard({
      files: [{ filename: "test/non-statement.test.ts" }],
      contents: [
        { file: "test/non-statement.test.ts", ref: ENV.BASE_SHA, text: "" },
        {
          file: "test/non-statement.test.ts",
          repo: ENV.HEAD_REPO,
          ref: ENV.HEAD_SHA,
          text: "const obj = { if: true }; expect(obj.if).toBe(true); type Shape = { if: boolean };",
        },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
  });

  it("ignores removed files and files renamed out of test patterns", () => {
    const result = runWorkflowConditionalsGuard({
      files: [
        { filename: "test/removed.test.ts", status: "removed" },
        {
          filename: "src/helper.ts",
          previous_filename: "test/renamed-out.test.ts",
          status: "renamed",
        },
      ],
      contents: [
        {
          file: "test/removed.test.ts",
          ref: ENV.BASE_SHA,
          text: "if (flag) expect(flag).toBe(true);",
        },
        {
          file: "test/renamed-out.test.ts",
          ref: ENV.BASE_SHA,
          text: "if (flag) expect(flag).toBe(true);",
        },
      ],
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("PASS");
  });

  it("counts executable if statements inside template interpolation", () => {
    const result = runWorkflowConditionalsGuard({
      files: [{ filename: "test/template.test.ts" }],
      contents: [
        { file: "test/template.test.ts", ref: ENV.BASE_SHA, text: "" },
        {
          file: "test/template.test.ts",
          repo: ENV.HEAD_REPO,
          ref: ENV.HEAD_SHA,
          text: 'const value = `${(() => { if (flag) return "enabled"; return "disabled"; })()}`;',
        },
      ],
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/template.test.ts");
  });
});
