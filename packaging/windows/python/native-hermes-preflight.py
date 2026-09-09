# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise installed Hermes messaging imports and its real Windows PTY bridge."""

import json
import os
from pathlib import Path
import sys
import threading
import uuid


def main():
    if sys.platform != "win32" or len(sys.argv) != 2:
        raise RuntimeError("Native Windows and an installed Hermes site directory are required")
    sys.path.insert(0, sys.argv[1])
    import aiohttp._http_parser
    import concurrent_log_handler
    import discord
    import hermes_cli.main
    from hermes_cli.win_pty_bridge import WinPtyBridge
    from plugins.platforms.discord import adapter as discord_adapter
    from plugins.platforms.slack import adapter as slack_adapter
    from plugins.platforms.telegram import adapter as telegram_adapter

    if not callable(hermes_cli.main.main) or not callable(concurrent_log_handler.ConcurrentRotatingFileHandler):
        raise RuntimeError("The authentic Hermes CLI dependency surface is incomplete")
    if not (Path(hermes_cli.main.__file__).parent / "tui_dist" / "entry.js").is_file():
        raise RuntimeError("The authentic Hermes dashboard TUI entrypoint is missing")
    if not all((discord_adapter.DISCORD_AVAILABLE, slack_adapter.SLACK_AVAILABLE,
                telegram_adapter.TELEGRAM_AVAILABLE)):
        raise RuntimeError("A required native messaging adapter has missing dependencies")
    if not aiohttp._http_parser.__file__.endswith(".pyd"):
        raise RuntimeError("The native aiohttp response parser was not loaded")
    for filename in ("libopus-0.x64.dll", "libopus-0.x86.dll"):
        if (Path(discord.__file__).parent / "bin" / filename).exists():
            raise RuntimeError("An unsupported Discord voice binary entered the native package")
    if not WinPtyBridge.is_available():
        raise RuntimeError("The authentic Hermes Windows PTY bridge is unavailable")

    # A native PTY read may block inside Windows. Bound the whole real round trip
    # independently, including cleanup; this fixture contains no provider key.
    watchdog = threading.Timer(25, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    bridge = None
    marker = "NEMOCLAW_CONPTY_" + uuid.uuid4().hex
    try:
        bridge = WinPtyBridge.spawn([
            sys.executable, "-c",
            "import sys; print('READY', flush=True); value=input(); print('ECHO:'+value, flush=True)",
        ], cwd=sys.argv[1], cols=80, rows=24)
        output = b""
        while b"READY" not in output:
            chunk = bridge.read()
            if chunk is None:
                raise RuntimeError("The native PTY exited before its input check")
            output += chunk
            if len(output) > 64 * 1024:
                raise RuntimeError("The native PTY fixture exceeded its output bound")
        bridge.resize(100, 30)
        if bridge._proc.getwinsize() != (30, 100):
            raise RuntimeError("The native PTY did not accept its resize")
        bridge.write((marker + "\r\n").encode())
        while ("ECHO:" + marker).encode() not in output:
            chunk = bridge.read()
            if chunk is None:
                raise RuntimeError("The native PTY exited before completing input/output")
            output += chunk
            if len(output) > 64 * 1024:
                raise RuntimeError("The native PTY fixture exceeded its output bound")
        print(json.dumps({"schemaVersion": 1, "nativeConPty": True,
                          "messagingImports": ["telegram", "discord", "slack"]}))
    finally:
        if bridge is not None:
            bridge.close()
        watchdog.cancel()


if __name__ == "__main__":
    main()
