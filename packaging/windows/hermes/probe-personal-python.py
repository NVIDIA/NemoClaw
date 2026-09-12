# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Fixed canonical tool operations, invoked only inside the owned MXC workload."""

import importlib.metadata
import hashlib
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
            "-B",
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
    from winpty import PTY, WinptyError
    from winpty.enums import Backend
    import winpty.winpty as native

    assert importlib.metadata.version("pywinpty") == "2.0.15"
    pty = PTY(80, 24, backend=Backend.ConPTY)
    command = " " + subprocess.list2cmdline(
        ["-I", "-B", "-c", "print('" + nonce + "')"]
    )
    output = ""
    details = {
        "backend": "ConPTY",
        "nativeModule": native.__file__,
        "pid": None,
        "exitCode": None,
        "childExitObserved": False,
        "eofObserved": False,
        "deadlineExpired": False,
    }
    try:
        assert pty.spawn(sys.executable, cmdline=command, cwd=os.getcwd())
        details["pid"] = pty.pid
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if not details["eofObserved"]:
                try:
                    output += pty.read(4096, blocking=False)
                except WinptyError as error:
                    # Locked winpty-rs0.4.1 emits this only after EOF and an
                    # empty output cache. It proves draining, not child success.
                    if str(error) != "Standard out reached EOF":
                        raise
                    details["eofObserved"] = True
                assert len(output) <= 65536, "ConPTY output exceeded its bound"
            details["childExitObserved"] = not pty.isalive()
            if details["childExitObserved"] and details["eofObserved"]:
                break
            time.sleep(0.02)
        else:
            details["deadlineExpired"] = True
        details["exitCode"] = pty.get_exitstatus()
        assert (
            details["childExitObserved"]
            and details["eofObserved"]
            and details["exitCode"] == 0
            and nonce in output
        ), "ConPTY did not drain its sentinel and exit successfully"
        return {**details, "output": output}
    except BaseException as error:
        # Preserve the primary read/exit error and bounded partial output. A
        # diagnostic status query must not replace the original failure.
        for key, method in (
            ("childExitObserved", "isalive"),
            ("exitCode", "get_exitstatus"),
        ):
            try:
                value = getattr(pty, method)()
                details[key] = not value if key == "childExitObserved" else value
            except BaseException as query_error:
                details[key + "Error"] = repr(query_error)
        error.add_note(
            "ConPTY probe details: "
            + json.dumps(
                {**details, "output": output[-8192:], "outputChars": len(output)}
            )
        )
        raise
    finally:
        # The canonical destructor owns ClosePseudoConsole, its pipe readers
        # and the original process/thread handles. No host PID reopening.
        pty = None


def configure_browser_logging():
    state = Path(os.environ["NEMOCLAW_AGENT_HOME"])
    # Derive logs from the admitted state even when TEMP differs.
    if os.environ.get("AGENT_BROWSER_ARGS") not in {
        "--enable-logging=stderr",
        "--enable-logging",
    }:
        raise ValueError("Unexpected canonical browser diagnostic arguments")
    # agent-browser 0.26 retains Chrome's stderr pipe without draining it after
    # DevToolsActivePort succeeds. Keep logging, directed to our owned file.
    log = state / "temp/chrome.log"
    os.environ["AGENT_BROWSER_ARGS"] = "--enable-logging"
    os.environ["CHROME_LOG_FILE"] = str(log)
    return state, log


def browser_log_tail(file, state):
    from nemoclaw_native_windows import NativeStartupRefusal

    record = {"path": str(file), "present": False}
    try:
        target = owned_file(file, state)
        with target.open("rb") as stream:
            size = os.fstat(stream.fileno()).st_size
            start = max(0, size - 4096)
            stream.seek(start)
            data = stream.read(min(size, 4096))
        record.update(
            present=True,
            totalBytesObserved=size,
            observedTailOffset=start,
            observedTailBytes=len(data),
            observedTailSha256=hashlib.sha256(data).hexdigest(),
            truncated=start > 0,
            text=data.decode("utf-8", errors="replace"),
        )
    except FileNotFoundError:
        pass
    except (Exception, NativeStartupRefusal) as error:
        record["readError"] = repr(error)[:512]
    return record


def bounded_browser_diagnostics(value):
    value["serializedLimitBytes"] = 12 * 1024
    value["aggregateTruncated"] = False
    while len(json.dumps(value).encode("utf-8")) > 12 * 1024:
        fields = [
            (row, key)
            for row in value["logs"].values()
            for key in ["text", "readError"]
            if isinstance(row.get(key), str) and row[key]
        ]
        if not fields:
            return {
                "serializedLimitBytes": 12 * 1024,
                "aggregateTruncated": True,
                "readError": "Browser diagnostic metadata exceeded its fixed bound",
            }
        row, key = max(fields, key=lambda pair: len(pair[0][pair[1]]))
        row[key] = row[key][len(row[key]) // 2 + 1 :]
        row["renderedTailTruncated"] = True
        value["aggregateTruncated"] = True
    return value


def browser_shutdown_code(session, state, retain_log):
    code = "from browser_harness.admin import restart_daemon, ipc\n"
    if retain_log:
        # Reuse this small reader in the existing shutdown interpreter. Its
        # canonical package resolves the real log path; .port tokens are never read.
        code += (
            "import importlib.util,json,pathlib\ntry:\n"
            + " spec=importlib.util.spec_from_file_location('nc_browser_log',"
            + repr(__file__)
            + ")\n"
            + " observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)\n"
            + " record=observer.browser_log_tail(ipc.log_path("
            + repr(session)
            + "),pathlib.Path("
            + repr(str(state))
            + "))\n"
            + "except Exception as error:\n record={'readError':repr(error)[:512]}\n"
            + "print('NEMOCLAW_BROWSER_HARNESS_LOG='+json.dumps(record))\n"
        )
    return code + (
        "restart_daemon(name="
        + repr(session)
        + ");assert not ipc.ping("
        + repr(session)
        + ",timeout=1.0);print('HARNESS_STOPPED')"
    )


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
    state, chrome_log = configure_browser_logging()
    diagnostics = {
        "chromeLogging": {"arguments": "--enable-logging", "file": str(chrome_log)},
        "logs": {},
    }
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
    raw = None
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
            isinstance(result, dict)
            and result.get("success") is True
            and type(result.get("exit_code")) is int
            and result.get("exit_code") == 0
            and result.get("error") is None
            and isinstance(result.get("output"), str)
            and "BROWSER_PERSONAL_OK" in result["output"]
        ), "Browser response did not satisfy the complete success contract"
    except BaseException as error:
        error.add_note("Browser Use raw response: " + repr(raw))
        primary = error
    finally:
        if primary:
            diagnostics["logs"]["chrome"] = browser_log_tail(chrome_log, state)
        try:
            # The Browser Use daemon is a distinct owner from agent-browser.
            # Its official shutdown checks PID/start identity; no process-name kill.
            tool_python = root / "tools/browser-use/Scripts/python.exe"
            shutdown = subprocess.run(
                [
                    str(tool_python),
                    "-I",
                    "-B",
                    "-c",
                    browser_shutdown_code(session, state, primary is not None),
                ],
                capture_output=True,
                text=True,
                timeout=15,
            )
            if primary:
                rows = [
                    line.split("=", 1)[1]
                    for line in shutdown.stdout.splitlines()
                    if line.startswith("NEMOCLAW_BROWSER_HARNESS_LOG=")
                ]
                diagnostics["logs"]["browserHarness"] = (
                    json.loads(rows[0])
                    if len(rows) == 1
                    else {
                        "readError": "The shutdown observer did not return exactly one log record"
                    }
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
        primary.nemoclaw_browser_diagnostics = bounded_browser_diagnostics(diagnostics)
        raise primary
    assert not errors, repr(errors)
    return {
        "browserUseResult": result,
        "selectedAgentBrowser": str(expected),
        "chromiumPath": os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH"),
        "chromeLogging": diagnostics["chromeLogging"],
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
    except BaseException as error:
        result["error"] = traceback.format_exc()[-16000:]
        if hasattr(error, "nemoclaw_browser_diagnostics"):
            result["browserDiagnostics"] = error.nemoclaw_browser_diagnostics
    print("NEMOCLAW_PERSONAL_RESULT=" + json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
