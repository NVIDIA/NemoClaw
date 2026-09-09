# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Exercise installed Hermes messaging imports and its real Windows PTY bridge."""

import argparse
import ctypes
from ctypes import wintypes
import json
import os
from pathlib import Path
import struct
import sys
import threading
import uuid


def verify_console_files(site):
    package = site / "winpty"
    for filename in ("_winpty.cp313-win_arm64.pyd", "conpty.dll", "OpenConsole.exe"):
        file = package / filename
        if not file.is_file() or file.is_symlink():
            raise RuntimeError(f"The packaged Windows console dependency is missing: {filename}")
        with file.open("rb") as stream:
            if stream.read(2) != b"MZ":
                raise RuntimeError(f"The console dependency is not a Windows binary: {filename}")
            stream.seek(0x3C)
            offset = struct.unpack("<I", stream.read(4))[0]
            stream.seek(offset)
            if stream.read(4) != b"PE\0\0" or struct.unpack("<H", stream.read(2))[0] != 0xAA64:
                raise RuntimeError(f"The console dependency is not native ARM64: {filename}")
    return package


def verify_loaded_console(package):
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
    kernel.GetModuleHandleW.restype = wintypes.HMODULE
    kernel.GetModuleFileNameW.argtypes = [wintypes.HMODULE, wintypes.LPWSTR, wintypes.DWORD]
    kernel.GetModuleFileNameW.restype = wintypes.DWORD
    handle = kernel.GetModuleHandleW("conpty.dll")
    buffer = ctypes.create_unicode_buffer(32768)
    length = kernel.GetModuleFileNameW(handle, buffer, len(buffer)) if handle else 0
    if not length or length >= len(buffer) or not os.path.samefile(buffer.value, package / "conpty.dll"):
        raise RuntimeError("The Windows PTY did not load its packaged ConPTY library")


def verify_messaging(site):
    import aiohttp._http_parser
    import concurrent_log_handler
    import discord
    import hermes_cli.main
    from plugins.platforms.discord import adapter as discord_adapter
    from plugins.platforms.slack import adapter as slack_adapter
    from plugins.platforms.telegram import adapter as telegram_adapter

    if not callable(hermes_cli.main.main) or not callable(concurrent_log_handler.ConcurrentRotatingFileHandler):
        raise RuntimeError("The authentic Hermes CLI dependency surface is incomplete")
    if not (site / "hermes_cli" / "tui_dist" / "entry.js").is_file():
        raise RuntimeError("The authentic Hermes dashboard TUI entrypoint is missing")
    if not all((discord_adapter.DISCORD_AVAILABLE, slack_adapter.SLACK_AVAILABLE,
                telegram_adapter.TELEGRAM_AVAILABLE)):
        raise RuntimeError("A required native messaging adapter has missing dependencies")
    if not aiohttp._http_parser.__file__.endswith(".pyd"):
        raise RuntimeError("The native aiohttp response parser was not loaded")
    for filename in ("libopus-0.x64.dll", "libopus-0.x86.dll"):
        if (Path(discord.__file__).parent / "bin" / filename).exists():
            raise RuntimeError("An unsupported Discord voice binary entered the native package")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("site", type=Path)
    parser.add_argument("--pty-only", action="store_true")
    parser.add_argument("--receipt", type=Path)
    options = parser.parse_args()
    if sys.platform != "win32" or not options.site.is_dir():
        raise RuntimeError("Native Windows and an installed Hermes site directory are required")
    site = options.site.resolve()
    sys.path.insert(0, str(site))
    package = verify_console_files(site)
    # Import directly first: Hermes converts an ImportError into a generic
    # unavailable flag, hiding a missing native dependency from diagnostics.
    from winpty import PtyProcess
    from hermes_cli.win_pty_bridge import WinPtyBridge

    verify_loaded_console(package)
    if not WinPtyBridge.is_available() or not callable(PtyProcess.spawn):
        raise RuntimeError("The authentic Hermes Windows PTY bridge is unavailable")
    if not options.pty_only:
        verify_messaging(site)

    # A native PTY read may block inside Windows. Bound the whole real round trip
    # independently, including cleanup; this fixture contains no provider key.
    watchdog = threading.Timer(25, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()
    bridge = None
    marker = "NEMOCLAW_CONPTY_" + uuid.uuid4().hex
    child = """import os, sys, time
print('READY', flush=True)
value = input()
deadline = time.monotonic() + 2
size = os.get_terminal_size()
while tuple(size) != (100, 30) and time.monotonic() < deadline:
    time.sleep(0.01)
    size = os.get_terminal_size()
print('ECHO:' + value + ':' + str(size.columns) + 'x' + str(size.lines), flush=True)
"""
    try:
        bridge = WinPtyBridge.spawn([sys.executable, "-c", child], cwd=str(site), cols=80, rows=24)
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
        while ("ECHO:" + marker + ":100x30").encode() not in output:
            chunk = bridge.read()
            if chunk is None:
                raise RuntimeError("The native PTY did not prove input, output, and child-observed resize")
            output += chunk
            if len(output) > 64 * 1024:
                raise RuntimeError("The native PTY fixture exceeded its output bound")
    finally:
        try:
            if bridge is not None:
                bridge.close()
                if bridge._proc.isalive():
                    raise RuntimeError("The native PTY child did not stop during cleanup")
        finally:
            watchdog.cancel()
    receipt = {"schemaVersion": 1, "nativeConPty": True, "packagedConsoleLoaded": True,
               "childObservedSize": [100, 30], "childStopped": True,
               "messagingImports": [] if options.pty_only else ["telegram", "discord", "slack"]}
    text = json.dumps(receipt) + "\n"
    if options.receipt is not None:
        with options.receipt.open("x", encoding="utf-8") as stream:
            stream.write(text)
    print(text, end="", flush=True)


if __name__ == "__main__":
    main()
