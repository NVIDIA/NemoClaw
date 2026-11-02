// SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/*
 * The fixture code adapted from deepagents-code 0.1.71 and 0.1.87 below uses the following license.
 *
 * MIT License
 *
 * Copyright (c) LangChain, Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { addDarwinFcntlSealConstants } from "./darwin-fcntl-seal-fixture";

export const agentDir = path.join(process.cwd(), "agents", "langchain-deepagents-code");
export const patcher = path.join(agentDir, "patch-managed-deepagents-code.py");
const packageFixtureDirs = new Set<string>();
let cachedPatchedFixture: string | undefined;

export function managedAutoApprovalPath(root: string): string {
  return path.join(root, "managed-auto-approval");
}

export function writeManagedAutoApproval(root: string, content: string, mode = 0o444): string {
  const capabilityPath = managedAutoApprovalPath(root);
  fs.writeFileSync(capabilityPath, content, { mode });
  fs.chmodSync(capabilityPath, mode);
  return capabilityPath;
}

export function managedReasoningEffortPath(root: string): string {
  return path.join(root, "managed-reasoning-effort");
}

export function managedUpstreamProviderPath(root: string): string {
  return path.join(root, "managed-upstream-provider");
}

export function writeManagedReasoningEffort(root: string, content: string, mode = 0o444): string {
  const capabilityPath = managedReasoningEffortPath(root);
  fs.writeFileSync(capabilityPath, content, { mode });
  fs.chmodSync(capabilityPath, mode);
  return capabilityPath;
}

export function linkManagedReasoningEffort(root: string, content: string, mode = 0o444): string {
  const targetPath = path.join(root, "managed-reasoning-effort-target");
  fs.writeFileSync(targetPath, content, { mode });
  fs.chmodSync(targetPath, mode);
  const capabilityPath = managedReasoningEffortPath(root);
  fs.symlinkSync(targetPath, capabilityPath);
  return capabilityPath;
}

export function writeFixtureFile(root: string, relativePath: string, content: string): void {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${content.trim()}\n`, "utf8");
}

export const approvalPackageSources: Readonly<Record<string, string>> = {
  "tui/widgets/tool_renderers.py": `
class ToolApprovalWidget:
    def __init__(self, data):
        self.data = data


class ToolRenderer:
    @staticmethod
    def get_approval_widget(tool_args, assistant_id=None):
        return ToolApprovalWidget, dict(tool_args)


def get_renderer(tool_name):
    return ToolRenderer()
`,
  "tui/widgets/approval.py": `
from __future__ import annotations

from types import SimpleNamespace
from deepagents_code.tui.widgets.tool_renderers import get_renderer


class ApprovalMenu:
    def __init__(self):
        self._is_auto_fallback = False
        self._show_auto_option = True
        self._options = self._build_options()
        self.decisions = []
        self.notifications = []
        self.app = SimpleNamespace(
            notify=lambda *args, **kwargs: self.notifications.append((args, kwargs))
        )

    async def _update_tool_info(self) -> None:
        """Mount the tool-specific approval widgets for all tools."""
        if not self._tool_info_container:
            return

        # Clear existing content
        await self._tool_info_container.remove_children()

        # Mount info for each tool
        for i, action_request in enumerate(self._action_requests):
            tool_name = action_request.get("name", "unknown")
            tool_args = action_request.get("args", {})

            # Add tool header if multiple tools
            if len(self._action_requests) > 1:
                header = Static(
                    Content.from_markup(
                        "[bold]$num. $name[/bold]",
                        num=i + 1,
                        name=tool_name,
                    )
                )
                await self._tool_info_container.mount(header)

            # Show description if present
            description = action_request.get("description")
            if description:
                await self._tool_info_container.mount(_description_widget(description))

            # Get the appropriate renderer for this tool
            renderer = get_renderer(tool_name)
            widget_class, data = renderer.get_approval_widget(
                tool_args, assistant_id=self._assistant_id
            )
            if "show_numbers" in data:
                data["show_numbers"] = (
                    bool(data["show_numbers"]) and self._show_diff_line_numbers
                )
            approval_widget = widget_class(data)
            await self._tool_info_container.mount(approval_widget)

    def _build_options(self):
        return [
            ("Approve (y)", "approve"),
            ("Enable Auto for this thread (a)", "auto_approve_all"),
            ("Reject (n)", "reject"),
        ]

    def _handle_selection(self, option, *, reject_message=None):
        decision_map = {0: "approve", 1: "auto_approve_all", 2: "reject"}
        self.decisions.append((decision_map[option], reject_message))

    def action_select_auto(self):
        self._handle_selection(1)
`,
};

export const nonInteractivePackageSource = `
from __future__ import annotations

import logging
import sys

logger = logging.getLogger(__name__)


def _resolve_shell_allow_list():
    return ["bash"]


class _Console:
    def __init__(self, stderr=False):
        self.file = sys.stderr if stderr else sys.stdout

    def print(self, message, **kwargs):
        print(message, file=self.file)


def escape_markup(value):
    return value


def generate_thread_id():
    return "thread-1"


def _workspace_conflict_text(exc: BaseException) -> str | None:
    from langgraph_sdk.errors import ConflictError
    if not isinstance(exc, ConflictError):
        return None
    from deepagents_code.client.headless_resume import WORKSPACE_CONFLICT_MESSAGE
    from deepagents_code.client.remote_client import workspace_conflict_diagnostics
    from deepagents_code.workspace_diagnostics import SAFE_SNAPSHOT_FIELDS
    diagnostics = workspace_conflict_diagnostics(exc)
    changed = sorted({change.name for change in diagnostics.changes} & SAFE_SNAPSHOT_FIELDS if diagnostics is not None else set())
    if not changed:
        return WORKSPACE_CONFLICT_MESSAGE
    return f"{WORKSPACE_CONFLICT_MESSAGE} Changed: {', '.join(changed)}."


def _write_text(text):
    print(text, end="", flush=True)


def _write_newline():
    print()


async def _run_non_interactive_impl(*args, **kwargs):
    del args
    from deepagents_code.hooks.manager import HooksManager

    HooksManager.create().dispatch()
    if kwargs.get("message") == "fixture-json-task":
        return 0
    return kwargs


async def _run_agent_loop(*args, **kwargs):
    return await _run_non_interactive_impl(*args, **kwargs)


async def run_non_interactive(*args, **kwargs):
    quiet = kwargs.get("quiet", False)
    console = _Console(stderr=quiet)
    thread_id = generate_thread_id()
    if quiet:
        # Printed despite \`-q\`: scripts parse it to resume the thread later.
        console.print(
            f"Thread: {thread_id}", markup=False, highlight=False, soft_wrap=True
        )
    resume = kwargs.get("resume")
    try:
        result = await _run_agent_loop(*args, **kwargs)
        return result
    except Exception as e:
        logger.exception("Unexpected error during non-interactive execution")
        if resume is not None and (conflict := _workspace_conflict_text(e)):
            console.print(
                f"\\n[red]Error: {escape_markup(conflict)}[/red]", soft_wrap=True
            )
            return 1
        if e.args and isinstance(e.args[0], dict):
            # The server raised it; show its type and message, not the dict.
            from deepagents_code.client.remote_client import format_agent_exception

            detail = format_agent_exception(e)
            console.print(f"\\n[red]Agent error: {escape_markup(detail)}[/red]")
        else:
            console.print(
                f"\\n[red]Unexpected error ({type(e).__name__}): "
                f"{escape_markup(str(e))}[/red]"
            )
        return 1


async def _run_startup_command(command, console, *, quiet):
    del console, quiet
    return command
`;

export function createPackageFixture(version = "0.1.87"): string {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patch-"));
  packageFixtureDirs.add(tempDir);
  const packageDir = path.join(tempDir, "deepagents_code");
  writeFixtureFile(packageDir, "__init__.py", '"""Test package."""');
  writeFixtureFile(
    packageDir,
    "approval_mode.py",
    `
from enum import Enum


class ApprovalMode(str, Enum):
    MANUAL = "manual"
    AUTO = "auto"
    YOLO = "yolo"
`,
  );
  writeFixtureFile(
    tempDir,
    "httpx/__init__.py",
    `
class HTTPError(Exception):
    pass


class RequestError(HTTPError):
    pass


class TransportError(RequestError):
    pass


class TimeoutException(TransportError):
    pass


class ConnectTimeout(TimeoutException):
    pass


class ReadTimeout(TimeoutException):
    pass


class WriteTimeout(TimeoutException):
    pass


class PoolTimeout(TimeoutException):
    pass


class NetworkError(TransportError):
    pass


class ConnectError(NetworkError):
    pass


class ReadError(NetworkError):
    pass


class WriteError(NetworkError):
    pass


class CloseError(NetworkError):
    pass


class ProxyError(TransportError):
    pass
`,
  );
  writeFixtureFile(tempDir, "langgraph/__init__.py", '"""Test package."""');
  writeFixtureFile(tempDir, "langgraph/pregel/__init__.py", '"""Test package."""');
  writeFixtureFile(
    tempDir,
    "langgraph/pregel/remote.py",
    `
class RemoteException(Exception):
    pass
`,
  );
  writeFixtureFile(tempDir, "langgraph_sdk/__init__.py", '"""Test package."""');
  writeFixtureFile(
    tempDir,
    "langgraph_sdk/errors.py",
    `
class LangGraphError(Exception):
    pass


class APIError(LangGraphError):
    pass


class APIStatusError(APIError):
    def __init__(self, message, *, body=None):
        super().__init__(message)
        self.body = body


class ConflictError(APIStatusError):
    pass


class APIConnectionError(APIError):
    pass


class APITimeoutError(APIConnectionError):
    pass


class AuthenticationError(APIStatusError):
    pass


class PermissionDeniedError(APIStatusError):
    pass


class NotFoundError(APIStatusError):
    pass


class RateLimitError(APIStatusError):
    pass


class InternalServerError(APIStatusError):
    pass
`,
  );
  writeFixtureFile(
    packageDir,
    "__main__.py",
    `
"""Allow running the test package as a module."""

from deepagents_code import cli_main


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
import asyncio
from types import SimpleNamespace


class Parser:
    def parse_args(self):
        argv = sys.argv[1:]
        command = next((arg for arg in argv if not arg.startswith("-") and arg != "none"), None)
        non_interactive_message = None
        for index, arg in enumerate(argv):
            if arg in {"-n", "--non-interactive"} and index + 1 < len(argv):
                non_interactive_message = argv[index + 1]
            elif arg.startswith("--non-interactive="):
                non_interactive_message = arg.split("=", 1)[1]
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
            yolo="--yolo" in argv,
            startup_mode="auto",
            approval_mode="auto",
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
            non_interactive_message=non_interactive_message,
            output_format=("json" if "--json" in argv else "text"),
            quiet=("-q" in argv or "--quiet" in argv),
            no_stream=("--no-stream" in argv),
            timeout=None,
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
    output_format = getattr(args, "output_format", "text")
    if args.non_interactive_message:
        from deepagents_code.client.non_interactive import run_non_interactive

        timeout = getattr(args, "timeout", None)
        exit_code = asyncio.run(
            asyncio.wait_for(
                run_non_interactive(
                            message=args.non_interactive_message,
                            quiet=args.quiet,
                            stream=not args.no_stream,
                ),
                        timeout=timeout,
            )
        )
        raise SystemExit(exit_code)
    print(
        f"managed-posture-ok auto_approve={args.auto_approve} "
        f"yolo={getattr(args, 'yolo', False)} "
        f"startup_mode={args.startup_mode} approval_mode={args.approval_mode}"
    )
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
      `from deepagents_code.approval_mode import ApprovalMode


class _StatusBar:
    def __init__(self):
        self.auto_approve = True
        self.approval_mode = "yolo"

    def set_auto_approve(self, *, enabled):
        self.auto_approve = enabled

    def set_approval_mode(self, mode):
        self.approval_mode = mode
        self.auto_approve = mode == "yolo"


class _SessionState:
    def __init__(self):
        self.thread_id = "thread-1"
        self.auto_approve = True
        self.approval_mode = ApprovalMode.YOLO
        self.approval_mode_key = "approval/thread-1"


class DeepAgentsApp:
`,
    )
    .replace(
      "        self._auto_approve = True\n        self._status_bar = None\n        self._session_state = None\n",
      `        self._approval_mode = ApprovalMode.YOLO
        self._auto_approve = True
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
      `    async def _set_approval_mode(self, target):
        self._approval_mode = target
        self._auto_approve = target is ApprovalMode.YOLO
        self._status_bar.set_approval_mode(target.value)
        self._session_state.approval_mode = target
        self._session_state.auto_approve = self._auto_approve
        return True

    async def _on_auto_approve_enabled(self):
        return await self._set_approval_mode(ApprovalMode.AUTO)

    async def action_toggle_auto_approve(self):
        target = (
            ApprovalMode.AUTO
            if self._approval_mode is ApprovalMode.MANUAL
            else ApprovalMode.MANUAL
        )
        await self._set_approval_mode(target)

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
    "tools.py",
    `
from __future__ import annotations

import contextlib
import ipaddress
import threading
from urllib.parse import urljoin, urlparse

_dns_pin_lock = threading.Lock()

def _is_blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    """Return True if \`ip\` belongs to a non-publicly-routable range.

    Rejects: private (RFC1918/ULA), loopback, link-local (including cloud
    IMDS at \`169.254.169.254\`), reserved, multicast, unspecified
    (\`0.0.0.0\`/\`::\`), and anything \`ipaddress\` does not consider globally
    routable (catches benchmarking, documentation, and similar ranges the
    explicit predicates miss).

    IPv4-mapped IPv6 (\`::ffff:a.b.c.d\`) and 6to4 (\`2002::/16\`) are unwrapped
    to their underlying IPv4 address before the checks so that private
    space tunneled inside an IPv6 wrapper is still caught — e.g.,
    \`::ffff:127.0.0.1\` and \`2002:a9fe:a9fe::1\` (6to4 over IMDS) both
    evaluate as blocked.
    """
    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif ip.sixtofour is not None:
            ip = ip.sixtofour
    return (
        not ip.is_global
        or ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    )


@contextlib.contextmanager
def _pinned_dns(hostname: str, allowed_ips: list[str]) -> Iterator[None]:
    """Force outgoing urllib3 connections for \`hostname\` to use \`allowed_ips\`.

    Patches \`urllib3.util.connection.create_connection\` for the duration of
    the context so that \`requests\` cannot re-resolve \`hostname\` to a
    different IP than the one \`_validate_url\` vetted (defends against DNS
    rebinding TOCTOU). The patch is process-global, so the module lock
    serializes concurrent fetches.

    Args:
        hostname: The exact hostname (already IDNA-encoded by the caller)
            whose resolution must be pinned.
        allowed_ips: The IPs \`_validate_url\` confirmed are safe to connect
            to. Tried in order; the first that accepts the connection wins.
    """
    from urllib3.util import connection as urllib3_connection

    with _dns_pin_lock:
        original = urllib3_connection.create_connection

        def patched(
            address: tuple[str, int], *args: Any, **kwargs: Any
        ) -> socket.socket:
            host, port = address[0], address[1]
            if host != hostname:
                return original(address, *args, **kwargs)
            last_exc: OSError | None = None
            for ip in allowed_ips:
                try:
                    return original((ip, port), *args, **kwargs)
                except OSError as exc:
                    last_exc = exc
            assert last_exc is not None  # noqa: S101  # loop body guarantees this
            raise last_exc

        urllib3_connection.create_connection = patched  # ty: ignore[invalid-assignment]  # signature matches at runtime
        try:
            yield
        finally:
            urllib3_connection.create_connection = original


_ALLOWED_URL_SCHEMES = frozenset({"http", "https"})
_MAX_FETCH_REDIRECTS = 5


class _UrlValidationError(ValueError):
    pass


def _fetch_with_redirects(url, *, timeout):
    return {"transport": "direct", "url": url, "timeout": timeout}
`,
  );
  writeFixtureFile(
    packageDir,
    "model_config.py",
    `
from __future__ import annotations

from pathlib import Path

DEFAULT_CONFIG_DIR = Path("/tmp")


class ModelConfigError(RuntimeError):
    pass


class NoCredentialsConfiguredError(ModelConfigError):
    pass


class UnknownProviderError(ModelConfigError):
    pass


class MissingCredentialsError(ModelConfigError):
    pass


class MissingProviderPackageError(ModelConfigError):
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
    "hooks/__init__.py",
    `
from deepagents_code.hooks.legacy import dispatch_hook, _load_hooks, _run_single_hook

__all__ = ["dispatch_hook", "_load_hooks", "_run_single_hook"]
`,
  );
  writeFixtureFile(
    packageDir,
    "hooks/legacy.py",
    `
from __future__ import annotations

import asyncio
import json
import subprocess
from typing import Any

_hooks_config = None


def _load_hooks():
    global _hooks_config
    if _hooks_config is None:
        from deepagents_code.model_config import DEFAULT_CONFIG_DIR

        path = DEFAULT_CONFIG_DIR / "hooks.json"
        _hooks_config = json.loads(path.read_text()).get("hooks", []) if path.is_file() else []
    return _hooks_config


def _run_single_hook(command, event, payload_bytes):
    del event, payload_bytes
    subprocess.run(command, check=False)


async def dispatch_hook(event, payload):
    payload_bytes = json.dumps({"event": event, **payload}).encode()
    for hook in _load_hooks():
        if not hook.get("events") or event in hook["events"]:
            await asyncio.to_thread(_run_single_hook, hook["command"], event, payload_bytes)
`,
  );
  writeFixtureFile(
    packageDir,
    "hooks/manager.py",
    `
from __future__ import annotations

import os
from pathlib import Path


class HooksManager:
    def __init__(self, enabled):
        self.enabled = enabled

    @classmethod
    def create(cls, *args, **kwargs):
        del args, kwargs
        return cls(True)

    @classmethod
    def inert(cls):
        return cls(False)

    def dispatch(self):
        marker = os.environ.get("DCODE_FIXTURE_HOOK_MARKER")
        if self.enabled and marker:
            Path(marker).touch()
`,
  );
  writeFixtureFile(packageDir, "client/non_interactive.py", nonInteractivePackageSource);
  // Pinned 0.1.87 classifier dependencies; omit unrelated rendering/serialization methods.
  writeFixtureFile(
    packageDir,
    "client/headless_resume.py",
    `
WORKSPACE_CONFLICT_MESSAGE = "Couldn't resume this thread because it was created with different settings. A thread keeps the directory, agent, approval, shell, sandbox, and MCP settings it started with, so threads from the interactive UI can't be resumed with -n. Rerun from the same directory with the same flags as the run that created it."
`,
  );
  writeFixtureFile(
    packageDir,
    "client/remote_client.py",
    `
from __future__ import annotations
from typing import cast

def workspace_conflict_diagnostics(exc: BaseException) -> WorkspaceDiagnostics | None:
    from deepagents_code.workspace_diagnostics import WorkspaceDiagnostics
    body = getattr(exc, 'body', None)
    if not isinstance(body, dict):
        return None
    return WorkspaceDiagnostics.from_dict(cast('dict[str, Any]', body).get('diagnostics'))
`,
  );
  writeFixtureFile(
    packageDir,
    "workspace_diagnostics.py",
    `
from __future__ import annotations
from dataclasses import dataclass, field
from typing import cast

SAFE_SNAPSHOT_FIELDS = frozenset({'allow_fs_tools', 'assistant_id', 'auto_approve', 'enable_ask_user', 'enable_interpreter', 'enable_memory', 'enable_shell', 'enable_skills', 'interactive', 'interpreter_ptc', 'interpreter_ptc_acknowledge_unsafe', 'interrupt_shell_only', 'no_mcp', 'recursion_limit', 'sandbox_type', 'shell_allow_list', 'trust_project_extensions', 'trust_project_mcp'})

@dataclass(frozen=True)
class FieldChange:
    name: str
    bound: object = field(default=None)
    current: object = field(default=None)
    state: Literal['changed', 'values_unavailable'] = 'changed'

@dataclass(frozen=True)
class WorkspaceDiagnostics:
    category: _DiagnosticCategory
    reason: str
    changes: tuple[FieldChange, ...] = ()
    snapshot_status: Literal['current', 'unavailable'] = 'current'
    binding_schema_version: int | None = None
    server_schema_version: int | None = None

    @classmethod
    def from_dict(cls, data: object) -> WorkspaceDiagnostics | None:
        if not isinstance(data, dict):
            return None
        category = data.get('category')
        reason = data.get('reason')
        snapshot_status = data.get('snapshot_status')
        if not isinstance(category, str) or not isinstance(reason, str) or (not isinstance(snapshot_status, str)) or (snapshot_status not in {'current', 'unavailable'}):
            return None
        changes: list[FieldChange] = []
        raw_changes = data.get('changes')
        if isinstance(raw_changes, list):
            for item in raw_changes:
                parsed = _parse_field_change(item)
                if parsed is None:
                    return None
                changes.append(parsed)
        binding_schema = data.get('binding_schema_version')
        server_schema = data.get('server_schema_version')
        return cls(category=cast('_DiagnosticCategory', category), reason=reason, changes=tuple(changes), snapshot_status=snapshot_status, binding_schema_version=binding_schema if isinstance(binding_schema, int) else None, server_schema_version=server_schema if isinstance(server_schema, int) else None)

def _parse_field_change(item: object) -> FieldChange | None:
    if not isinstance(item, dict):
        return None
    entry = cast('dict[str, object]', item)
    name = entry.get('name')
    if not isinstance(name, str):
        return None
    state = entry.get('state')
    if state == 'values_unavailable':
        return FieldChange(name=name, state='values_unavailable')
    if state == 'changed':
        return FieldChange(name=name, bound=entry.get('bound'), current=entry.get('current'))
    return None
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


async def _caller_six():
    return await _run_install_subprocess("six", progress=None, log_path=None)
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
  for (const [relativePath, source] of Object.entries(approvalPackageSources)) {
    writeFixtureFile(packageDir, relativePath, source);
  }
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
  const managedUpstreamProviderFile = managedUpstreamProviderPath(tempDir);
  fs.writeFileSync(managedUpstreamProviderFile, "nvidia-prod\n", "utf8");
  fs.chmodSync(managedUpstreamProviderFile, 0o444);
  return tempDir;
}

export function cleanupPackageFixtures(): void {
  for (const tempDir of packageFixtureDirs) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  packageFixtureDirs.clear();
}

export function cleanupCachedPatchedFixture(): void {
  if (cachedPatchedFixture) fs.rmSync(cachedPatchedFixture, { recursive: true, force: true });
  cachedPatchedFixture = undefined;
}

function runPatcher(tempDir: string): void {
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
    .replace(
      '"/usr/local/share/nemoclaw/dcode-reasoning-effort"',
      JSON.stringify(managedReasoningEffortPath(tempDir)),
    )
    .replace(
      '"/usr/local/share/nemoclaw/dcode-upstream-provider"',
      JSON.stringify(managedUpstreamProviderPath(tempDir)),
    )
    .replace("_MANAGED_FILE_OWNER_UID = 0", `_MANAGED_FILE_OWNER_UID = ${process.getuid?.() ?? 0}`);
  fs.writeFileSync(helperPath, helper, "utf8");
}

export function createPatchedPackageFixture(): string {
  if (!cachedPatchedFixture) {
    cachedPatchedFixture = createPackageFixture();
    packageFixtureDirs.delete(cachedPatchedFixture);
    runPatcher(cachedPatchedFixture);
  }
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "nemoclaw-dcode-patched-"));
  packageFixtureDirs.add(tempDir);
  for (const name of fs.readdirSync(cachedPatchedFixture)) {
    const target = path.join(tempDir, name);
    fs.rmSync(target, { force: true, recursive: true });
    fs.cpSync(path.join(cachedPatchedFixture, name), target, { recursive: true });
  }
  const helperPath = path.join(tempDir, "deepagents_code", "_nemoclaw_managed.py");
  const helper = fs.readFileSync(helperPath, "utf8").replaceAll(cachedPatchedFixture, tempDir);
  fs.writeFileSync(helperPath, helper, "utf8");
  return tempDir;
}

export function patchFixture(tempDir: string): void {
  runPatcher(tempDir);
}
