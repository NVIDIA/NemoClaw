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
        "def _delete(",
        "    skill_name,",
        "): return None",
        "",
        "def setup(skills_subparsers):",
        "    delete_parser = skills_subparsers.add_parser(",
        '        "delete",',
        "    )",
        "    # Skills info",
        "    return skills_subparsers",
        "",
        "def execute(args):",
        '    if args.skills_command == "create":',
        "        pass",
        '    elif args.skills_command == "info":',
        "        pass",
        '    elif args.skills_command == "delete":',
        "        _delete(",
        "            args.name,",
        "        )",
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
    expect(source).toContain('elif args.skills_command == "delete"');
    expect(source).toContain('delete_parser = skills_subparsers.add_parser(\n        "delete"');
    expect(source).toContain('"--expected-digest"');
    expect(source).toContain("observed_digest != expected_digest");
    expect(source.match(/_resolve_active_skill\(/g)).toHaveLength(3);
    expect(source).toContain("Cannot reconcile native skill transaction");
    expect(source).toContain('import_prefix = f".{skill_name}.import."');
    expect(source).toContain("os.replace(abandoned_backup, destination)");
    expect(source).toContain("os.replace(destination, failed_install)");
    expect(source).toContain("quarantined failed install retained at");
    expect(source).not.toContain("shutil.rmtree(destination, ignore_errors=True)");
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
        "class Console:",
        "    def __init__(self): self.messages = []",
        '    def print(self, *args, **_kwargs): self.messages.append(" ".join(str(arg) for arg in args))',
        "_console = Console()",
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
    expect(source).toContain("Cannot reconcile native skill transaction");
    expect(source).toContain("os.replace(abandoned_backup, destination)");
    expect(source).toContain("os.replace(destination, failed_install)");
    expect(source).toContain("quarantined failed install retained at");
    expect(source).not.toContain("shutil.rmtree(destination, ignore_errors=True)");
    expect(source).not.toContain(
      "clear_skills_system_prompt_cache(clear_snapshot=True)\n        except",
    );
    expect(source).toContain("if not before:");
    expect(source).toContain("NEMOCLAW_NATIVE_SKILL_IMPORT=");
    expect(runPython(["-m", "py_compile", parser, hub]).status).toBe(0);

    const cacheFailure = runPython([
      "-c",
      [
        "import importlib.util, sys, types",
        "prompt_builder = types.ModuleType('agent.prompt_builder')",
        "def fail_cache_clear(**_kwargs):",
        "    raise RuntimeError('controlled cache invalidation failure')",
        "prompt_builder.clear_skills_system_prompt_cache = fail_cache_clear",
        "agent = types.ModuleType('agent')",
        "agent.prompt_builder = prompt_builder",
        "sys.modules['agent'] = agent",
        "sys.modules['agent.prompt_builder'] = prompt_builder",
        "spec = importlib.util.spec_from_file_location('patched_hermes_skills', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "try:",
        "    module._clear_skills_prompt_cache()",
        "except RuntimeError as exc:",
        "    assert str(exc) == 'controlled cache invalidation failure'",
        "else:",
        "    raise AssertionError('cache invalidation failure was suppressed')",
      ].join("\n"),
      hub,
    ]);
    expect(cacheFailure.status, cacheFailure.stderr).toBe(0);

    const behaviorRoot = path.join(root, "behavior");
    const behavior = runPython([
      "-c",
      [
        "import importlib.util, pathlib, sys",
        "spec = importlib.util.spec_from_file_location('patched_hermes_skills', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "assert module.do_import_local('/unused', '../escaped', '0' * 64) is False",
        "stage = pathlib.Path(sys.argv[2]) / 'reserved-stage'",
        "stage.mkdir(parents=True)",
        '(stage / "SKILL.md").write_text("---\\nname: .hub\\ndescription: reserved\\n---\\n")',
        "module._console.messages.clear()",
        "assert module.do_import_local(str(stage), '.hub', '0' * 64) is False",
        "assert module._console.messages == ['[bold red]Error:[/] Invalid staged skill name.']",
        "assert not (pathlib.Path(sys.argv[2]) / '.hub').exists()",
      ].join("; "),
      hub,
      behaviorRoot,
    ]);
    expect(behavior.status, behavior.stderr).toBe(0);
  });
});
