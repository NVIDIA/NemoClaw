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


class BrowserHarnessProcess:
    """Retain only query/synchronize access to the authenticated Windows daemon."""

    def __init__(self, pid):
        import ctypes

        self.ctypes = ctypes
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        handle, dword, boolean = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int

        class Filetime(ctypes.Structure):
            _fields_ = [("low", dword), ("high", dword)]

        self.Filetime = Filetime
        declarations = {
            "OpenProcess": ([dword, boolean, dword], handle),
            "GetProcessId": ([handle], dword),
            "GetProcessTimes": ([handle] + [ctypes.POINTER(Filetime)] * 4, boolean),
            "GetExitCodeProcess": ([handle, ctypes.POINTER(dword)], boolean),
            "WaitForSingleObject": ([handle, dword], dword),
            "CloseHandle": ([handle], boolean),
        }
        for name, (arguments, result) in declarations.items():
            function = getattr(self.kernel, name)
            function.argtypes, function.restype = arguments, result
        self.handle = self.kernel.OpenProcess(0x00101000, False, pid)
        if not self.handle:
            raise ctypes.WinError(ctypes.get_last_error())

    def identity(self):
        values = [self.Filetime() for _ in range(4)]
        pid = self.kernel.GetProcessId(self.handle)
        if not pid or not self.kernel.GetProcessTimes(
            self.handle, *(self.ctypes.byref(v) for v in values)
        ):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        return pid, str((values[0].high << 32) | values[0].low)

    def wait(self, seconds):
        value = self.kernel.WaitForSingleObject(
            self.handle, max(0, int(seconds * 1000))
        )
        if value not in (0, 258):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        return value == 0

    def exit_code(self):
        code = self.ctypes.c_uint32()
        if not self.kernel.GetExitCodeProcess(self.handle, self.ctypes.byref(code)):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        return code.value

    def close(self):
        if not self.kernel.CloseHandle(self.handle):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        self.handle = None


def shutdown_browser_harness(
    session, state, ipc, process_factory=BrowserHarnessProcess
):
    from nemoclaw_native_windows import NativeStartupRefusal
    import re

    record = {
        "schemaVersion": 1,
        "classification": "authenticated-Windows-browser-harness-shutdown",
        "session": session,
        "recordsAbsent": False,
        "identifiedPid": None,
        "creationFiletime": None,
        "processHandleRetained": False,
        "openProcessAccess": "0x00101000",
        "identityReconfirmed": False,
        "shutdownAcknowledged": False,
        "processExitObserved": False,
        "exitCode": None,
        "endpointRemoved": False,
        "pidRecordRemoved": False,
        "handleClosed": True,
        "complete": False,
        "error": None,
    }
    started = time.monotonic()
    deadline = (
        started + 12
    )  # Leave startup/log/receipt margin under the existing 15s subprocess ceiling.
    process = None
    stage = "validate-owned-endpoint"

    def read_owned(file, limit):
        Path(file).relative_to(state)
        if not Path(file).exists():
            return None
        with owned_file(file, state).open("rb") as stream:
            data = stream.read(limit + 1)
        if len(data) > limit:
            raise ValueError("Browser Harness ownership record exceeded its bound")
        return data

    try:
        if not re.fullmatch(r"nc-[a-f0-9]{12}", session):
            raise ValueError("Unexpected owned Browser Harness session")
        port_file, pid_file = ipc.port_path(session), ipc.pid_path(session)
        endpoint_bytes, pid_bytes = (
            read_owned(port_file, 4096),
            read_owned(pid_file, 128),
        )
        if endpoint_bytes is None:
            if pid_bytes is not None:
                raise ValueError(
                    "Daemon PID record exists without an authenticated endpoint"
                )
            record["recordsAbsent"] = True
            record["complete"] = True
            return record
        endpoint = json.loads(endpoint_bytes)
        if (
            type(endpoint.get("port")) is not int
            or not 0 < endpoint["port"] <= 65535
            or not isinstance(endpoint.get("token"), str)
            or not re.fullmatch(r"[a-f0-9]{64}", endpoint["token"])
        ):
            raise ValueError("Invalid owned Browser Harness endpoint record")
        record["endpointRecordSha256"] = hashlib.sha256(endpoint_bytes).hexdigest()

        def call(request, seconds):
            if read_owned(port_file, 4096) != endpoint_bytes:
                raise ValueError("Browser Harness endpoint identity changed")
            remaining = min(seconds, deadline - time.monotonic())
            if remaining <= 0:
                raise TimeoutError("Browser Harness shutdown budget exhausted")
            channel, token = ipc.connect(session, timeout=remaining)
            try:
                if (
                    token != endpoint["token"]
                    or channel.getpeername()[:2] != ("127.0.0.1", endpoint["port"])
                    or read_owned(port_file, 4096) != endpoint_bytes
                ):
                    raise ValueError("Authenticated Browser Harness endpoint differs")
                channel.settimeout(
                    max(0.001, min(seconds, deadline - time.monotonic()))
                )
                return ipc.request(channel, token, request)
            finally:
                channel.close()

        stage = "authenticate-daemon"
        identified = call({"meta": "ping"}, 1)
        pid = identified.get("pid") if isinstance(identified, dict) else None
        if (
            not isinstance(identified, dict)
            or identified.get("pong") is not True
            or type(pid) is not int
            or not 0 < pid < 2**32
            or identified.get("browser_kind") not in {"local", "cdp"}
        ):
            raise ValueError("The owned endpoint did not identify a local daemon")
        if pid_bytes is not None and pid_bytes.strip() != str(pid).encode():
            raise ValueError("Daemon PID record differs from authenticated identity")
        record["identifiedPid"] = pid
        stage = "retain-daemon-handle"
        process = process_factory(pid)
        record["processHandleRetained"] = True
        record["handleClosed"] = False
        actual_pid, creation = process.identity()
        if actual_pid != pid or process.wait(0):
            raise ValueError("The identified daemon process changed before shutdown")
        record["creationFiletime"] = creation
        stage = "reconfirm-daemon-identity"
        again = call({"meta": "ping"}, 1)
        if (
            not isinstance(again, dict)
            or again.get("pong") is not True
            or type(again.get("pid")) is not int
            or again.get("pid") != pid
            or process.wait(0)
        ):
            raise ValueError(
                "The retained daemon no longer owns the authenticated endpoint"
            )
        record["identityReconfirmed"] = True
        stage = "request-authenticated-shutdown"
        response = call({"meta": "shutdown"}, 5)
        if (
            not isinstance(response, dict)
            or response.get("ok") is not True
            or response.get("error")
        ):
            raise ValueError("Browser Harness did not acknowledge clean shutdown")
        record["shutdownAcknowledged"] = True
        stage = "wait-for-daemon-exit"
        if not process.wait(max(0, deadline - time.monotonic())):
            raise TimeoutError(
                "The identified daemon did not exit within cleanup budget"
            )
        record["processExitObserved"] = True
        record["exitCode"] = process.exit_code()
        stage = "remove-exited-daemon-records"
        remaining_endpoint = read_owned(port_file, 4096)
        if remaining_endpoint is not None and remaining_endpoint != endpoint_bytes:
            raise ValueError("A successor changed the Browser Harness endpoint")
        remaining_pid = read_owned(pid_file, 128)
        if remaining_pid is not None and remaining_pid.strip() != str(pid).encode():
            raise ValueError("A successor changed the Browser Harness PID record")
        ipc.cleanup_endpoint(session)
        record["endpointRemoved"] = not Path(port_file).exists()
        if remaining_pid is not None:
            Path(pid_file).unlink(missing_ok=True)
        record["pidRecordRemoved"] = not Path(pid_file).exists()
    except (Exception, NativeStartupRefusal) as error:
        record["error"] = {
            "stage": stage,
            "name": type(error).__name__,
            "message": str(error)[:512],
            "winerror": getattr(error, "winerror", None),
        }
    finally:
        if process is not None:
            try:
                process.close()
                record["handleClosed"] = True
            except Exception as error:
                record["closeError"] = repr(error)[:256]
        record["elapsedMs"] = (time.monotonic() - started) * 1000
    record["complete"] = (
        record["error"] is None
        and record["identityReconfirmed"]
        and record["shutdownAcknowledged"]
        and record["processExitObserved"]
        and record["exitCode"] == 0
        and record["endpointRemoved"]
        and record["pidRecordRemoved"]
        and record["handleClosed"]
    )
    return record


def browser_shutdown_code(session, state, retain_log):
    code = (
        "import importlib.util,json,pathlib\nfrom browser_harness import _ipc as ipc\n"
        + "spec=importlib.util.spec_from_file_location('nc_browser_log',"
        + repr(__file__)
        + ")\n"
        + "observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)\n"
    )
    if retain_log:
        # Reuse this small reader in the existing shutdown interpreter. Its
        # canonical package resolves the real log path; .port tokens are never read.
        code += (
            "try:\n record=observer.browser_log_tail(ipc.log_path("
            + repr(session)
            + "),pathlib.Path("
            + repr(str(state))
            + "))\n"
            + "except Exception as error:\n record={'readError':repr(error)[:512]}\n"
            + "print('NEMOCLAW_BROWSER_HARNESS_LOG='+json.dumps(record))\n"
        )
    return code + (
        "shutdown=observer.shutdown_browser_harness("
        + repr(session)
        + ",pathlib.Path("
        + repr(str(state))
        + "),ipc)\n"
        + "print('NEMOCLAW_BROWSER_HARNESS_SHUTDOWN='+json.dumps(shutdown))\n"
        + "assert shutdown['complete'],'Browser Harness shutdown failed: '+json.dumps(shutdown)\nprint('HARNESS_STOPPED')"
    )


def browser_page_code(url, nonce):
    # The canonical marker may decorate document.title. Actual owned navigation
    # and rendered nonce content are the acceptance evidence.
    snapshot = (
        "(()=>{const e=document.getElementById('sentinel');return {"
        "url:location.href.slice(0,512),title:document.title.slice(0,256),"
        "readyState:document.readyState,sentinel:e?e.textContent.slice(0,128):null};})()"
    )
    return (
        "import json\n"
        + "expected_url="
        + repr(url)
        + "\nexpected_nonce="
        + repr(nonce)
        + "\n"
        + "actual=None\nstage='navigate-owned-page'\ntry:\n"
        + " new_tab(expected_url)\n stage='wait-rendered-sentinel'\n"
        + " visible=wait_for_element('#sentinel',timeout=15.0,visible=True)\n"
        + " stage='observe-owned-page'\n actual=js("
        + repr(snapshot)
        + ")\n"
        + " print('NEMOCLAW_BROWSER_PAGE_STATE='+json.dumps({'visible':visible,'actual':actual}))\n"
        + " stage='assert-rendered-sentinel'\n assert visible is True,'#sentinel did not become visible'\n"
        + " stage='assert-owned-url'\n assert isinstance(actual,dict) and actual.get('url')==expected_url,'owned URL mismatch'\n"
        + " stage='assert-owned-nonce'\n assert actual.get('sentinel')==expected_nonce,'rendered nonce mismatch'\n"
        + "except Exception as error:\n"
        + " raise RuntimeError(f'Browser stage {stage}: expected_url={expected_url!r}, expected_nonce={expected_nonce!r}, actual={actual!r}; {error}') from error\n"
        + "print('BROWSER_PERSONAL_OK')"
    )


def browser_page_observation(result):
    if not isinstance(result, dict) or not isinstance(result.get("output"), str):
        return None
    rows = [
        line.split("=", 1)[1]
        for line in result["output"].splitlines()
        if line.startswith("NEMOCLAW_BROWSER_PAGE_STATE=")
    ]
    if len(rows) != 1 or len(rows[0].encode()) > 4096:
        return None
    try:
        value = json.loads(rows[0])
        return value if isinstance(value, dict) else None
    except ValueError:
        return None


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
        code = browser_page_code(
            "http://127.0.0.1:" + str(server.server_port) + "/", nonce
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
        diagnostics["pageObservation"] = browser_page_observation(result)
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
            shutdown_rows = [
                line.split("=", 1)[1]
                for line in shutdown.stdout.splitlines()
                if line.startswith("NEMOCLAW_BROWSER_HARNESS_SHUTDOWN=")
            ]
            diagnostics["harnessShutdown"] = (
                json.loads(shutdown_rows[0]) if len(shutdown_rows) == 1 else None
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
            assert (
                shutdown.returncode == 0
                and "HARNESS_STOPPED" in shutdown.stdout
                and isinstance(diagnostics["harnessShutdown"], dict)
                and diagnostics["harnessShutdown"].get("complete") is True
            ), repr(shutdown)
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
    if errors:
        failure = AssertionError("Browser cleanup failed: " + repr(errors))
        failure.nemoclaw_browser_diagnostics = bounded_browser_diagnostics(diagnostics)
        raise failure
    return {
        "browserUseResult": result,
        "selectedAgentBrowser": str(expected),
        "chromiumPath": os.environ.get("AGENT_BROWSER_EXECUTABLE_PATH"),
        "chromeLogging": diagnostics["chromeLogging"],
        "pageObservation": diagnostics["pageObservation"],
        "browserHarnessShutdown": diagnostics["harnessShutdown"],
        "browserHarnessEndpointClosed": True,
        "browserHarnessProcessExitIndependentlyVerified": diagnostics[
            "harnessShutdown"
        ].get("processExitObserved")
        is True,
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
