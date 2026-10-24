# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Retain the fixed Personal controller and its host children in a disposable CI job."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re
import secrets
import stat


OWNER_FILE = Path(__file__).with_name("probe-host-browser.py")
SPEC = importlib.util.spec_from_file_location("personal_process_owner", OWNER_FILE)
OWNER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OWNER)
require = OWNER.require
NODE_SHA256 = "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878"
ARGUMENTS = (
    "--runtime-root", "--mxc", "--stock-mxc", "--host-controller-python",
    "--wpr-powershell", "--output", "--compatibility-root", "--compatibility-receipt",
    "--compatibility-proof", "--mxc-build-receipt", "--derived-runtime-receipt",
    "--state-owner-build",
)


def ordinary_identity(file, *, read_limit=None):
    file = Path(file)
    require(file.is_absolute(), "Personal host input must be absolute")
    for part in reversed((file, *file.parents)):
        info = part.lstat()
        require(
            not stat.S_ISLNK(info.st_mode)
            and not getattr(info, "st_file_attributes", 0) & 0x400,
            "Personal host input cannot traverse a link or reparse point",
        )
    named = file.lstat()
    with file.open("rb") as stream:
        before = os.fstat(stream.fileno())
        require(
            stat.S_ISREG(before.st_mode) and before.st_nlink == 1
            and (before.st_dev, before.st_ino) == (named.st_dev, named.st_ino)
            and before.st_size <= (read_limit if read_limit is not None else 256 * 1024 * 1024),
            "Personal host input is not the bounded ordinary file",
        )
        if read_limit is None:
            digest = hashlib.file_digest(stream, "sha256").hexdigest()
            data = None
        else:
            data = stream.read(read_limit + 1)
            require(len(data) == before.st_size, "Personal host input size changed")
            digest = hashlib.sha256(data).hexdigest()
        after = os.fstat(stream.fileno())
        named_after = file.lstat()
        require(
            (before.st_size, before.st_mtime_ns, before.st_ctime_ns)
            == (after.st_size, after.st_mtime_ns, after.st_ctime_ns)
            and (after.st_dev, after.st_ino) == (named_after.st_dev, named_after.st_ino),
            "Personal host input changed while held",
        )
    return {"bytes": before.st_size, "sha256": digest}, data


def validate_arguments(node, arguments, receipt, controller):
    require(
        arguments[:3] == ["--experimental-strip-types", "--no-warnings", controller],
        "The Personal host can run only its fixed controller",
    )
    values = arguments[3:]
    record_startup = values[-1:] == ["--record-startup"]
    if record_startup:
        values = values[:-1]
    require(len(values) == len(ARGUMENTS) * 2, "Unexpected Personal controller arguments")
    pairs = dict(zip(values[::2], values[1::2]))
    require(
        len(pairs) == len(ARGUMENTS) and set(pairs) == set(ARGUMENTS),
        "Missing, duplicate, or unsupported Personal controller argument",
    )
    for value in (node, receipt, controller, *pairs.values()):
        require(
            isinstance(value, str) and PureWindowsPath(value).is_absolute()
            and re.match(r"^[A-Za-z]:\\", value) is not None
            and not any(char in value for char in ('\0', '\r', '\n', '"'))
            and ".." not in PureWindowsPath(value).parts,
            "Personal host paths must be absolute local Windows paths",
        )
    require(
        re.fullmatch(r"[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}", pairs["--runtime-root"]),
        "Personal host runtime must be the fresh canonical build root",
    )
    output = PureWindowsPath(pairs["--output"])
    require(
        output.name == "personal-mxc" and output.parent == PureWindowsPath(receipt).parent
        and PureWindowsPath(receipt).name == "personal-host-owner.json",
        "Personal host evidence must stay in the current production directory",
    )
    return pairs


def child_environment(environment, state, nonce):
    folded = {key.upper(): value for key, value in environment.items()}
    require(folded.get("GITHUB_ACTIONS") == "true" and folded.get("OS") == "Windows_NT",
            "The Personal host requires actual disposable Windows CI")
    for name, pattern in (("GITHUB_SHA", r"[a-f0-9]{40}"),
                          ("GITHUB_RUN_ID", r"[1-9][0-9]*"),
                          ("GITHUB_RUN_ATTEMPT", r"[1-9][0-9]*")):
        require(re.fullmatch(pattern, folded.get(name, "")), "Invalid Personal host CI identity")
    result = {}
    for name in ("SystemRoot", "SystemDrive", "WINDIR", "COMSPEC", "OS",
                 "ProgramFiles", "ProgramFiles(x86)", "RUNNER_TRACKING_ID",
                 "GITHUB_ACTIONS", "GITHUB_SHA", "GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"):
        if name.upper() in folded:
            result[name] = folded[name.upper()]
    require(
        re.fullmatch(r"[A-Za-z]:\\Windows", result.get("SystemRoot", ""), re.IGNORECASE)
        and PureWindowsPath(result.get("COMSPEC", ""))
        == PureWindowsPath(result["SystemRoot"]) / "System32/cmd.exe",
        "Personal host system paths differ from Windows",
    )
    for name in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"):
        result[name] = str(PureWindowsPath(state) / "home")
    result.update(
        TEMP=str(PureWindowsPath(state) / "temp"), TMP=str(PureWindowsPath(state) / "temp"),
        PATH=str(PureWindowsPath(result["SystemRoot"]) / "System32"),
        PYTHONDONTWRITEBYTECODE="1", NODE_DISABLE_COMPILE_CACHE="1",
        NEMOCLAW_PERSONAL_HOST_OWNER=nonce,
        # The child cannot execute this environment until WindowsJob.assign succeeds.
        NEMOCLAW_RUNTIME_JOB_OWNED="1",
    )
    return result


def controller_result(file, source, runtime):
    identity, data = ordinary_identity(file, read_limit=8 * 1024 * 1024)
    result = json.loads(data)
    require(
        type(result.get("schemaVersion")) is int and result["schemaVersion"] == 2
        and result.get("classification") == "canonical-personal-mxc-feasibility"
        and result.get("sourceRevision") == source and result.get("runtime") == runtime
        and type(result.get("feasibilityPassed")) is bool,
        "Personal host result differs from the current controller and runtime",
    )
    return {"passed": result["feasibilityPassed"], "file": str(file), **identity}


def host_closed(record, source, runtime, run_id, attempt):
    try:
        require(isinstance(source, str) and re.fullmatch(r"[a-f0-9]{40}", source)
                and isinstance(runtime, str) and re.fullmatch(r"[A-Za-z]:\\NemoClawHermesProbe-[a-f0-9]{12}", runtime)
                and isinstance(run_id, str) and re.fullmatch(r"[1-9][0-9]*", run_id)
                and isinstance(attempt, str) and re.fullmatch(r"[1-9][0-9]*", attempt),
                "Personal host closure requires current CI identities")
        require(
            type(record["schemaVersion"]) is int and record["schemaVersion"] == 1
            and record["classification"] == "personal-native-host-process-owner"
            and record["sourceRevision"] == source and record["runtimeRoot"] == runtime
            and record["workflowRunId"] == run_id and record["workflowRunAttempt"] == attempt,
            "Personal host receipt identity differs",
        )
        require(all(record[key] is True for key in ("childrenClosed", "cleanupComplete")),
                "Personal host descendants are not closed")
        require(all(record["cleanup"][key] is True for key in (
            "captureClosed", "processHandleClosed", "threadHandleClosed", "jobHandleClosed", "stateRemoved")),
            "Personal host cleanup is incomplete")
        require(record["cleanup"]["errors"] == [], "Personal host cleanup failed")
        if record["processCreated"] is True:
            require(record["execution"]["childClosed"] is True
                    and type(record["job"]["activeAfterCleanup"]) is int
                    and record["job"]["activeAfterCleanup"] == 0,
                    "Personal host process or descendants remain")
        else:
            require(record["processCreated"] is False, "Personal host creation state is unknown")
        return True
    except (KeyError, TypeError, ValueError):
        return False


def run_controller(node, arguments, receipt, environment, native, **timing):
    controller = str(Path(__file__).with_name("probe-personal-candidate.mts"))
    pairs = validate_arguments(node, arguments, str(receipt), controller)
    require(not receipt.exists() and not receipt.is_symlink() and receipt.parent.is_dir(),
            "Personal host receipt must be fresh")
    require(not Path(pairs["--output"]).exists(), "Personal controller output must be fresh")
    nonce = secrets.token_hex(12)
    state = PureWindowsPath(pairs["--runtime-root"]).anchor + "NemoClawPersonalHost-" + nonce[:12]
    child_env = child_environment(environment, state, nonce)
    files = (node, controller, str(Path(__file__)), str(OWNER_FILE))
    identities = {file: ordinary_identity(file)[0] for file in files}
    require(identities[node]["sha256"] == NODE_SHA256, "Personal host Node differs from its pin")

    def verify_inputs():
        require(all(ordinary_identity(file)[0] == value for file, value in identities.items()),
                "Personal host command or owner changed")

    request = {"nonce": nonce, "runtimeRoot": pairs["--runtime-root"],
               "stateRoot": state, "environment": child_env}
    record = OWNER.own_fixed_process(
        request, native, [node, *arguments], verify_inputs,
        lambda _stdout: controller_result(Path(pairs["--output"]) / "personal-feasibility.json",
                                         child_env["GITHUB_SHA"], pairs["--runtime-root"]),
        classification="personal-native-host-process-owner", diagnostic_only=False,
        work_seconds=600, cleanup_seconds=15, **timing,
    )
    record.update(sourceRevision=child_env["GITHUB_SHA"], workflowRunId=child_env["GITHUB_RUN_ID"],
                  workflowRunAttempt=child_env["GITHUB_RUN_ATTEMPT"], inputs=identities)
    record["operationSucceeded"] = record["operationSucceeded"] and not record["job"]["forcedTermination"]
    with receipt.open("x", encoding="utf-8") as stream:
        json.dump(record, stream, indent=2)
        stream.write("\n")
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--node")
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--check-closure", action="store_true")
    parser.add_argument("--runtime-root")
    parser.add_argument("arguments", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    require(os.name == "nt" and os.environ.get("GITHUB_ACTIONS") == "true",
            "Personal host execution requires disposable Windows CI")
    if args.check_closure:
        require(args.runtime_root and not args.node and not args.arguments,
                "Personal host closure accepts only its receipt and runtime")
        _, data = ordinary_identity(args.receipt, read_limit=1024 * 1024)
        closed = host_closed(json.loads(data), os.environ.get("GITHUB_SHA"), args.runtime_root,
                             os.environ.get("GITHUB_RUN_ID"), os.environ.get("GITHUB_RUN_ATTEMPT"))
        print(json.dumps({"childrenClosed": closed}))
        return 0 if closed else 1
    require(args.node and not args.runtime_root, "Personal host execution requires its pinned Node")
    require(args.arguments[:1] == ["--"], "Personal host command separator is required")
    record = run_controller(args.node, args.arguments[1:], args.receipt, os.environ, OWNER.WindowsJob())
    print(json.dumps({"receipt": str(args.receipt), "operationSucceeded": record["operationSucceeded"],
                      "childrenClosed": record["childrenClosed"], "cleanupComplete": record["cleanupComplete"]}))
    return 0 if record["operationSucceeded"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
