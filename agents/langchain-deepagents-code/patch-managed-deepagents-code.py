# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Patch the pinned Deep Agents Code package for NemoClaw-managed posture."""

# Source-of-truth review for this pinned third-party patch boundary:
# invalidState: upstream entrypoints can independently enable credential stores,
# ambient MCP discovery, update/install flows, first-run model selection,
# optional LangGraph CLI analytics, or child-process config paths that bypass
# NemoClaw's managed inference, policy, and integrity-bound MCP boundaries.
# sourceBoundary: deepagents-code owns those Python entrypoints and child env;
# langgraph-cli owns the analytics opt-out; NemoClaw owns the sandbox image
# posture and therefore validates every patched symbol before build.
# whyNotSourceFix: upstream 0.1.34 has no single managed-runtime hook that can
# enforce these constraints across CLI, UI, headless, server, and restart paths.
# regressionTest: the exact version plus AST symbol/method gates fail the image
# build on drift, while hostile analytics values exercise patched entrypoints and
# the server start/restart override paths.
# removalCondition: replace these sites only when a pinned upstream release offers
# equivalent discovery-free, credential-free, update-disabled, analytics-disabled
# managed hooks before every LangGraph process starts.

from __future__ import annotations

import ast
import importlib.metadata
import importlib.util
from pathlib import Path

EXPECTED_DCODE_VERSION = "0.1.34"
PATCH_MARKER = "NemoClaw-managed Deep Agents Code hardening v2."
TOOL_DISCLOSURE_PATCH_MARKER = "NemoClaw-managed progressive tool disclosure."
OBSERVABILITY_PATCH_MARKER = "NemoClaw-managed backend-neutral observability."
MIDDLEWARE_MODULE = "progressive_tool_disclosure.py"
OBSERVABILITY_MODULE = "nemoclaw_observability.py"
MANAGED_RUNTIME_SOURCE_PATH = Path(__file__).with_name("managed-dcode-runtime.py")

MAIN_MARKER = "    args = parser.parse_args()\n"
ENTRYPOINT_MARKER = "from deepagents_code.main import cli_main\n"
ENTRYPOINT_PATCH = '''# NemoClaw-managed Deep Agents Code hardening v2.
import os

os.environ["HOME"] = "/sandbox"
os.environ["DEEPAGENTS_CODE_AUTO_UPDATE"] = "0"
os.environ["DEEPAGENTS_CODE_NO_UPDATE_CHECK"] = "1"
os.environ["LANGGRAPH_NO_VERSION_CHECK"] = "true"
os.environ["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"
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
    os.environ["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"
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

    from deepagents_code._nemoclaw_managed import (
        assert_safe_runtime as _nemoclaw_assert_safe_runtime,
        managed_auto_approval_enabled as _nemoclaw_managed_auto_approval_enabled,
        managed_mcp_config_path as _nemoclaw_managed_mcp_config_path,
    )

    nemoclaw_auto_approval_enabled = _nemoclaw_managed_auto_approval_enabled()

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
    if getattr(args, "auto_approve", False) and not nemoclaw_auto_approval_enabled:
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
    # Load only NemoClaw's dedicated projection. The helper canonicalizes it
    # into a process-local integrity-bound snapshot; user/project discovery is
    # disabled separately in the patched MCP loader.
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
    if hasattr(args, "auto_approve") and not nemoclaw_auto_approval_enabled:
        args.auto_approve = False
    if hasattr(args, "rubric_model"):
        args.rubric_model = None
    if hasattr(args, "acp"):
        args.acp = False
    if hasattr(args, "startup_cmd"):
        args.startup_cmd = None

    _nemoclaw_assert_safe_runtime()
    if (
        getattr(args, "auto_approve", False)
        and nemoclaw_auto_approval_enabled
        and not getattr(args, "non_interactive_message", None)
    ):
        print(
            "WARNING: Auto-approval is enabled for this thread. Tool calls, "
            "including shell commands, may execute without further confirmation "
            "inside the sandbox.",
            file=sys.stderr,
        )
'''

APP_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_NEMOCLAW_MANAGED_UI_MESSAGE = (
    "NemoClaw manages credentials, dependencies, updates, and MCP for this "
    "sandbox. Use NemoClaw policy/configuration on the host instead."
)
_NEMOCLAW_AUTO_APPROVAL_DISABLED_MESSAGE = (
    "Auto-approval is disabled in NemoClaw-managed sandboxes."
)
_NEMOCLAW_AUTO_APPROVAL_WARNING = (
    "Auto-approval is enabled for this thread. Tool calls, including shell "
    "commands, may execute without further confirmation inside the sandbox."
)
_nemoclaw_original_handle_command = DeepAgentsApp._handle_command
_nemoclaw_original_resume_thread = DeepAgentsApp._resume_thread
_nemoclaw_original_restart_server_for_agent_swap = (
    DeepAgentsApp._restart_server_for_agent_swap
)
_nemoclaw_original_switch_model = DeepAgentsApp._switch_model
_nemoclaw_original_on_auto_approve_enabled = (
    DeepAgentsApp._on_auto_approve_enabled
)
_nemoclaw_original_action_toggle_auto_approve = (
    DeepAgentsApp.action_toggle_auto_approve
)
_nemoclaw_original_absolutize_launch_relative_path = (
    DeepAgentsApp._absolutize_launch_relative_path
)


async def _nemoclaw_run_thread_transition(self, operation, *args) -> None:
    _nemoclaw_reset_thread_auto_approval(self)
    await operation(self, *args)


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
    if normalized not in {"/clear", "/force-clear"}:
        await _nemoclaw_original_handle_command(self, command)
        return
    await _nemoclaw_run_thread_transition(
        self, _nemoclaw_original_handle_command, command
    )


async def _nemoclaw_resume_thread(self, thread_id: str) -> None:
    await _nemoclaw_run_thread_transition(
        self, _nemoclaw_original_resume_thread, thread_id
    )


async def _nemoclaw_restart_server_for_agent_swap(
    self, agent_name: str
) -> None:
    await _nemoclaw_run_thread_transition(
        self, _nemoclaw_original_restart_server_for_agent_swap, agent_name
    )


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


def _nemoclaw_absolutize_launch_relative_path(
    raw: object,
    launch_cwd: Path,
) -> str | None:
    """Keep the managed descriptor path from resolving to its deleted inode."""
    from deepagents_code._nemoclaw_managed import is_managed_mcp_config_path

    if is_managed_mcp_config_path(raw):
        return raw
    return _nemoclaw_original_absolutize_launch_relative_path(raw, launch_cwd)


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


def _nemoclaw_auto_approval_is_allowed() -> bool:
    from deepagents_code._nemoclaw_managed import managed_auto_approval_enabled

    return managed_auto_approval_enabled()


def _nemoclaw_reset_thread_auto_approval(self) -> None:
    self._auto_approve = False
    if getattr(self, "_status_bar", None) is not None:
        self._status_bar.set_auto_approve(enabled=False)
    if getattr(self, "_session_state", None) is not None:
        self._session_state.auto_approve = False
        self._session_state.approval_mode_key = None


async def _nemoclaw_block_auto_approve(self) -> None:
    _nemoclaw_reset_thread_auto_approval(self)
    self.notify(
        _NEMOCLAW_AUTO_APPROVAL_DISABLED_MESSAGE,
        severity="warning",
        markup=False,
    )


def _nemoclaw_notify_auto_approval_warning(self) -> None:
    self.notify(
        _NEMOCLAW_AUTO_APPROVAL_WARNING,
        severity="warning",
        markup=False,
    )


async def _nemoclaw_on_auto_approve_enabled(self) -> None:
    if not _nemoclaw_auto_approval_is_allowed():
        await _nemoclaw_block_auto_approve(self)
        return
    await _nemoclaw_original_on_auto_approve_enabled(self)
    if getattr(self, "_auto_approve", False):
        _nemoclaw_notify_auto_approval_warning(self)


async def _nemoclaw_action_toggle_auto_approve(self) -> None:
    if not _nemoclaw_auto_approval_is_allowed():
        await _nemoclaw_block_auto_approve(self)
        return
    was_enabled = bool(getattr(self, "_auto_approve", False))
    await _nemoclaw_original_action_toggle_auto_approve(self)
    if not was_enabled and getattr(self, "_auto_approve", False):
        _nemoclaw_notify_auto_approval_warning(self)


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


async def _nemoclaw_skip_launch_model(
    self,
) -> "tuple[bool, tuple[str, str] | None]":
    """Skip model picker during first-run; NemoClaw owns model configuration."""
    return (False, None)


def _nemoclaw_skip_launch_dependencies_prompt(self):
    """Return a pre-resolved dependency result that skips the model picker.

    The mount path pre-builds the model screen and passes it as
    continue_screen to the name prompt, bypassing
    _prompt_launch_dependencies_then_model. This override returns None
    as the screen (so no model picker is pushed after the name prompt)
    and a pre-resolved future with (False, None).
    """
    import asyncio
    loop = asyncio.get_running_loop()
    result_future = loop.create_future()
    result_future.set_result((False, None))
    return None, result_future


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
DeepAgentsApp._resume_thread = _nemoclaw_resume_thread
DeepAgentsApp._restart_server_for_agent_swap = (
    _nemoclaw_restart_server_for_agent_swap
)
DeepAgentsApp._switch_model = _nemoclaw_switch_model
DeepAgentsApp._absolutize_launch_relative_path = staticmethod(
    _nemoclaw_absolutize_launch_relative_path
)
DeepAgentsApp._check_for_updates = _nemoclaw_check_for_updates
DeepAgentsApp._handle_update_command = _nemoclaw_block_update_command
DeepAgentsApp._handle_install_command = _nemoclaw_block_install_command
DeepAgentsApp._install_extra = _nemoclaw_block_install_extra
DeepAgentsApp._handle_install_package = _nemoclaw_block_install_package
DeepAgentsApp._handle_auto_update_toggle = _nemoclaw_block_auto_update
DeepAgentsApp._on_auto_approve_enabled = _nemoclaw_on_auto_approve_enabled
DeepAgentsApp.action_toggle_auto_approve = (
    _nemoclaw_action_toggle_auto_approve
)
DeepAgentsApp._set_rubric_model = _nemoclaw_block_rubric_model
DeepAgentsApp._prompt_launch_tavily = _nemoclaw_skip_launch_tavily
DeepAgentsApp._prompt_launch_dependencies_then_model = _nemoclaw_skip_launch_model
DeepAgentsApp._build_launch_dependencies_prompt = _nemoclaw_skip_launch_dependencies_prompt
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

# Source-of-truth boundary: pinned upstream deepagents-code==0.1.34 cannot inject
# managed progressive-disclosure or Relay middleware into both main and subagent
# graphs, nor attach a metadata-only callback to the compiled graph. Without this
# root-owned image patch, those graphs omit NemoClaw's runtime controls; this repo
# cannot change the third-party package source. Patcher shape guards, direct-patch
# tests, progressive-disclosure tests, and observability conformance tests fail
# closed on upstream drift. Remove each injection once an upstream agent-factory
# API can preserve the managed MCP, credential, approval, executor, sandbox,
# private checkpoint-state, bounded model/tool content, and metadata-only graph
# trace boundaries end to end.
AGENT_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
# NemoClaw-managed progressive tool disclosure.
# NemoClaw-managed backend-neutral observability.
from contextvars import ContextVar as _NemoClawContextVar

_nemoclaw_original_create_cli_agent = create_cli_agent
_nemoclaw_original_create_deep_agent = globals().get("create_deep_agent")
_nemoclaw_progressive_disclosure_active = _NemoClawContextVar(
    "nemoclaw_progressive_disclosure_active", default=False
)
_nemoclaw_observability_active = _NemoClawContextVar(
    "nemoclaw_observability_active", default=False
)


def _nemoclaw_create_deep_agent(*args, **kwargs):
    """Install managed middleware in the main and local subagent graphs."""
    if _nemoclaw_original_create_deep_agent is None:
        raise RuntimeError("Deep Agents Code create_deep_agent boundary is unavailable")
    progressive_active = _nemoclaw_progressive_disclosure_active.get()
    observability_active = _nemoclaw_observability_active.get()
    if not progressive_active and not observability_active:
        return _nemoclaw_original_create_deep_agent(*args, **kwargs)

    middleware = list(kwargs.get("middleware") or ())
    if progressive_active:
        from deepagents_code.progressive_tool_disclosure import (
            ProgressiveToolDisclosureMiddleware,
        )

        middleware.append(ProgressiveToolDisclosureMiddleware())
    if observability_active:
        from deepagents_code.nemoclaw_observability import new_relay_middleware

        middleware.append(new_relay_middleware())
    kwargs["middleware"] = middleware

    subagents = kwargs.get("subagents")
    if subagents:
        patched_subagents = []
        for subagent in subagents:
            if isinstance(subagent, dict):
                subagent_middleware = list(subagent.get("middleware") or ())
                if progressive_active:
                    subagent_middleware.append(ProgressiveToolDisclosureMiddleware())
                if observability_active:
                    subagent_middleware.append(new_relay_middleware())
                subagent = {**subagent, "middleware": subagent_middleware}
            patched_subagents.append(subagent)
        kwargs["subagents"] = patched_subagents

    return _nemoclaw_original_create_deep_agent(*args, **kwargs)


if _nemoclaw_original_create_deep_agent is not None:
    create_deep_agent = _nemoclaw_create_deep_agent


def create_cli_agent(model, assistant_id, *args, **kwargs):
    """Keep managed graph posture, disclosure, and observability boundaries."""
    kwargs["rubric_model"] = None
    kwargs["async_subagents"] = None
    from deepagents_code.progressive_tool_disclosure import (
        assert_unique_callable_tool_names,
    )

    assert_unique_callable_tool_names(
        kwargs.get("tools"), kwargs.get("mcp_server_info")
    )
    has_loaded_mcp_tools = any(
        getattr(info, "tools", ()) for info in kwargs.get("mcp_server_info") or ()
    )
    if has_loaded_mcp_tools:
        from deepagents_code.progressive_tool_disclosure import (
            progressive_tool_disclosure_enabled,
        )

        progressive_active = progressive_tool_disclosure_enabled()
    else:
        progressive_active = False
    if progressive_active and _nemoclaw_original_create_deep_agent is None:
        raise RuntimeError("Deep Agents Code create_deep_agent boundary is unavailable")
    from deepagents_code.nemoclaw_observability import (
        initialize_observability,
        new_metadata_only_callback_manager,
    )

    observability_active = initialize_observability()
    if observability_active and _nemoclaw_original_create_deep_agent is None:
        raise RuntimeError("Deep Agents Code create_deep_agent boundary is unavailable")
    progressive_token = _nemoclaw_progressive_disclosure_active.set(
        progressive_active
    )
    observability_token = _nemoclaw_observability_active.set(observability_active)
    try:
        result = _nemoclaw_original_create_cli_agent(
            model, assistant_id, *args, **kwargs
        )
    finally:
        _nemoclaw_observability_active.reset(observability_token)
        _nemoclaw_progressive_disclosure_active.reset(progressive_token)
    if not observability_active:
        return result
    agent, backend = result
    # Copy the graph, then replace callbacks directly. with_config would merge a
    # pre-bound manager first and retain its handlers. Invocation safety then
    # relies on pinned LangGraph 1.2.6 calling ensure_config(self.config,
    # input_config); validate-observability.py locks that merge path.
    agent = agent.with_config({})
    agent.config = {
        **agent.config,
        "callbacks": new_metadata_only_callback_manager(),
    }
    return agent, backend


def _resolve_ptc_option(*args, **kwargs):
    """Disable interpreter programmatic tool calling at the final build boundary."""
    del args, kwargs
    return None


def load_async_subagents(config_path=None):
    """Disable mutable remote subagents and their arbitrary HTTP headers."""
    del config_path
    return []


_nemoclaw_original_build_model_identity_section = build_model_identity_section


def build_model_identity_section(
    name,
    provider=None,
    context_limit=None,
    unsupported_modalities=frozenset(),
):
    """Report the onboard-selected upstream provider in the model identity."""
    from deepagents_code._nemoclaw_managed import managed_display_provider

    display_provider = managed_display_provider(provider) if provider else provider
    return _nemoclaw_original_build_model_identity_section(
        name,
        provider=display_provider,
        context_limit=context_limit,
        unsupported_modalities=unsupported_modalities,
    )
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
_NEMOCLAW_AUTO_APPROVAL_DISABLED_MESSAGE = (
    "Auto-approval is disabled in NemoClaw-managed sandboxes."
)
_nemoclaw_original_approval_selection = ApprovalMenu._handle_selection


def _nemoclaw_handle_approval_selection(
    self, option: int, *, reject_message: str | None = None
) -> None:
    """Gate the thread-wide auto-approval choice on the managed capability."""
    if option == 1:
        from deepagents_code._nemoclaw_managed import managed_auto_approval_enabled

        if managed_auto_approval_enabled():
            _nemoclaw_original_approval_selection(
                self, option, reject_message=reject_message
            )
            return
        self.app.notify(
            _NEMOCLAW_AUTO_APPROVAL_DISABLED_MESSAGE,
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
    """Keep the LangGraph subprocess from starting update or analytics threads."""
    env = _nemoclaw_original_build_server_env()
    env["LANGGRAPH_NO_VERSION_CHECK"] = "true"
    env["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"
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

SERVER_CONFIG_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_normalize_path = _normalize_path


def _normalize_path(raw_path, project_context, label):
    """Preserve the process-local managed MCP descriptor across serialization."""
    from deepagents_code._nemoclaw_managed import is_managed_mcp_config_path

    if (
        label == "MCP config"
        and isinstance(raw_path, str)
        and raw_path.startswith("/proc/self/fd/")
    ):
        if is_managed_mcp_config_path(raw_path):
            return raw_path
        raise ValueError("NemoClaw managed MCP descriptor path is invalid")
    return _nemoclaw_original_normalize_path(raw_path, project_context, label)
'''

MCP_TOOLS_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
def discover_mcp_configs(*, project_context=None) -> list[Path]:
    """Disable user and project MCP layering in the managed image."""
    del project_context
    return []
'''

MCP_CONFIG_LOAD_MARKER = '''    path = Path(config_path)

    if not path.exists():
        error_msg = f"MCP config file not found: {config_path}"
        raise FileNotFoundError(error_msg)

    try:
        with path.open(encoding="utf-8") as file_obj:
            return json.load(file_obj)
'''

MCP_CONFIG_LOAD_PATCH = '''    from deepagents_code._nemoclaw_managed import (
        managed_mcp_config_bytes,
    )

    path = Path(config_path)
    try:
        managed_payload = managed_mcp_config_bytes(config_path)
        if managed_payload is not None:
            return json.loads(managed_payload)
        if not path.exists():
            error_msg = f"MCP config file not found: {config_path}"
            raise FileNotFoundError(error_msg)
        with path.open(encoding="utf-8") as file_obj:
            return json.load(file_obj)
'''

MCP_EXPLICIT_CONFIG_MARKER = '''    if explicit_config_path:
        config_path = (
            str(project_context.resolve_user_path(explicit_config_path))
            if project_context is not None
            else explicit_config_path
        )
        configs.append(load_mcp_config(config_path))
'''

MCP_EXPLICIT_CONFIG_PATCH = '''    if explicit_config_path:
        from deepagents_code._nemoclaw_managed import (
            is_managed_mcp_config_path,
        )

        config_path = (
            explicit_config_path
            if is_managed_mcp_config_path(explicit_config_path)
            else (
                str(project_context.resolve_user_path(explicit_config_path))
                if project_context is not None
                else explicit_config_path
            )
        )
        configs.append(load_mcp_config(config_path))
'''

SERVER_ENV_OVERRIDES_MARKER = '''        env.update(self._persistent_env_overrides)
        env.update(self._env_overrides)
'''

SERVER_ENV_OVERRIDES_PATCH = '''        env.update(self._persistent_env_overrides)
        env.update(self._env_overrides)

        # Reassert the managed child-process posture after both override
        # layers so restarts cannot re-enable update checks, optional
        # analytics, or unmanaged telemetry export.
        env["LANGGRAPH_NO_VERSION_CHECK"] = "true"
        env["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"
        env["OTEL_ENABLED"] = "false"
        for name in (
            "OPENAI_PROXY",
            "OTEL_EXPORTER_OTLP_ENDPOINT",
            "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
            "OTEL_EXPORTER_OTLP_HEADERS",
            "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
        ):
            env.pop(name, None)

        # Revalidate and bind the exact managed MCP snapshot before creating
        # any launch artifacts. Initial start and restart share this path.
        nemoclaw_mcp_pass_fds: tuple[int, ...] = ()
        nemoclaw_mcp_binding_env = "NEMOCLAW_DCODE_MCP_BINDING"
        env.pop(nemoclaw_mcp_binding_env, None)
        nemoclaw_mcp_path = env.get("DEEPAGENTS_CODE_SERVER_MCP_CONFIG_PATH")
        if nemoclaw_mcp_path:
            from deepagents_code._nemoclaw_managed import (
                managed_mcp_server_binding,
            )

            descriptor, binding = managed_mcp_server_binding(nemoclaw_mcp_path)
            nemoclaw_mcp_pass_fds = (descriptor,)
            env[nemoclaw_mcp_binding_env] = binding
'''

SERVER_POPEN_MARKER = '''        self._process = subprocess.Popen(  # noqa: S603, ASYNC220
            cmd,
            cwd=str(work_dir),
            env=env,
            stdout=self._log_file,
            stderr=subprocess.STDOUT,
        )
'''

SERVER_POPEN_PATCH = '''        self._process = subprocess.Popen(  # noqa: S603, ASYNC220
            cmd,
            cwd=str(work_dir),
            env=env,
            stdout=self._log_file,
            stderr=subprocess.STDOUT,
            pass_fds=nemoclaw_mcp_pass_fds,
        )
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

STATUS_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_status_bar_set_model = StatusBar.set_model


def _nemoclaw_status_bar_set_model(self, *, provider, model, effort=""):
    """Report the onboard-selected upstream provider in the status bar."""
    from deepagents_code._nemoclaw_managed import managed_display_provider

    _nemoclaw_original_status_bar_set_model(
        self,
        provider=managed_display_provider(provider),
        model=model,
        effort=effort,
    )


StatusBar.set_model = _nemoclaw_status_bar_set_model
'''

WELCOME_PATCH = r'''

# NemoClaw-managed Deep Agents Code hardening v2.
_nemoclaw_original_welcome_banner_update_model = WelcomeBanner.update_model


def _nemoclaw_welcome_banner_update_model(self, *, provider, model):
    """Report the onboard-selected upstream provider in the welcome banner."""
    from deepagents_code._nemoclaw_managed import managed_display_provider

    _nemoclaw_original_welcome_banner_update_model(
        self,
        provider=managed_display_provider(provider),
        model=model,
    )


WelcomeBanner.update_model = _nemoclaw_welcome_banner_update_model
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


def _load_managed_module(
    root: Path,
    module_name: str,
    source_boundary_name: str,
    installed_boundary_name: str | None = None,
) -> tuple[Path, str]:
    source_path = Path(__file__).with_name(module_name)
    destination_path = root / module_name
    if not source_path.is_file():
        raise RuntimeError(
            f"NemoClaw {source_boundary_name} source not found at {source_path}"
        )
    source = source_path.read_text(encoding="utf-8")
    compile(source, str(destination_path), "exec")
    if destination_path.exists() or destination_path.is_symlink():
        if (
            not destination_path.is_file()
            or destination_path.is_symlink()
            or destination_path.read_text(encoding="utf-8") != source
        ):
            raise RuntimeError(
                "Refusing to overwrite unexpected "
                f"{installed_boundary_name or source_boundary_name} at {destination_path}"
            )
    return destination_path, source


def main() -> None:
    actual_version = importlib.metadata.version("deepagents-code")
    if actual_version != EXPECTED_DCODE_VERSION:
        raise RuntimeError(
            f"Expected deepagents-code=={EXPECTED_DCODE_VERSION}, found {actual_version}"
        )

    try:
        managed_runtime_source = MANAGED_RUNTIME_SOURCE_PATH.read_text(encoding="utf-8")
    except OSError as exc:
        raise RuntimeError(
            f"Managed runtime source is unreadable: {MANAGED_RUNTIME_SOURCE_PATH}"
        ) from exc
    if PATCH_MARKER not in managed_runtime_source:
        raise RuntimeError(
            f"Managed runtime source is missing its patch marker: "
            f"{MANAGED_RUNTIME_SOURCE_PATH}"
        )
    compile(managed_runtime_source, str(MANAGED_RUNTIME_SOURCE_PATH), "exec")

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
        "auth_ui": root / "tui" / "widgets" / "auth.py",
        "codex_ui": root / "tui" / "widgets" / "codex_auth.py",
        "model_selector": root / "tui" / "widgets" / "model_selector.py",
        "approval": root / "tui" / "widgets" / "approval.py",
        "status": root / "tui" / "widgets" / "status.py",
        "welcome": root / "tui" / "widgets" / "welcome.py",
        "server": root / "client" / "launch" / "server.py",
        "server_config": root / "_server_config.py",
        "mcp_tools": root / "mcp_tools.py",
        "subagents": root / "subagents.py",
        "hooks": root / "hooks.py",
        "non_interactive": root / "client" / "non_interactive.py",
    }
    texts = {name: path.read_text(encoding="utf-8") for name, path in paths.items()}

    module_destination_path, module_source = _load_managed_module(
        root, MIDDLEWARE_MODULE, "middleware"
    )
    observability_destination_path, observability_source = _load_managed_module(
        root, OBSERVABILITY_MODULE, "observability", "observability module"
    )

    marker_states = {PATCH_MARKER in text for text in texts.values()}
    helper_path = root / "_nemoclaw_managed.py"
    if marker_states == {True}:
        helper_source = (
            helper_path.read_text(encoding="utf-8")
            if helper_path.is_file() and not helper_path.is_symlink()
            else ""
        )
        analytics_guard = 'os.environ["LANGGRAPH_CLI_NO_ANALYTICS"] = "1"'
        auto_approval_guards = (
            "def managed_auto_approval_mode() -> str:",
            "def managed_auto_approval_enabled() -> bool:",
        )
        if (
            PATCH_MARKER not in helper_source
            or sum(
                line.strip() == analytics_guard
                for line in helper_source.splitlines()
            )
            != 1
            or any(
                sum(
                    line.strip() == guard
                    for line in helper_source.splitlines()
                )
                != 1
                for guard in auto_approval_guards
            )
        ):
            raise RuntimeError(
                "Managed package patch is partial: helper is missing or stale"
            )
        if not module_destination_path.is_file():
            raise RuntimeError("Managed package patch is partial: middleware is missing")
        if not observability_destination_path.is_file():
            raise RuntimeError(
                "Managed package patch is partial: observability module is missing"
            )
        for marker, boundary in (
            (TOOL_DISCLOSURE_PATCH_MARKER, "progressive-disclosure"),
            (OBSERVABILITY_PATCH_MARKER, "observability"),
        ):
            if texts["agent"].count(marker) != 1:
                raise RuntimeError(
                    f"Managed package {boundary} patch is partial in {paths['agent']}"
                )
        for name, patch in (
            ("entrypoint", ENTRYPOINT_PATCH),
            ("main", MAIN_PATCH),
            ("app", APP_PATCH),
            ("approval", APPROVAL_PATCH),
            ("agent", AGENT_PATCH),
            ("status", STATUS_PATCH),
            ("welcome", WELCOME_PATCH),
            ("server", SERVER_PATCH),
        ):
            if texts[name].count(patch.lstrip()) != 1:
                raise RuntimeError(
                    f"Managed package {name} patch is incomplete in {paths[name]}"
                )
        if texts["server"].count(SERVER_ENV_OVERRIDES_PATCH.lstrip()) != 1:
            raise RuntimeError(
                "Managed package server override patch is incomplete in "
                f"{paths['server']}"
            )
        return
    if marker_states != {False} or helper_path.exists():
        raise RuntimeError("Managed package patch is partial; refusing mixed source state")
    if TOOL_DISCLOSURE_PATCH_MARKER in texts["agent"]:
        raise RuntimeError(
            "Managed package progressive-disclosure patch is partial; "
            "refusing mixed source state"
        )
    if OBSERVABILITY_PATCH_MARKER in texts["agent"]:
        raise RuntimeError(
            "Managed package observability patch is partial; "
            "refusing mixed source state"
        )

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
            "_restart_server_for_agent_swap",
            "_resume_thread",
            "_handle_update_action",
            "_handle_update_command",
            "_install_extra",
            "_prompt_launch_dependencies_then_model",
            "_build_launch_dependencies_prompt",
            "_prompt_launch_tavily",
            "_prompt_model_auth_if_needed",
            "_show_auth_manager",
            "_start_mcp_login",
            "_switch_model",
            "_absolutize_launch_relative_path",
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
        {
            "create_cli_agent",
            "_resolve_ptc_option",
            "load_async_subagents",
            "build_model_identity_section",
        },
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
    _require_methods(
        paths["status"],
        texts["status"],
        "StatusBar",
        {"set_model"},
    )
    _require_methods(
        paths["welcome"],
        texts["welcome"],
        "WelcomeBanner",
        {"update_model"},
    )
    _require_functions(paths["server"], texts["server"], {"_build_server_env"})
    _require_functions(
        paths["server_config"], texts["server_config"], {"_normalize_path"}
    )
    _require_functions(
        paths["mcp_tools"],
        texts["mcp_tools"],
        {"discover_mcp_configs", "load_mcp_config"},
    )
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
    if texts["mcp_tools"].count(MCP_CONFIG_LOAD_MARKER) != 1:
        raise RuntimeError(
            "Expected one Deep Agents Code MCP config loader marker in "
            f"{paths['mcp_tools']}"
        )
    if texts["mcp_tools"].count(MCP_EXPLICIT_CONFIG_MARKER) != 1:
        raise RuntimeError(
            "Expected one Deep Agents Code explicit MCP config marker in "
            f"{paths['mcp_tools']}"
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
    transformed["status"] = _append_patch(
        paths["status"], texts["status"], STATUS_PATCH
    )
    transformed["welcome"] = _append_patch(
        paths["welcome"], texts["welcome"], WELCOME_PATCH
    )
    if texts["server"].count(SERVER_POPEN_MARKER) != 1:
        raise RuntimeError(
            "Expected one Deep Agents Code server Popen marker in "
            f"{paths['server']}"
        )
    if texts["server"].count(SERVER_ENV_OVERRIDES_MARKER) != 1:
        raise RuntimeError(
            "Expected one Deep Agents Code server environment marker in "
            f"{paths['server']}"
        )
    transformed_server = texts["server"].replace(
        SERVER_ENV_OVERRIDES_MARKER,
        SERVER_ENV_OVERRIDES_PATCH,
        1,
    )
    transformed["server"] = _append_patch(
        paths["server"],
        transformed_server.replace(
            SERVER_POPEN_MARKER,
            SERVER_POPEN_PATCH,
            1,
        ),
        SERVER_PATCH,
    )
    transformed["server_config"] = _append_patch(
        paths["server_config"],
        texts["server_config"],
        SERVER_CONFIG_PATCH,
    )
    transformed_mcp_tools = texts["mcp_tools"].replace(
        MCP_CONFIG_LOAD_MARKER,
        MCP_CONFIG_LOAD_PATCH,
        1,
    ).replace(
        MCP_EXPLICIT_CONFIG_MARKER,
        MCP_EXPLICIT_CONFIG_PATCH,
        1,
    )
    transformed["mcp_tools"] = _append_patch(
        paths["mcp_tools"], transformed_mcp_tools, MCP_TOOLS_PATCH
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
    for name, text in transformed.items():
        paths[name].write_text(text, encoding="utf-8")
    helper_path.write_text(managed_runtime_source, encoding="utf-8")
    if not module_destination_path.exists():
        module_destination_path.write_text(module_source, encoding="utf-8")
    if not observability_destination_path.exists():
        observability_destination_path.write_text(
            observability_source,
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
