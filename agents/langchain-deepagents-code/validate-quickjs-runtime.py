# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Exercise DCode's pinned interpreter, tool bridge, and restored REPL."""

from __future__ import annotations

import asyncio
import errno
import os
import subprocess
import sys


def require_memfd_denied() -> None:
    """Check the kernel boundary before importing or caching Wasmtime artifacts."""
    try:
        descriptor = os.memfd_create(
            "nemoclaw-quickjs-probe", os.MFD_CLOEXEC | os.MFD_ALLOW_SEALING
        )
    except OSError as error:
        if error.errno == errno.EPERM:
            return
        raise RuntimeError("QuickJS probe could not verify memfd denial") from None
    os.close(descriptor)
    raise RuntimeError("QuickJS probe requires memfd_create to return EPERM")


async def validate_runtime() -> None:
    from langchain_core.tools import StructuredTool
    # This is the registry used by langchain-quickjs==0.3.5. Unlike Runtime()
    # alone, it creates a worker and enables the OXC source transformer.
    from langchain_quickjs._repl import _Registry

    calls = 0

    def shell_probe() -> str:
        """Return the output of one fixed, read-only shell command."""
        nonlocal calls
        calls += 1
        return subprocess.run(
            ["/bin/sh", "-c", "printf 42"],
            check=True,
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout

    tool = StructuredTool.from_function(shell_probe)
    registry = _Registry(
        memory_limit=128 * 1024 * 1024,
        timeout=10,
        capture_console=True,
        max_stdout_chars=1024,
    )
    try:
        repl = registry.get("nemoclaw-quickjs-probe")
        repl.install_tools([tool])
        outcome = await repl.eval_async(
            "const answer = Number(await tools.shellProbe({})); answer"
        )
        if outcome.error_type is not None or outcome.result != "42" or calls != 1:
            raise RuntimeError("QuickJS async shell-tool probe failed")
        snapshot = await repl.acreate_snapshot()
        await registry.aevict("nemoclaw-quickjs-probe")
        repl = registry.get("nemoclaw-quickjs-probe")
        await repl.arestore_snapshot(snapshot)
        repl.install_tools([tool])
        outcome = repl.eval_sync("answer + Number(await tools.shellProbe({}))")
        if outcome.error_type is not None or outcome.result != "84" or calls != 2:
            raise RuntimeError("QuickJS restored shell-tool probe failed")
    finally:
        registry.close()


def main() -> None:
    if sys.argv[1:] not in ([], ["--require-memfd-denied"]):
        raise SystemExit("usage: validate-quickjs-runtime.py [--require-memfd-denied]")
    try:
        if sys.argv[1:]:
            require_memfd_denied()
        asyncio.run(validate_runtime())
    except Exception:
        # Third-party errors can contain user paths or runtime configuration.
        raise SystemExit(
            "Deep Agents QuickJS/Wasmtime compatibility validation failed; "
            "rebuild with the managed runtime patch and check the syscall policy"
        ) from None
    print("NEMOCLAW_QUICKJS_TOOL_RUNTIME_OK")


if __name__ == "__main__":
    main()
