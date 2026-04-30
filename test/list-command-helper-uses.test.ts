// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "..");
const TSX = path.join(REPO_ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = path.join(REPO_ROOT, "scripts", "list-command-helper-uses.ts");

type HelperMatch = {
  filePath: string;
  line: number;
  column: number;
  kind: "call" | "assign";
  name: string;
  expression: string;
  moduleSpecifier: string | null;
  runnerBound: boolean;
  arg0Kind: string | null;
  commandHead: string | null;
  snippet: string;
};

type CommandSummary = {
  command: string;
  calls: number;
  helpers: string[];
  files: number;
  examples: string[];
};

function makeFixture(prefix: string, files: Record<string, string>): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  for (const [relativePath, content] of Object.entries(files)) {
    const absPath = path.join(rootDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  return rootDir;
}

function runScript(args: string[], cwd = REPO_ROOT): ReturnType<typeof spawnSync> {
  return spawnSync(TSX, [SCRIPT, ...args], {
    cwd,
    encoding: "utf-8",
  });
}

function parseJsonOutput<T>(result: ReturnType<typeof spawnSync>): T {
  expect(result.status).toBe(0);
  return JSON.parse(String(result.stdout));
}

describe("list-command-helper-uses", () => {
  it("finds default-import runner helpers", () => {
    const rootDir = makeFixture("nemoclaw-cmd-helper-", {
      "src/runner.ts": "export default function run(cmd: readonly string[]) { return cmd; }\n",
      "src/app.ts": 'import run from "./runner";\nrun(["podman", "ps"]);\n',
    });

    const matches = parseJsonOutput<HelperMatch[]>(
      runScript(["--root", rootDir, "--json", "--list-calls", path.join(rootDir, "src")]),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].moduleSpecifier).toBe("./runner");
    expect(matches[0].runnerBound).toBe(true);
    expect(matches[0].expression).toBe("run");
    expect(matches[0].commandHead).toBe("podman");
  });

  it('finds identifier calls bound from require("./runner")', () => {
    const rootDir = makeFixture("nemoclaw-cmd-helper-", {
      "src/runner.js": "module.exports = function run(cmd) { return cmd; };\n",
      "src/app.js": 'const run = require("./runner");\nrun(["docker", "ps"]);\n',
    });

    const matches = parseJsonOutput<HelperMatch[]>(
      runScript(["--root", rootDir, "--json", "--list-calls", path.join(rootDir, "src")]),
    );

    expect(matches).toHaveLength(1);
    expect(matches[0].moduleSpecifier).toBe("./runner");
    expect(matches[0].runnerBound).toBe(true);
    expect(matches[0].expression).toBe("run");
    expect(matches[0].commandHead).toBe("docker");
  });

  it("groups by command and excludes tests by default", () => {
    const rootDir = makeFixture("nemoclaw-cmd-helper-", {
      "src/runner.ts": "export default { run(cmd: readonly string[]) { return cmd; } };\n",
      "src/app.ts": 'import runner from "./runner";\nrunner.run(["docker", "ps"]);\n',
      "test/app.test.ts": 'import runner from "../src/runner";\nrunner.run(["git", "status"]);\n',
    });

    const summaries = parseJsonOutput<CommandSummary[]>(
      runScript(["--root", rootDir, "--json", rootDir]),
    );

    expect(summaries.some((summary) => summary.command === "docker")).toBe(true);
    expect(summaries.some((summary) => summary.command === "git")).toBe(false);
  });

  it("can include tests and list raw callsites when requested", () => {
    const rootDir = makeFixture("nemoclaw-cmd-helper-", {
      "src/runner.ts": "export default { run(cmd: readonly string[]) { return cmd; } };\n",
      "src/app.ts": 'import runner from "./runner";\nrunner.run(["docker", "ps"]);\n',
      "test/app.test.ts": 'import runner from "../src/runner";\nrunner.run(["git", "status"]);\n',
    });

    const matches = parseJsonOutput<HelperMatch[]>(
      runScript(["--root", rootDir, "--json", "--include-tests", "--list-calls", rootDir]),
    );

    expect(matches.some((match) => match.commandHead === "docker")).toBe(true);
    expect(matches.some((match) => match.commandHead === "git")).toBe(true);
  });

  it("documents grouped reporting defaults and override flags in help output", () => {
    const result = runScript(["--help"]);
    expect(result.status).toBe(0);
    expect(String(result.stdout)).toContain(
      "excludes test files and groups results by inferred command head",
    );
    expect(String(result.stdout)).toContain("--include-tests");
    expect(String(result.stdout)).toContain("--list-calls");
  });
});
