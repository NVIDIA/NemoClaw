# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch the pinned Deep Agents Code package for NemoClaw-managed posture."""

from __future__ import annotations

import ast
import importlib.metadata
import importlib.util
from pathlib import Path

EXPECTED_DCODE_VERSION = "0.1.30"
PATCH_MARKER = "NemoClaw-managed Deep Agents Code hardening v2."

MAIN_MARKER = "    args = parser.parse_args()\n"
ENTRYPOINT_MARKER = "from deepagents_code.main import cli_main\n"
ENTRYPOINT_PATCH = '''# NemoClaw-managed Deep Agents Code hardening v2.
import os

os.environ["HOME"] = "/sandbox"
os.environ["DEEPAGENTS_CODE_AUTO_UPDATE"] = "0"
os.environ["DEEPAGENTS_CODE_NO_UPDATE_CHECK"] = "1"
os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "true"
os.environ["OTEL_ENABLED"] = "false"
os.environ["DEEPAGENTS_CODE_LANGSMITH_TRACING"] = "false"
os.environ["DEEPAGENTS_CODE_LANGSMITH_TRACING_V2"] = "false"
os.environ["DEEPAGENTS_CODE_LANGCHAIN_TRACING"] = "false"
os.environ["DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2"] = "false"
os.environ["LANGSMITH_TRACING"] = "false"
os.environ["LANGSMITH_TRACING_V2"] = "false"
os.environ["LANGCHAIN_TRACING"] = "false"
os.environ["LANGCHAIN_TRACING_V2"] = "false"
os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)
os.environ.pop("PYTHONHOME", None)
os.environ.pop("PYTHONPATH", None)
os.environ.pop("OPENAI_PROXY", None)

from deepagents_code._nemoclaw_managed import assert_safe_runtime

assert_safe_runtime()
from deepagents_code.main import cli_main
'''
MAIN_PATCH = '''    # NemoClaw-managed Deep Agents Code hardening v2.
    os.environ["HOME"] = "/sandbox"
    os.environ["DEEPAGENTS_CODE_AUTO_UPDATE"] = "0"
    os.environ["DEEPAGENTS_CODE_NO_UPDATE_CHECK"] = "1"
    os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "true"
    os.environ["OTEL_ENABLED"] = "false"
    os.environ["DEEPAGENTS_CODE_LANGSMITH_TRACING"] = "false"
    os.environ["DEEPAGENTS_CODE_LANGSMITH_TRACING_V2"] = "false"
    os.environ["DEEPAGENTS_CODE_LANGCHAIN_TRACING"] = "false"
    os.environ["DEEPAGENTS_CODE_LANGCHAIN_TRACING_V2"] = "false"
    os.environ["LANGSMITH_TRACING"] = "false"
    os.environ["LANGSMITH_TRACING_V2"] = "false"
    os.environ["LANGCHAIN_TRACING"] = "false"
    os.environ["LANGCHAIN_TRACING_V2"] = "false"
    os.environ["DEEPAGENTS_CODE_OFFLINE"] = "1"
    os.environ["DEEPAGENTS_CODE_RIPGREP_INSTALLER"] = "system"
    os.environ.pop("DEEPAGENTS_CODE_SHELL_ALLOW_LIST", None)
    os.environ.pop("PYTHONHOME", None)
    os.environ.pop("PYTHONPATH", None)
    os.environ.pop("OPENAI_PROXY", None)

    blocked_command = getattr(args, "command", None)
    if blocked_command == "mcp":
        parser.error("MCP commands are disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if blocked_command in {"auth", "install", "update"}:
        parser.error(f"{blocked_command} commands are disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if blocked_command == "tools" and getattr(args, "tools_command", None) not in (None, "list", "help"):
        parser.error(f"tools {getattr(args, 'tools_command', '?')} is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "update", False):
        parser.error("--update is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "auto_update", False):
        parser.error("--auto-update is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "install", None) is not None:
        parser.error("--install is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "model_params", None) is not None:
        parser.error("--model-params is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "rubric_model", None) is not None:
        parser.error("--rubric-model is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "startup_cmd", None) is not None:
        parser.error("--startup-cmd is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "interpreter_tools", None) is not None:
        parser.error("--interpreter-tools is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "interpreter", None) is True:
        parser.error("--interpreter is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "auto_approve", False):
        parser.error("--auto-approve is disabled in NemoClaw-managed Deep Agents Code sandboxes")
    if getattr(args, "acp", False):
        parser.error("--acp is disabled in NemoClaw-managed Deep Agents Code sandboxes")

    if hasattr(args, "sandbox"):
        args.sandbox = "none"
    if hasattr(args, "sandbox_id"):
        args.sandbox_id = None
    if hasattr(args, "sandbox_snapshot_name"):
        args.sandbox_snapshot_name = None
    if hasattr(args, "sandbox_setup"):
        args.sandbox_setup = None
    from deepagents_code._nemoclaw_managed import (
        assert_safe_runtime as _nemoclaw_assert_safe_runtime,
        managed_mcp_config_path as _nemoclaw_managed_mcp_config_path,
    )

    # The pinned release treats this as its trusted user-level config;
    # /sandbox/.mcp.json is project-level and remains untrusted.
    managed_mcp_config = _nemoclaw_managed_mcp_config_path()
    has_managed_mcp = managed_mcp_config is not None
    if hasattr(args, "mcp_config"):
        args.mcp_config = managed_mcp_config if has_managed_mcp else None
    if hasattr(args, "no_mcp"):
        args.no_mcp = not has_managed_mcp
    if hasattr(args, "trust_project_mcp"):
        args.trust_project_mcp = False
    if hasattr(args, "shell_allow_list"):
        args.shell_allow_list = None
    if hasattr(args, "interpreter"):
        args.interpreter = False
    if hasattr(args, "interpreter_tools"):
        args.interpreter_tools = None
    if hasattr(args, "auto_approve"):
        args.auto_approve = False
    if hasattr(args, "rubric_model"):
        args.rubric_model = None
    if hasattr(args, "acp"):
        args.acp = False
    if hasattr(args, "startup_cmd"):
        args.startup_cmd = None

    _nemoclaw_assert_safe_runtime()
'''

APP_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_NEMOCLAW_MANAGED_UI_MESSAGE = (
    "NemoClaw manages credentials, dependencies, updates, and MCP for this "
    "sandbox. Use NemoClaw policy/configuration on the host instead."
)
_nemoclaw_original_handle_command = DeepAgentsApp._handle_command
_nemoclaw_original_switch_model = DeepAgentsApp._switch_model


async def _nemoclaw_handle_command(self, command: str) -> None:
    normalized = command.lower().strip()
    tokens = normalized.split()
    root = tokens[0] if tokens else ""
    blocked_model_params = root == "/model" and "--model-params" in normalized
    blocked_grader_model = (
        len(tokens) >= 2
        and tokens[1] == "model"
        and (
            root in {"/rubric", "/criteria"}
            or (root == "/goal" and len(tokens) <= 3)
        )
    )
    if blocked_model_params or blocked_grader_model or root in {"/auth", "/connect", "/update", "/auto-update", "/install", "/mcp"}:
        await self._mount_message(UserMessage(command))
        await self._mount_message(AppMessage(_NEMOCLAW_MANAGED_UI_MESSAGE))
        return
    await _nemoclaw_original_handle_command(self, command)


async def _nemoclaw_switch_model(
    self,
    model_spec: str,
    *,
    extra_kwargs=None,
    announce_unchanged: bool = True,
    persist: bool = True,
    from_resume: bool = False,
) -> None:
    del extra_kwargs
    await _nemoclaw_original_switch_model(
        self,
        model_spec,
        extra_kwargs=None,
        announce_unchanged=announce_unchanged,
        persist=persist,
        from_resume=from_resume,
    )


async def _nemoclaw_check_for_updates(self, *, periodic: bool = False) -> None:
    del periodic
    update_done = getattr(self, "_update_check_done", None)
    if update_done is not None:
        update_done.set()


async def _nemoclaw_block_update_command(self, command: str = "/update") -> None:
    await self._mount_message(UserMessage(command))
    await self._mount_message(AppMessage(_NEMOCLAW_MANAGED_UI_MESSAGE))


async def _nemoclaw_block_install_command(self, command: str) -> None:
    await self._mount_message(UserMessage(command))
    await self._mount_message(AppMessage(_NEMOCLAW_MANAGED_UI_MESSAGE))


async def _nemoclaw_block_install_extra(self, *args, **kwargs) -> bool:
    del args, kwargs
    await self._mount_message(AppMessage(_NEMOCLAW_MANAGED_UI_MESSAGE))
    return False


async def _nemoclaw_block_install_package(self, *args, **kwargs) -> None:
    del args, kwargs
    await self._mount_message(AppMessage(_NEMOCLAW_MANAGED_UI_MESSAGE))


async def _nemoclaw_block_auto_update(self) -> None:
    self.notify(_NEMOCLAW_MANAGED_UI_MESSAGE, severity="warning", markup=False)


async def _nemoclaw_block_auto_approve(self) -> None:
    self._auto_approve = False
    if getattr(self, "_status_bar", None) is not None:
        self._status_bar.set_auto_approve(enabled=False)
    if getattr(self, "_session_state", None) is not None:
        self._session_state.auto_approve = False
    self.notify(
        "Auto-approval is disabled in NemoClaw-managed sandboxes.",
        severity="warning",
        markup=False,
    )


async def _nemoclaw_block_rubric_model(self, model_spec: str | None) -> None:
    self._rubric_model = None
    if getattr(self, "_server_kwargs", None) is not None:
        self._server_kwargs["rubric_model"] = None
    if model_spec is not None:
        self.notify(
            "Custom rubric models are disabled; the managed chat model is used.",
            severity="warning",
            markup=False,
        )


async def _nemoclaw_skip_launch_tavily(self) -> None:
    return None


async def _nemoclaw_block_model_auth(self, model_spec: str) -> bool:
    del model_spec
    self.notify(_NEMOCLAW_MANAGED_UI_MESSAGE, severity="warning", markup=False)
    return False


async def _nemoclaw_block_auth_manager(self, **kwargs) -> None:
    del kwargs
    self.notify(_NEMOCLAW_MANAGED_UI_MESSAGE, severity="warning", markup=False)


async def _nemoclaw_block_service_key(self, *args, **kwargs) -> None:
    del args, kwargs
    self.notify(_NEMOCLAW_MANAGED_UI_MESSAGE, severity="warning", markup=False)


async def _nemoclaw_block_update_action(self, *args, **kwargs) -> None:
    del args, kwargs
    self.notify(_NEMOCLAW_MANAGED_UI_MESSAGE, severity="warning", markup=False)


def _nemoclaw_block_mcp_login(self, server_name: str) -> None:
    del server_name
    self.notify(_NEMOCLAW_MANAGED_UI_MESSAGE, severity="warning", markup=False)


DeepAgentsApp._handle_command = _nemoclaw_handle_command
DeepAgentsApp._switch_model = _nemoclaw_switch_model
DeepAgentsApp._check_for_updates = _nemoclaw_check_for_updates
DeepAgentsApp._handle_update_command = _nemoclaw_block_update_command
DeepAgentsApp._handle_install_command = _nemoclaw_block_install_command
DeepAgentsApp._install_extra = _nemoclaw_block_install_extra
DeepAgentsApp._handle_install_package = _nemoclaw_block_install_package
DeepAgentsApp._handle_auto_update_toggle = _nemoclaw_block_auto_update
DeepAgentsApp._on_auto_approve_enabled = _nemoclaw_block_auto_approve
DeepAgentsApp.action_toggle_auto_approve = _nemoclaw_block_auto_approve
DeepAgentsApp._set_rubric_model = _nemoclaw_block_rubric_model
DeepAgentsApp._prompt_launch_tavily = _nemoclaw_skip_launch_tavily
DeepAgentsApp._prompt_model_auth_if_needed = _nemoclaw_block_model_auth
DeepAgentsApp._show_auth_manager = _nemoclaw_block_auth_manager
DeepAgentsApp._enter_service_api_key = _nemoclaw_block_service_key
DeepAgentsApp._handle_update_action = _nemoclaw_block_update_action
DeepAgentsApp._start_mcp_login = _nemoclaw_block_mcp_login
'''

AUTH_STORE_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
def load_credentials() -> dict[str, StoredCredential]:
    """Ignore upstream credential state inside a NemoClaw-managed sandbox."""
    return {}


def set_stored_key(*args, **kwargs) -> WriteOutcome:
    """Refuse upstream credential writes inside a managed sandbox."""
    del args, kwargs
    raise RuntimeError(
        "Deep Agents Code credential storage is disabled in NemoClaw-managed sandboxes"
    )
'''

CONFIG_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
def _preview_dotenv_environ(*, start_path=None) -> dict[str, str]:
    """Return only the live managed environment; never read project dotenv files."""
    del start_path
    return dict(os.environ)


def _load_dotenv(*, start_path=None, refresh_loaded=False) -> bool:
    """Disable project and global dotenv loading in the managed image."""
    del start_path, refresh_loaded
    _dotenv_loaded_values.clear()
    return False


def _tracing_enabled() -> bool:
    """Keep tracing disabled regardless of mutable runtime/profile state."""
    return False


def _parse_interpreter_ptc(raw):
    """Disable programmatic tool calling from the managed interpreter."""
    del raw
    return False


def _get_provider_kwargs(provider: str, *, model_name: str | None = None) -> dict[str, Any]:
    """Return only the NemoClaw-managed OpenAI-compatible constructor contract."""
    del model_name
    from deepagents_code.model_config import ModelConfig, ModelConfigError
    from deepagents_code._nemoclaw_managed import managed_inference_base_url

    if provider != "openai":
        raise ModelConfigError(
            "Only the NemoClaw-managed OpenAI-compatible provider is enabled"
        )
    # Load once so malformed TOML still fails through the upstream config error
    # path, but do not consume mutable provider classes, credentials, params, or
    # endpoints from it.
    ModelConfig.load()
    return {
        "api_key": "nemoclaw-managed-inference",
        "base_url": managed_inference_base_url(),
        "use_responses_api": False,
    }
'''

MODEL_CONFIG_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
def _nemoclaw_get_class_path(self, provider_name: str):
    """Ignore mutable custom model classes inside the managed image."""
    del self, provider_name
    return None


ModelConfig.get_class_path = _nemoclaw_get_class_path
'''

AGENT_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_create_cli_agent = create_cli_agent


def create_cli_agent(model, assistant_id, *args, **kwargs):
    """Keep secondary model and remote-agent paths on the managed graph."""
    kwargs["rubric_model"] = None
    kwargs["async_subagents"] = None
    return _nemoclaw_original_create_cli_agent(
        model, assistant_id, *args, **kwargs
    )


def _resolve_ptc_option(*args, **kwargs):
    """Disable interpreter programmatic tool calling at the final build boundary."""
    del args, kwargs
    return None


def load_async_subagents(config_path=None):
    """Disable mutable remote subagents and their arbitrary HTTP headers."""
    del config_path
    return []
'''

SUBAGENTS_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_list_subagents = list_subagents


def list_subagents(*args, **kwargs):
    """Ignore project/user subagent model overrides while preserving prompts."""
    subagents = _nemoclaw_original_list_subagents(*args, **kwargs)
    return [{**subagent, "model": None} for subagent in subagents]
'''

HOOKS_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
def _load_hooks() -> list[dict[str, Any]]:
    """Disable user-configured subprocess hooks in the managed harness."""
    global _hooks_config
    _hooks_config = []
    return _hooks_config


def _run_single_hook(command, event, payload_bytes) -> None:
    """Refuse hook execution even if a caller supplies a hook directly."""
    del command, event, payload_bytes
'''

NON_INTERACTIVE_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_run_non_interactive = run_non_interactive


async def run_non_interactive(*args, **kwargs):
    """Enforce the managed headless boundary at the final Python call site."""
    settings.shell_allow_list = None
    kwargs["startup_cmd"] = None
    kwargs["model_params"] = None
    kwargs["profile_override"] = None
    kwargs["sandbox_type"] = "none"
    from deepagents_code._nemoclaw_managed import managed_mcp_config_path

    managed_mcp_config = managed_mcp_config_path()
    has_managed_mcp = managed_mcp_config is not None
    kwargs["mcp_config_path"] = managed_mcp_config if has_managed_mcp else None
    kwargs["no_mcp"] = not has_managed_mcp
    kwargs["trust_project_mcp"] = False
    kwargs["enable_interpreter"] = False
    kwargs["interpreter_ptc"] = None
    kwargs["rubric_model"] = None
    return await _nemoclaw_original_run_non_interactive(*args, **kwargs)


async def _run_startup_command(command, console, *, quiet: bool) -> None:
    """Disable the unapproved startup shell subprocess backend."""
    del command, console, quiet
'''

APPROVAL_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_approval_selection = ApprovalMenu._handle_selection


def _nemoclaw_handle_approval_selection(
    self, option: int, *, reject_message: str | None = None
) -> None:
    """Refuse the thread-wide auto-approval choice without approving this batch."""
    if option == 1:
        self.app.notify(
            "Auto-approval is disabled in NemoClaw-managed sandboxes.",
            severity="warning",
            markup=False,
        )
        return
    _nemoclaw_original_approval_selection(
        self, option, reject_message=reject_message
    )


ApprovalMenu._handle_selection = _nemoclaw_handle_approval_selection
'''

SERVER_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_build_server_env = _build_server_env


def _build_server_env() -> dict[str, str]:
    """Keep the LangGraph API subprocess from starting a PyPI update thread."""
    env = _nemoclaw_original_build_server_env()
    env["LANGGRAPH_NO_VERSION_CHECK"] = "true"
    env["OTEL_ENABLED"] = "false"
    for name in (
        "OPENAI_PROXY",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ):
        env.pop(name, None)
    return env
'''

UPDATE_CHECK_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
async def _run_install_subprocess(*args, **kwargs) -> tuple[bool, str]:
    """Refuse every upstream update/install subprocess in the managed image."""
    del args, kwargs
    return False, "Updates and package installs are managed by NemoClaw"


def set_auto_update(enabled: bool) -> None:
    """Refuse updates to the upstream auto-update preference."""
    del enabled
    raise RuntimeError("Automatic updates are managed by NemoClaw")
'''

OPENAI_CODEX_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
def get_status(*, store_path=None) -> CodexAuthStatus:
    """Never consume ChatGPT OAuth state inside a managed sandbox."""
    return CodexAuthStatus(
        logged_in=False,
        store_path=store_path or default_store_path(),
    )


async def run_browser_login(*args, **kwargs) -> CodexAuthStatus:
    """Refuse ChatGPT OAuth before browser, network, or file activity."""
    del args, kwargs
    raise RuntimeError("ChatGPT OAuth is disabled in NemoClaw-managed sandboxes")


def build_chat_model(*args, **kwargs):
    """Refuse use of preexisting or raced ChatGPT OAuth token files."""
    del args, kwargs
    raise RuntimeError("ChatGPT OAuth is disabled in NemoClaw-managed sandboxes")
'''

AUTH_UI_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_NEMOCLAW_AUTH_DISABLED_MESSAGE = (
    "Credential entry is disabled. Configure credentials through NemoClaw on the host."
)


def _nemoclaw_auth_prompt_compose(self):
    del self
    yield Static(_NEMOCLAW_AUTH_DISABLED_MESSAGE)


def _nemoclaw_auth_prompt_mount(self) -> None:
    self.app.notify(_NEMOCLAW_AUTH_DISABLED_MESSAGE, severity="warning", markup=False)
    self.call_after_refresh(lambda: self.dismiss(AuthResult.CANCELLED))


def _nemoclaw_auth_manager_compose(self):
    del self
    yield Static(_NEMOCLAW_AUTH_DISABLED_MESSAGE)


def _nemoclaw_auth_manager_mount(self) -> None:
    self.app.notify(_NEMOCLAW_AUTH_DISABLED_MESSAGE, severity="warning", markup=False)
    self.call_after_refresh(lambda: self.dismiss(None))


AuthPromptScreen.compose = _nemoclaw_auth_prompt_compose
AuthPromptScreen.on_mount = _nemoclaw_auth_prompt_mount
AuthManagerScreen.compose = _nemoclaw_auth_manager_compose
AuthManagerScreen.on_mount = _nemoclaw_auth_manager_mount
'''

CODEX_UI_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_NEMOCLAW_CODEX_DISABLED_MESSAGE = (
    "ChatGPT OAuth is disabled. Configure credentials through NemoClaw on the host."
)


def _nemoclaw_codex_compose(self):
    del self
    yield Static(_NEMOCLAW_CODEX_DISABLED_MESSAGE)


def _nemoclaw_codex_mount(self) -> None:
    self.app.notify(_NEMOCLAW_CODEX_DISABLED_MESSAGE, severity="warning", markup=False)
    self.call_after_refresh(lambda: self.dismiss(False))


CodexAuthScreen.compose = _nemoclaw_codex_compose
CodexAuthScreen.on_mount = _nemoclaw_codex_mount
'''

MODEL_SELECTOR_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_select_with_auth_check = ModelSelectorScreen._select_with_auth_check


def _nemoclaw_select_with_auth_check(self, model_spec: str, provider: str) -> None:
    if provider:
        if provider != "openai":
            self.app.notify(
                "Only the NemoClaw-managed OpenAI-compatible provider is enabled.",
                severity="warning",
                markup=False,
            )
            return
        from deepagents_code.config_manifest import (
            is_provider_package_installed,
            provider_install_extra,
        )

        extra = provider_install_extra(provider)
        if extra is not None and not is_provider_package_installed(provider):
            self.app.notify(
                "Provider installs are managed by NemoClaw on the host.",
                severity="warning",
                markup=False,
            )
            return
        if get_provider_auth_status(provider).blocks_start:
            self.app.notify(
                "Credential entry is disabled. Configure credentials through NemoClaw on the host.",
                severity="warning",
                markup=False,
            )
            return
    _nemoclaw_original_select_with_auth_check(self, model_spec, provider)


ModelSelectorScreen._select_with_auth_check = _nemoclaw_select_with_auth_check
'''

HELPER_SOURCE = r'''# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
# NemoClaw-managed Deep Agents Code hardening v2.
"""Runtime invariants for the NemoClaw-managed Deep Agents Code image."""

from __future__ import annotations

import json
import ipaddress
import os
import re
import stat
from pathlib import Path
from urllib.parse import urlparse

_MANAGED_STATE_DIR = Path("/sandbox/.deepagents/.state")
_AUTH_FILE = _MANAGED_STATE_DIR / "auth.json"
_CODEX_AUTH_FILE = _MANAGED_STATE_DIR / "chatgpt-auth.json"
_MCP_CONFIG_FILE = Path("/sandbox/.deepagents/.mcp.json")
_INFERENCE_BASE_URL_FILE = Path(
    "/usr/local/share/nemoclaw/dcode-inference-base-url"
)
_MANAGED_FILE_OWNER_UID = 0
_CREDENTIAL_NAME = re.compile(
    r"(?:^|_)(?:API_KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL)$",
    re.IGNORECASE,
)
_CREDENTIAL_ENV_NAMES = {
    "LANGSMITH_RUNS_ENDPOINTS",
    "LANGCHAIN_RUNS_ENDPOINTS",
    "OTEL_EXPORTER_OTLP_ENDPOINT",
    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
    "OTEL_EXPORTER_OTLP_HEADERS",
    "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
}
_OPENSHELL_ENV_PLACEHOLDER_PREFIX = "openshell:resolve:env:"
_MCP_SERVER_NAME = re.compile(r"[A-Za-z][A-Za-z0-9_-]{0,63}")
_MCP_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,127}")
_MCP_DNS_NAME = re.compile(
    r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
)
_SECRET_PATTERNS = tuple(
    (platform, re.compile(pattern, flags))
    for platform, pattern, flags in (
        (None, r"(?:sk-proj-|sk-ant-)[A-Za-z0-9_-]{10,}", 0),
        (None, r"sk-[A-Za-z0-9_-]{20,}", 0),
        (None, r"(?:nvapi-|nvcf-|ghp_|hf_|glpat-|gsk_|pypi-|tvly-)[A-Za-z0-9_-]{10,}", 0),
        (None, r"github_pat_[A-Za-z0-9_]{30,}", 0),
        ("slack", r"xox[bpas]-[A-Za-z0-9_-]{10,}", 0),
        ("slack", r"xapp-[A-Za-z0-9_-]{10,}", 0),
        (None, r"A(?:K|S)IA[A-Z0-9]{16}", 0),
        ("telegram", r"(?:bot)?[0-9]{8,10}:[A-Za-z0-9_-]{35}", 0),
        ("discord", r"[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}", 0),
        (None, r"Bearer\s+[A-Za-z0-9_.+/=-]{10,}", re.IGNORECASE),
        (None, r"(?:_KEY|API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)[=:\s]['\"]?[A-Za-z0-9_.+/=-]{10,}", re.IGNORECASE),
        (None, r"lsv2_(?:pt|sk)_[A-Za-z0-9]{10,}(?:_[A-Za-z0-9]+)*", 0),
        (None, r"-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*-----END [^-\r\n]*PRIVATE KEY-----", 0),
    )
)


def _contains_secret_shape(value: str) -> bool:
    return any(pattern.search(value) for _platform, pattern in _SECRET_PATTERNS)


def _contains_other_platform_secret(value: str, platform: str) -> bool:
    return any(
        pattern.search(value)
        for pattern_platform, pattern in _SECRET_PATTERNS
        if pattern_platform != platform
    )


def _is_openshell_placeholder_for_name(name: str, value: str) -> bool:
    if name == "OPENSHELL_TLS_KEY" or not _MCP_ENV_NAME.fullmatch(name):
        return False
    canonical = f"{_OPENSHELL_ENV_PLACEHOLDER_PREFIX}{name}"
    versioned = re.fullmatch(
        rf"{re.escape(_OPENSHELL_ENV_PLACEHOLDER_PREFIX)}v[0-9]{{1,20}}_{re.escape(name)}",
        value,
    )
    return value == canonical or versioned is not None


def _is_managed_value(name: str, value: str) -> bool:
    if name == "DEEPAGENTS_CODE_OPENAI_API_KEY":
        return value == "nemoclaw-managed-inference"
    if name == "OPENSHELL_TLS_KEY":
        return value == "/etc/openshell/tls/client/tls.key"
    if name == "SLACK_BOT_TOKEN":
        return bool(re.fullmatch(r"xoxb-[A-Za-z0-9_-]{10,}", value)) and not _contains_other_platform_secret(value, "slack")
    if name == "SLACK_APP_TOKEN":
        return bool(re.fullmatch(r"xapp-[A-Za-z0-9_-]{10,}", value)) and not _contains_other_platform_secret(value, "slack")
    if name == "TELEGRAM_BOT_TOKEN":
        return bool(re.fullmatch(r"(?:bot)?[0-9]{8,10}:[A-Za-z0-9_-]{35}", value)) and not _contains_other_platform_secret(value, "telegram")
    if name == "DISCORD_BOT_TOKEN":
        return bool(
            re.fullmatch(r"[A-Za-z0-9]{24}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}", value)
        ) and not _contains_other_platform_secret(value, "discord")
    return False


def _assert_safe_environment() -> None:
    for name, value in os.environ.items():
        if _OPENSHELL_ENV_PLACEHOLDER_PREFIX in value:
            if _is_openshell_placeholder_for_name(name, value):
                continue
            raise RuntimeError(
                f"runtime environment variable {name} contains an invalid "
                "OpenShell credential placeholder"
            )
        if _is_managed_value(name, value):
            continue
        if _contains_secret_shape(value) or (
            len(value) >= 10 and _CREDENTIAL_NAME.search(name)
        ) or (
            bool(value) and name.upper() in _CREDENTIAL_ENV_NAMES
        ):
            raise RuntimeError(
                f"runtime environment variable {name} contains a credential; "
                "use NemoClaw credential handling"
            )


def _assert_safe_auth_state() -> None:
    if _CODEX_AUTH_FILE.exists() or _CODEX_AUTH_FILE.is_symlink():
        raise RuntimeError(
            "chatgpt-auth.json is not allowed in a NemoClaw-managed sandbox"
        )
    if not _AUTH_FILE.exists() and not _AUTH_FILE.is_symlink():
        return
    if _AUTH_FILE.is_symlink():
        raise RuntimeError("auth.json must not be a symlink in a managed sandbox")
    try:
        data = json.loads(_AUTH_FILE.read_text(encoding="utf-8"))
    except Exception as exc:
        raise RuntimeError(
            "auth.json is unreadable or malformed in a NemoClaw-managed sandbox"
        ) from exc
    credentials = data.get("credentials") if isinstance(data, dict) else None
    if credentials:
        raise RuntimeError(
            "auth.json contains credentials; use NemoClaw credential handling"
        )


def _validate_managed_mcp_url(value: object) -> None:
    if not isinstance(value, str) or not value or len(value) > 2048:
        raise RuntimeError("managed MCP server URL is invalid")
    if value != value.strip() or any(ord(character) < 32 for character in value):
        raise RuntimeError("managed MCP server URL is invalid")
    if any(character in value for character in ("%", "\\", "*", "[", "]", "{", "}", ";")):
        raise RuntimeError("managed MCP server URL is not canonical")
    parsed = urlparse(value)
    if (
        parsed.scheme != "https"
        or not parsed.netloc
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.params
        or parsed.query
        or parsed.fragment
        or not parsed.path.startswith("/")
        or "//" in parsed.path
    ):
        raise RuntimeError("managed MCP server URL is invalid")
    try:
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("managed MCP server URL port is invalid") from exc
    if port is not None and not 1 <= port <= 65535:
        raise RuntimeError("managed MCP server URL port is invalid")
    hostname = parsed.hostname
    expected_netloc = hostname if port is None else f"{hostname}:{port}"
    if parsed.netloc != expected_netloc:
        raise RuntimeError("managed MCP server URL hostname is not canonical")
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        if (
            hostname != hostname.lower()
            or hostname.endswith(".")
            or not _MCP_DNS_NAME.fullmatch(hostname)
            or hostname == "localhost"
            or hostname.endswith((".localhost", ".local", ".internal"))
        ):
            raise RuntimeError("managed MCP server URL hostname is invalid")
    else:
        if address.version != 4 or not address.is_global:
            raise RuntimeError("managed MCP server URL address is not public IPv4")
    if _contains_secret_shape(parsed.path):
        raise RuntimeError("managed MCP server URL path contains credential-shaped data")


def _validate_managed_mcp_entry(server: object, entry: object) -> None:
    if not isinstance(server, str) or not _MCP_SERVER_NAME.fullmatch(server):
        raise RuntimeError("managed MCP config contains an invalid server name")
    if not isinstance(entry, dict) or set(entry) != {"type", "url", "headers"}:
        raise RuntimeError(f"managed MCP server {server} has an invalid shape")
    if entry["type"] != "http":
        raise RuntimeError(f"managed MCP server {server} must use HTTP transport")
    _validate_managed_mcp_url(entry["url"])
    headers = entry["headers"]
    if not isinstance(headers, dict) or set(headers) != {"Authorization"}:
        raise RuntimeError(f"managed MCP server {server} has invalid headers")
    authorization = headers["Authorization"]
    if not isinstance(authorization, str) or not authorization.startswith("Bearer "):
        raise RuntimeError(f"managed MCP server {server} has invalid authorization")
    placeholder = authorization.removeprefix("Bearer ")
    if not placeholder.startswith(_OPENSHELL_ENV_PLACEHOLDER_PREFIX):
        raise RuntimeError(f"managed MCP server {server} must use an OpenShell placeholder")
    suffix = placeholder.removeprefix(_OPENSHELL_ENV_PLACEHOLDER_PREFIX)
    match = re.fullmatch(r"(?:v[0-9]{1,20}_)?([A-Za-z_][A-Za-z0-9_]{0,127})", suffix)
    if match is None or not _is_openshell_placeholder_for_name(match.group(1), placeholder):
        raise RuntimeError(f"managed MCP server {server} has an invalid OpenShell placeholder")


def managed_mcp_config_path() -> str | None:
    """Return only a complete, strict, HTTP-only NemoClaw MCP config."""
    path = _MCP_CONFIG_FILE
    if not path.exists() and not path.is_symlink():
        return None
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("managed MCP config is missing or unsafe")
    try:
        metadata = path.stat()
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError("managed MCP config is unreadable") from exc
    if metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) != 0o600:
        raise RuntimeError("managed MCP config has unsafe ownership or mode")
    if not raw or len(raw.encode("utf-8")) > 262144:
        raise RuntimeError("managed MCP config has invalid size")
    try:
        data = json.loads(raw)
    except Exception as exc:
        raise RuntimeError("managed MCP config is malformed") from exc
    if not isinstance(data, dict) or set(data) != {"mcpServers"}:
        raise RuntimeError("managed MCP config must contain only mcpServers")
    servers = data["mcpServers"]
    if not isinstance(servers, dict) or not servers or len(servers) > 64:
        raise RuntimeError("managed MCP config has an invalid server map")
    for server, entry in servers.items():
        _validate_managed_mcp_entry(server, entry)
    return str(path)


def managed_inference_base_url() -> str:
    """Read and validate the root-owned inference route baked into the image."""
    path = _INFERENCE_BASE_URL_FILE
    if not path.is_file() or path.is_symlink():
        raise RuntimeError("managed inference base URL file is missing or unsafe")
    try:
        metadata = path.stat()
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError("managed inference base URL file is unreadable") from exc
    if (
        metadata.st_uid != _MANAGED_FILE_OWNER_UID
        or stat.S_IMODE(metadata.st_mode) != 0o444
    ):
        raise RuntimeError("managed inference base URL file has unsafe ownership or mode")
    value = raw.rstrip("\n")
    if not value or len(value) > 2048 or raw not in {value, f"{value}\n"}:
        raise RuntimeError("managed inference base URL file has invalid contents")
    if value != value.strip() or any(ord(character) < 32 for character in value):
        raise RuntimeError("managed inference base URL file has invalid contents")
    parsed = urlparse(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("managed inference base URL is invalid")
    return value


def assert_safe_runtime() -> None:
    """Reject unmanaged runtime credentials before dcode bootstraps settings."""
    _assert_safe_environment()
    _assert_safe_auth_state()
    base_url = managed_inference_base_url()
    os.environ["OPENAI_BASE_URL"] = base_url
    os.environ["NEMOCLAW_INFERENCE_BASE_URL"] = base_url
    os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "true"
    os.environ["OTEL_ENABLED"] = "false"
    for name in (
        "OPENAI_PROXY",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_HEADERS",
        "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    ):
        os.environ.pop(name, None)
'''


def _top_level_functions(tree: ast.Module) -> set[str]:
    return {
        node.name
        for node in tree.body
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
    }


def _class_methods(tree: ast.Module, class_name: str) -> set[str]:
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            return {
                child.name
                for child in node.body
                if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef))
            }
    raise RuntimeError(f"Required upstream class {class_name} was not found")


def _require_functions(path: Path, text: str, names: set[str]) -> ast.Module:
    tree = ast.parse(text, filename=str(path))
    missing = names - _top_level_functions(tree)
    if missing:
        raise RuntimeError(f"Required upstream functions missing in {path}: {sorted(missing)}")
    return tree


def _require_methods(
    path: Path, text: str, class_name: str, names: set[str]
) -> ast.Module:
    tree = ast.parse(text, filename=str(path))
    missing = names - _class_methods(tree, class_name)
    if missing:
        raise RuntimeError(
            f"Required upstream methods missing in {path}::{class_name}: {sorted(missing)}"
        )
    return tree


def _append_patch(path: Path, text: str, patch: str) -> str:
    if PATCH_MARKER in text:
        return text
    patched = f"{text.rstrip()}\n{patch.lstrip()}"
    compile(patched, str(path), "exec")
    return patched


def _package_root() -> Path:
    spec = importlib.util.find_spec("deepagents_code")
    if spec is None or not spec.submodule_search_locations:
        raise RuntimeError("deepagents_code package not found")
    roots = list(spec.submodule_search_locations)
    if len(roots) != 1:
        raise RuntimeError(f"Expected one deepagents_code package root, found {roots}")
    return Path(roots[0])


def main() -> None:
    actual_version = importlib.metadata.version("deepagents-code")
    if actual_version != EXPECTED_DCODE_VERSION:
        raise RuntimeError(
            f"Expected deepagents-code=={EXPECTED_DCODE_VERSION}, found {actual_version}"
        )

    root = _package_root()
    paths = {
        "entrypoint": root / "__main__.py",
        "main": root / "main.py",
        "app": root / "app.py",
        "auth_store": root / "auth_store.py",
        "config": root / "config.py",
        "model_config": root / "model_config.py",
        "agent": root / "agent.py",
        "update_check": root / "update_check.py",
        "openai_codex": root / "integrations" / "openai_codex.py",
        "auth_ui": root / "widgets" / "auth.py",
        "codex_ui": root / "widgets" / "codex_auth.py",
        "model_selector": root / "widgets" / "model_selector.py",
        "approval": root / "widgets" / "approval.py",
        "server": root / "server.py",
        "subagents": root / "subagents.py",
        "hooks": root / "hooks.py",
        "non_interactive": root / "non_interactive.py",
    }
    texts = {name: path.read_text(encoding="utf-8") for name, path in paths.items()}

    marker_states = {PATCH_MARKER in text for text in texts.values()}
    helper_path = root / "_nemoclaw_managed.py"
    if marker_states == {True}:
        if not helper_path.is_file() or PATCH_MARKER not in helper_path.read_text(
            encoding="utf-8"
        ):
            raise RuntimeError("Managed package patch is partial: helper is missing")
        return
    if marker_states != {False} or helper_path.exists():
        raise RuntimeError("Managed package patch is partial; refusing mixed source state")

    _require_functions(paths["main"], texts["main"], {"parse_args"})
    _require_methods(
        paths["app"],
        texts["app"],
        "DeepAgentsApp",
        {
            "_check_for_updates",
            "_enter_service_api_key",
            "_handle_auto_update_toggle",
            "_handle_command",
            "_handle_install_command",
            "_handle_install_package",
            "_handle_update_action",
            "_handle_update_command",
            "_install_extra",
            "_prompt_launch_tavily",
            "_prompt_model_auth_if_needed",
            "_show_auth_manager",
            "_start_mcp_login",
            "_switch_model",
            "_set_rubric_model",
            "_on_auto_approve_enabled",
            "action_toggle_auto_approve",
        },
    )
    _require_functions(
        paths["auth_store"], texts["auth_store"], {"load_credentials", "set_stored_key"}
    )
    _require_functions(
        paths["config"],
        texts["config"],
        {
            "_get_provider_kwargs",
            "_load_dotenv",
            "_parse_interpreter_ptc",
            "_preview_dotenv_environ",
            "_tracing_enabled",
        },
    )
    _require_methods(
        paths["model_config"],
        texts["model_config"],
        "ModelConfig",
        {"get_class_path"},
    )
    _require_functions(
        paths["agent"],
        texts["agent"],
        {"create_cli_agent", "_resolve_ptc_option", "load_async_subagents"},
    )
    update_tree = _require_functions(
        paths["update_check"],
        texts["update_check"],
        {"_run_install_subprocess", "set_auto_update"},
    )
    install_calls = sum(
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id == "_run_install_subprocess"
        for node in ast.walk(update_tree)
    )
    if install_calls != 5:
        raise RuntimeError(
            "Expected five Deep Agents Code install-subprocess call sites, "
            f"found {install_calls}"
        )
    _require_functions(
        paths["openai_codex"],
        texts["openai_codex"],
        {"build_chat_model", "get_status", "run_browser_login"},
    )
    _require_methods(
        paths["auth_ui"], texts["auth_ui"], "AuthPromptScreen", {"compose", "on_mount"}
    )
    _require_methods(
        paths["auth_ui"], texts["auth_ui"], "AuthManagerScreen", {"compose", "on_mount"}
    )
    _require_methods(
        paths["codex_ui"], texts["codex_ui"], "CodexAuthScreen", {"compose", "on_mount"}
    )
    _require_methods(
        paths["model_selector"],
        texts["model_selector"],
        "ModelSelectorScreen",
        {"_select_with_auth_check"},
    )
    _require_methods(
        paths["approval"],
        texts["approval"],
        "ApprovalMenu",
        {"_handle_selection"},
    )
    _require_functions(paths["server"], texts["server"], {"_build_server_env"})
    _require_functions(paths["subagents"], texts["subagents"], {"list_subagents"})
    _require_functions(
        paths["hooks"], texts["hooks"], {"_load_hooks", "_run_single_hook"}
    )
    _require_functions(
        paths["non_interactive"],
        texts["non_interactive"],
        {"run_non_interactive", "_run_startup_command"},
    )

    if texts["main"].count(MAIN_MARKER) != 1:
        raise RuntimeError(
            f"Expected one Deep Agents Code parser marker in {paths['main']}"
        )
    if texts["entrypoint"].count(ENTRYPOINT_MARKER) != 1:
        raise RuntimeError(
            f"Expected one Deep Agents Code entrypoint marker in {paths['entrypoint']}"
        )
    transformed = dict(texts)
    transformed["entrypoint"] = texts["entrypoint"].replace(
        ENTRYPOINT_MARKER, ENTRYPOINT_PATCH, 1
    )
    transformed["main"] = texts["main"].replace(
        MAIN_MARKER, f"{MAIN_MARKER}{MAIN_PATCH}", 1
    )
    transformed["app"] = _append_patch(paths["app"], texts["app"], APP_PATCH)
    transformed["auth_store"] = _append_patch(
        paths["auth_store"], texts["auth_store"], AUTH_STORE_PATCH
    )
    transformed["config"] = _append_patch(paths["config"], texts["config"], CONFIG_PATCH)
    transformed["model_config"] = _append_patch(
        paths["model_config"], texts["model_config"], MODEL_CONFIG_PATCH
    )
    transformed["agent"] = _append_patch(paths["agent"], texts["agent"], AGENT_PATCH)
    transformed["update_check"] = _append_patch(
        paths["update_check"], texts["update_check"], UPDATE_CHECK_PATCH
    )
    transformed["openai_codex"] = _append_patch(
        paths["openai_codex"], texts["openai_codex"], OPENAI_CODEX_PATCH
    )
    transformed["auth_ui"] = _append_patch(
        paths["auth_ui"], texts["auth_ui"], AUTH_UI_PATCH
    )
    transformed["codex_ui"] = _append_patch(
        paths["codex_ui"], texts["codex_ui"], CODEX_UI_PATCH
    )
    transformed["model_selector"] = _append_patch(
        paths["model_selector"], texts["model_selector"], MODEL_SELECTOR_PATCH
    )
    transformed["approval"] = _append_patch(
        paths["approval"], texts["approval"], APPROVAL_PATCH
    )
    transformed["server"] = _append_patch(
        paths["server"], texts["server"], SERVER_PATCH
    )
    transformed["subagents"] = _append_patch(
        paths["subagents"], texts["subagents"], SUBAGENTS_PATCH
    )
    transformed["hooks"] = _append_patch(
        paths["hooks"], texts["hooks"], HOOKS_PATCH
    )
    transformed["non_interactive"] = _append_patch(
        paths["non_interactive"],
        texts["non_interactive"],
        NON_INTERACTIVE_PATCH,
    )

    for name, text in transformed.items():
        compile(text, str(paths[name]), "exec")
    compile(HELPER_SOURCE, str(helper_path), "exec")
    for name, text in transformed.items():
        paths[name].write_text(text, encoding="utf-8")
    helper_path.write_text(HELPER_SOURCE, encoding="utf-8")


if __name__ == "__main__":
    main()
