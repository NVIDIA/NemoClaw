# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build the canonical Hermes runtime in CI; relocation and acceptance follow."""

import argparse
import contextlib
import configparser
import functools
import hashlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import threading
import time
import urllib.request
import zipfile


UPSTREAM_COMMIT = "2237be355906fbe6065ce1815711eee52b2d646e"


def sha256(path):
    with Path(path).open("rb") as handle:
        return hashlib.file_digest(handle, "sha256").hexdigest()


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as handle:
        json.dump(value, handle, indent=2)
        handle.write("\n")


def download(artifact, directory):
    target = Path(directory) / artifact["file"]
    if target.name != artifact["file"] or not artifact["url"].startswith("https://"):
        raise ValueError("Unsafe official input location")
    print(
        f"[Hermes runtime] Fetching {artifact['file']} ({artifact['size']:,} bytes)",
        flush=True,
    )
    with (
        urllib.request.urlopen(artifact["url"], timeout=120) as response,
        target.open("xb") as output,
    ):
        count = 0
        while chunk := response.read(1024 * 1024):
            count += len(chunk)
            if count > artifact["size"]:
                raise ValueError(f"Artifact exceeded its pinned size: {target.name}")
            output.write(chunk)
    if count != artifact["size"] or sha256(target) != artifact["sha256"]:
        raise ValueError(
            f"Artifact failed its immutable hash/size check: {target.name}"
        )
    return target


def extract_complete(archive, target, archive_format, strip_components=1):
    """Extract every member, retaining licenses and dynamic assets without pruning."""
    target = Path(target)
    target.mkdir(parents=True, exist_ok=False)

    def destination(name):
        parts = Path(name.replace("\\", "/")).parts
        if (
            name.startswith(("/", "\\"))
            or ".." in parts
            or any(":" in part for part in parts)
        ):
            raise ValueError("An official archive contains an unsafe path")
        return target.joinpath(*parts[strip_components:])

    if archive_format == "zip":
        with zipfile.ZipFile(archive) as handle:
            for member in handle.infolist():
                output = destination(member.filename)
                if member.is_dir():
                    output.mkdir(parents=True, exist_ok=True)
                else:
                    if (member.external_attr >> 16) & 0o170000 == 0o120000:
                        raise ValueError("Unexpected link in official supplemental ZIP")
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with handle.open(member) as source, output.open("xb") as writer:
                        shutil.copyfileobj(source, writer)
    elif archive_format == "tar.gz":
        with tarfile.open(archive, "r:gz") as handle:
            for member in handle:
                output = destination(member.name)
                if member.isdir():
                    output.mkdir(parents=True, exist_ok=True)
                elif member.isfile():
                    output.parent.mkdir(parents=True, exist_ok=True)
                    with (
                        handle.extractfile(member) as source,
                        output.open("xb") as writer,
                    ):
                        shutil.copyfileobj(source, writer)
                else:
                    raise ValueError(
                        "Unexpected non-file in official supplemental tar archive"
                    )
    else:
        raise ValueError("Unsupported official supplemental archive format")


class MirrorHandler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        file = self.server.inputs.get(self.path)
        if file is None:
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Length", str(file.stat().st_size))
        self.end_headers()
        with file.open("rb") as source:
            shutil.copyfileobj(source, self.wfile)

    def log_message(self, format_string, *args):
        print(
            f"[Hermes runtime] Verified local artifact: {format_string % args}",
            flush=True,
        )


@contextlib.contextmanager
def artifact_mirror(inputs):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), MirrorHandler)
    server.inputs = inputs
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        primary = sys.exception()
        try:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
        except Exception as error:
            if primary is None:
                raise
            primary.add_note(f"Artifact mirror cleanup also failed: {error}")


def windows_taskkill(environment):
    # os.environ is case-insensitive on Windows, but its copy() is a plain
    # dictionary with uppercase keys. Accept the same Windows key identity.
    roots = {
        value for name, value in environment.items() if name.upper() == "SYSTEMROOT"
    }
    if len(roots) != 1:
        raise ValueError("Windows process cleanup requires one unambiguous SystemRoot")
    root = roots.pop()
    if not root or not Path(root).is_absolute():
        raise ValueError("Windows process cleanup requires an absolute SystemRoot")
    return Path(root) / "System32" / "taskkill.exe"


NODE_DEPS_COMMAND_TIMEOUT_SECONDS = 600
NODE_DEPS_COMMAND_COUNT = 3  # npm root, Playwright Chromium, npm ui-tui
NODE_DEPS_REPORTING_GRACE_SECONDS = 60


def official_stage_timeout(stage):
    if stage == "node-deps":
        return (
            NODE_DEPS_COMMAND_COUNT * NODE_DEPS_COMMAND_TIMEOUT_SECONDS
            + NODE_DEPS_REPORTING_GRACE_SECONDS
        )
    return 600


def node_stage_log_bytes(evidence):
    evidence = Path(evidence)
    files = list((evidence / "npm-cache" / "diagnostic-logs").glob("*")) + list(
        (evidence / "npm-cache" / "tmp").glob("hermes-*.log")
    )
    if len(files) > 256:
        raise ValueError("The owned npm diagnostic inventory exceeded its bound")
    total = 0
    for file in files:
        info = file.lstat()
        if file.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400:
            raise ValueError("The npm diagnostic path is a link")
        if file.is_file():
            total += info.st_size
    return total


def retain_node_stage_logs(evidence):
    """Copy bounded npm/command diagnostics out of the artifact-excluded scratch root."""
    evidence = Path(evidence)
    locations = [
        (
            evidence / "npm-cache" / "tmp",
            "upstream-command-logs",
            r"hermes-(?:npm-browser|npm-tui|playwright-install)-[0-9]+\.log",
        ),
        (
            evidence / "npm-cache" / "diagnostic-logs",
            "npm-logs",
            r"[A-Za-z0-9_.-]+\.(?:log|json)",
        ),
    ]
    files = []
    total = 0
    for scratch, category, pattern in locations:
        target = evidence / category
        target.mkdir(exist_ok=True)
        for source in sorted(scratch.glob("*")):
            if not re.fullmatch(pattern, source.name):
                continue
            info = source.lstat()
            if (
                source.is_symlink()
                or not source.is_file()
                or info.st_nlink != 1
                or getattr(info, "st_file_attributes", 0) & 0x400
            ):
                raise ValueError(
                    "The upstream command log is not an ordinary owned file"
                )
            count = min(info.st_size, 8 * 1024 * 1024, 64 * 1024 * 1024 - total)
            if count < 0 or len(files) >= 256:
                raise ValueError(
                    "The upstream command log inventory exceeded its bound"
                )
            with source.open("rb") as reader:
                data = reader.read(count)
            with (target / source.name).open("xb") as writer:
                writer.write(data)
                writer.flush()
                os.fsync(writer.fileno())
            total += len(data)
            files.append(
                {
                    "category": category,
                    "file": source.name,
                    "sourceBytes": info.st_size,
                    "retainedBytes": len(data),
                    "sha256": hashlib.sha256(data).hexdigest(),
                    "truncated": len(data) != info.st_size,
                }
            )
    return {
        "files": files,
        "retainedBytes": total,
        "sourceScratch": "npm-cache",
        "maximumRetainedBytes": 64 * 1024 * 1024,
    }


def run_owned(executable, args, environment, cwd, evidence, label, timeout=600):
    stdout_path = Path(evidence) / f"{label}.stdout.log"
    stderr_path = Path(evidence) / f"{label}.stderr.log"
    print(f"[Hermes runtime] {label}", flush=True)
    process = None
    primary = None
    cleanup_errors = []
    started = time.monotonic()
    with stdout_path.open("xb") as stdout, stderr_path.open("xb") as stderr:
        try:
            killer = windows_taskkill(environment) if os.name == "nt" else None
            process = subprocess.Popen(
                [str(executable), *map(str, args)],
                env=environment,
                cwd=cwd,
                stdin=subprocess.DEVNULL,
                stdout=stdout,
                stderr=stderr,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            while True:
                try:
                    code = process.wait(
                        timeout=min(
                            15, max(0.1, timeout - (time.monotonic() - started))
                        )
                    )
                    break
                except subprocess.TimeoutExpired:
                    elapsed = time.monotonic() - started
                    output_size = (
                        stdout_path.stat().st_size + stderr_path.stat().st_size
                    )
                    if label == "stage-node-deps":
                        output_size += node_stage_log_bytes(evidence)
                    print(
                        f"[Hermes runtime] {label}: {elapsed:.0f}s elapsed, {output_size:,} diagnostic bytes",
                        flush=True,
                    )
                    if elapsed >= timeout or output_size > 64 * 1024 * 1024:
                        raise TimeoutError(
                            f"{label} exceeded its bounded execution or diagnostic budget"
                        )
            if code:
                raise RuntimeError(
                    f"{label} exited {code}; its complete stdout/stderr were retained"
                )
        except BaseException as error:
            primary = error
        finally:
            if process is not None and process.poll() is None:
                try:
                    if os.name == "nt":
                        subprocess.run(
                            [str(killer), "/PID", str(process.pid), "/T", "/F"],
                            env=environment,
                            stdin=subprocess.DEVNULL,
                            stdout=stderr,
                            stderr=stderr,
                            timeout=10,
                            check=False,
                        )
                    else:
                        process.kill()
                    process.wait(timeout=10)
                except Exception as error:
                    cleanup_errors.append(str(error))
    node_logs = None
    if (
        label == "stage-node-deps"
        and process is not None
        and process.poll() is not None
    ):
        try:
            node_logs = retain_node_stage_logs(evidence)
        except Exception as error:
            if primary is None:
                primary = error
            else:
                primary.add_note(f"Upstream command log retention also failed: {error}")
    result = {
        "label": label,
        "observerTimeoutSeconds": timeout,
        "upstreamNodeCommands": (
            {
                "maximumSequentialCommands": NODE_DEPS_COMMAND_COUNT,
                "perCommandTimeoutSeconds": NODE_DEPS_COMMAND_TIMEOUT_SECONDS,
                "reportingGraceSeconds": NODE_DEPS_REPORTING_GRACE_SECONDS,
                "classification": "CI-build-observer-envelope",
            }
            if label == "stage-node-deps"
            else None
        ),
        "retainedNodeLogs": node_logs,
        "executable": str(executable),
        "arguments": list(map(str, args)),
        "elapsedSeconds": time.monotonic() - started,
        "processId": None if process is None else process.pid,
        "exitCode": None if process is None else process.poll(),
        "stdout": str(stdout_path),
        "stderr": str(stderr_path),
        "cleanupErrors": cleanup_errors,
        "passed": primary is None and not cleanup_errors,
    }
    try:
        write_json(Path(evidence) / f"{label}.process.json", result)
    except Exception as error:
        if primary is None:
            raise
        primary.add_note(f"Process receipt write also failed: {error}")
    if primary is not None:
        raise primary
    if cleanup_errors:
        raise RuntimeError(f"{label} did not finish its owned cleanup")
    return result


def clean_environment(runtime, evidence, build_paths):
    names = [
        "SystemRoot",
        "SystemDrive",
        "WINDIR",
        "COMSPEC",
        "OS",
        "TEMP",
        "TMP",
        "LOCALAPPDATA",
        "APPDATA",
        "USERPROFILE",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_ARCHITEW6432",
        "NUMBER_OF_PROCESSORS",
        "INCLUDE",
        "LIB",
        "LIBPATH",
        "VCINSTALLDIR",
        "VCToolsInstallDir",
        "WindowsSdkDir",
        "WindowsSDKVersion",
        "WindowsSdkVerBinPath",
        "UniversalCRTSdkDir",
        "UCRTVersion",
        "VSCMD_ARG_TGT_ARCH",
        "VSCMD_ARG_HOST_ARCH",
        "RUNNER_TRACKING_ID",
        "OPENSSL_DIR",
        "OPENSSL_STATIC",
        "CARGO_HOME",
        "RUSTUP_HOME",
    ]
    environment = {name: os.environ[name] for name in names if name in os.environ}
    for directory in ["profile", "appdata", "localappdata", "config"]:
        (evidence / directory).mkdir()
    (evidence / "npm-cache" / "tmp").mkdir(parents=True)
    (evidence / "npm-cache" / "diagnostic-logs").mkdir()
    for name in ["npm-user.npmrc", "npm-global.npmrc"]:
        (evidence / name).write_text("", encoding="utf-8")
    environment.update(
        USERPROFILE=str(evidence / "profile"),
        APPDATA=str(evidence / "appdata"),
        LOCALAPPDATA=str(evidence / "localappdata"),
        XDG_CONFIG_HOME=str(evidence / "config"),
        GIT_CONFIG_GLOBAL=os.devnull,
        GIT_CONFIG_NOSYSTEM="1",
    )
    managed = [
        runtime / "node",
        runtime / "bin",
        runtime / "ripgrep",
        runtime / "ffmpeg/bin",
        runtime / "git/cmd",
        runtime / "git/bin",
    ]
    environment.update(
        PATH=os.pathsep.join(
            map(
                str,
                [
                    *managed,
                    *build_paths,
                    runtime / "git/usr/bin",
                    Path(environment["SystemRoot"]) / "System32",
                ],
            )
        ),
        CI="1",
        # npm12 cmd-shim9 appends a blank after ENDLOCAL. A terminal separator
        # keeps that blank outside .CMD; the executable-extension set is unchanged.
        PATHEXT=".COM;.EXE;.BAT;.CMD;",
        DISTUTILS_USE_SDK="1",
        HERMES_GIT_BASH_PATH=str(runtime / "git/bin/bash.exe"),
        UV_LINK_MODE="copy",
        UV_CACHE_DIR=str(evidence / "uv-cache"),
        UV_PYTHON_DOWNLOADS="never",
        UV_KEYRING_PROVIDER="disabled",
        UV_TOOL_DIR=str(runtime / "tools"),
        UV_TOOL_BIN_DIR=str(runtime / "bin"),
        TEMP=str(evidence / "npm-cache" / "tmp"),
        TMP=str(evidence / "npm-cache" / "tmp"),
        npm_config_cache=str(evidence / "npm-cache"),
        npm_config_logs_dir=str(evidence / "npm-cache" / "diagnostic-logs"),
        npm_config_logs_max="64",
        npm_config_foreground_scripts="true",
        NODE_DEPS_TIMEOUT=str(NODE_DEPS_COMMAND_TIMEOUT_SECONDS),
        npm_config_userconfig=str(evidence / "npm-user.npmrc"),
        npm_config_globalconfig=str(evidence / "npm-global.npmrc"),
        PLAYWRIGHT_BROWSERS_PATH=str(runtime / "browsers"),
    )
    return environment


@contextlib.contextmanager
def official_user_path(value):
    import winreg

    with winreg.CreateKey(winreg.HKEY_CURRENT_USER, "Environment") as key:
        previous = {}
        for name in ["Path", "HERMES_HOME", "HERMES_GIT_BASH_PATH"]:
            try:
                previous[name] = winreg.QueryValueEx(key, name)
            except FileNotFoundError:
                previous[name] = None
        winreg.SetValueEx(key, "Path", 0, winreg.REG_EXPAND_SZ, value)
        try:
            yield
        finally:
            primary = sys.exception()
            failures = []
            for name, original in previous.items():
                try:
                    if original is None:
                        try:
                            winreg.DeleteValue(key, name)
                        except FileNotFoundError:
                            pass
                    else:
                        value, kind = original
                        winreg.SetValueEx(key, name, 0, kind, value)
                except Exception as error:
                    failures.append(
                        f"Official installer {name} restoration failed: {error}"
                    )
            if failures:
                if primary is None:
                    raise RuntimeError("; ".join(failures))
                for failure in failures:
                    primary.add_note(failure)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--runtime-root", required=True, type=Path)
    parser.add_argument("--artifact-directory", required=True, type=Path)
    parser.add_argument("--component-lock", required=True, type=Path)
    parser.add_argument("--source-archive", type=Path)
    parser.add_argument("--python-phase-evidence", type=Path)
    parser.add_argument("--build-tool-path", action="append", default=[], type=Path)
    parser.add_argument("--phase", choices=["python", "runtime"], default="runtime")
    args = parser.parse_args()
    args.build_tool_path = [
        directory.resolve(strict=True) for directory in args.build_tool_path
    ]
    if os.name != "nt":
        raise ValueError("The official runtime build requires Windows")
    if args.phase == "runtime" and args.source_archive is None:
        raise ValueError(
            "The complete build requires its immutable official source archive"
        )
    runtime = args.runtime_root.resolve(strict=True)
    source = runtime / "hermes-agent"
    evidence = args.artifact_directory.resolve()
    evidence.mkdir(parents=True, exist_ok=False)
    scripts = Path(__file__).resolve().parent
    lock = json.loads(
        (scripts / "official-runtime.lock.json").read_text(encoding="utf-8")
    )
    component_lock = json.loads(args.component_lock.read_text(encoding="utf-8"))
    if (
        lock["upstreamCommit"] != UPSTREAM_COMMIT
        or component_lock["upstream"]["commit"] != UPSTREAM_COMMIT
    ):
        raise ValueError("The build inputs do not identify the canonical stable source")
    for name, expected_hash in lock["upstreamFiles"].items():
        if sha256(source / name) != expected_hash:
            raise ValueError(f"The official source input changed: {name}")
    original_locks = {
        name: sha256(source / name) for name in ["uv.lock", "package-lock.json"]
    }
    receipt = {
        "schemaVersion": 1,
        "upstreamCommit": UPSTREAM_COMMIT,
        "status": "failed",
        "completeRuntime": False,
        "installedAcceptance": False,
        "stages": [],
        "fallbacks": [],
        "sourceUnchanged": False,
        "selectedBrowser": "browser-use",
        "computerUse": "explicitly skipped",
        "buildToolPaths": list(map(str, args.build_tool_path)),
    }
    environment = clean_environment(runtime, evidence, args.build_tool_path)
    receipt["buildTools"] = []
    for name in ["cargo.exe", "rustc.exe", "cl.exe", "cmake.exe"]:
        resolved = shutil.which(
            name, path=os.pathsep.join(map(str, args.build_tool_path))
        )
        if resolved:
            receipt["buildTools"].append(
                {"name": name, "path": resolved, "sha256": sha256(resolved)}
            )
    powershell = (
        Path(environment["SystemRoot"])
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    invoke = functools.partial(
        run_owned, environment=environment, cwd=runtime, evidence=evidence
    )
    try:
        for tool in receipt["buildTools"]:
            if tool["name"] in ["cargo.exe", "rustc.exe", "cmake.exe"]:
                flags = ["-vV"] if tool["name"] == "rustc.exe" else ["--version"]
                version = invoke(
                    tool["path"],
                    flags,
                    label="version-" + tool["name"].removesuffix(".exe"),
                    timeout=30,
                )
                tool["versionOutput"] = Path(version["stdout"]).read_text(
                    encoding="utf-8"
                )[:8192]
        inventory_spec = importlib.util.spec_from_file_location(
            "official_runtime_inventory", scripts / "official-runtime-inventory.py"
        )
        inventory_module = importlib.util.module_from_spec(inventory_spec)
        inventory_spec.loader.exec_module(inventory_module)
        write_json(
            evidence / "upstream-locked-inputs.json",
            inventory_module.source_inputs(source),
        )
        build_requirements = scripts / lock["pythonBuildRequirements"]
        if sha256(build_requirements) != lock["pythonBuildRequirementsSha256"]:
            raise ValueError("The official Python build-only dependency graph changed")
        if args.python_phase_evidence is None:
            raise ValueError(
                "Full provisioning requires the current verified native Python prerequisite phase"
            )
        phase_root = args.python_phase_evidence.resolve(strict=True)
        phase_file = phase_root / "python-phase.json"
        phase = json.loads(phase_file.read_text(encoding="utf-8-sig"))
        python_result_file = phase_root / "dependency-stage/official-python.json"
        if (
            phase.get("schemaVersion") != 1
            or phase.get("status") != "python-provisioned"
            or phase.get("completeRuntime") is not False
            or phase.get("installedAcceptance") is not False
            or phase.get("upstreamCommit") != UPSTREAM_COMMIT
            or phase.get("inputLockSha256")
            != sha256(scripts / "official-python.lock.json")
            or phase.get("dependencyReceiptSha256") != sha256(python_result_file)
        ):
            raise ValueError(
                "The retained native Python phase is incomplete or differs from its inputs"
            )
        python_receipt = json.loads(python_result_file.read_text(encoding="utf-8-sig"))
        if (
            python_receipt.get("status") != "python-provisioned"
            or python_receipt.get("installedTier") != "hash-verified (uv.lock)"
            or python_receipt.get("upstream", {}).get("commit") != UPSTREAM_COMMIT
            or python_receipt.get("python", {}).get("cryptographyVersion") != "50.0.0"
            or not python_receipt.get("python", {})
            .get("opensslVersion", "")
            .startswith("OpenSSL 3.5.8 ")
        ):
            raise ValueError("The complete canonical Python environment has not passed")
        sdk_file = phase_root / "openssl/openssl-build.json"
        sdk = json.loads(sdk_file.read_text(encoding="utf-8"))
        sdk_root = phase_root / "openssl/sdk"
        if (
            phase.get("opensslReceiptSha256") != sha256(sdk_file)
            or sdk.get("status") != "sdk-built"
            or sdk.get("static") is not True
            or sdk.get("opensslVersion") != "3.5.8"
            or Path(sdk["sdkRoot"]).resolve(strict=True)
            != sdk_root.resolve(strict=True)
        ):
            raise ValueError(
                "The native Python stage has no matching static OpenSSL build provenance"
            )
        environment["OPENSSL_DIR"] = str(sdk_root)
        environment["OPENSSL_STATIC"] = "1"
        environment["CARGO_HOME"] = str(phase_root / "cargo-home")
        build_wheels = phase_root / "downloads"
        for artifact in lock["pythonBuildArtifacts"]:
            file = build_wheels / artifact["file"]
            if (
                file.stat().st_size != artifact["size"]
                or sha256(file) != artifact["sha256"]
            ):
                raise ValueError(
                    "A retained Python build wheel changed after the prerequisite phase"
                )
        environment["UV_BUILD_CONSTRAINT"] = str(build_requirements)
        environment["UV_FIND_LINKS"] = str(build_wheels)
        receipt["pythonPhaseReceiptSha256"] = sha256(phase_file)
        receipt["pythonDependencyReceiptSha256"] = sha256(python_result_file)
        receipt["opensslBuildReceiptSha256"] = sha256(sdk_file)
        # Static OpenSSL code enters the built cryptography module. Carry its
        # actual license and immutable input/build identity into the candidate.
        openssl_license = runtime / "licenses/openssl-3.5.8"
        openssl_license.mkdir(parents=True, exist_ok=False)
        shutil.copyfile(sdk_root / "LICENSE.txt", openssl_license / "LICENSE.txt")
        write_json(
            openssl_license / "build-provenance.json",
            {
                "schemaVersion": 1,
                "component": "OpenSSL",
                "version": "3.5.8",
                "static": True,
                "buildReceiptSha256": sha256(sdk_file),
                "inputLockSha256": sdk["inputLockSha256"],
                "configuration": sdk["configuration"],
                "sourceAuthority": sdk["sourceAuthority"],
                "libraries": sdk["libraries"],
                "source": sdk["artifacts"][0],
            },
        )
        receipt["installedTier"] = python_receipt["installedTier"]
        receipt["stages"].append(
            {"stage": "dependencies", "ok": True, "skipped": False}
        )
        if args.phase == "python":
            receipt["status"] = "python-provisioned"
            return
        environment.pop("UV_BUILD_CONSTRAINT")
        environment.pop("UV_FIND_LINKS")
        downloads = evidence / "downloads"
        downloads.mkdir()
        inputs = {}
        for artifact in lock["artifacts"]:
            file = download(artifact, downloads)
            inputs[artifact["id"]] = file
            if "destination" in artifact:
                extract_complete(
                    file,
                    runtime / artifact["destination"],
                    artifact["format"],
                    artifact["stripComponents"],
                )
        wheel_lock = scripts / lock["browserUseWheelLock"]
        requirements = scripts / lock["browserUseRequirements"]
        if (
            sha256(wheel_lock) != lock["browserUseWheelLockSha256"]
            or sha256(requirements) != lock["browserUseRequirementsSha256"]
        ):
            raise ValueError("The complete Browser Use graph changed")
        wheel_inputs = json.loads(wheel_lock.read_text(encoding="utf-8"))
        wheels = evidence / "browser-use-wheels"
        wheels.mkdir()
        for artifact in wheel_inputs["artifacts"]:
            download(artifact, wheels)
        uv = runtime / "bin/uv.exe"
        python = (
            source
            / ".hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe"
        )
        invoke(
            uv,
            [
                "tool",
                "install",
                "browser-use==0.13.10",
                "--python",
                python,
                "--no-index",
                "--find-links",
                wheels,
                "--constraints",
                requirements,
                "--no-build",
            ],
            label="official-browser-use-tool",
        )
        tool_environment = runtime / "tools/browser-use"
        tool_python = tool_environment / "Scripts/python.exe"
        installed = invoke(
            uv,
            ["pip", "list", "--python", tool_python, "--format", "json"],
            label="browser-use-graph",
        )
        graph = json.loads(Path(installed["stdout"]).read_text(encoding="utf-8"))

        def normalize(value):
            return value.lower().replace("_", "-").replace(".", "-")

        actual = {normalize(item["name"]): item["version"] for item in graph}
        expected = {
            normalize(item["name"]): item["version"]
            for item in wheel_inputs["artifacts"]
        }
        if actual != expected:
            raise ValueError(
                "Browser Use did not install the exact complete pinned dependency graph"
            )
        receipt["browserUsePackages"] = graph
        browser_metadata = configparser.ConfigParser()
        browser_metadata.read(
            tool_environment
            / "Lib/site-packages/browser_use-0.13.10.dist-info/entry_points.txt",
            encoding="utf-8",
        )
        browser_aliases = sorted(browser_metadata["console_scripts"])
        if len(browser_aliases) > 64 or any(
            not re.fullmatch(r"[A-Za-z0-9_-]+", name) for name in browser_aliases
        ):
            raise ValueError("The official Browser Use launcher metadata is invalid")
        outer_inventory = {
            "schemaVersion": 1,
            "package": "browser-use",
            "version": "0.13.10",
            "launchers": {},
        }
        for name in browser_aliases:
            file = runtime / "bin" / f"{name}.exe"
            outer_inventory["launchers"][name] = {
                "sha256": sha256(file),
                "bytes": file.stat().st_size,
            }
        write_json(
            evidence / "browser-use-outer-before-relocation.json", outer_inventory
        )
        receipt["browserUseLaunchers"] = [
            {"path": str(file.relative_to(runtime)), "sha256": sha256(file)}
            for file in [
                *(
                    directory / f"{name}.exe"
                    for name in browser_aliases
                    for directory in [runtime / "bin", tool_environment / "Scripts"]
                ),
                tool_environment / "uv-receipt.toml",
            ]
        ]
        build_tools = evidence / "node-build-tools"
        build_tools.mkdir()
        for artifact in lock["nodeBuildTools"]:
            file = download(artifact, downloads)
            extract_complete(file, build_tools / artifact["id"], "tar.gz")
        # Input caching runs no lifecycle scripts and never enters the payload.
        invoke(
            runtime / "node/node.exe",
            [
                "--experimental-strip-types",
                "--no-warnings",
                scripts / "prefetch-official-npm.mts",
                runtime / "node/node_modules/npm",
                source / "package-lock.json",
                evidence / "npm-cache",
                evidence / "npm-input-cache.json",
            ],
            label="locked-npm-input-cache",
        )
        mirror_inputs = {
            item["mirrorPath"]: inputs[item["id"]]
            for item in lock["artifacts"]
            if "mirrorPath" in item
        }

        def invoke_official_stage(stage):
            value = invoke(
                powershell,
                [
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    source / "scripts/install.ps1",
                    "-Stage",
                    stage,
                    "-NonInteractive",
                    "-SkipSetup",
                    "-SkipComputerUse",
                    "-Commit",
                    UPSTREAM_COMMIT,
                    "-Branch",
                    "v2026.9.7",
                    "-HermesHome",
                    runtime,
                    "-InstallDir",
                    source,
                    "-Json",
                ],
                label="stage-" + stage,
                timeout=official_stage_timeout(stage),
            )
            frames = [
                json.loads(line)
                for line in Path(value["stdout"])
                .read_text(encoding="utf-8-sig")
                .splitlines()
                if line.startswith("{")
            ]
            if (
                len(frames) != 1
                or frames[0].get("stage") != stage
                or frames[0].get("ok") is not True
                or frames[0].get("skipped") is not False
            ):
                raise ValueError(f"Official stage did not complete: {stage}")
            receipt["stages"].append(frames[0])

        with (
            artifact_mirror(mirror_inputs) as mirror,
            official_user_path(environment["PATH"]),
        ):
            environment["PLAYWRIGHT_DOWNLOAD_HOST"] = mirror
            for stage in [
                "node",
                "system-packages",
                "config-templates",
                "platform-sdks",
            ]:
                invoke_official_stage(stage)
            # The pinned Playwright installer consumes only hash-verified local
            # archives. It is a CI tool, not a root npm runtime dependency.
            invoke(
                runtime / "node/node.exe",
                [build_tools / "playwright-core/cli.js", "install", "chromium"],
                label="official-chromium-install",
            )
        node_spec = importlib.util.spec_from_file_location(
            "official_node_build", scripts / "build-official-node.py"
        )
        node_builder = importlib.util.module_from_spec(node_spec)
        node_spec.loader.exec_module(node_builder)
        receipt["nodeBuild"] = node_builder.build_selected(
            runtime=runtime,
            evidence=evidence,
            source_archive=args.source_archive,
            npm_root=build_tools / "npm",
            extract=extract_complete,
            invoke=invoke,
        )
        write_json(evidence / "selected-node-production.json", receipt["nodeBuild"])
        browser = list(
            (runtime / "browsers").glob("chromium-*/chrome-win64/chrome.exe")
        )
        expected_browser = next(
            item for item in lock["artifacts"] if item["id"] == "chromium"
        )
        agent_browser = runtime / "agent-browser/bin/agent-browser-win32-x64.exe"
        if (
            len(browser) != 1
            or sha256(browser[0]) != expected_browser["executables"][0]["sha256"]
            or sha256(agent_browser)
            != lock["selectedBrowserChain"]["agentBrowserSha256"]
        ):
            raise ValueError(
                "The selected official browser executables differ from their pinned inputs"
            )
        browser_version = invoke(
            agent_browser,
            ["--version"],
            label="official-agent-browser-version",
            timeout=30,
        )
        if "0.26.0" not in Path(browser_version["stdout"]).read_text(encoding="utf-8"):
            raise ValueError(
                "The official agent-browser executable reported another version"
            )
        node_contract = {
            "schemaVersion": 1,
            "upstreamCommit": UPSTREAM_COMMIT,
            "profile": node_builder.PROFILE,
            "tui": "hermes-agent/ui-tui/dist/entry.js",
            "web": "hermes-agent/hermes_cli/web_dist/index.html",
            "chromium": browser[0].relative_to(runtime).as_posix(),
            "agentBrowser": agent_browser.relative_to(runtime).as_posix(),
            "browserUse": "0.13.10",
            "browserArchitecture": "x64-emulated",
            "runtimeQualified": False,
        }
        write_json(runtime / "nemoclaw-hermes-node.json", node_contract)
        receipt["selectedBrowserChain"] = node_contract
        # Ask official uv to regenerate its own editable/tool entrypoints for a
        # relocatable environment. The later adapter owns only generated metadata
        # and the outer delegating wrappers; executable bytes are never patched.
        for name, directory in [
            ("hermes", source / "venv"),
            ("browser-use", tool_environment),
        ]:
            invoke(
                uv,
                [
                    "venv",
                    "--allow-existing",
                    "--relocatable",
                    "--python",
                    python,
                    directory,
                ],
                label="relocatable-environment-" + name,
            )
        browser_wheel = next(
            wheels / item["file"]
            for item in wheel_inputs["artifacts"]
            if item["name"] == "browser-use"
        )
        invoke(
            uv,
            [
                "pip",
                "install",
                "--python",
                tool_python,
                "--no-index",
                "--find-links",
                wheels,
                "--no-deps",
                "--reinstall-package",
                "browser-use",
                browser_wheel,
            ],
            label="regenerate-browser-use-entrypoint",
        )
        regeneration_environment = dict(
            environment,
            UV_PROJECT_ENVIRONMENT=str(source / "venv"),
            UV_PYTHON=str(source / "venv/Scripts/python.exe"),
            UV_CACHE_DIR=str(phase_root / "dependency-stage/uv-cache"),
            UV_BUILD_CONSTRAINT=str(build_requirements),
            UV_FIND_LINKS=str(build_wheels),
        )
        run_owned(
            uv,
            [
                "sync",
                "--extra",
                "all",
                "--locked",
                "--offline",
                "--reinstall-package",
                "hermes-agent",
            ],
            regeneration_environment,
            source,
            evidence,
            "regenerate-hermes-entrypoints",
        )
        receipt["entrypointRegeneration"] = (
            "official-uv-relocatable-environment-and-exact-reinstall"
        )
        receipt["outerBrowserUseWrapperRelocationRequired"] = True
        # The official path stage chooses relative .cmd delegation only after
        # uv has marked the venv relocatable and regenerated its entrypoints.
        with official_user_path(environment["PATH"]):
            invoke_official_stage("path")
        if any(
            sha256(source / name) != value for name, value in original_locks.items()
        ):
            raise ValueError(
                "The unmodified official stage changed a locked dependency graph"
            )
        receipt["officialSourceFilesVerified"] = (
            inventory_module.verify_official_source(runtime, args.source_archive)
        )
        receipt["sourceUnchanged"] = True
        receipt["status"] = "runtime-provisioned"
        receipt["relocationRequired"] = True
        receipt["productionSplitRequired"] = False
        receipt["productionPartition"] = (
            "full-python-source-with-official-prebuilt-node-outputs"
        )
        receipt["standaloneDesktopBuilt"] = False
        receipt["profile"] = (
            "official-cli-web-tui-and-browser-use; optional desktop packaging and CUA not selected"
        )
    except BaseException as error:
        receipt["error"] = str(error)
        receipt["cleanupErrors"] = getattr(error, "__notes__", [])
        raise
    finally:
        primary = sys.exception()
        try:
            write_json(evidence / "official-runtime-build.json", receipt)
        except Exception as error:
            if primary is None:
                raise
            primary.add_note(f"Build receipt write also failed: {error}")


if __name__ == "__main__":
    main()
