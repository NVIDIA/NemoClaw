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
    import nemoclaw_native_windows as native_paths

    return native_paths._regular_file(Path(file), root)


def renderer_wer_paths(runtime, state, selected):
    """Admit only the separately owned diagnostic copy for this exact session."""
    from pathlib import PureWindowsPath
    import re

    match = re.fullmatch(
        r"([A-Za-z]):\\NemoClawMsysProof-([a-f0-9]{12})-state-start", state
    )
    if not match or PureWindowsPath(runtime).drive != match[1] + ":":
        raise ValueError("Renderer WER diagnostic state identity differs")
    owner = PureWindowsPath(match[1] + ":\\NemoClawRendererWer-" + match[2])
    expected = owner / "chrome-win64/chrome.exe"
    if selected != str(expected):
        raise ValueError("Renderer WER diagnostic Chrome path differs")
    return str(expected), str(owner)


def selected_chrome_file(root, default):
    selected = os.environ.get("NEMOCLAW_HERMES_WER_CHROME")
    if not selected:
        return owned_file(default, root)
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Renderer WER selection requires the explicit CI diagnostic")
    file, owner = renderer_wer_paths(
        str(root), os.environ.get("NEMOCLAW_AGENT_HOME", ""), selected
    )
    return owned_file(Path(file), Path(owner))


def runtime_readonly_check(root):
    """Observe access to one existing static runtime file without changing it."""
    import ctypes

    relative = "tools/browser-use/Lib/site-packages/browser_use/cli.py"
    record = {
        "relativePath": relative,
        "creationDisposition": 3,
        "shareMode": 7,
        "fileFlags": 0x00200000,
        "contentWriteAttempted": False,
        "passed": False,
        "operations": {},
    }
    try:
        file = owned_file(root / relative, root)
        record["path"] = str(file)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        handle, dword, boolean = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int
        for name, arguments, result in (
            (
                "CreateFileW",
                [ctypes.c_wchar_p, dword, dword, handle, dword, dword, handle],
                handle,
            ),
            (
                "ReadFile",
                [handle, handle, dword, ctypes.POINTER(dword), handle],
                boolean,
            ),
            ("CloseHandle", [handle], boolean),
        ):
            function = getattr(kernel, name)
            function.argtypes, function.restype = arguments, result
        invalid = handle(-1).value
        for name, mask in (("read", 0x80000000), ("write", 2)):
            row = {
                "accessMask": mask,
                "openSucceeded": False,
                "openError": None,
                "handleClosed": None,
            }
            record["operations"][name] = row
            opened = kernel.CreateFileW(str(file), mask, 7, None, 3, 0x00200000, None)
            row["openSucceeded"] = opened not in (None, invalid)
            row["invalidHandleReturned"] = opened == invalid
            row["openError"] = 0 if row["openSucceeded"] else ctypes.get_last_error()
            if not row["openSucceeded"]:
                continue
            try:
                if name == "read":
                    data, copied = ctypes.create_string_buffer(64), dword()
                    row["readSucceeded"] = bool(
                        kernel.ReadFile(opened, data, 64, ctypes.byref(copied), None)
                    )
                    row["readError"] = (
                        0 if row["readSucceeded"] else ctypes.get_last_error()
                    )
                    row["bytesRead"] = copied.value
                    if row["readSucceeded"] and 0 < copied.value <= 64:
                        row["prefixSha256"] = hashlib.sha256(
                            data.raw[: copied.value]
                        ).hexdigest()
            finally:
                row["handleClosed"] = bool(kernel.CloseHandle(opened))
                row["closeError"] = (
                    0 if row["handleClosed"] else ctypes.get_last_error()
                )
        read, write = record["operations"]["read"], record["operations"]["write"]
        record["passed"] = (
            read["openSucceeded"]
            and read.get("readSucceeded") is True
            and read.get("bytesRead") == 64
            and read["handleClosed"] is True
            and not write["openSucceeded"]
            and write["invalidHandleReturned"]
            and write["openError"] == 5
        )
        if not record["passed"]:
            raise AssertionError(
                "Canonical runtime read/write-open access proof failed"
            )
        return record
    except BaseException as error:
        error.nemoclaw_runtime_access = record
        raise


def apply_browser_launch_adapter(root):
    """Apply the same owned helper used by installed startup, outside the base."""
    import importlib.util
    import nemoclaw_native_windows as native
    from tools import browser_use_cli

    file = Path(__file__).with_name("nemoclaw_browser_use.py")
    owned_file(file, file.parent)
    content = file.read_bytes()
    spec = importlib.util.spec_from_file_location("nc_current_browser_use", file)
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    result = helper.adapt(browser_use_cli, root, native)
    if file.read_bytes() != content:
        raise ValueError("The staged Browser Use adapter changed during loading.")
    result["source"] = {
        "path": str(file),
        "bytes": len(content),
        "sha256": hashlib.sha256(content).hexdigest(),
    }
    return result


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
        del pty


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
    import nemoclaw_native_windows as native_paths

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
        # Absence is an expected diagnostic state and is reported by present=False.
        pass
    except (Exception, native_paths.NativeStartupRefusal) as error:
        record["readError"] = repr(error)[:512]
    return record


def browser_process_dos_image(process, creation):
    """Read the existing observed PID's DOS image while retaining its generation."""
    record = {
        "api": "QueryFullProcessImageNameW",
        "flags": 0,
        "pid": process.pid,
        "creationFiletime": None,
        "queryAttempted": False,
        "querySucceeded": False,
        "identityRechecked": False,
        "value": None,
        "handleAccess": "0x00101000",
        "handleClosed": True,
        "complete": False,
        "error": None,
    }
    held = None
    stage = "retain-observed-process"
    try:
        held = BrowserHarnessProcess(process.pid)
        record["handleClosed"] = False
        identity = held.identity()
        if (
            identity[0] != process.pid
            or held.wait(0)
            or process.create_time() != creation
        ):
            raise ValueError("Observed process generation changed before image query")
        record["creationFiletime"] = identity[1]
        stage = "query-dos-image"
        record["queryAttempted"] = True
        value = held.image()
        record["querySucceeded"] = True
        stage = "recheck-observed-process"
        if (
            held.identity() != identity
            or held.wait(0)
            or process.create_time() != creation
        ):
            raise ValueError("Observed process generation changed during image query")
        record["identityRechecked"] = True
        record["value"] = value
    except Exception as error:
        record["error"] = {
            "stage": stage,
            "error": repr(error)[:256],
            "winerror": getattr(error, "winerror", None),
        }
    finally:
        if held is not None:
            try:
                held.close()
                record["handleClosed"] = True
            except Exception as error:
                record["closeError"] = repr(error)[:256]
    record["complete"] = (
        record["querySucceeded"]
        and record["identityRechecked"]
        and record["handleClosed"]
        and record["error"] is None
    )
    return record


def browser_agent_state(state, expected, launches):
    """Failure-only query of the exact CLI session before canonical cleanup."""
    import nemoclaw_native_windows as native_paths
    import re

    observation = {
        "diagnosticOnly": True,
        "snapshotOnly": True,
        "historicalProcessExitsObserved": False,
        "commands": [],
        "processes": [],
        "errors": [],
    }
    started = time.monotonic()

    def record_file(file):
        target = owned_file(file, state)
        with target.open("rb") as stream:
            data = stream.read(513)
        if len(data) > 512:
            raise ValueError("Session observation file exceeds 512 bytes")
        return {
            "path": str(file),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "text": data.decode("utf-8"),
        }

    try:
        import psutil

        for argv, env, socket_dir, proc, launched_at in launches[:2]:
            row = {
                "argv": argv,
                "pid": proc.pid,
                # Read the result already collected by the canonical caller;
                # do not poll/wait, signal or change its returned exception.
                "returncode": proc.returncode,
                "elapsedSinceSpawnMs": int((time.monotonic() - launched_at) * 1000),
                "environment": env,
                "sessionDirectory": socket_dir,
                "files": {},
            }
            observation["commands"].append(row)
            session = argv[argv.index("--session") + 1]
            directory = Path(socket_dir)
            directory.relative_to(state)
            if (
                Path(argv[0]) != expected
                or not re.fullmatch(r"h_[0-9a-f]{10}", session)
                or directory.name != "agent-browser-" + session
                or env.get("AGENT_BROWSER_SOCKET_DIR") != socket_dir
            ):
                raise ValueError("Unexpected canonical agent-browser session identity")
            for extension in ("pid", "port", "version"):
                try:
                    row["files"][extension] = record_file(
                        directory / (session + "." + extension)
                    )
                except (Exception, native_paths.NativeStartupRefusal) as error:
                    row["files"][extension] = {"readError": repr(error)[:256]}
            pid_text = row["files"]["pid"].get("text", "").strip()
            if not pid_text.isdigit() or not 0 < int(pid_text) < 2**32:
                continue
            daemon = psutil.Process(int(pid_text))
            created = daemon.create_time()
            daemon_env = daemon.environ()
            daemon_executable = daemon.exe()
            row["daemonExecutableObserved"] = {
                "value": daemon_executable[:512],
                "characters": len(daemon_executable),
                "truncated": len(daemon_executable) > 512,
            }
            row["daemonDosImage"] = browser_process_dos_image(daemon, created)
            row["daemonIdentityChecks"] = {
                "executableMatches": row["daemonDosImage"]["complete"]
                and Path(row["daemonDosImage"]["value"]) == expected,
                "socketDirectoryMatches": daemon_env.get("AGENT_BROWSER_SOCKET_DIR")
                == socket_dir,
                "sessionMatches": daemon_env.get("AGENT_BROWSER_SESSION") == session,
            }
            if not all(row["daemonIdentityChecks"].values()):
                raise ValueError(
                    "Daemon PID is not bound to the exact canonical session"
                )
            row["daemonIdentityBound"] = True
            queue = [(daemon, None, created)]
            seen = set()
            while queue and len(observation["processes"]) < 8:
                if time.monotonic() - started > 2:
                    observation["queryBudgetExhausted"] = True
                    break
                current, parent, creation = queue.pop(0)
                if current.pid in seen:
                    continue
                seen.add(current.pid)
                try:
                    if current.create_time() != creation or not current.is_running():
                        raise ValueError("Process identity changed during observation")
                    psutil_executable = current.exe()
                    dos_image = browser_process_dos_image(current, creation)
                    if not dos_image["complete"]:
                        observation["errors"].append(
                            {"pid": current.pid, "dosImage": dos_image}
                        )
                        raise ValueError("Observed process DOS image is unavailable")
                    executable = dos_image["value"]
                    command = current.cmdline()
                    parent_pid = current.ppid()
                    relation = parent is None or (
                        parent_pid == parent[0] and creation >= parent[1]
                    )
                    if not relation or not current.is_running():
                        raise ValueError("Observed child no longer matches its parent")
                    selected = [
                        arg
                        for arg in command
                        if arg.startswith(
                            (
                                "--type=",
                                "--utility-sub-type=",
                                "--user-data-dir=",
                                "--remote-debugging-",
                                "--headless",
                                "--enable-logging",
                            )
                        )
                    ]
                    record = {
                        "pid": current.pid,
                        "parentPid": parent_pid,
                        "creationTime": creation,
                        "parentCreationTime": parent[1] if parent else None,
                        "executable": executable,
                        "psutilExecutableObserved": {
                            "value": psutil_executable[:512],
                            "characters": len(psutil_executable),
                            "truncated": len(psutil_executable) > 512,
                        },
                        "dosImage": dos_image,
                        "status": current.status(),
                        "identityRechecked": True,
                        "parentRelationVerified": relation,
                        "commandLineSha256": hashlib.sha256(
                            json.dumps(command).encode()
                        ).hexdigest(),
                        "commandLineArgumentCount": len(command),
                        "selectedArguments": [arg[:512] for arg in selected[:8]],
                        "selectedArgumentsTruncated": len(selected) > 8
                        or any(len(arg) > 512 for arg in selected),
                    }
                    observation["processes"].append(record)
                    for argument in command:
                        if argument.startswith("--user-data-dir="):
                            try:
                                record["devToolsActivePort"] = record_file(
                                    Path(argument.split("=", 1)[1])
                                    / "DevToolsActivePort"
                                )
                            except (Exception, native_paths.NativeStartupRefusal) as error:
                                record["devToolsActivePort"] = {
                                    "readError": repr(error)[:256]
                                }
                    # No machine-wide name search: traverse only this verified
                    # session daemon's live descendants, capped at eight rows.
                    for child in current.children(recursive=False)[:8]:
                        queue.append(
                            (child, (current.pid, creation), child.create_time())
                        )
                except (Exception, native_paths.NativeStartupRefusal) as error:
                    observation["errors"].append(
                        {"pid": current.pid, "error": repr(error)[:256]}
                    )
            if queue:
                observation["processesTruncated"] = True
    except (Exception, native_paths.NativeStartupRefusal) as error:
        observation["errors"].append({"error": repr(error)[:256]})
    observation["elapsedMs"] = int((time.monotonic() - started) * 1000)
    # Reserve room for the original error, page/shutdown records and both logs
    # inside the unchanged 12 KiB aggregate browser-diagnostic ceiling.
    while len(json.dumps(observation).encode()) > 6 * 1024:
        observation["aggregateTruncated"] = True
        if observation["processes"]:
            observation["processes"].pop()
        elif observation["commands"]:
            observation["commands"].pop()
        elif observation["errors"]:
            observation["errors"].pop()
        else:
            break
    return observation


def existing_crashpad_reports(
    root, state, observation, budget=2.0, process_factory=None
):
    """Read existing Windows Crashpad reports; never create a database or copy dumps."""
    import nemoclaw_native_windows as native
    import re
    import struct
    import importlib.util

    started = time.monotonic()
    deadline = started + min(2.0, max(0.0, budget))
    result = {
        "classification": "owned-Crashpad-minidump-diagnostic",
        "diagnosticOnly": True,
        "databaseCreated": False,
        "uploadSettingsChanged": False,
        "rawDumpRetained": False,
        "maximumReports": 3,
        "maximumFileBytes": 16 * 1024 * 1024,
        "maximumDirectoryEntries": 64,
        "reports": [],
        "error": None,
        "processHandleClosed": True,
        "stackUnwound": False,
    }
    held = None

    def remaining():
        if time.monotonic() >= deadline:
            raise TimeoutError("Crashpad observation budget exhausted")

    def directory(path):
        native._absolute_path(path).relative_to(state)
        for item in (*reversed(path.parents), path):
            if native._path_kind(item) != "directory":
                raise ValueError("Crashpad directory is redirected or not ordinary")
        return path

    def read_file(path, maximum):
        remaining()
        file = owned_file(path, state)
        with file.open("rb") as source:
            before = os.fstat(source.fileno())
            if not 0 <= before.st_size <= maximum:
                raise ValueError("Crashpad file exceeds its read bound")
            chunks = []
            size = 0
            while True:
                remaining()
                chunk = source.read(min(65536, maximum + 1 - size))
                if not chunk:
                    break
                chunks.append(chunk)
                size += len(chunk)
                if size > maximum:
                    raise ValueError("Crashpad file grew beyond its bound")
            after = os.fstat(source.fileno())
        if (
            before.st_size != after.st_size
            or before.st_mtime_ns != after.st_mtime_ns
            or size != before.st_size
        ):
            raise ValueError("Crashpad file changed during observation")
        return b"".join(chunks)

    try:
        expected = selected_chrome_file(
            root, root / "browsers/chromium-1234/chrome-win64/chrome.exe"
        )
        rows = [
            row
            for row in observation.get("processes", [])
            if Path(row.get("executable", "")) == expected
            and not any(
                arg.startswith("--type=") for arg in row.get("selectedArguments", [])
            )
        ]
        if len(rows) != 1 or rows[0].get("identityRechecked") is not True:
            raise ValueError("No single identity-checked root Chrome profile")
        row = rows[0]
        profiles = [
            arg.split("=", 1)[1]
            for arg in row["selectedArguments"]
            if arg.startswith("--user-data-dir=")
        ]
        if len(profiles) != 1 or row["dosImage"].get("complete") is not True:
            raise ValueError("Chrome profile or DOS identity is ambiguous")
        profile = directory(Path(profiles[0]))
        if len(str(profile.relative_to(state))) > 512:
            raise ValueError("Owned Chrome profile name exceeds its evidence bound")
        parser_path = Path(__file__).with_name("parse-chrome-minidump.py")
        parser_path = owned_file(parser_path, parser_path.parent)
        parser_bytes = parser_path.read_bytes()
        if len(parser_bytes) > 128 * 1024:
            raise ValueError("Minidump parser source exceeds its bound")
        spec = importlib.util.spec_from_file_location("nc_owned_minidump", parser_path)
        parser = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(parser)
        if parser_path.read_bytes() != parser_bytes:
            raise ValueError("Staged minidump parser changed during loading")
        result["parser"] = {
            "file": parser_path.name,
            "bytes": len(parser_bytes),
            "sha256": hashlib.sha256(parser_bytes).hexdigest(),
        }
        held = (process_factory or BrowserHarnessProcess)(row["pid"])
        result["processHandleClosed"] = False
        identity = (row["pid"], row["dosImage"]["creationFiletime"])
        if held.identity() != identity:
            raise ValueError(
                "Chrome process generation changed before Crashpad observation"
            )
        exited = held.wait(0)
        observed = row["dosImage"]
        if (
            observed.get("pid") != identity[0]
            or Path(observed.get("value", "")) != expected
            or not exited
            and Path(held.image()) != expected
        ):
            raise ValueError(
                "Chrome image identity changed before Crashpad observation"
            )
        result["processExitedBeforeRead"] = exited
        result["imageIdentitySource"] = (
            "prior-complete-DOS-observation" if exited else "same-retained-handle"
        )
        result["browserProcess"] = {"pid": identity[0], "creationFiletime": identity[1]}
        database = directory(profile / "Crashpad")
        result["databaseRelativeToState"] = str(database.relative_to(state))
        try:
            settings = read_file(database / "settings.dat", 4096)
            if len(settings) < 40:
                raise ValueError("Crashpad settings header is truncated")
            magic, version, options = struct.unpack_from("<III", settings)
            if magic != 0x43506473 or version != 1:
                raise ValueError("Crashpad settings magic/version differs")
            result["settings"] = {
                "bytes": len(settings),
                "sha256": hashlib.sha256(settings).hexdigest(),
                "version": version,
                "options": hex(options),
                "uploadsEnabled": bool(options & 1),
            }
        except (Exception, native.NativeStartupRefusal) as error:
            result["settings"] = {"error": repr(error)[:160], "uploadsEnabled": None}
        reports = directory(database / "reports")
        names = []
        with os.scandir(reports) as entries:
            for index, entry in enumerate(entries):
                remaining()
                if index == 64:
                    result["directoryTruncated"] = True
                    break
                if re.fullmatch(
                    r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\.dmp",
                    entry.name,
                ):
                    names.append(entry.name)
        result["reportsObserved"] = len(names)
        result["reportsTruncated"] = len(names) > 3
        for name in sorted(names)[:3]:
            record = {"name": name, "rawDumpRetained": False}
            try:
                remaining()
                record["parsed"] = parser.parse_minidump(
                    owned_file(reports / name, state), deadline=deadline
                )
                record["parsed"]["validatedModuleCount"] = len(
                    record["parsed"].get("modules", [])
                )
                record["parsed"]["unreferencedModulesOmitted"] = 0
                record["parsed"].setdefault("stack", {})[
                    "candidateCountBeforeOutputLimit"
                ] = len(record["parsed"].get("stack", {}).get("candidates", []))
            except (Exception, native.NativeStartupRefusal) as error:
                record["error"] = repr(error)[:160]
            result["reports"].append(record)
        result["processIdentityRechecked"] = held.identity() == identity
        result["processStillRunning"] = not held.wait(0)
    except (Exception, native.NativeStartupRefusal) as error:
        result["error"] = repr(error)[:160]
    finally:
        if held is not None:
            try:
                held.close()
                result["processHandleClosed"] = True
            except Exception as error:
                result["processCloseError"] = repr(error)[:160]
    result["elapsedMs"] = int((time.monotonic() - started) * 1000)
    result["serializedLimitBytes"] = 12 * 1024

    # Reserve bytes for the caller's nonce; every iteration removes candidates,
    # condenses one previously full report, or removes a report. Never spin.
    def omit_unreferenced_modules():
        removed = 0
        for report in result["reports"]:
            parsed = report.get("parsed", {})
            references = [
                parsed.get("exception", {}).get("location")
                if parsed.get("exception")
                else None,
                parsed.get("context", {}).get("instructionLocation"),
            ]
            references += parsed.get("stack", {}).get("candidates", [])
            bases = {
                entry.get("base") for entry in references if isinstance(entry, dict)
            }
            modules = parsed.get("modules", [])
            kept = [module for module in modules if module.get("base") in bases]
            if len(kept) < len(modules):
                parsed["unreferencedModulesOmitted"] += len(modules) - len(kept)
                parsed["modules"] = kept
                removed += len(modules) - len(kept)
        return removed

    omit_unreferenced_modules()
    result["aggregateTruncated"] = False
    while len(json.dumps(result).encode()) > 12 * 1024 - 128:
        result["aggregateTruncated"] = True
        if omit_unreferenced_modules():
            continue
        candidates = [
            r["parsed"]["stack"]["candidates"]
            for r in result["reports"]
            if r.get("parsed", {}).get("stack", {}).get("candidates")
        ]
        if candidates:
            max(candidates, key=len).pop()
            continue
        full = [
            r
            for r in result["reports"]
            if "parsed" in r and not r.get("detailsOmittedForBudget")
        ]
        if full:
            report = full[-1]
            parsed = report["parsed"]
            report["parsed"] = {
                key: parsed.get(key)
                for key in (
                    "file",
                    "exception",
                    "headerTimeDateStamp",
                    "miscInfo",
                    "systemInfo",
                )
            }
            report["parsed"]["context"] = {
                "status": parsed.get("context", {}).get("status"),
                "detailsOmittedForBudget": True,
            }
            report["parsed"]["stack"] = {
                "unwound": False,
                "status": "omitted for budget",
                "candidates": [],
            }
            report["detailsOmittedForBudget"] = True
        elif result["reports"]:
            result["reports"].pop()
            result["reportEntriesDroppedForBudget"] = (
                result.get("reportEntriesDroppedForBudget", 0) + 1
            )
        else:
            result = {
                "classification": result["classification"],
                "diagnosticOnly": True,
                "error": "Crashpad metadata exceeded output bound",
                "aggregateTruncated": True,
                "rawDumpRetained": False,
                "processHandleClosed": result["processHandleClosed"],
            }
            break
    return result


def existing_agent_browser_status(
    root, state, observation, budget=1.0, process_factory=None
):
    """One read-only status query to the already identified daemon; never launch a CLI."""
    import nemoclaw_native_windows as native_paths
    import re
    import socket

    started = time.monotonic()
    deadline = started + min(1.0, max(0.0, budget))
    held, channel, request_started = None, None, None
    record = {
        "diagnosticOnly": True,
        "action": "stream_status",
        "stage": "bind-existing-daemon",
        "requestSent": False,
        "responseReceived": False,
        "identityRechecked": False,
        "socketClosed": True,
        "processHandleClosed": True,
        "error": None,
    }

    def remaining():
        seconds = deadline - time.monotonic()
        if seconds <= 0:
            raise TimeoutError("Existing daemon status budget exhausted")
        return seconds

    try:
        rows = observation.get("commands", [])
        if len(rows) != 1 or rows[0].get("daemonIdentityBound") is not True:
            raise ValueError("No single bound existing agent-browser daemon")
        row = rows[0]
        argv = row["argv"]
        expected = owned_file(
            root / "agent-browser/bin/agent-browser-win32-x64.exe", root
        )
        if (
            len(argv) != 6
            or Path(argv[0]) != expected
            or argv[1] != "--session"
            or argv[3:] != ["--json", "get", "cdp-url"]
            or not re.fullmatch(r"h_[a-f0-9]{10}", argv[2])
        ):
            raise ValueError("Existing daemon command/session identity differs")
        session = argv[2]
        directory = state / ("agent-browser-" + session)
        if Path(row["sessionDirectory"]) != directory:
            raise ValueError("Existing daemon directory differs")

        def read_records():
            values = {}
            for suffix in ("pid", "port", "version"):
                path = owned_file(directory / (session + "." + suffix), state)
                with path.open("rb") as source:
                    data = source.read(513)
                saved = row["files"][suffix]
                if (
                    len(data) > 512
                    or len(data) != saved["bytes"]
                    or hashlib.sha256(data).hexdigest() != saved["sha256"]
                ):
                    raise ValueError("Existing daemon record changed: " + suffix)
                values[suffix] = data.decode("ascii").strip()
            return values

        files = read_records()
        if (
            not files["pid"].isdigit()
            or not 0 < int(files["pid"]) < 2**32
            or not files["port"].isdigit()
            or not 0 < int(files["port"]) < 65536
            or files["version"] != "0.26.0"
        ):
            raise ValueError("Existing daemon record values differ")
        pid, port = int(files["pid"]), int(files["port"])
        dos = row["daemonDosImage"]
        if dos.get("complete") is not True or dos.get("pid") != pid:
            raise ValueError("Existing daemon DOS identity is incomplete")
        generation = dos["creationFiletime"]
        held = (process_factory or BrowserHarnessProcess)(pid)
        record["processHandleClosed"] = False
        record.update(pid=pid, creationFiletime=generation, session=session, port=port)

        def recheck():
            if (
                held.identity() != (pid, generation)
                or held.wait(0)
                or Path(held.image()) != expected
                or read_records() != files
            ):
                raise ValueError("Existing daemon process or endpoint changed")

        recheck()
        record["stage"] = "connect-existing-command-port"
        request_started = time.monotonic()
        channel = socket.create_connection(("127.0.0.1", port), timeout=remaining())
        record["socketClosed"] = False
        if channel.getpeername()[:2] != ("127.0.0.1", port):
            raise ValueError("Existing daemon peer differs")
        # This supported skip-launch query reads status/CDP liveness only. It cannot
        # launch/reconfigure/close a browser; the normal handler may await its mutex.
        request = {"id": "nc-status", "action": "stream_status"}
        channel.settimeout(remaining())
        channel.sendall((json.dumps(request) + "\n").encode())
        record["requestSent"] = True
        record["stage"] = "read-status-response"
        data = b""
        while b"\n" not in data:
            channel.settimeout(remaining())
            chunk = channel.recv(2049 - len(data))
            if not chunk:
                raise EOFError("Existing daemon closed before a status response")
            data += chunk
            if len(data) > 2048:
                record["responseTruncated"] = True
                raise ValueError("Existing daemon response exceeded2048 bytes")
        record["responseBytes"] = len(data)
        record["responseSha256"] = hashlib.sha256(data).hexdigest()
        response = json.loads(data)
        if (
            response.get("id") != "nc-status"
            or type(response.get("success")) is not bool
        ):
            raise ValueError("Existing daemon response envelope differs")
        record["responseReceived"] = True
        status = response.get("data")
        if response["success"]:
            if (
                not isinstance(status, dict)
                or set(status) != {"enabled", "port", "connected", "screencasting"}
                or any(
                    type(status[k]) is not bool
                    for k in ("enabled", "connected", "screencasting")
                )
                or status["port"] is not None
                and (type(status["port"]) is not int or not 0 <= status["port"] < 65536)
            ):
                raise ValueError("Existing daemon status schema differs")
            record["status"] = status
        else:
            record["daemonError"] = str(response.get("error"))[:160]
        recheck()
        record["identityRechecked"] = True
        record["stage"] = "complete"
    except (Exception, native_paths.NativeStartupRefusal) as error:
        record["error"] = repr(error)[:160]
    finally:
        if request_started is not None:
            record["requestElapsedMs"] = int(
                (time.monotonic() - request_started) * 1000
            )
        if channel is not None:
            try:
                channel.close()
                record["socketClosed"] = True
            except Exception as error:
                record["socketCloseError"] = repr(error)[:120]
        if held is not None:
            try:
                held.close()
                record["processHandleClosed"] = True
            except Exception as error:
                record["processCloseError"] = repr(error)[:120]
    record["elapsedMs"] = int((time.monotonic() - started) * 1000)
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


def browser_cdp_selection(root, state, observation):
    """Recheck one already observed canonical browser; never discover by name."""
    import nemoclaw_native_windows as native_paths
    import psutil
    import re

    try:
        daemon_pids = {
            int(row["files"]["pid"]["text"])
            for row in observation.get("commands", [])
            if row.get("daemonIdentityBound") is True
        }
        expected = selected_chrome_file(
            root, os.environ["AGENT_BROWSER_EXECUTABLE_PATH"]
        )
        candidates = [
            row
            for row in observation.get("processes", [])
            if row.get("parentPid") in daemon_pids
            and row.get("executable") == str(expected)
            and row.get("identityRechecked") is True
            and row.get("parentRelationVerified") is True
            and not row.get("selectedArgumentsTruncated")
            and not any(
                arg.startswith("--type=") for arg in row.get("selectedArguments", [])
            )
            and "--remote-debugging-port=0" in row.get("selectedArguments", [])
        ]
        if len(candidates) != 1:
            raise ValueError("No single identity-bound main Chrome endpoint")
        row = candidates[0]
        process = psutil.Process(row["pid"])
        command = process.cmdline()
        if (
            process.create_time() != row["creationTime"]
            or not process.is_running()
            or process.ppid() != row["parentPid"]
            or hashlib.sha256(json.dumps(command).encode()).hexdigest()
            != row["commandLineSha256"]
        ):
            raise ValueError("Observed Chrome process identity changed")
        profiles = [
            arg.split("=", 1)[1]
            for arg in command
            if arg.startswith("--user-data-dir=")
        ]
        if len(profiles) != 1:
            raise ValueError("Observed Chrome profile is ambiguous")
        port_file = owned_file(Path(profiles[0]) / "DevToolsActivePort", state)
        with port_file.open("rb") as stream:
            data = stream.read(513)
        observed = row["devToolsActivePort"]
        if (
            len(data) > 512
            or len(data) != observed["bytes"]
            or hashlib.sha256(data).hexdigest() != observed["sha256"]
        ):
            raise ValueError("Owned Chrome endpoint changed after observation")
        lines = data.decode("ascii").splitlines()
        if (
            len(lines) != 2
            or not lines[0].isdigit()
            or not 0 < int(lines[0]) < 65536
            or not re.fullmatch(r"/devtools/browser/[A-Za-z0-9-]{1,128}", lines[1])
        ):
            raise ValueError("Invalid owned Chrome DevTools endpoint")
        held = BrowserHarnessProcess(row["pid"])
        try:
            pid, created = held.identity()
            image = held.image()
            if Path(image) != expected:
                raise ValueError(
                    "Observed Chrome DOS image changed before CDP observation"
                )
            if (
                pid != row["pid"]
                or held.wait(0)
                or process.create_time() != row["creationTime"]
                or held.identity() != (pid, created)
            ):
                raise ValueError("Chrome exited or changed during identity binding")
            return {
                "endpoint": "ws://127.0.0.1:" + lines[0] + lines[1],
                "pid": pid,
                "creationFiletime": created,
                "endpointFile": str(port_file),
                "endpointSha256": hashlib.sha256(data).hexdigest(),
                "processIdentityRechecked": True,
            }
        finally:
            held.close()
    except (Exception, native_paths.NativeStartupRefusal) as error:
        return {"skipped": repr(error)[:256]}


def raw_cdp_endpoint(endpoint):
    from urllib.parse import urlsplit

    try:
        value = urlsplit(endpoint)
        if (
            not isinstance(endpoint, str)
            or len(endpoint) > 512
            or value.scheme != "ws"
            or value.hostname not in {"127.0.0.1", "::1"}
            or not value.port
            or value.username
            or value.password
            or value.query
            or value.fragment
        ):
            return None
        return {
            "url": endpoint,
            "scheme": value.scheme,
            "host": value.hostname,
            "port": value.port,
            "path": value.path,
            "sha256": hashlib.sha256(endpoint.encode()).hexdigest(),
        }
    except (TypeError, ValueError, AttributeError):
        return None


async def raw_cdp_diagnostic(selection, budget):
    """One new blank target only; never replace the normal Browser Use result."""
    import asyncio
    import re
    import websockets

    endpoint = selection.get("endpoint")
    result = {
        "process": {
            key: selection.get(key)
            for key in ("pid", "creationFiletime", "endpointSha256")
        },
        "diagnosticOnly": True,
        "canonicalQualification": False,
        "endpoint": raw_cdp_endpoint(endpoint),
        "budgetMs": budget * 1000,
        "commands": [],
        "attachedEvents": [],
        "waitingForDebuggerObserved": False,
        "waitingForDebugger": None,
        "targetCreationAttempted": False,
        "targetCreationUncertain": False,
        "targetCreated": False,
        "targetClosed": False,
        "webSocketClosed": False,
        "error": None,
    }
    if result["endpoint"] is None or not 4 <= budget <= 8:
        result["skipped"] = (
            "No eligible loopback WebSocket endpoint or diagnostic time budget"
        )
        return result
    began = time.monotonic()
    deadline = began + budget
    work_deadline = deadline - 1
    ws = None
    process = None
    target = session = None
    sequence = frames = 0
    pending = {}

    def small(value):
        encoded = json.dumps(value).encode()
        return (
            value
            if len(encoded) <= 512
            else {
                "responseTruncated": True,
                "bytes": len(encoded),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }
        )

    async def command(method, params=None, session_id=None, closing=False):
        nonlocal sequence, frames
        sequence += 1
        identifier = sequence
        message = {"id": identifier, "method": method, "params": params or {}}
        if session_id is not None:
            message["sessionId"] = session_id
        record = {
            "id": identifier,
            "method": method,
            "sessionId": session_id,
            "params": params or {},
            "response": None,
            "timedOut": False,
            "error": None,
        }
        result["commands"].append(record)
        started = time.monotonic()
        until = min(deadline if closing else work_deadline, started + 1)
        try:
            if until <= started:
                raise TimeoutError("Diagnostic budget exhausted")
            await asyncio.wait_for(
                ws.send(json.dumps(message)), until - time.monotonic()
            )
            while identifier not in pending:
                remaining = until - time.monotonic()
                if remaining <= 0:
                    raise TimeoutError("CDP response deadline")
                if frames >= 48:
                    raise ValueError("Diagnostic frame count exceeded")
                raw = await asyncio.wait_for(ws.recv(), remaining)
                frames += 1
                value = json.loads(raw)
                if not isinstance(value, dict):
                    raise ValueError("Unexpected diagnostic CDP frame")
                if type(value.get("id")) is int and 0 < value["id"] <= sequence:
                    pending[value["id"]] = value
                elif value.get("method") == "Target.attachedToTarget":
                    params = value.get("params", {})
                    if (
                        params.get("targetInfo", {}).get("targetId") == target
                        and len(result["attachedEvents"]) < 1
                    ):
                        event_session = params.get("sessionId")
                        result["attachedEvents"].append(
                            {
                                "targetId": target,
                                "sessionId": event_session
                                if isinstance(event_session, str)
                                and len(event_session) <= 128
                                else None,
                                "waitingForDebugger": params.get("waitingForDebugger"),
                            }
                        )
            response = pending.pop(identifier)
            record["response"] = small(response)
            return response
        except (TimeoutError, asyncio.TimeoutError) as error:
            record["timedOut"] = True
            record["error"] = str(error)[:128]
        except Exception as error:
            record["error"] = repr(error)[:128]
        finally:
            record["elapsedMs"] = (time.monotonic() - started) * 1000
        return {}

    def response_size(record):
        return len(json.dumps(record["response"]))

    try:
        process = BrowserHarnessProcess(selection["pid"])
        if process.identity() != (
            selection["pid"],
            selection["creationFiletime"],
        ) or process.wait(0):
            raise ValueError("Owned Chrome identity changed before CDP observation")
        result["processIdentityReconfirmed"] = True
        ws = await asyncio.wait_for(
            websockets.connect(
                endpoint, proxy=None, max_size=65536, open_timeout=1, close_timeout=0.25
            ),
            1,
        )
        await command("Browser.getVersion")
        await command("Target.getTargets")
        result["targetCreationAttempted"] = True
        created = await command(
            "Target.createTarget", {"url": "about:blank", "background": True}
        )
        target = created.get("result", {}).get("targetId")
        if not isinstance(target, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", target
        ):
            result["targetCreationUncertain"] = (
                "result" not in created and "error" not in created
            )
            raise ValueError("Diagnostic did not create a valid owned target")
        result["targetId"] = target
        result["targetCreated"] = True
        attached = await command(
            "Target.attachToTarget", {"targetId": target, "flatten": True}
        )
        session = attached.get("result", {}).get("sessionId")
        if not isinstance(session, str) or not re.fullmatch(
            r"[A-Za-z0-9_-]{1,128}", session
        ):
            raise ValueError("Diagnostic did not attach to its owned target")
        result["sessionId"] = session
        await command("Page.enable", session_id=session)
        await command("Runtime.enable", session_id=session)
        if time.monotonic() < work_deadline:
            await command("Network.enable", session_id=session)
        else:
            result["networkEnableSkipped"] = (
                "No remaining diagnostic work budget; target cleanup reserved"
            )
        evaluate = {
            "expression": "({value:1+1,url:location.href,readyState:document.readyState})",
            "returnByValue": True,
        }
        await command("Runtime.evaluate", evaluate, session)
    except Exception as error:
        result["error"] = repr(error)[:128]
    finally:
        if ws is not None:
            if result["targetCreated"]:
                closed = await command(
                    "Target.closeTarget", {"targetId": target}, closing=True
                )
                result["targetClosed"] = closed.get("result", {}).get("success") is True
            try:
                await asyncio.wait_for(
                    ws.close(), max(0.001, min(0.3, deadline - time.monotonic()))
                )
                result["webSocketClosed"] = True
            except Exception as error:
                result["webSocketCloseError"] = repr(error)[:128]
        for event in result["attachedEvents"]:
            if (
                event["sessionId"] == session
                and type(event["waitingForDebugger"]) is bool
            ):
                result["waitingForDebuggerObserved"] = True
                result["waitingForDebugger"] = event["waitingForDebugger"]
        if process is not None:
            try:
                result["processStillRunning"] = not process.wait(0)
                process.close()
                result["processHandleClosed"] = True
            except Exception as error:
                result["processCloseError"] = repr(error)[:128]
        result["elapsedMs"] = (time.monotonic() - began) * 1000
        result["serializedLimitBytes"] = 4096
        while len(json.dumps(result).encode()) > 4096:
            candidates = [
                r
                for r in result["commands"]
                if isinstance(r.get("response"), dict)
                and not r["response"].get("responseTruncated")
            ]
            if not candidates:
                result["metadataExceeded"] = True
                break
            record = max(candidates, key=response_size)
            encoded = json.dumps(record["response"]).encode()
            record["response"] = {
                "responseTruncated": True,
                "bytes": len(encoded),
                "sha256": hashlib.sha256(encoded).hexdigest(),
            }
    return result


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

    def image(self):
        # Flags0 requests the DOS image path from the same retained handle.
        # No drive prefix is inferred from the caller's environment or cwd.
        query = self.kernel.QueryFullProcessImageNameW
        query.argtypes = [
            self.ctypes.c_void_p,
            self.ctypes.c_uint32,
            self.ctypes.POINTER(self.ctypes.c_wchar),
            self.ctypes.POINTER(self.ctypes.c_uint32),
        ]
        query.restype = self.ctypes.c_int
        buffer = self.ctypes.create_unicode_buffer(4096)
        length = self.ctypes.c_uint32(4096)
        if not query(self.handle, 0, buffer, self.ctypes.byref(length)):
            raise self.ctypes.WinError(self.ctypes.get_last_error())
        value = buffer.value
        if (
            not 0 < length.value < 4096
            or len(value.encode("utf-16-le", "surrogatepass")) != length.value * 2
        ):
            raise ValueError("Observed DOS image path is incomplete or unbounded")
        return value

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
    import nemoclaw_native_windows as native_paths
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
    except (Exception, native_paths.NativeStartupRefusal) as error:
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


def browser_shutdown_code(session, state, retain_log, cdp_selection=None, cdp_budget=0):
    code = (
        "import importlib.util,json,pathlib\nfrom browser_harness import _ipc as ipc\n"
        + "spec=importlib.util.spec_from_file_location('nc_browser_log',"
        + repr(__file__)
        + ")\n"
        + "observer=importlib.util.module_from_spec(spec);spec.loader.exec_module(observer)\n"
    )
    if cdp_selection and cdp_budget:
        code += (
            "try:\n import asyncio\n raw=asyncio.run(observer.raw_cdp_diagnostic("
            + repr(cdp_selection)
            + ","
            + repr(cdp_budget)
            + "))\n"
            + "except Exception as error:\n raw={'diagnosticOnly':True,'canonicalQualification':False,'error':repr(error)[:256]}\n"
            + "print('NEMOCLAW_RAW_CDP_DIAGNOSTIC='+json.dumps(raw))\n"
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
    import nemoclaw_native_windows as native_paths

    component_started = time.monotonic()
    if os.environ.get("NEMOCLAW_HERMES_WER_CHROME"):
        selected = selected_chrome_file(root, "")
        # The separate diagnostic tree changes only the WER callback DLL.
        # The browser itself must remain the exact canonical executable.
        with selected.open("rb") as source:
            data = source.read(4024833)
        if len(data) != 4024832 or hashlib.sha256(data).hexdigest() != (
            "409805a16d6416087e6b2f778df1cf8f7bbb267d6b99f6b5bb0a618eace234f2"
        ):
            raise ValueError("Renderer WER diagnostic changed the Chrome executable")
        os.environ["AGENT_BROWSER_EXECUTABLE_PATH"] = str(selected)
    from tools.browser_use_cli import browser_exec, _backend_cache_key
    from tools.browser_tool_install import _find_agent_browser
    from tools.browser_tool_lifecycle import cleanup_browser
    from tools import browser_tool_session
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
    launches = []
    original_spawn = browser_tool_session._popen_agent_browser

    def observed_spawn(argv, env, socket_dir, tag):
        proc = original_spawn(argv, env, socket_dir, tag)
        if (
            tag == "get"
            and argv[-3:] == ["--json", "get", "cdp-url"]
            and len(launches) < 2
        ):
            launches.append(
                (
                    list(argv),
                    {
                        key: env[key]
                        for key in (
                            "AGENT_BROWSER_SOCKET_DIR",
                            "AGENT_BROWSER_EXECUTABLE_PATH",
                            "AGENT_BROWSER_ARGS",
                            "CHROME_LOG_FILE",
                        )
                        if key in env
                    },
                    socket_dir,
                    proc,
                    time.monotonic(),
                )
            )
        return proc

    browser_tool_session._popen_agent_browser = observed_spawn
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
    except (Exception, native_paths.NativeStartupRefusal) as error:
        error.add_note("Browser Use raw response: " + repr(raw))
        primary = error
    finally:
        browser_tool_session._popen_agent_browser = original_spawn
        diagnostics["pageObservation"] = browser_page_observation(result)
        cdp_selection, cdp_budget = None, 0
        if primary:
            diagnostics["agentBrowserState"] = browser_agent_state(
                state, expected, launches
            )
            diagnostics["logs"]["chrome"] = browser_log_tail(chrome_log, state)
            diagnostic_started = time.monotonic()
            crashpad = existing_crashpad_reports(
                root,
                state,
                diagnostics["agentBrowserState"],
                min(2.0, max(0.0, 60.0 - (time.monotonic() - component_started))),
            )
            crashpad["nonce"] = nonce
            print("NEMOCLAW_CRASHPAD_RESULT=" + json.dumps(crashpad), flush=True)
            diagnostics["agentBrowserStatus"] = existing_agent_browser_status(
                root,
                state,
                diagnostics["agentBrowserState"],
                min(1.0, max(0.0, 60.0 - (time.monotonic() - component_started))),
            )
            cdp_selection = browser_cdp_selection(
                root, state, diagnostics["agentBrowserState"]
            )
            cdp_budget = min(
                max(0.0, 8.0 - (time.monotonic() - diagnostic_started)),
                max(0.0, 60.0 - (time.monotonic() - component_started)),
            )
            if cdp_selection.get("skipped") or cdp_budget < 4:
                cdp_budget = 0
            diagnostics["rawCdp"] = {
                "diagnosticOnly": True,
                "canonicalQualification": False,
                "selection": cdp_selection,
                "skipped": cdp_selection.get("skipped")
                or "Insufficient remaining component budget",
            }
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
                    browser_shutdown_code(
                        session, state, primary is not None, cdp_selection, cdp_budget
                    ),
                ],
                capture_output=True,
                text=True,
                timeout=15 + cdp_budget,
            )
            if cdp_budget:
                cdp_rows = [
                    line.split("=", 1)[1]
                    for line in shutdown.stdout.splitlines()
                    if line.startswith("NEMOCLAW_RAW_CDP_DIAGNOSTIC=")
                ]
                diagnostics["rawCdp"] = (
                    json.loads(cdp_rows[0])
                    if len(cdp_rows) == 1
                    else {
                        "diagnosticOnly": True,
                        "canonicalQualification": False,
                        "error": "Raw CDP observer did not return exactly one record",
                    }
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
        except (Exception, native_paths.NativeStartupRefusal) as error:
            errors.append(repr(error))
        try:
            cleanup_browser(_backend_cache_key(task, session))
        except (Exception, native_paths.NativeStartupRefusal) as error:
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
    import nemoclaw_native_windows as native_paths

    kind, directory, nonce = sys.argv[1:]
    result = {"schemaVersion": 1, "component": kind, "nonce": nonce, "passed": False}
    try:
        assert (
            os.name == "nt"
            and len(nonce) == 24
            and all(value in "0123456789abcdef" for value in nonce)
        )
        root = owned_runtime(directory)
        if kind == "python":
            result["runtimeAccess"] = runtime_readonly_check(root)
        if kind == "browser":
            result["browserLauncherAdaptation"] = apply_browser_launch_adapter(root)
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
    except (Exception, native_paths.NativeStartupRefusal) as error:
        result["error"] = traceback.format_exc()[-16000:]
        if hasattr(error, "nemoclaw_browser_diagnostics"):
            result["browserDiagnostics"] = error.nemoclaw_browser_diagnostics
        if hasattr(error, "nemoclaw_runtime_access"):
            result["runtimeAccess"] = error.nemoclaw_runtime_access
    print("NEMOCLAW_PERSONAL_RESULT=" + json.dumps(result))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
