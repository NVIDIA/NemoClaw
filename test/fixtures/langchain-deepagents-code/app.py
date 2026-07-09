# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Minimal pinned app fixture for the managed package patch tests."""

from __future__ import annotations

from pathlib import Path


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

    @staticmethod
    def _absolutize_launch_relative_path(raw, launch_cwd):
        if not isinstance(raw, str) or not raw:
            return None
        path = Path(raw).expanduser()
        if path.is_absolute():
            return str(path.resolve())
        return str((launch_cwd / path).resolve())

    async def _check_for_updates(self, *, periodic=False):
        pass

    async def _handle_update_command(self, command="/update"):
        pass

    async def _handle_install_command(self, command):
        pass

    async def _install_extra(self, *args, **kwargs):
        del args, kwargs
        return True

    async def _handle_install_package(self, *args, **kwargs):
        pass

    async def _handle_auto_update_toggle(self):
        return None

    async def _prompt_launch_tavily(self):
        self.original_tavily = True

    async def _prompt_launch_dependencies_then_model(self):
        return (True, ("openai:gpt-4", "openai"))

    def _build_launch_dependencies_prompt(self):
        import asyncio
        loop = asyncio.get_running_loop()
        fut = loop.create_future()
        fut.set_result((True, ("openai:gpt-4", "openai")))
        return object(), fut

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
