// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addDarwinFcntlSealConstants } from "./darwin-fcntl-seal-fixture";

export const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
export const patcher = path.join(agentDir, "patch-managed-deepagents-code.py");
const packageFixtureDirs = new Set<string>();

export function managedAutoApprovalPath(root: string): string {
  return path.join(root, "managed-auto-approval");
}

export function writeManagedAutoApproval(root: string, content: string, mode = 0o444): string {
  const capabilityPath = managedAutoApprovalPath(root);
  fs.writeFileSync(capabilityPath, content, { mode });
  fs.chmodSync(capabilityPath, mode);
  return capabilityPath;
}

export function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${content.trim()}\n`, "utf8");
}

export function createPackageFixture(version = "0.1.34"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patch-"));
  packageFixtureDirs.add(tempDir);
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
    args = parse_args()
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
    assert os.environ["LANGGRAPH_CLI_NO_ANALYTICS"] == "1"
    assert os.environ["HOME"] == "/sandbox"
    print(f"managed-posture-ok auto_approve={args.auto_approve}")
`,
  );
  writeFixtureFile(
    packageDir,
    "onboarding.py",
    `
from __future__ import annotations


def should_run_onboarding(state_dir=None):
    del state_dir
    return True
`,
  );
  const appFixture = fs
    .readFileSync(
      path.join(process.cwd(), "test", "fixtures", "langchain-deepagents-code", "app.py"),
      "utf8",
    )
    .replace(
      "class DeepAgentsApp:\n",
      `class _StatusBar:
    def __init__(self):
        self.auto_approve = True

    def set_auto_approve(self, *, enabled):
        self.auto_approve = enabled


class _SessionState:
    def __init__(self):
        self.thread_id = "thread-1"
        self.auto_approve = True
        self.approval_mode_key = "approval/thread-1"


class DeepAgentsApp:
`,
    )
    .replace(
      "        self._auto_approve = True\n        self._status_bar = None\n        self._session_state = None\n",
      `        self._auto_approve = True
        self._status_bar = _StatusBar()
        self._session_state = _SessionState()
        self._agent = object()
        self._assistant_id = "agent-1"
        self.resume_should_fail = False
        self.resume_should_fail_after_reset = False
        self.agent_swap_should_fail = False
        self.agent_swap_should_fail_after_reset = False
        self.clear_should_fail_early = False
        self.clear_should_fail_after_reset = False
`,
    )
    .replace(
      "    async def _on_auto_approve_enabled(self):\n        self._auto_approve = True\n\n    async def action_toggle_auto_approve(self):\n        self._auto_approve = not self._auto_approve\n",
      `    async def _on_auto_approve_enabled(self):
        self._auto_approve = True
        self._status_bar.set_auto_approve(enabled=True)
        self._session_state.auto_approve = True

    async def action_toggle_auto_approve(self):
        self._auto_approve = not self._auto_approve
        self._status_bar.set_auto_approve(enabled=self._auto_approve)
        self._session_state.auto_approve = self._auto_approve

    async def _resume_thread(self, thread_id):
        if self.resume_should_fail:
            return
        previous_thread_id = self._session_state.thread_id
        self._session_state.thread_id = thread_id
        if self.resume_should_fail_after_reset:
            self._session_state.thread_id = previous_thread_id
            raise RuntimeError("resume failed after reset")

    async def _restart_server_for_agent_swap(self, agent_name):
        if self.agent_swap_should_fail:
            return
        self._session_state.thread_id = f"{self._session_state.thread_id}-swap"
        if self.agent_swap_should_fail_after_reset:
            self._agent = None
            raise RuntimeError("agent swap failed after reset")
        self._assistant_id = agent_name
        self._agent = object()
`,
    )
    .replace(
      "    async def _handle_command(self, command):\n        self.original_commands.append(command)\n",
      `    async def _handle_command(self, command):
        self.original_commands.append(command)
        if command.lower().strip() in {"/clear", "/force-clear"}:
            if self.clear_should_fail_early:
                raise RuntimeError("clear failed before reset")
            self._session_state.thread_id = f"{self._session_state.thread_id}-clear"
            if self.clear_should_fail_after_reset:
                raise RuntimeError("clear failed after reset")
`,
    );
  writeFixtureFile(packageDir, "app.py", appFixture);
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


def build_model_identity_section(name, provider=None, context_limit=None, unsupported_modalities=frozenset()):
    del context_limit, unsupported_modalities
    section = f"You are running as model \`{name}\`"
    if provider:
        section += f" (provider: {provider})"
    return f"{section}.\\n"
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
    "client/launch/server.py",
    fs.readFileSync(
      path.join(process.cwd(), "test", "fixtures", "langchain-deepagents-code", "server.py"),
      "utf8",
    ),
  );
  writeFixtureFile(
    packageDir,
    "_server_config.py",
    `
from __future__ import annotations

from pathlib import Path


def _normalize_path(raw_path, project_context, label):
    if not raw_path:
        return None
    if project_context is not None:
        return str(project_context.resolve_user_path(raw_path))
    return str(Path(raw_path).expanduser().resolve())
`,
  );
  writeFixtureFile(
    packageDir,
    "mcp_tools.py",
    fs.readFileSync(
      path.join(process.cwd(), "test", "fixtures", "langchain-deepagents-code", "mcp_tools.py"),
      "utf8",
    ),
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
    "client/non_interactive.py",
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
  writeFixtureFile(packageDir, "client/__init__.py", '"""Test client."""');
  writeFixtureFile(packageDir, "client/launch/__init__.py", '"""Test launch client."""');
  writeFixtureFile(packageDir, "tui/__init__.py", '"""Test TUI."""');
  writeFixtureFile(packageDir, "tui/widgets/__init__.py", '"""Test widgets."""');
  writeFixtureFile(
    packageDir,
    "tui/widgets/auth.py",
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
    "tui/widgets/codex_auth.py",
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
    "tui/widgets/model_selector.py",
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
    "tui/widgets/approval.py",
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
    packageDir,
    "tui/widgets/status.py",
    `
from __future__ import annotations


class StatusBar:
    def __init__(self):
        self.model_display = None

    def set_model(self, *, provider, model, effort=""):
        self.model_display = {"provider": provider, "model": model, "effort": effort}
`,
  );
  writeFixtureFile(
    packageDir,
    "tui/widgets/welcome.py",
    `
from __future__ import annotations


class WelcomeBanner:
    def __init__(self):
        self.model_display = None

    def update_model(self, *, provider, model):
        self.model_display = {"provider": provider, "model": model}
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

export function cleanupPackageFixtures(): void {
  for (const tempDir of packageFixtureDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  packageFixtureDirs.clear();
}

export function patchFixture(tempDir: string): void {
  execFileSync("python3", [patcher], {
    env: { PATH: process.env.PATH, PYTHONPATH: tempDir },
  });
  const managedBaseUrlFile = path.join(tempDir, "managed-inference-base-url");
  const helperPath = path.join(tempDir, "deepagents_code", "_nemoclaw_managed.py");
  const helper = addDarwinFcntlSealConstants(fs.readFileSync(helperPath, "utf8"))
    .replace(
      '"/usr/local/share/nemoclaw/dcode-inference-base-url"',
      JSON.stringify(managedBaseUrlFile),
    )
    .replace(
      '"/usr/local/share/nemoclaw/dcode-auto-approval"',
      JSON.stringify(managedAutoApprovalPath(tempDir)),
    )
    .replace("_MANAGED_FILE_OWNER_UID = 0", `_MANAGED_FILE_OWNER_UID = ${process.getuid?.() ?? 0}`);
  fs.writeFileSync(helperPath, helper, "utf8");
}
