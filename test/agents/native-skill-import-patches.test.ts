// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.join(import.meta.dirname, "../..");
const DCODE_PATCH = path.join(
  REPO_ROOT,
  "agents/langchain-deepagents-code/patch-native-skill-import.py",
);
const HERMES_PATCH = path.join(REPO_ROOT, "agents/hermes/patch-native-skill-import.py");
const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function runPython(args: string[]) {
  return spawnSync("python3", ["-I", ...args], { encoding: "utf8" });
}

afterEach(() => {
  roots.splice(0).forEach((root) => fs.rmSync(root, { recursive: true, force: true }));
});

describe("agent-native local skill import patches", () => {
  it("adds one idempotent DCode import command at reviewed CLI seams", () => {
    const root = temporaryRoot("nemoclaw-dcode-skill-import-");
    const target = path.join(root, "commands.py");
    fs.writeFileSync(
      target,
      [
        "# fixture",
        "def _info(",
        "    skill_name,",
        "): return None",
        "",
        "def setup(skills_subparsers):",
        "    # Skills info",
        "    return skills_subparsers",
        "",
        "def execute(args):",
        '    if args.skills_command == "create":',
        "        pass",
        '    elif args.skills_command == "info":',
        "        pass",
      ].join("\n") + "\n",
    );

    const first = runPython([DCODE_PATCH, target]);
    expect(first.status, first.stderr).toBe(0);
    const second = runPython([DCODE_PATCH, target]);
    expect(second.status, second.stderr).toBe(0);
    const source = fs.readFileSync(target, "utf8");
    expect(source.match(/NemoClaw native local skill import \(#10210\)/g)).toHaveLength(3);
    expect(source).toContain('skills_subparsers.add_parser(\n        "import"');
    expect(source).toContain('elif args.skills_command == "import"');
    expect(source).toContain('"--expected-digest"');
    expect(source).toContain("observed_digest != expected_digest");
    expect(source).toContain("NEMOCLAW_NATIVE_SKILL_IMPORT=");
    expect(runPython(["-m", "py_compile", target]).status).toBe(0);
  });

  it("adds Hermes import and fail-closed uninstall at reviewed CLI seams", () => {
    const root = temporaryRoot("nemoclaw-hermes-skill-import-");
    const parser = path.join(root, "skills.py");
    const hub = path.join(root, "skills_hub.py");
    fs.writeFileSync(
      parser,
      [
        "def setup(skills_subparsers):",
        "    skills_inspect = skills_subparsers.add_parser(",
        '        "inspect", help="Preview a skill without installing"',
        "    )",
        "    return skills_inspect",
      ].join("\n"),
    );
    fs.writeFileSync(
      hub,
      [
        "from typing import Optional",
        "class Console: pass",
        "",
        "def do_inspect(identifier: str, console: Optional[Console] = None) -> None:",
        "    pass",
        "",
        "def route(action, args):",
        '    if action == "install":',
        "        pass",
        '    elif action == "inspect":',
        "        do_inspect(args.identifier)",
        '    elif action == "uninstall":',
        '        do_uninstall(args.name, skip_confirm=getattr(args, "yes", False))',
      ].join("\n") + "\n",
    );

    const first = runPython([HERMES_PATCH, parser, hub]);
    expect(first.status, first.stderr).toBe(0);
    const second = runPython([HERMES_PATCH, parser, hub]);
    expect(second.status, second.stderr).toBe(0);
    const parserSource = fs.readFileSync(parser, "utf8");
    expect(parserSource).toContain('"import-local"');
    expect(parserSource).toContain('"--expected-digest"');
    const source = fs.readFileSync(hub, "utf8");
    expect(source.match(/NemoClaw native local skill import \(#10210\)/g)).toHaveLength(3);
    expect(source).toContain('elif action == "import-local"');
    expect(source).toContain("observed_digest != expected_digest");
    expect(source).toContain("if not before:");
    expect(source).toContain("NEMOCLAW_NATIVE_SKILL_IMPORT=");
    expect(runPython(["-m", "py_compile", parser, hub]).status).toBe(0);
  });
});
