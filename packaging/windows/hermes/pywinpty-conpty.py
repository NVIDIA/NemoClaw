# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""CI-only package feature configuration and an actual host ConPTY smoke."""

import argparse
import ctypes
import gc
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import sys
import time
import tomllib
import traceback

PYPROJECT_SHA256 = "1f0d8d7e9e19c3a1cc25521a5cf56f3c885e4604d3081246cd42d9924a983174"
FEATURE_ARGS = "--features winpty-rs/conpty --locked"


def render_configuration(source):
    original = tomllib.loads(source)["tool"]["uv"]
    if set(original) != {
        "override-dependencies",
        "exclude-newer",
        "exclude-newer-package",
    }:
        raise ValueError("The upstream uv settings require a fresh explicit review.")
    lines = []
    selected = False
    for line in source.splitlines():
        if line.startswith("["):
            selected = line == "[tool.uv]" or line.startswith("[tool.uv.")
        if selected and line != "[tool.uv]":
            lines.append(re.sub(r"^\[tool\.uv\.", "[", line))
    text = (
        "\n".join(lines)
        + '\n[config-settings-package.pywinpty]\nbuild-args = "'
        + FEATURE_ARGS
        + '"\n'
    )
    expected = {
        **original,
        "config-settings-package": {"pywinpty": {"build-args": FEATURE_ARGS}},
    }
    if tomllib.loads(text) != expected:
        raise ValueError("The CI config changed unrelated upstream uv settings.")
    return text


def prepare_configuration(project, output, receipt):
    source = project.read_bytes()
    if hashlib.sha256(source).hexdigest() != PYPROJECT_SHA256:
        raise ValueError(
            "The Hermes pyproject differs from the exact canonical source."
        )
    text = render_configuration(source.decode("utf-8"))
    with output.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(text)
    record = {
        "schemaVersion": 1,
        "classification": "ci-only-pywinpty-conpty-build-settings",
        "pyprojectSha256": PYPROJECT_SHA256,
        "configurationSha256": hashlib.sha256(text.encode()).hexdigest(),
        "package": "pywinpty",
        "version": "2.0.15",
        "dependency": "winpty-rs",
        "dependencyVersion": "0.4.1",
        "pywinptySourceSha256": "312cf39153a8736c617d45ce8b6ad6cd2107de121df91c455b10ce6bba7a39b2",
        "winptyCrateSha256": "067bd0835c7d94e21f436c6c735a0725d63276503045a65a0e43856746b1235d",
        "feature": "conpty",
        "maturinBuildArgs": FEATURE_ARGS,
        "upstreamUvSettingsPreserved": True,
        "globalRustFlagsChanged": False,
        "upstreamSourcesChanged": False,
    }
    with receipt.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")
    return record


def conpty_smoke(record):
    if (
        sys.platform != "win32"
        or platform.machine().lower() not in {"arm64", "aarch64"}
        or sys.version_info[:3] != (3, 11, 16)
        or os.environ.get("GITHUB_ACTIONS") != "true"
    ):
        raise RuntimeError(
            "Run the ConPTY smoke in Windows ARM64 CI with the shipping Python3.11.16."
        )
    from winpty import PTY
    from winpty.enums import Backend
    import winpty.winpty as native

    if importlib.metadata.version("pywinpty") != "2.0.15":
        raise RuntimeError("The pywinpty version was substituted.")
    binary = Path(native.__file__).read_bytes()
    offset = int.from_bytes(binary[0x3C:0x40], "little")
    if (
        binary[:2] != b"MZ"
        or binary[offset : offset + 4] != b"PE\0\0"
        or int.from_bytes(binary[offset + 4 : offset + 6], "little") != 0xAA64
    ):
        raise RuntimeError("The pywinpty extension is not a native ARM64 PE.")
    record.update(
        {
            "backend": "ConPTY",
            "pywinptyVersion": "2.0.15",
            "pythonVersion": platform.python_version(),
            "nativeModule": native.__file__,
            "nativeModuleSha256": hashlib.sha256(binary).hexdigest(),
            "nativeModuleMachine": "0xaa64",
        }
    )
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel.OpenProcess.restype = ctypes.c_void_p
    kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.WaitForSingleObject.restype = ctypes.c_uint32
    kernel.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel.TerminateProcess.restype = ctypes.c_int
    kernel.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel.CloseHandle.restype = ctypes.c_int
    pty = None
    handle = None
    primary = None
    cleanup_error = None
    token = "NEMOCLAW_CONPTY_BUILD_" + os.urandom(12).hex()
    try:
        pty = PTY(80, 24, backend=Backend.ConPTY)
        record["constructorSucceeded"] = True
        # The builder's pinned drive-root path contains no spaces; winpty-rs
        # prepends this app name to cmdline. This child performs no I/O except print.
        command = subprocess.list2cmdline(
            ["-I", "-B", "-c", "print(" + repr(token) + ", flush=True)"]
        )
        if not pty.spawn(sys.executable, cmdline=command, cwd=os.getcwd()):
            raise RuntimeError("The explicit ConPTY child did not spawn.")
        record["spawnSucceeded"] = True
        record["processId"] = pty.pid
        # PTY retains its original process handle, so this PID cannot be reused
        # while we open an additional handle for exact bounded failure cleanup.
        handle = kernel.OpenProcess(0x00101001, False, pty.pid)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        output = ""
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            try:
                output += pty.read(4096, blocking=False)
            except Exception:
                if kernel.WaitForSingleObject(handle, 0) == 0 and token in output:
                    break
                raise
            if len(output) > 65536:
                raise RuntimeError("ConPTY smoke output exceeded its bound.")
            if not pty.isalive() and pty.iseof():
                break
            time.sleep(0.02)
        record["exitCode"] = pty.get_exitstatus()
        record["outputContainsSentinel"] = token in output
        record["childExitObserved"] = kernel.WaitForSingleObject(handle, 0) == 0
        if (
            record["exitCode"] != 0
            or not record["outputContainsSentinel"]
            or not record["childExitObserved"]
        ):
            raise RuntimeError(
                "The ConPTY child did not produce its sentinel and exit0."
            )
    except Exception as error:
        primary = error
    finally:
        if handle:
            try:
                if kernel.WaitForSingleObject(handle, 0) != 0:
                    if (
                        not kernel.TerminateProcess(handle, 1)
                        or kernel.WaitForSingleObject(handle, 5000) != 0
                    ):
                        raise RuntimeError("The exact ConPTY smoke child did not stop.")
            except Exception as error:
                cleanup_error = error
            finally:
                if not kernel.CloseHandle(handle) and cleanup_error is None:
                    cleanup_error = ctypes.WinError(ctypes.get_last_error())
        # The official object's destructor owns ClosePseudoConsole and its pipes.
        pty = None
        gc.collect()
        record["cleanupPassed"] = cleanup_error is None
        if cleanup_error:
            record["cleanupError"] = str(cleanup_error)
    if primary:
        raise primary
    if cleanup_error:
        raise cleanup_error
    record["status"] = "pass"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=["configuration", "smoke"])
    parser.add_argument("--project", type=Path)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    if args.operation == "configuration":
        if not args.project or not args.output:
            parser.error("configuration requires --project and --output")
        print(
            json.dumps(prepare_configuration(args.project, args.output, args.receipt))
        )
        return
    record = {
        "schemaVersion": 1,
        "classification": "ci-built-pywinpty-conpty-smoke",
        "status": "failed",
    }
    primary = None
    try:
        conpty_smoke(record)
    except Exception as error:
        primary = error
        record["error"] = traceback.format_exc()
    try:
        with args.receipt.open("x", encoding="utf-8") as stream:
            json.dump(record, stream, indent=2)
            stream.write("\n")
    except Exception as write_error:
        print("ConPTY receipt write failed: " + repr(write_error), file=sys.stderr)
        if primary:
            raise primary from None
        raise
    if primary:
        raise primary
    print("PYWINPTY_EXPLICIT_CONPTY_SPAWN_READ_EXIT_OK")


if __name__ == "__main__":
    main()
