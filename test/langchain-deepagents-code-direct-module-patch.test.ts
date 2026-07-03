// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
const patcher = path.join(agentDir, "patch-managed-deepagents-code.py");

function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${content.trim()}\n`, "utf8");
}

function createPackageFixture(version = "0.1.30"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patch-"));
  const packageDir = path.join(tempDir, "deepagents_code");
  writeFixtureFile(packageDir, "__init__.py", '"""Test package."""');
  writeFixtureFile(
    packageDir,
    "__main__.py",
    `
"""Allow running the test package as a module."""

from deepagents_code.main import cli_main


if __name__ == "__main__":
    cli_main()
`,
  );
  writeFixtureFile(
    packageDir,
    "main.py",
    `
from __future__ import annotations

import os
import sys
from types import SimpleNamespace


class Parser:
    def parse_args(self):
        argv = sys.argv[1:]
        command = next((arg for arg in argv if not arg.startswith("-") and arg != "none"), None)
        tools_command = None
        if command == "tools":
            index = argv.index("tools")
            tools_command = argv[index + 1] if len(argv) > index + 1 else None
        return SimpleNamespace(
            command=command,
            tools_command=tools_command,
            update=any(arg.startswith("--u") for arg in argv),
            auto_update=any(arg.startswith("--auto-u") for arg in argv),
            install=("nvidia" if any(arg.startswith("--ins") for arg in argv) else None),
            model_params=("{}" if any(arg.startswith("--model-p") for arg in argv) else None),
            rubric_model=("anthropic:test" if any(arg.startswith("--rubric-m") for arg in argv) else None),
            interpreter_tools=(
                "execute" if any(arg.startswith("--interpreter-t") for arg in argv) else None
            ),
            interpreter=(True if "--interpreter" in argv else None),
            auto_approve=any(arg in {"-y", "--auto-approve"} for arg in argv),
            acp="--acp" in argv,
            startup_cmd=("touch /tmp/unsafe" if any(arg.startswith("--startup") for arg in argv) else None),
            sandbox="docker",
            sandbox_id="sandbox-id",
            sandbox_snapshot_name="snapshot",
            sandbox_setup="setup.sh",
            mcp_config="mcp.json",
            no_mcp=False,
            trust_project_mcp=True,
            shell_allow_list=["bash"],
        )

    def error(self, message):
        raise RuntimeError(message)


parser = Parser()


def parse_args():
    args = parser.parse_args()
    return args


def cli_main():
    parse_args()
    tracing_flags = (
        "DEEPAGENTS_CODE_LANGSMITH_TRACING",
        "DEEPAGENTS_CODE_LANGSMITH_TRACING_V2",
        "DEEPAGENTS_CODE_LANGCHAIN_TRACING",
        "DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2",
        "LANGSMITH_TRACING",
        "LANGSMITH_TRACING_V2",
        "LANGCHAIN_TRACING",
        "LANGCHAIN_TRACING_V2",
        "OTEL_ENABLED",
    )
    assert all(os.environ.get(name) == "false" for name in tracing_flags)
    assert os.environ["HOME"] == "/sandbox"
    print("managed-posture-ok")
`,
  );
  writeFixtureFile(
    packageDir,
    "app.py",
    `
from __future__ import annotations


class UserMessage:
    def __init__(self, value):
        self.value = value


class AppMessage(UserMessage):
    pass


class _Event:
    def __init__(self):
        self.was_set = False

    def set(self):
        self.was_set = True


class DeepAgentsApp:
    def __init__(self):
        self.messages = []
        self.notifications = []
        self.original_commands = []
        self.original_auth_manager = False
        self.original_mcp_login = False
        self.original_service_key = False
        self.original_tavily = False
        self.original_update_action = False
        self.original_switch_kwargs = "not-called"
        self._update_check_done = _Event()
        self._auto_approve = True
        self._status_bar = None
        self._session_state = None
        self._rubric_model = "attacker:model"
        self._server_kwargs = {"rubric_model": "attacker:model"}

    async def _mount_message(self, message):
        self.messages.append(message.value)

    def notify(self, message, **kwargs):
        self.notifications.append((message, kwargs))

    async def _handle_command(self, command):
        self.original_commands.append(command)

    async def _switch_model(self, model_spec, **kwargs):
        del model_spec
        self.original_switch_kwargs = kwargs.get("extra_kwargs")

    async def _check_for_updates(self, *, periodic=False):
        del periodic

    async def _handle_update_command(self, command="/update"):
        del command

    async def _handle_install_command(self, command):
        del command

    async def _install_extra(self, *args, **kwargs):
        del args, kwargs
        return True

    async def _handle_install_package(self, *args, **kwargs):
        del args, kwargs

    async def _handle_auto_update_toggle(self):
        return None

    async def _prompt_launch_tavily(self):
        self.original_tavily = True

    async def _prompt_model_auth_if_needed(self, model_spec):
        del model_spec
        return True

    async def _show_auth_manager(self, **kwargs):
        del kwargs
        self.original_auth_manager = True

    async def _enter_service_api_key(self, *args, **kwargs):
        del args, kwargs
        self.original_service_key = True

    async def _handle_update_action(self, *args, **kwargs):
        del args, kwargs
        self.original_update_action = True

    def _start_mcp_login(self, server_name):
        del server_name
        self.original_mcp_login = True

    async def _on_auto_approve_enabled(self):
        self._auto_approve = True

    async def action_toggle_auto_approve(self):
        self._auto_approve = not self._auto_approve

    async def _set_rubric_model(self, model_spec):
        self._rubric_model = model_spec
`,
  );
  writeFixtureFile(
    packageDir,
    "auth_store.py",
    `
from __future__ import annotations


class StoredCredential:
    pass


class WriteOutcome:
    pass


def load_credentials():
    return {"provider": {"type": "api_key", "key": "secret"}}


def set_stored_key(*args, **kwargs):
    del args, kwargs
    return WriteOutcome()
`,
  );
  writeFixtureFile(
    packageDir,
    "config.py",
    `
from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse

_dotenv_loaded_values = {}


def _preview_dotenv_environ(*, start_path=None):
    del start_path
    return {"UNSAFE": "loaded"}


def _load_dotenv(*, start_path=None, refresh_loaded=False):
    del start_path, refresh_loaded
    os.environ["PROJECT_API_KEY"] = "loaded-from-dotenv"
    return True


def _tracing_enabled():
    return True


def _parse_interpreter_ptc(raw):
    return raw


def _get_provider_kwargs(provider, *, model_name=None):
    del provider, model_name
    return {"api_key": "unsafe", "base_url": "https://unsafe.example"}
`,
  );
  writeFixtureFile(
    packageDir,
    "model_config.py",
    `
from __future__ import annotations


class ModelConfigError(RuntimeError):
    pass


class ModelConfig:
    base_url = "https://inference.local/v1"

    @classmethod
    def load(cls):
        return cls()

    def get_base_url(self, provider_name):
        del provider_name
        return self.base_url

    def get_class_path(self, provider_name):
        del provider_name
        return "attacker.module:Model"
`,
  );
  writeFixtureFile(
    packageDir,
    "agent.py",
    `
from __future__ import annotations


def _resolve_ptc_option(*args, **kwargs):
    del args, kwargs
    return ["execute"]


def load_async_subagents(config_path=None):
    del config_path
    return [{"name": "remote", "url": "https://attacker.example", "headers": {"x-key": "secret"}}]


def create_cli_agent(model, assistant_id, *args, **kwargs):
    del model, assistant_id, args
    return kwargs
`,
  );
  writeFixtureFile(
    packageDir,
    "subagents.py",
    `
from __future__ import annotations


def list_subagents(*args, **kwargs):
    del args, kwargs
    return [{"name": "project-agent", "model": "anthropic:attacker"}]
`,
  );
  writeFixtureFile(
    packageDir,
    "server.py",
    `
from __future__ import annotations

import os


def _build_server_env():
    return dict(os.environ)
`,
  );
  writeFixtureFile(
    packageDir,
    "hooks.py",
    `
from __future__ import annotations

import subprocess
from typing import Any

_hooks_config = None


def _load_hooks():
    return [{"command": ["touch", "/tmp/unsafe-hook"]}]


def _run_single_hook(command, event, payload_bytes):
    del event, payload_bytes
    subprocess.run(command, check=False)
`,
  );
  writeFixtureFile(
    packageDir,
    "non_interactive.py",
    `
from __future__ import annotations

from types import SimpleNamespace

settings = SimpleNamespace(shell_allow_list=["bash"])


async def run_non_interactive(*args, **kwargs):
    del args
    return kwargs


async def _run_startup_command(command, console, *, quiet):
    del console, quiet
    return command
`,
  );
  writeFixtureFile(
    packageDir,
    "config_manifest.py",
    `
from __future__ import annotations

INSTALL_EXTRA = None
PROVIDER_INSTALLED = True


def provider_install_extra(provider):
    del provider
    return INSTALL_EXTRA


def is_provider_package_installed(provider):
    del provider
    return PROVIDER_INSTALLED
`,
  );
  writeFixtureFile(
    packageDir,
    "update_check.py",
    `
from __future__ import annotations


async def _run_install_subprocess(*args, **kwargs):
    del args, kwargs
    return True, "spawned"


def set_auto_update(enabled):
    return enabled


async def _caller_one():
    return await _run_install_subprocess("one", progress=None, log_path=None)


async def _caller_two():
    return await _run_install_subprocess("two", progress=None, log_path=None)


async def _caller_three():
    return await _run_install_subprocess("three", progress=None, log_path=None)


async def _caller_four():
    return await _run_install_subprocess("four", progress=None, log_path=None)


async def _caller_five():
    return await _run_install_subprocess("five", progress=None, log_path=None)
`,
  );
  writeFixtureFile(packageDir, "integrations/__init__.py", '"""Test integrations."""');
  writeFixtureFile(
    packageDir,
    "integrations/openai_codex.py",
    `
from __future__ import annotations

from pathlib import Path


class CodexAuthStatus:
    def __init__(self, *, logged_in, store_path):
        self.logged_in = logged_in
        self.store_path = store_path


def default_store_path():
    return Path("/sandbox/.deepagents/.state/chatgpt-auth.json")


def get_status(*, store_path=None):
    return CodexAuthStatus(logged_in=True, store_path=store_path or default_store_path())


async def run_browser_login(*args, **kwargs):
    del args, kwargs
    return get_status()


def build_chat_model(*args, **kwargs):
    del args, kwargs
    return object()
`,
  );
  writeFixtureFile(packageDir, "widgets/__init__.py", '"""Test widgets."""');
  writeFixtureFile(
    packageDir,
    "widgets/auth.py",
    `
from __future__ import annotations


class Static:
    def __init__(self, value):
        self.value = value


class AuthResult:
    CANCELLED = "cancelled"


class _BaseScreen:
    def __init__(self):
        self.app = self
        self.dismissed = "not-dismissed"
        self.notifications = []

    def notify(self, message, **kwargs):
        self.notifications.append((message, kwargs))

    def call_after_refresh(self, callback):
        callback()

    def dismiss(self, value):
        self.dismissed = value


class AuthPromptScreen(_BaseScreen):
    def compose(self):
        yield Static("original")

    def on_mount(self):
        self.original_mount = True


class AuthManagerScreen(_BaseScreen):
    def compose(self):
        yield Static("original")

    def on_mount(self):
        self.original_mount = True
`,
  );
  writeFixtureFile(
    packageDir,
    "widgets/codex_auth.py",
    `
from __future__ import annotations


class Static:
    def __init__(self, value):
        self.value = value


class CodexAuthScreen:
    def __init__(self):
        self.app = self
        self.dismissed = None
        self.notifications = []
        self.worker_started = False

    def notify(self, message, **kwargs):
        self.notifications.append((message, kwargs))

    def call_after_refresh(self, callback):
        callback()

    def dismiss(self, value):
        self.dismissed = value

    def compose(self):
        yield Static("original")

    def on_mount(self):
        self.worker_started = True
`,
  );
  writeFixtureFile(
    packageDir,
    "widgets/model_selector.py",
    `
from __future__ import annotations

from types import SimpleNamespace


def get_provider_auth_status(provider):
    del provider
    return SimpleNamespace(blocks_start=False)


class ModelSelectorScreen:
    def __init__(self):
        self.original_selection = None
        self.app = SimpleNamespace(notify=lambda *args, **kwargs: None)

    def _select_with_auth_check(self, model_spec, provider):
        self.original_selection = (model_spec, provider)
`,
  );
  writeFixtureFile(
    packageDir,
    "widgets/approval.py",
    `
from __future__ import annotations

from types import SimpleNamespace


class ApprovalMenu:
    def __init__(self):
        self.decisions = []
        self.notifications = []
        self.app = SimpleNamespace(
            notify=lambda *args, **kwargs: self.notifications.append((args, kwargs))
        )

    def _handle_selection(self, option, *, reject_message=None):
        decision_map = {0: "approve", 1: "auto_approve_all", 2: "reject"}
        self.decisions.append((decision_map[option], reject_message))

    def action_select_auto(self):
        self._handle_selection(1)
`,
  );

  writeFixtureFile(
    tempDir,
    `deepagents_code-${version}.dist-info/METADATA`,
    `
Metadata-Version: 2.1
Name: deepagents-code
Version: ${version}
`,
  );
  const managedBaseUrlFile = path.join(tempDir, "managed-inference-base-url");
  fs.writeFileSync(managedBaseUrlFile, "https://inference.local/v1\n", "utf8");
  fs.chmodSync(managedBaseUrlFile, 0o444);
  return tempDir;
}

function patchFixture(tempDir: string): void {
  execFileSync("python3", [patcher], {
    env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
  });
  const managedBaseUrlFile = path.join(tempDir, "managed-inference-base-url");
  const helperPath = path.join(tempDir, "deepagents_code", "_nemoclaw_managed.py");
  const helper = fs
    .readFileSync(helperPath, "utf8")
    .replace(
      '"/usr/local/share/nemoclaw/dcode-inference-base-url"',
      JSON.stringify(managedBaseUrlFile),
    )
    .replace("_MANAGED_FILE_OWNER_UID = 0", `_MANAGED_FILE_OWNER_UID = ${process.getuid?.() ?? 0}`);
  fs.writeFileSync(helperPath, helper, "utf8");
}

describe("LangChain Deep Agents Code managed package patch", () => {
  it("patches every 0.1.30 mutation and credential boundary idempotently", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    patchFixture(tempDir);

    const packageDir = path.join(tempDir, "deepagents_code");
    for (const relativePath of [
      "main.py",
      "__main__.py",
      "app.py",
      "auth_store.py",
      "config.py",
      "model_config.py",
      "agent.py",
      "update_check.py",
      "integrations/openai_codex.py",
      "widgets/auth.py",
      "widgets/codex_auth.py",
      "widgets/model_selector.py",
      "widgets/approval.py",
      "server.py",
      "subagents.py",
      "hooks.py",
      "non_interactive.py",
      "_nemoclaw_managed.py",
    ]) {
      const source = fs.readFileSync(path.join(packageDir, relativePath), "utf8");
      expect(source.match(/NemoClaw-managed Deep Agents Code hardening v2\./g)).toHaveLength(1);
    }

    const main = fs.readFileSync(path.join(packageDir, "main.py"), "utf8");
    for (const expected of [
      'args.sandbox = "none"',
      "args.no_mcp = not has_managed_mcp",
      "args.mcp_config = managed_mcp_config if has_managed_mcp else None",
      "args.shell_allow_list = None",
      'getattr(args, "update", False)',
      'getattr(args, "auto_update", False)',
      'getattr(args, "install", None)',
      'getattr(args, "model_params", None)',
      'getattr(args, "interpreter_tools", None)',
      'getattr(args, "auto_approve", False)',
      "_nemoclaw_assert_safe_runtime()",
      'os.environ.pop("PYTHONPATH", None)',
    ]) {
      expect(main).toContain(expected);
    }
  });

  it.each([
    ["update"],
    ["auth"],
    ["install"],
    ["mcp"],
    ["tools", "install"],
    ["--update"],
    ["--upd"],
    ["--auto-update"],
    ["--auto-upd"],
    ["--install", "nvidia"],
    ["--inst", "nvidia"],
    ["--model-params", '{"api_key":"secret"}'],
    ['--model-p={"api_key":"secret"}'],
    ["--rubric-model", "anthropic:test"],
    ["--rubric-m=anthropic:test"],
    ["--interpreter"],
    ["--interpreter-tools", "execute"],
    ["--interpreter-t=execute"],
    ["-y"],
    ["--auto-approve"],
    ["--acp"],
    ["--startup-cmd", "touch /tmp/unsafe"],
    ["--startup-cmd=touch /tmp/unsafe"],
  ])("rejects direct-module mutation arguments: %s", (...args) => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync("python3", ["-m", "deepagents_code", ...args], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain("disabled in NemoClaw-managed");
  });

  it("preserves ordinary direct-module and read-only tools execution", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    for (const args of [[], ["tools", "list"], ["tools", "help"]]) {
      const result = spawnSync("python3", ["-m", "deepagents_code", ...args], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
        encoding: "utf8",
      });
      expect(result.status, `${args.join(" ")} failed: ${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("managed-posture-ok");
    }
  });

  it("rejects direct-module runtime credentials before settings bootstrap", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    for (const [name, value] of [
      ["OPENAI_API_KEY", "sk-TEST-FAKE-DO-NOT-USE-000000000000"],
      ["NOTES", "metadata API_KEY=ABCDEFGHIJKL"],
      ["SLACK_BOT_TOKEN", "xoxb-sk-abcdefghijklmnopqrstuv"],
      ["LANGSMITH_RUNS_ENDPOINTS", '{"https://trace.example":"opaque-key-value"}'],
      ["LANGCHAIN_RUNS_ENDPOINTS", '{"https://trace.example":"opaque-key-value"}'],
      ["OTEL_EXPORTER_OTLP_ENDPOINT", "https://collector.example/v1/traces"],
      ["OTEL_EXPORTER_OTLP_HEADERS", "authorization=opaque-value"],
    ]) {
      const result = spawnSync("python3", ["-m", "deepagents_code"], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir, [name]: value },
        encoding: "utf8",
      });

      expect(result.status, `${name} was allowed`).not.toBe(0);
      expect(result.stderr).toContain(`runtime environment variable ${name}`);
    }
  });

  it("allows only scoped managed credential-shaped runtime values", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const result = spawnSync("python3", ["-m", "deepagents_code"], {
      env: {
        PATH: process.env.PATH,
        PYTHONPATH: tempDir,
        DEEPAGENTS_CODE_OPENAI_API_KEY: "nemoclaw-managed-inference",
        SLACK_BOT_TOKEN: ["xoxb", "1234567890abcdef"].join("-"),
        DEEPAGENTS_CODE_LANGSMITH_TRACING: "true",
        DEEPAGENTS_CODE_LANGSMITH_TRACING_V2: "true",
        DEEPAGENTS_CODE_LANGCHAIN_TRACING: "true",
        DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2: "true",
        LANGSMITH_TRACING: "true",
        LANGSMITH_TRACING_V2: "true",
        LANGCHAIN_TRACING: "true",
        LANGCHAIN_TRACING_V2: "true",
        OTEL_ENABLED: "true",
      },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("managed-posture-ok");
  });

  it("accepts only exact same-name OpenShell credential placeholders", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const run = (name: string, value: string) =>
      spawnSync("python3", ["-m", "deepagents_code"], {
        env: { PATH: process.env.PATH, PYTHONPATH: tempDir, [name]: value },
        encoding: "utf8",
      });

    for (const value of [
      "openshell:resolve:env:GITHUB_MCP_TOKEN",
      "openshell:resolve:env:v0_GITHUB_MCP_TOKEN",
      `openshell:resolve:env:v${"1".repeat(20)}_GITHUB_MCP_TOKEN`,
    ]) {
      const result = run("GITHUB_MCP_TOKEN", value);
      expect(result.status, result.stderr).toBe(0);
    }

    for (const [name, value] of [
      ["GITHUB_MCP_TOKEN", "prefix-openshell:resolve:env:GITHUB_MCP_TOKEN"],
      ["GITHUB_MCP_TOKEN", "openshell:resolve:env:OTHER_TOKEN"],
      ["GITHUB_MCP_TOKEN", `openshell:resolve:env:v${"1".repeat(21)}_GITHUB_MCP_TOKEN`],
      ["OPENSHELL_TLS_KEY", "openshell:resolve:env:OPENSHELL_TLS_KEY"],
    ]) {
      const result = run(name, value);
      expect(result.status, `${name}=${value} was allowed`).not.toBe(0);
      expect(result.stderr).toContain("invalid OpenShell credential placeholder");
    }
  });

  it("loads only strict HTTPS-only managed MCP configuration", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const configPath = path.join(tempDir, ".mcp.json");
    const validate = (config: unknown, mode = 0o600) => {
      fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`, { mode });
      fs.chmodSync(configPath, mode);
      return spawnSync(
        "python3",
        [
          "-c",
          [
            "import sys",
            "from pathlib import Path",
            "from deepagents_code import _nemoclaw_managed as managed",
            "managed._MCP_CONFIG_FILE = Path(sys.argv[1])",
            "print(managed.managed_mcp_config_path() or 'absent')",
          ].join("; "),
          configPath,
        ],
        {
          env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
          encoding: "utf8",
        },
      );
    };
    const validServer = {
      type: "http",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: "Bearer openshell:resolve:env:v20_GITHUB_MCP_TOKEN",
      },
    };

    const valid = validate({ mcpServers: { github: validServer } });
    expect(valid.status, valid.stderr).toBe(0);
    expect(valid.stdout.trim()).toBe(configPath);

    for (const config of [
      { mcpServers: { github: { command: "bash", args: ["-c", "id"] } } },
      { mcpServers: { github: validServer }, ui: { theme: "dark" } },
      {
        mcpServers: {
          github: { ...validServer, headers: { "X-Test": "value" } },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, headers: { Authorization: "Bearer raw-secret-value" } },
        },
      },
      {
        mcpServers: {
          github: { ...validServer, url: "https://127.0.0.1/mcp/" },
        },
      },
    ]) {
      const result = validate(config);
      expect(result.status, JSON.stringify(config)).not.toBe(0);
    }

    const badMode = validate({ mcpServers: { github: validServer } }, 0o644);
    expect(badMode.status).not.toBe(0);
    expect(badMode.stderr).toContain("unsafe ownership or mode");
  });

  it("blocks TUI commands, credential screens, dotenv, OAuth, and install backends", () => {
    const tempDir = createPackageFixture();
    patchFixture(tempDir);
    const managedMcpPath = path.join(tempDir, "managed-mcp.json");
    fs.writeFileSync(
      managedMcpPath,
      `${JSON.stringify({
        mcpServers: {
          github: {
            type: "http",
            url: "https://api.githubcopilot.com/mcp/",
            headers: {
              Authorization: "Bearer openshell:resolve:env:GITHUB_MCP_TOKEN",
            },
          },
        },
      })}\n`,
      { mode: 0o600 },
    );
    const validation = `
import asyncio
import os
from pathlib import Path

from deepagents_code import agent, app, auth_store, config, hooks, main as dcode_main, model_config, non_interactive, server, subagents, update_check
from deepagents_code import _nemoclaw_managed
from deepagents_code import config_manifest
from deepagents_code.integrations import openai_codex
from deepagents_code.widgets.auth import AuthManagerScreen, AuthPromptScreen, AuthResult
from deepagents_code.widgets.codex_auth import CodexAuthScreen
from deepagents_code.widgets import model_selector
from deepagents_code.widgets.approval import ApprovalMenu
from types import SimpleNamespace


async def validate():
    instance = app.DeepAgentsApp()
    for command in (
        "/update",
        "/install nvidia",
        "/auto-update",
        "/auth",
        "/connect",
        "/mcp login server",
        '/model openai:test --model-params {"api_key":"secret"}',
        "/rubric model anthropic:test",
        "/criteria model anthropic:test",
        "/goal model anthropic:test",
    ):
        await instance._handle_command(command)
    assert len(instance.original_commands) == 0, instance.original_commands
    await instance._handle_command("/help")
    assert instance.original_commands == ["/help"], instance.original_commands
    await instance._check_for_updates()
    assert instance._update_check_done.was_set
    await instance._handle_update_command()
    await instance._handle_install_command("/install nvidia")
    assert await instance._install_extra("nvidia") is False
    await instance._handle_install_package("package", force=True)
    await instance._handle_auto_update_toggle()
    await instance._switch_model(
        "openai:test", extra_kwargs={"api_key": "secret"}
    )
    assert instance.original_switch_kwargs is None
    instance._auto_approve = True
    await instance._on_auto_approve_enabled()
    assert instance._auto_approve is False
    instance._auto_approve = True
    await instance.action_toggle_auto_approve()
    assert instance._auto_approve is False
    await instance._set_rubric_model("anthropic:test")
    assert instance._rubric_model is None
    assert instance._server_kwargs["rubric_model"] is None
    await instance._prompt_launch_tavily()
    assert await instance._prompt_model_auth_if_needed("provider:model") is False
    await instance._show_auth_manager(initial_provider="provider")
    await instance._enter_service_api_key(None, None)
    await instance._handle_update_action(None, None, None)
    instance._start_mcp_login("server")
    assert not instance.original_tavily
    assert not instance.original_auth_manager
    assert not instance.original_service_key
    assert not instance.original_update_action
    assert not instance.original_mcp_login
    assert instance.notifications

    approval = ApprovalMenu()
    approval._handle_selection(1)
    approval.action_select_auto()
    assert approval.decisions == []
    assert len(approval.notifications) == 2
    approval._handle_selection(0)
    assert approval.decisions == [("approve", None)]

    prompt = AuthPromptScreen()
    prompt.on_mount()
    assert prompt.dismissed == AuthResult.CANCELLED
    assert list(prompt.compose())[0].value.startswith("Credential entry is disabled")

    manager = AuthManagerScreen()
    manager.on_mount()
    assert manager.dismissed is None

    codex = CodexAuthScreen()
    codex.on_mount()
    assert codex.dismissed is False
    assert not codex.worker_started

    assert auth_store.load_credentials() == {}
    try:
        auth_store.set_stored_key("openai", "secret")
    except RuntimeError as exc:
        assert "credential storage is disabled" in str(exc)
    else:
        raise AssertionError("credential write was not blocked")

    success, message = await update_check._run_install_subprocess("uv", progress=None, log_path=None)
    assert success is False and "managed by NemoClaw" in message
    try:
        update_check.set_auto_update(True)
    except RuntimeError as exc:
        assert "managed by NemoClaw" in str(exc)
    else:
        raise AssertionError("auto-update write was not blocked")

    try:
        await openai_codex.run_browser_login()
    except RuntimeError as exc:
        assert "OAuth is disabled" in str(exc)
    else:
        raise AssertionError("OAuth login was not blocked")
    assert openai_codex.get_status().logged_in is False
    try:
        openai_codex.build_chat_model("gpt")
    except RuntimeError as exc:
        assert "OAuth is disabled" in str(exc)
    else:
        raise AssertionError("OAuth token use was not blocked")

    selector_notices = []
    selector = model_selector.ModelSelectorScreen()
    selector.app = SimpleNamespace(
        notify=lambda *args, **kwargs: selector_notices.append((args, kwargs))
    )
    model_selector.get_provider_auth_status = lambda provider: SimpleNamespace(blocks_start=True)
    selector._select_with_auth_check("openai:model", "openai")
    assert selector.original_selection is None
    assert selector_notices
    model_selector.get_provider_auth_status = lambda provider: SimpleNamespace(blocks_start=False)
    config_manifest.INSTALL_EXTRA = "provider"
    config_manifest.PROVIDER_INSTALLED = False
    selector._select_with_auth_check("openai:model", "openai")
    assert selector.original_selection is None
    config_manifest.INSTALL_EXTRA = None
    config_manifest.PROVIDER_INSTALLED = True
    selector._select_with_auth_check("openai:model", "openai")
    assert selector.original_selection == ("openai:model", "openai")
    selector.original_selection = None
    selector._select_with_auth_check("anthropic:model", "anthropic")
    assert selector.original_selection is None

    assert config._parse_interpreter_ptc(["execute"]) is False
    assert agent._resolve_ptc_option(
        ["execute"], tools=[], acknowledge_unsafe=True, auto_approve=True
    ) is None
    assert agent.load_async_subagents(Path("/tmp/attacker-config.toml")) == []
    graph_kwargs = agent.create_cli_agent(
        object(),
        "assistant",
        rubric_model="anthropic:attacker",
        async_subagents=[{"url": "https://attacker.example"}],
    )
    assert graph_kwargs["rubric_model"] is None
    assert graph_kwargs["async_subagents"] is None
    assert subagents.list_subagents()[0]["model"] is None
    hook_marker = Path(${JSON.stringify(path.join(tempDir, "hook-ran"))})
    assert hooks._load_hooks() == []
    hooks._run_single_hook(["touch", str(hook_marker)], "session.start", b"{}")
    assert not hook_marker.exists()
    headless_kwargs = await non_interactive.run_non_interactive(
        "message",
        "assistant",
        startup_cmd="touch /tmp/unsafe",
        model_params={"api_key": "secret"},
        profile_override={"attacker": True},
        sandbox_type="modal",
        mcp_config_path="mcp.json",
        no_mcp=False,
        trust_project_mcp=True,
        enable_interpreter=True,
        interpreter_ptc=["execute"],
        rubric_model="anthropic:attacker",
    )
    assert headless_kwargs["startup_cmd"] is None
    assert headless_kwargs["model_params"] is None
    assert headless_kwargs["profile_override"] is None
    assert headless_kwargs["sandbox_type"] == "none"
    assert headless_kwargs["mcp_config_path"] is None
    assert headless_kwargs["no_mcp"] is True
    assert headless_kwargs["trust_project_mcp"] is False
    assert headless_kwargs["enable_interpreter"] is False
    assert headless_kwargs["interpreter_ptc"] is None
    assert headless_kwargs["rubric_model"] is None
    assert non_interactive.settings.shell_allow_list is None
    _nemoclaw_managed._MCP_CONFIG_FILE = Path(${JSON.stringify(managedMcpPath)})
    managed_args = dcode_main.parse_args()
    assert managed_args.mcp_config == ${JSON.stringify(managedMcpPath)}
    assert managed_args.no_mcp is False
    assert managed_args.trust_project_mcp is False
    managed_headless_kwargs = await non_interactive.run_non_interactive(
        "message",
        "assistant",
        mcp_config_path="attacker.json",
        no_mcp=True,
        trust_project_mcp=True,
    )
    assert managed_headless_kwargs["mcp_config_path"] == ${JSON.stringify(managedMcpPath)}
    assert managed_headless_kwargs["no_mcp"] is False
    assert managed_headless_kwargs["trust_project_mcp"] is False
    assert model_config.ModelConfig().get_class_path("openai") is None
    managed_kwargs = config._get_provider_kwargs("openai")
    assert managed_kwargs == {
        "api_key": "nemoclaw-managed-inference",
        "base_url": "https://inference.local/v1",
        "use_responses_api": False,
    }
    model_config.ModelConfig.base_url = "https://attacker.example/v1"
    assert config._get_provider_kwargs("openai")["base_url"] == "https://inference.local/v1"
    try:
        config._get_provider_kwargs("anthropic")
    except model_config.ModelConfigError as exc:
        assert "managed OpenAI-compatible provider" in str(exc)
    else:
        raise AssertionError("non-managed model provider was allowed")
    child_env = server._build_server_env()
    assert child_env["LANGGRAPH_NO_VERSION_CHECK"] == "true"
    assert child_env["OTEL_ENABLED"] == "false"
    assert "OTEL_EXPORTER_OTLP_ENDPOINT" not in child_env
    assert "OTEL_EXPORTER_OTLP_HEADERS" not in child_env

    os.environ["OPENAI_BASE_URL"] = "https://attacker.example/v1"
    os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "false"
    os.environ["OTEL_ENABLED"] = "true"
    _nemoclaw_managed.assert_safe_runtime()
    assert os.environ["OPENAI_BASE_URL"] == "https://inference.local/v1"
    assert os.environ["LANGGRAPH_NO_VERSION_CHECK"] == "true"
    assert os.environ["OTEL_ENABLED"] == "false"

    project = Path(${JSON.stringify(tempDir)}) / "project"
    project.mkdir()
    (project / ".env").write_text("PROJECT_API_KEY=should-not-load\\n", encoding="utf-8")
    os.chdir(project)
    assert config._load_dotenv() is False
    assert "PROJECT_API_KEY" not in os.environ
    assert "PROJECT_API_KEY" not in config._preview_dotenv_environ()
    for name in (
        "LANGSMITH_TRACING",
        "LANGSMITH_TRACING_V2",
        "LANGCHAIN_TRACING",
        "LANGCHAIN_TRACING_V2",
    ):
        os.environ[name] = "true"
    assert config._tracing_enabled() is False

    state_dir = Path(${JSON.stringify(tempDir)}) / "state"
    state_dir.mkdir()
    _nemoclaw_managed._AUTH_FILE = state_dir / "auth.json"
    _nemoclaw_managed._CODEX_AUTH_FILE = state_dir / "chatgpt-auth.json"
    _nemoclaw_managed._AUTH_FILE.write_text(
        '{"version": 1, "credentials": {"openai": {"key": "secret"}}}',
        encoding="utf-8",
    )
    try:
        _nemoclaw_managed._assert_safe_auth_state()
    except RuntimeError as exc:
        assert "auth.json contains credentials" in str(exc)
    else:
        raise AssertionError("preexisting auth.json was not blocked")
    _nemoclaw_managed._AUTH_FILE.write_text(
        '{"version": 1, "credentials": {}}', encoding="utf-8"
    )
    _nemoclaw_managed._assert_safe_auth_state()
    _nemoclaw_managed._CODEX_AUTH_FILE.write_text("{}", encoding="utf-8")
    try:
        _nemoclaw_managed._assert_safe_auth_state()
    except RuntimeError as exc:
        assert "chatgpt-auth.json" in str(exc)
    else:
        raise AssertionError("preexisting ChatGPT OAuth store was not blocked")


asyncio.run(validate())
print("managed-boundaries-ok")
`;
    const output = execFileSync("python3", ["-c", validation], {
      env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
      encoding: "utf8",
    });
    expect(output).toContain("managed-boundaries-ok");
  });

  it("fails closed when the installed version or required source shape drifts", () => {
    const wrongVersion = createPackageFixture("0.1.31");
    const versionResult = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: wrongVersion },
      encoding: "utf8",
    });
    expect(versionResult.status).not.toBe(0);
    expect(versionResult.stderr).toContain("Expected deepagents-code==0.1.30");

    const missingMethod = createPackageFixture();
    const appPath = path.join(missingMethod, "deepagents_code", "app.py");
    fs.writeFileSync(
      appPath,
      fs.readFileSync(appPath, "utf8").replace("_prompt_launch_tavily", "_renamed_tavily"),
      "utf8",
    );
    const shapeResult = spawnSync("python3", [patcher], {
      env: { PATH: process.env.PATH, PYTHONPATH: missingMethod },
      encoding: "utf8",
    });
    expect(shapeResult.status).not.toBe(0);
    expect(shapeResult.stderr).toContain("_prompt_launch_tavily");
  });
});
