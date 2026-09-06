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
        "from pathlib import Path",
        "def _validate_name(_name): return True, None",
        "def _validate_skill_path(_destination, _root): return True, None",
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
    expect(source).toContain("native skill import staging requires inspection");
    expect(source).not.toContain("for abandoned_import in abandoned_imports");
    expect(source).toContain("os.replace(abandoned_backup, destination)");
    expect(source).toContain("os.replace(destination, failed_install)");
    expect(source).toContain("quarantined failed install retained at");
    expect(source).toContain("native skill import staging cleanup");
    expect(source).not.toContain("shutil.rmtree(transaction_root, ignore_errors=True)");
    expect(source).not.toContain("shutil.rmtree(destination, ignore_errors=True)");
    expect(source).toContain("NEMOCLAW_NATIVE_SKILL_IMPORT=");
    expect(runPython(["-m", "py_compile", target]).status).toBe(0);

    const behaviorRoot = path.join(root, "behavior");
    const stagedSkill = path.join(behaviorRoot, "stage");
    fs.mkdirSync(stagedSkill, { recursive: true });
    fs.writeFileSync(
      path.join(stagedSkill, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Digest rejection fixture.\n---\n# Demo\n",
    );
    const forgedDigest = runPython([
      "-c",
      [
        "import importlib.util, pathlib, sys, types",
        "root = pathlib.Path(sys.argv[2])",
        "skills_root = root / 'skills'",
        "skills_root.mkdir(parents=True)",
        "class Console:",
        "    def __init__(self): self.messages = []",
        "    def print(self, message): self.messages.append(str(message))",
        "console = Console()",
        "class Settings:",
        "    @classmethod",
        "    def from_environment(cls): return cls()",
        "    def ensure_user_skills_dir(self, _agent): return skills_root",
        "    def get_built_in_skills_dir(self): return root / 'builtin'",
        "    def get_user_skills_dir(self, _agent): return skills_root",
        "    def get_project_skills_dir(self): return root / 'project'",
        "    def get_user_agent_skills_dir(self): return root / 'user-agent'",
        "    def get_project_agent_skills_dir(self): return root / 'project-agent'",
        "package = types.ModuleType('deepagents_code')",
        "package.__path__ = []",
        "config = types.ModuleType('deepagents_code.config')",
        "config.Settings = Settings",
        "config.console = console",
        "skills = types.ModuleType('deepagents_code.skills')",
        "skills.__path__ = []",
        "loader = types.ModuleType('deepagents_code.skills.load')",
        "loader.list_skills = lambda **_kwargs: []",
        "sys.modules.update({'deepagents_code': package, 'deepagents_code.config': config, 'deepagents_code.skills': skills, 'deepagents_code.skills.load': loader})",
        "spec = importlib.util.spec_from_file_location('patched_dcode_skills', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "args = types.SimpleNamespace(skills_command='import', path=sys.argv[3], name='demo-skill', expected_digest='0' * 64, agent='agent', replace=False)",
        "try:",
        "    module.execute(args)",
        "except SystemExit as exc:",
        "    assert exc.code == 1",
        "else:",
        "    raise AssertionError('forged digest was accepted')",
        "assert any('digest changed before native publication' in message for message in console.messages)",
        "assert not (skills_root / 'demo-skill').exists()",
        "assert not list(skills_root.glob('.demo-skill.*'))",
      ].join("\n"),
      target,
      behaviorRoot,
      stagedSkill,
    ]);
    expect(forgedDigest.status, forgedDigest.stderr).toBe(0);
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
        "from pathlib import Path",
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
    const originalHubSource = fs.readFileSync(hub, "utf8");

    const first = runPython([HERMES_PATCH, parser, hub]);
    expect(first.status, first.stderr).toBe(0);
    fs.writeFileSync(hub, originalHubSource);
    const resumed = runPython([HERMES_PATCH, parser, hub]);
    expect(resumed.status, resumed.stderr).toBe(0);
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
    expect(source).toContain("cleanup_native_quarantine");
    expect(source).not.toContain("shutil.rmtree(quarantine, ignore_errors=True)");
    expect(source).toContain("Skills prompt cache requires inspection");
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

    const stagedSkill = path.join(behaviorRoot, "forged-stage");
    fs.mkdirSync(stagedSkill, { recursive: true });
    fs.writeFileSync(
      path.join(stagedSkill, "SKILL.md"),
      "---\nname: demo-skill\ndescription: Digest rejection fixture.\n---\n# Demo\n",
    );
    const forgedDigest = runPython([
      "-c",
      [
        "import importlib.util, pathlib, sys, types",
        "root = pathlib.Path(sys.argv[2])",
        "skills_root = root / 'skills'",
        "skills_root.mkdir(parents=True, exist_ok=True)",
        "agent = types.ModuleType('agent')",
        "agent.__path__ = []",
        "skill_utils = types.ModuleType('agent.skill_utils')",
        "skill_utils.is_external_skill_path = lambda _path: False",
        "tools = types.ModuleType('tools')",
        "tools.__path__ = []",
        "guard = types.ModuleType('tools.skills_guard')",
        "guard.format_scan_report = lambda _scan: ''",
        "guard.scan_skill_cached = lambda *_args, **_kwargs: (object(), object())",
        "guard.should_allow_install = lambda _scan, force=False: (True, '')",
        "hub = types.ModuleType('tools.skills_hub')",
        "hub.SKILLS_DIR = str(skills_root)",
        "hub.HubLockFile = type('HubLockFile', (), {})",
        "hub.SkillBundle = type('SkillBundle', (), {})",
        "hub.install_from_quarantine = lambda *_args, **_kwargs: skills_root / 'demo-skill'",
        "hub.quarantine_bundle = lambda *_args, **_kwargs: None",
        "skill_tool = types.ModuleType('tools.skills_tool')",
        "skill_tool.skill_view = lambda *_args, **_kwargs: '{}'",
        "sys.modules.update({'agent': agent, 'agent.skill_utils': skill_utils, 'tools': tools, 'tools.skills_guard': guard, 'tools.skills_hub': hub, 'tools.skills_tool': skill_tool})",
        "spec = importlib.util.spec_from_file_location('patched_hermes_skills', sys.argv[1])",
        "module = importlib.util.module_from_spec(spec)",
        "spec.loader.exec_module(module)",
        "args = types.SimpleNamespace(path=sys.argv[3], name='demo-skill', expected_digest='0' * 64)",
        "try:",
        "    module.route('import-local', args)",
        "except SystemExit as exc:",
        "    assert exc.code == 1",
        "else:",
        "    raise AssertionError('forged digest was accepted')",
        "assert any('digest changed before native publication' in message for message in module._console.messages)",
        "assert not (skills_root / 'demo-skill').exists()",
      ].join("\n"),
      hub,
      behaviorRoot,
      stagedSkill,
    ]);
    expect(forgedDigest.status, forgedDigest.stderr).toBe(0);
  });
});
