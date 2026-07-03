// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");

describe("LangChain Deep Agents Code direct module patch", () => {
  it("patches direct module execution back to NemoClaw managed posture", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patch-"));
    const packageDir = path.join(tempDir, "deepagents_code");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(path.join(packageDir, "__init__.py"), "", "utf8");
    fs.writeFileSync(
      path.join(packageDir, "main.py"),
      [
        "import os",
        "from types import SimpleNamespace",
        "",
        "class Parser:",
        "    def __init__(self):",
        "        self.args = SimpleNamespace(",
        "            command=None, tools_command=None, sandbox='docker',",
        "            sandbox_id='sandbox-id', sandbox_snapshot_name='snapshot',",
        "            sandbox_setup='setup.sh', mcp_config='mcp.json',",
        "            no_mcp=False, trust_project_mcp=True, shell_allow_list=['bash'],",
        "        )",
        "    def parse_args(self): return self.args",
        "    def error(self, message): raise RuntimeError(message)",
        "parser = Parser()",
        "def parse_args():",
        "    args = parser.parse_args()",
        "    return args",
        "",
      ].join("\n"),
      "utf8",
    );

    execFileSync("python3", [path.join(agentDir, "patch-managed-deepagents-code.py")], {
      env: { ...process.env, PYTHONPATH: tempDir },
    });

    const patched = fs.readFileSync(path.join(packageDir, "main.py"), "utf8");
    for (const expected of [
      'args.sandbox = "none"',
      "args.no_mcp = True",
      "args.mcp_config = None",
      "args.shell_allow_list = None",
      'os.environ["DEEPAGENTS_CODE_LANGSMITH_TRACING"] = "false"',
      'os.environ["LANGSMITH_TRACING"] = "false"',
      'os.environ["DEEPAGENTS_CODE_OFFLINE"] = "1"',
      'os.environ["DEEPAGENTS_CODE_RIPGREP_INSTALLER"] = "system"',
      'os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)',
      'blocked_command = getattr(args, "command", None)',
      'blocked_command in {"auth", "install", "update"}',
    ]) {
      expect(patched).toContain(expected);
    }
    expect(patched).not.toContain("NEMOCLAW_DEEPAGENTS_CODE_SHELL_ALLOW_LIST");

    const output = execFileSync(
      "python3",
      [
        "-c",
        [
          "import os",
          "import deepagents_code.main as main",
          "os.environ['DEEPAGENTS_CODE_SHELL_ALLOW_LIST'] = 'bash'",
          "args = main.parse_args()",
          "assert args.sandbox == 'none', args.sandbox",
          "assert args.sandbox_id is None, args.sandbox_id",
          "assert args.sandbox_snapshot_name is None, args.sandbox_snapshot_name",
          "assert args.sandbox_setup is None, args.sandbox_setup",
          "assert args.mcp_config is None, args.mcp_config",
          "assert args.no_mcp is True, args.no_mcp",
          "assert args.trust_project_mcp is False, args.trust_project_mcp",
          "assert args.shell_allow_list is None, args.shell_allow_list",
          "assert 'DEEPAGENTS_CODE_SHELL_ALLOW_LIST' not in os.environ",
          "assert os.environ['DEEPAGENTS_CODE_AUTO_UPDATE'] == '0'",
          "assert os.environ['DEEPAGENTS_CODE_NO_UPDATE_CHECK'] == '1'",
          "assert os.environ['DEEPAGENTS_CODE_LANGSMITH_TRACING'] == 'false'",
          "assert os.environ['LANGSMITH_TRACING'] == 'false'",
          "assert os.environ['DEEPAGENTS_CODE_OFFLINE'] == '1'",
          "assert os.environ['DEEPAGENTS_CODE_RIPGREP_INSTALLER'] == 'system'",
          "for cmd, msg in [('mcp','MCP'),('update','update'),('auth','auth'),('install','install')]:",
          "    main.parser.args.command = cmd",
          "    try: main.parse_args()",
          "    except RuntimeError as exc: assert f'{msg} commands are disabled' in str(exc), exc",
          "    else: raise AssertionError(f'{cmd} command did not fail')",
          "main.parser.args.command = 'tools'",
          "main.parser.args.tools_command = 'install'",
          "try: main.parse_args()",
          "except RuntimeError as exc: assert 'tools install is disabled' in str(exc), exc",
          "else: raise AssertionError('tools install command did not fail')",
          "for tc in ('list', None):",
          "    main.parser.args.command = 'tools'",
          "    main.parser.args.tools_command = tc",
          "    main.parse_args()",
          "print('managed-posture-ok')",
        ].join("\n"),
      ],
      { env: { ...process.env, PYTHONPATH: tempDir }, encoding: "utf8" },
    );
    expect(output).toContain("managed-posture-ok");
  });
});
