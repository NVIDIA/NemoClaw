# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fixed canonical tool operations, invoked only inside the owned MXC workload."""

import importlib.metadata
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import traceback


def owned_runtime(directory):
    # The already-loaded production adapter validates every path component
    # without the final-path API denied to an otherwise readable MXC runtime.
    import nemoclaw_native_windows as native_paths

    root = native_paths._absolute_path(Path(directory))
    if root != native_paths._active_root:
        raise ValueError("The supplied runtime differs from the loaded native adapter.")
    native_paths._regular_file(root / native_paths.MARKER, root)
    return root


def owned_file(file, root):
    from nemoclaw_native_windows import _regular_file

    return _regular_file(Path(file), root)


def python_check(root, nonce):
    expected = (
        root
        / "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none"
    )
    assert sys.version_info[:3] == (3, 11, 16)
    assert Path(sys.base_prefix) == expected
    assert owned_file(sys._base_executable, root) == owned_file(
        expected / "python.exe", root
    )
    assert "nemoclaw_native_windows" in sys.modules
    with tempfile.TemporaryDirectory() as directory:
        file = Path(directory) / "owned.txt"
        file.write_text(nonce, encoding="utf-8")
        assert file.read_text(encoding="utf-8") == nonce
        file.unlink()
    assert not Path(directory).exists()
    child = subprocess.run(
        [
            sys.executable,
            "-I",
            "-c",
            "import pathlib,tempfile;\nwith tempfile.TemporaryDirectory() as d:\n p=pathlib.Path(d)/'child';p.write_text('CHILD_TEMP_OK');assert p.read_text()=='CHILD_TEMP_OK';p.unlink()\nassert not pathlib.Path(d).exists();print('CHILD_TEMP_OK')",
        ],
        capture_output=True,
        text=True,
        timeout=15,
    )
    assert child.returncode == 0 and child.stdout.strip() == "CHILD_TEMP_OK", repr(
        child
    )
    return {
        "baseExecutable": sys._base_executable,
        "basePrefix": sys.base_prefix,
        "version": sys.version,
        "parentTemp": True,
        "childTemp": True,
        "aclVerified": False,
        "tokenVerified": False,
        "versions": {
            name: importlib.metadata.version(name)
            for name in ["hermes-agent", "pywinpty", "cryptography"]
        },
    }


def bash_check(root, nonce):
    from tools.environments.local import LocalEnvironment, _find_bash

    selected = owned_file(_find_bash(), root)
    assert selected == owned_file(root / "git/bin/bash.exe", root)
    environment = LocalEnvironment(cwd=os.getcwd(), timeout=20)
    try:
        result = environment.execute(
            "printf '%s' '"
            + nonce
            + "' > canonical-shell.txt && cat canonical-shell.txt && rm canonical-shell.txt",
            timeout=20,
            bounded_capture=True,
        )
        assert result["returncode"] == 0 and nonce in result["output"], repr(result)
        assert not Path("canonical-shell.txt").exists()
        return {
            "selectedBash": str(selected),
            "canonicalLocalEnvironment": True,
            "result": result,
        }
    finally:
        environment.cleanup()


def conpty_check(_root, nonce):
    from winpty import PTY
    from winpty.enums import Backend
    import winpty.winpty as native

    assert importlib.metadata.version("pywinpty") == "2.0.15"
    pty = PTY(80, 24, backend=Backend.ConPTY)
    command = " " + subprocess.list2cmdline(["-I", "-c", "print('" + nonce + "')"])
    assert pty.spawn(sys.executable, cmdline=command, cwd=os.getcwd())
    output = ""
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        output += pty.read(4096, blocking=False)
        assert len(output) <= 65536
        if not pty.isalive() and pty.iseof():
            break
        time.sleep(0.02)
    assert not pty.isalive() and pty.get_exitstatus() == 0 and nonce in output, repr(
        output
    )
    return {
        "backend": "ConPTY",
        "nativeModule": native.__file__,
        "pid": pty.pid,
        "exitCode": pty.get_exitstatus(),
        "output": output,
    }


def browser_check(root, nonce):
    from tools.browser_use_cli import browser_exec, _backend_cache_key
    from tools.browser_tool_install import _find_agent_browser
    from tools.browser_tool_lifecycle import cleanup_browser
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import threading

    expected = root / "agent-browser/bin/agent-browser-win32-x64.exe"
    assert owned_file(_find_agent_browser(validate=True), root) == owned_file(
        expected, root
    )
    page = (
        "<!doctype html><title>Hermes Personal proof</title><p id='sentinel'>"
        + nonce
        + "</p>"
    ).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    session = "nc-" + nonce[:12]
    task = "personal-" + nonce[:12]
    errors = []
    primary = None
    result = None
    try:
        code = (
            "new_tab('http://127.0.0.1:"
            + str(server.server_port)
            + "/'); wait_for_load(); assert js('document.title') == 'Hermes Personal proof'; assert js(\"document.getElementById('sentinel').textContent\") == '"
            + nonce
            + "'; print('BROWSER_PERSONAL_OK')"
        )
        raw = browser_exec(code, session=session, task_id=task, timeout_s=45)
        result = json.loads(raw) if isinstance(raw, str) else raw
        assert (
            result["success"] is True
            and result["exit_code"] == 0
            and "BROWSER_PERSONAL_OK" in result["output"]
        ), repr(result)
    except BaseException as error:
        primary = error
    finally:
        try:
            # The Browser Use daemon is a distinct owner from agent-browser.
            # Its official shutdown checks PID/start identity; no process-name kill.
            tool_python = root / "tools/browser-use/Scripts/python.exe"
            shutdown = subprocess.run(
                [
                    str(tool_python),
                    "-I",
                    "-c",
                    "from browser_harness.admin import restart_daemon, ipc;restart_daemon(name='"
                    + session
                    + "');assert not ipc.ping('"
                    + session
                    + "',timeout=1.0);print('HARNESS_STOPPED')",
                ],
                capture_output=True,
                text=True,
                timeout=15,
            )
            assert shutdown.returncode == 0 and "HARNESS_STOPPED" in shutdown.stdout, (
                repr(shutdown)
            )
        except BaseException as error:
            errors.append(repr(error))
        try:
            cleanup_browser(_backend_cache_key(task, session))
        except BaseException as error:
            errors.append(repr(error))
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        if thread.is_alive():
            errors.append("Owned localhost server did not stop")
    if primary:
        primary.add_note("Browser cleanup: " + repr(errors))
        raise primary
    assert not errors, repr(errors)
    return {
        "browserUseResult": result,
        "selectedAgentBrowser": str(expected),
        "chromiumPath": os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH"),
        "browserHarnessEndpointClosed": True,
        "browserHarnessProcessExitIndependentlyVerified": False,
        "canonicalBrowserCleanupCalled": True,
        "ownedPageServerStopped": True,
        "tavilyLiveLookup": "not-tested-user-waiver",
    }


def main():
    kind, directory, nonce = sys.argv[1:]
    result = {"schemaVersion": 1, "component": kind, "nonce": nonce, "passed": False}
    try:
        assert (
            os.name == "nt"
            and len(nonce) == 24
            and all(value in "0123456789abcdef" for value in nonce)
        )
        root = owned_runtime(directory)
        # Retain the old prelude's actual Windows outcome separately; it is
        # not used as authority or allowed to prevent the component operation.
        try:
            previous = root.resolve(strict=True)
            result["previousFinalPathPrelude"] = {
                "succeeded": True,
                "path": str(previous),
            }
        except OSError as error:
            result["previousFinalPathPrelude"] = {
                "succeeded": False,
                "error": repr(error),
                "winerror": getattr(error, "winerror", None),
            }
        result["details"] = {
            "python": python_check,
            "bash": bash_check,
            "conpty": conpty_check,
            "browser": browser_check,
        }[kind](root, nonce)
        result["passed"] = True
    except BaseException:
        result["error"] = traceback.format_exc()[-16000:]
    print("NEMOCLAW_PERSONAL_RESULT=" + json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
