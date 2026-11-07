# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Own one disposable WER diagnostic clone; canonical runtime is read-only input."""

import argparse
import ctypes as c
import hashlib
import importlib.util
import json
import ntpath
import os
from pathlib import Path, PurePosixPath
import re
import stat
import time

INVENTORY_SHA = "f4df172630b7f5ae6ec9cc9cf9c54b4744c2b0046cb15859f9469ff9bfe7a0e2"
CHROME_PREFIX = "browsers/chromium-1234/chrome-win64/"
MAX_REPORTS = 32
MAX_REPORT_BYTES = 16 * 1024


def require(value, message):
    if not value:
        raise ValueError(message)


def detail(error):
    return {
        "name": type(error).__name__,
        "message": str(error)[:2048],
        "winerror": getattr(error, "winerror", None),
    }


def ordinary(path, directory=False):
    value = Path(path).lstat()
    require(
        not stat.S_ISLNK(value.st_mode)
        and not getattr(value, "st_file_attributes", 0) & 0x400,
        "Diagnostic paths cannot redirect through links or reparse points",
    )
    require(
        stat.S_ISDIR(value.st_mode) if directory else stat.S_ISREG(value.st_mode),
        "Unexpected diagnostic filesystem object",
    )
    if not directory:
        require(value.st_nlink == 1, "Diagnostic files cannot be hard-linked")
    return value


def read_file(path, limit, retain=False):
    before = ordinary(path)
    require(before.st_size <= limit, "File exceeds its diagnostic bound")
    digest = hashlib.sha256()
    chunks, count = [], 0
    with Path(path).open("rb") as stream:
        opened = os.fstat(stream.fileno())
        require(
            (opened.st_dev, opened.st_ino, opened.st_size)
            == (before.st_dev, before.st_ino, before.st_size),
            "File identity changed while opening",
        )
        while block := stream.read(min(1024 * 1024, limit + 1 - count)):
            count += len(block)
            require(count <= limit, "File grew beyond its diagnostic bound")
            digest.update(block)
            if retain:
                chunks.append(block)
        after = os.fstat(stream.fileno())
    require(
        count == after.st_size
        and (opened.st_size, opened.st_mtime_ns, opened.st_ctime_ns)
        == (after.st_size, after.st_mtime_ns, after.st_ctime_ns),
        "File changed while reading",
    )
    final = ordinary(path)
    require(
        (final.st_dev, final.st_ino, final.st_size, final.st_mtime_ns)
        == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
        "File path changed while reading",
    )
    return {
        "path": str(path),
        "bytes": after.st_size,
        "sha256": digest.hexdigest(),
    }, b"".join(chunks)


def file_identity(path, limit=512 * 1024 * 1024):
    return read_file(path, limit)[0]


def json_file(path, limit):
    identity, data = read_file(path, limit, True)
    return identity, json.loads(data)


def save(path, value):
    data = (json.dumps(value, separators=(",", ":")) + "\n").encode("utf-8")
    require(len(data) <= 2 * 1024 * 1024, "Owner receipt exceeded its bound")
    temporary = Path(str(path) + ".tmp")
    with temporary.open("xb") as stream:
        stream.write(data)
    os.replace(temporary, path)


class Windows:
    def __init__(self):
        self.k = c.WinDLL("kernel32", use_last_error=True)
        self.close_errors = []
        for name, (args, result) in {
            "CreateFileW": (
                [
                    c.c_wchar_p,
                    c.c_uint32,
                    c.c_uint32,
                    c.c_void_p,
                    c.c_uint32,
                    c.c_uint32,
                    c.c_void_p,
                ],
                c.c_void_p,
            ),
            "GetFileInformationByHandleEx": (
                [c.c_void_p, c.c_int, c.c_void_p, c.c_uint32],
                c.c_int,
            ),
            "CloseHandle": ([c.c_void_p], c.c_int),
            "OpenProcess": ([c.c_uint32, c.c_int, c.c_uint32], c.c_void_p),
            "GetProcessTimes": ([c.c_void_p, *([c.POINTER(c.c_uint64)] * 4)], c.c_int),
            "QueryFullProcessImageNameW": (
                [c.c_void_p, c.c_uint32, c.c_wchar_p, c.POINTER(c.c_uint32)],
                c.c_int,
            ),
            "WaitForSingleObject": ([c.c_void_p, c.c_uint32], c.c_uint32),
        }.items():
            function = getattr(self.k, name)
            function.argtypes, function.restype = args, result

    def close(self, handle):
        if not self.k.CloseHandle(handle):
            self.close_errors.append(
                {"stage": "CloseHandle", "winerror": c.get_last_error()}
            )

    def file_id(self, path, directory=False):
        ordinary(path, directory)
        handle = self.k.CreateFileW(
            str(path),
            0x80,
            7,
            None,
            3,
            0x00200000 | (0x02000000 if directory else 0),
            None,
        )
        if handle in (None, c.c_void_p(-1).value):
            raise c.WinError(c.get_last_error())
        try:
            value = c.create_string_buffer(24)
            if not self.k.GetFileInformationByHandleEx(handle, 18, value, 24):
                raise c.WinError(c.get_last_error())
            raw = value.raw
            return {
                "volumeSerialHex": hex(int.from_bytes(raw[:8], "little")),
                "fileIdHex": raw[8:].hex(),
            }
        finally:
            self.close(handle)

    def host_closure(self, host, deadline):
        pid, created, image = host["pid"], host["creationFiletime"], host["image"]
        require(
            type(pid) is int
            and 0 < pid < 2**32
            and re.fullmatch(r"[0-9]{1,20}", created),
            "Invalid reported WER host generation",
        )
        expected = ntpath.join(os.environ["SystemRoot"], "System32", "WerFault.exe")
        require(
            ntpath.normcase(image) == ntpath.normcase(expected),
            "Reported callback host is not the exact system WER image",
        )
        row = {
            "pid": pid,
            "creationFiletime": created,
            "expectedImage": image,
            "access": "0x00101000",
            "closed": False,
            "handleClosed": True,
            "error": None,
        }
        if time.monotonic() >= deadline:
            row["error"] = {"message": "WER host closure observation budget exhausted"}
            return row
        handle = self.k.OpenProcess(0x00101000, False, pid)
        if not handle:
            error = c.get_last_error()
            row.update(openError=error, closed=error == 87, absent=error == 87)
            return row
        row["handleClosed"] = False
        try:
            times = [c.c_uint64() for _ in range(4)]
            if not self.k.GetProcessTimes(handle, *(c.byref(value) for value in times)):
                raise c.WinError(c.get_last_error())
            row["observedCreationFiletime"] = str(times[0].value)
            if row["observedCreationFiletime"] != created:
                row.update(closed=True, pidReused=True)
                return row
            buffer = c.create_unicode_buffer(32768)
            length = c.c_uint32(len(buffer))
            if not self.k.QueryFullProcessImageNameW(
                handle, 0, buffer, c.byref(length)
            ):
                raise c.WinError(c.get_last_error())
            row["observedImage"] = buffer.value
            require(
                ntpath.normcase(buffer.value) == ntpath.normcase(expected),
                "WER host image identity differs",
            )
            remaining = max(0, int((deadline - time.monotonic()) * 1000))
            wait = self.k.WaitForSingleObject(handle, remaining)
            row["waitResult"] = wait
            if wait == 0xFFFFFFFF:
                raise c.WinError(c.get_last_error())
            require(wait in (0, 258), "Unexpected WER host wait result")
            row["closed"] = wait == 0
        except Exception as error:
            row["error"] = detail(error)
        finally:
            before = len(self.close_errors)
            self.close(handle)
            row["handleClosed"] = len(self.close_errors) == before
        return row


def selected_inventory(path):
    identity, inventory = json_file(path, 32 * 1024 * 1024)
    require(
        identity["sha256"] == INVENTORY_SHA, "Expected the exact complete8d78 inventory"
    )
    rows = [
        dict(row, relative=row["path"][len(CHROME_PREFIX) :])
        for row in inventory["files"]
        if row["path"].startswith(CHROME_PREFIX)
    ]
    require(
        len(rows) == 308 and sum(row["bytes"] for row in rows) == 447417940,
        "The exact canonical Chrome subtree differs",
    )
    directories = [
        value[len(CHROME_PREFIX) :]
        for value in inventory["directories"]
        if value.startswith(CHROME_PREFIX)
    ]
    for name in [row["relative"] for row in rows] + directories:
        require(
            name
            and PurePosixPath(name).as_posix() == name
            and not name.startswith("/")
            and "\\" not in name
            and ":" not in name
            and ".." not in PurePosixPath(name).parts,
            "Invalid canonical Chrome inventory path",
        )
    return identity, rows, directories


def copy_file(source, destination, expected):
    before = file_identity(source)
    require(
        (before["bytes"], before["sha256"]) == (expected["bytes"], expected["sha256"]),
        "Source differs from the exact recorded file",
    )
    with Path(source).open("rb") as reader, Path(destination).open("xb") as writer:
        while block := reader.read(1024 * 1024):
            writer.write(block)
    actual = file_identity(destination)
    require(
        (actual["bytes"], actual["sha256"]) == (expected["bytes"], expected["sha256"])
        and file_identity(source) == before,
        "File changed while cloning",
    )
    return actual


def registry_module():
    return load_module("renderer-wer-registry.py")


def load_module(name):
    path = Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def prepare(args, windows):
    require(
        re.fullmatch(r"[0-9a-f]{24}", args.nonce),
        "Expected the existing Personal nonce",
    )
    runtime = str(args.runtime_root)
    require(
        runtime == r"C:\NemoClawHermesProbe-274d797050ea",
        "Expected the admitted complete immutable runtime root",
    )
    drive = ntpath.splitdrive(runtime)[0]
    require(
        drive.casefold() == os.environ["SystemDrive"].casefold(),
        "Runtime drive differs",
    )
    root = Path(drive + "\\NemoClawRendererWer-" + args.nonce[:12])
    output = Path(args.output)
    require(
        not root.exists() and not output.exists(),
        "Diagnostic root and owner receipt must be fresh",
    )
    ordinary(output.parent, True)
    receipt = {
        "schemaVersion": 1,
        "classification": "renderer-wer-clone-owner",
        "status": "failed",
        "ready": False,
        "sourceRevision": os.environ["GITHUB_SHA"],
        "nonce": args.nonce,
        "cloneRoot": str(root),
        "chromePath": str(root / "chrome-win64/chrome.exe"),
        "reportRoot": str(root / "reports"),
        "rootCreated": False,
        "registry": None,
        "primaryError": None,
        "cleanupErrors": [],
        "diagnosticOnly": True,
        "canonicalQualification": False,
        "baseBytesModified": False,
    }

    def checkpoint(registry=None):
        if registry is not None:
            receipt["registry"] = registry
        save(output, receipt)

    try:
        inventory, files, directories = selected_inventory(args.inventory)
        receipt["baseInventory"] = inventory
        build_file = Path(args.observer_build)
        receipt["observerBuild"], build = json_file(build_file, 64 * 1024)
        require(
            build["schemaVersion"] == 1
            and build["classification"] == "renderer-wer-observer-build"
            and build["sourceRevision"] == receipt["sourceRevision"]
            and build["status"] == "built"
            and build["executed"] is False
            and build["observationsExecuted"] is False
            and build["qualified"] is False
            and not build["cleanupErrors"],
            "Observer build is not from this exact diagnostic source",
        )
        require(
            build["source"]["path"]
            == "packaging/windows/hermes/renderer-wer-observer.cpp",
            "Observer source path differs",
        )
        source_identity = file_identity(
            Path(__file__).with_name("renderer-wer-observer.cpp"), 64 * 1024
        )
        require(
            (source_identity["bytes"], source_identity["sha256"])
            == (build["source"]["bytes"], build["source"]["sha256"]),
            "Observer source bytes differ",
        )
        require(
            build["compatibilityReceipt"]["sourceRevision"]
            == "c830cd3ef8315ff46a7ebfcd3c0b2afefd152a4a"
            and build["toolchain"]["target"] == "x64",
            "Observer compiler lineage differs",
        )
        compatibility = file_identity(build["compatibilityReceipt"]["path"], 64 * 1024)
        require(
            (compatibility["bytes"], compatibility["sha256"])
            == (
                build["compatibilityReceipt"]["bytes"],
                build["compatibilityReceipt"]["sha256"],
            )
            and compatibility["sha256"]
            == "90a40c02c4112dbc41bc3b8b04c48ea7809ec086e623d99e81e80b0e645cbcd5",
            "Observer toolchain receipt differs from the passed c830 bytes",
        )
        require(
            build["diagnostics"]
            and all(
                row["exitCode"] == 0 and row["closed"] and row["captureClosed"]
                for row in build["diagnostics"]
            ),
            "Observer compiler did not close successfully",
        )
        require(len(build["files"]) == 1, "Expected one observer DLL")
        observer = build["files"][0]
        require(
            observer["role"] == "wer-observer"
            and observer["relativePath"] == "chrome_wer.dll"
            and observer["machine"] == 0x8664
            and observer["executed"] is False
            and observer["delayImportsAbsent"] is True
            and [value.lower() for value in observer["importDlls"]] == ["kernel32.dll"]
            and sorted(observer["exports"])
            == sorted(
                (
                    "OutOfProcessExceptionEventCallback",
                    "OutOfProcessExceptionEventSignatureCallback",
                    "OutOfProcessExceptionEventDebuggerLaunchCallback",
                )
            ),
            "Observer DLL import/export/architecture contract differs",
        )
        source_dll = build_file.parent / "chrome_wer.dll"
        receipt["expectedChromeFiles"] = [
            {key: row[key] for key in ("relative", "bytes", "sha256")} for row in files
        ]
        receipt["expectedChromeDirectories"] = directories
        checkpoint()
        root.mkdir()
        receipt["rootCreated"] = True
        receipt["rootIdentity"] = windows.file_id(root, True)
        checkpoint()
        access_file = output.with_name(output.stem + "-public-rx.json")
        receipt["publicRuntimeAccess"] = load_module(
            "prepare-public-runtime-acl.py"
        ).prepare(root, access_file, diagnostic_nonce=args.nonce[:12])
        receipt["publicRuntimeAccessDocument"] = file_identity(access_file, 64 * 1024)
        require(
            receipt["publicRuntimeAccess"]["status"] == "prepared"
            and receipt["publicRuntimeAccess"]["exactDeltaVerified"]
            and receipt["publicRuntimeAccess"]["handleClosed"],
            "Diagnostic public RX preparation did not finish",
        )
        checkpoint()
        chrome = root / "chrome-win64"
        chrome.mkdir()
        (root / "reports").mkdir()
        receipt["chromeDirectoryIdentity"] = windows.file_id(chrome, True)
        receipt["reportDirectoryIdentity"] = windows.file_id(root / "reports", True)
        for name in sorted(directories, key=lambda x: (x.count("/"), x)):
            (chrome / name).mkdir()
        for row in files:
            source = Path(runtime) / row["path"]
            for parent in source.parents:
                ordinary(parent, True)
                if str(parent).casefold() == runtime.casefold():
                    break
            if row["relative"] == "chrome_wer.dll":
                original = file_identity(source)
                require(
                    (original["bytes"], original["sha256"])
                    == (row["bytes"], row["sha256"]),
                    "Canonical WER DLL changed",
                )
                replacement = copy_file(source_dll, chrome / row["relative"], observer)
                receipt["observerReplacement"] = {
                    "original": original,
                    "replacement": replacement,
                }
            else:
                copy_file(source, chrome / row["relative"], row)
        identity = {
            **file_identity(chrome / "chrome.exe"),
            **windows.file_id(chrome / "chrome.exe"),
        }
        receipt["chromeIdentity"] = identity
        config = (
            "\n".join(
                (
                    "NEMOCLAW_RENDERER_WER_V1",
                    receipt["sourceRevision"],
                    args.nonce[:12],
                    str(identity["bytes"]),
                    identity["sha256"],
                    identity["volumeSerialHex"],
                    identity["fileIdHex"],
                )
            )
            + "\n"
        )
        require(
            len(config.encode("ascii")) <= 512, "Observer configuration exceeds bound"
        )
        with (root / "renderer-wer-observer.txt").open(
            "x", encoding="ascii", newline="\n"
        ) as stream:
            stream.write(config)
        receipt["config"] = file_identity(root / "renderer-wer-observer.txt", 512)
        receipt["cloneVerified"] = verify_clone(receipt, windows)
        receipt["registry"] = registry_module().prepare(
            str(chrome / "chrome_wer.dll"), checkpoint=checkpoint
        )
        require(not windows.close_errors, "A preparation handle did not close")
        receipt.update(status="prepared", ready=True)
    except Exception as error:
        receipt["primaryError"] = detail(error)
        if hasattr(error, "renderer_wer_receipt"):
            receipt["registry"] = error.renderer_wer_receipt
    finally:
        receipt["cleanupErrors"].extend(windows.close_errors)
        try:
            checkpoint()
        except Exception as error:
            receipt["receiptWriteError"] = detail(error)
            receipt["ready"] = False
    return receipt


def load_owner(args, windows):
    require(
        re.fullmatch(r"[0-9a-f]{64}", args.owner_sha256),
        "Owner receipt hash is required",
    )
    identity, owner = json_file(args.owner, 1024 * 1024)
    require(identity["sha256"] == args.owner_sha256, "Owner receipt changed")
    require(
        owner.get("schemaVersion") == 1
        and owner.get("classification") == "renderer-wer-clone-owner"
        and owner.get("sourceRevision") == os.environ["GITHUB_SHA"]
        and re.fullmatch(r"[0-9a-f]{24}", owner.get("nonce", "")),
        "Unexpected clone ownership receipt",
    )
    expected = (
        os.environ["SystemDrive"] + "\\NemoClawRendererWer-" + owner["nonce"][:12]
    )
    require(
        ntpath.normcase(owner["cloneRoot"]) == ntpath.normcase(expected)
        and owner["chromePath"]
        == str(Path(owner["cloneRoot"]) / "chrome-win64/chrome.exe")
        and owner["reportRoot"] == str(Path(owner["cloneRoot"]) / "reports"),
        "Clone ownership paths differ",
    )
    if owner["rootCreated"]:
        require(
            windows.file_id(owner["cloneRoot"], True) == owner["rootIdentity"],
            "The owned clone root changed identity",
        )
    if owner.get("registry"):
        require(
            owner["registry"]["valueName"]
            == str(Path(owner["cloneRoot"]) / "chrome-win64/chrome_wer.dll"),
            "Registry ownership names another clone",
        )
    return owner


def verify_clone(owner, windows):
    root = Path(owner["cloneRoot"])
    require(
        {path.name for path in root.iterdir()}
        == {"chrome-win64", "reports", "renderer-wer-observer.txt"},
        "Unexpected object in the diagnostic root",
    )
    chrome = root / "chrome-win64"
    require(
        windows.file_id(chrome, True) == owner["chromeDirectoryIdentity"],
        "Chrome directory identity changed",
    )
    expected = {row["relative"]: dict(row) for row in owner["expectedChromeFiles"]}
    expected["chrome_wer.dll"].update(owner["observerReplacement"]["replacement"])
    actual_files, actual_directories = set(), set()
    for current, names, files in os.walk(chrome, followlinks=False):
        ordinary(current, True)
        for name in names:
            directory = Path(current) / name
            ordinary(directory, True)
            actual_directories.add(directory.relative_to(chrome).as_posix())
        for name in files:
            file = Path(current) / name
            ordinary(file)
            actual_files.add(file.relative_to(chrome).as_posix())
    require(
        actual_files == set(expected)
        and actual_directories == set(owner["expectedChromeDirectories"]),
        "Diagnostic Chrome membership changed",
    )
    manifest = []
    for relative, row in sorted(expected.items()):
        identity = file_identity(chrome / relative)
        require(
            (identity["bytes"], identity["sha256"]) == (row["bytes"], row["sha256"]),
            "Diagnostic Chrome bytes changed",
        )
        manifest.append(
            {
                "relative": relative,
                "bytes": identity["bytes"],
                "sha256": identity["sha256"],
            }
        )
    require(
        file_identity(root / "renderer-wer-observer.txt", 512) == owner["config"],
        "Observer config changed",
    )
    require(
        windows.file_id(chrome / "chrome.exe")
        == {
            key: owner["chromeIdentity"][key]
            for key in ("volumeSerialHex", "fileIdHex")
        },
        "Chrome image file identity changed",
    )
    return {
        "complete": True,
        "files": len(manifest),
        "directories": len(actual_directories),
        "logicalBytes": sum(row["bytes"] for row in manifest),
        "inventorySha256": hashlib.sha256(
            json.dumps(manifest, sort_keys=True).encode()
        ).hexdigest(),
    }


def read_reports(owner, windows):
    result = {
        "schemaVersion": 1,
        "classification": "renderer-wer-reports",
        "nonce": owner["nonce"],
        "reports": [],
        "hostLoads": [],
        "errors": [],
        "complete": False,
        "diagnosticOnly": True,
    }
    root = Path(owner["reportRoot"])
    try:
        require(
            windows.file_id(root, True) == owner["reportDirectoryIdentity"],
            "Report directory identity changed",
        )
        entries = list(root.iterdir())
        require(len(entries) <= MAX_REPORTS, "WER report count exceeded its bound")
        for file in sorted(entries):
            try:
                require(
                    re.fullmatch(r"[A-Za-z0-9_.-]{1,128}\.json", file.name),
                    "Unexpected file in owned WER reports",
                )
                identity, data = read_file(file, MAX_REPORT_BYTES, True)
                try:
                    value = json.loads(data)
                except Exception as error:
                    result["reports"].append(
                        {
                            "identity": identity,
                            "rawText": data.decode("utf-8", errors="replace"),
                            "parseError": detail(error),
                            "bindingValidation": {"valid": False},
                        }
                    )
                    raise
                record = {"identity": identity, "value": value}
                result["reports"].append(record)
                bound = (
                    value.get("schemaVersion") == 1
                    and value.get("sourceRevision") == owner["sourceRevision"]
                    and value.get("nonce") == owner["nonce"][:12]
                )
                record["bindingValidation"] = {
                    "valid": bound,
                    "error": None if bound else "source/nonce unavailable or different",
                }
                require(
                    bound,
                    "WER binding unavailable or different; original bounded record retained",
                )
                kind = value.get("classification")
                if kind == "renderer-wer-host-load":
                    require(
                        value.get("hostIdentityComplete") is True
                        and value.get("configValid") is True
                        and value.get("callbackExecuted") is False,
                        "WER host initialization failed",
                    )
                    result["hostLoads"].append(record)
                elif kind == "renderer-wer-exception-observation":
                    require(
                        value.get("fileHandlesClosed") is True
                        and value.get("ownershipClaimed") is False
                        and value.get("callbackReturn") == "S_OK",
                        "WER callback file ownership/return differs",
                    )
                else:
                    raise ValueError(
                        "WER observer failure or unrecognized notice record"
                    )
            except Exception as error:
                result["errors"].append({"file": file.name, **detail(error)})
        result["complete"] = not result["errors"]
    except Exception as error:
        result["errors"].append(detail(error))
    result["errors"].extend(windows.close_errors)
    result["complete"] = result["complete"] and not result["errors"]
    return result


def cleanup(args, owner, windows):
    result = {
        "schemaVersion": 1,
        "classification": "renderer-wer-owner-cleanup",
        "nonce": owner["nonce"],
        "cleanupComplete": False,
        "registryRestored": False,
        "hostsClosed": False,
        "rootRemoved": False,
        "rootRetained": owner["rootCreated"],
        "hostObservations": [],
        "errors": [],
        "diagnosticOnly": True,
    }
    if not (args.executor_closed or args.executor_not_started):
        result["errors"].append(
            {
                "message": "Executor closure was not confirmed; registry and clone retained"
            }
        )
        result["errors"].extend(windows.close_errors)
        return result
    reports = None
    try:
        reports = (
            read_reports(owner, windows)
            if owner.get("reportDirectoryIdentity")
            else None
        )
        result["reportObservation"] = reports
        if args.executor_not_started:
            result["hostsClosed"] = (
                reports is None or reports["complete"] and not reports["reports"]
            )
        elif reports and reports["hostLoads"]:
            deadline = time.monotonic() + 5
            hosts = {}
            for record in reports["hostLoads"]:
                value = record["value"]
                host = {
                    "pid": value["hostPid"],
                    "creationFiletime": value["hostCreationFiletime"],
                    "image": value["hostImage"],
                }
                hosts[(host["pid"], host["creationFiletime"])] = host
            for host in hosts.values():
                result["hostObservations"].append(windows.host_closure(host, deadline))
            result["hostsClosed"] = all(
                row["closed"] and row["handleClosed"] and not row["error"]
                for row in result["hostObservations"]
            )
            if result["hostsClosed"]:
                reports = read_reports(owner, windows)
                result["reportObservationAfterHostClosure"] = reports
                final_hosts = {
                    (row["value"]["hostPid"], row["value"]["hostCreationFiletime"])
                    for row in reports["hostLoads"]
                }
                result["hostsClosed"] = reports["complete"] and final_hosts == set(
                    hosts
                )
    except Exception as error:
        result["errors"].append(detail(error))
    finally:
        try:
            if owner.get("registry"):
                restored = registry_module().cleanup(owner["registry"])
                result["registry"] = restored
                result["registryRestored"] = restored["passed"]
            else:
                result["registryRestored"] = True
        except Exception as error:
            result["errors"].append(detail(error))
    try:
        require(
            result["hostsClosed"],
            "WER host closure/initialization evidence incomplete; clone retained",
        )
        require(
            result["registryRestored"],
            "WER registry restoration incomplete; clone retained",
        )
        require(
            not owner.get("cleanupErrors"),
            "Earlier clone owner handle failure remains unresolved",
        )
        if owner.get("ready"):
            result["cloneIntegrityAfter"] = verify_clone(owner, windows)
            require(
                result["cloneIntegrityAfter"] == owner["cloneVerified"],
                "Diagnostic clone post-inventory differs",
            )
        else:
            result["cloneIntegrityAfter"] = {
                "complete": False,
                "status": "partial-prepare-not-qualified",
            }
        if owner["rootCreated"]:
            root = Path(owner["cloneRoot"])
            allowed = {"renderer-wer-observer.txt"} | {
                "chrome-win64/" + row["relative"]
                for row in owner["expectedChromeFiles"]
            }
            allowed_directories = {"chrome-win64", "reports"} | {
                "chrome-win64/" + name for name in owner["expectedChromeDirectories"]
            }
            if reports:
                allowed |= {
                    "reports/" + Path(row["identity"]["path"]).name
                    for row in reports["reports"]
                }
            files, directories = [], []
            for current, names, leaves in os.walk(root, followlinks=False):
                ordinary(current, True)
                for name in names:
                    directory = Path(current) / name
                    ordinary(directory, True)
                    require(
                        directory.relative_to(root).as_posix() in allowed_directories,
                        "Unrecorded directory in clone; retained",
                    )
                    directories.append(directory)
                for name in leaves:
                    file = Path(current) / name
                    ordinary(file)
                    require(
                        file.relative_to(root).as_posix() in allowed,
                        "Unrecorded file in clone; retained",
                    )
                    files.append(file)
            # A loaded DLL cannot be removed. Try it before any other owned file.
            dll = root / "chrome-win64/chrome_wer.dll"
            if dll in files:
                dll.unlink()
                files.remove(dll)
            for file in files:
                file.unlink()
            for directory in sorted(
                directories, key=lambda path: len(path.parts), reverse=True
            ):
                directory.rmdir()
            root.rmdir()
        result.update(rootRemoved=True, rootRetained=False)
    except Exception as error:
        result["errors"].append(detail(error))
    result["errors"].extend(windows.close_errors)
    result["cleanupComplete"] = (
        result["registryRestored"]
        and result["hostsClosed"]
        and result["rootRemoved"]
        and not result["errors"]
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    command = modes.add_parser("prepare")
    for name in ("runtime-root", "inventory", "observer-build", "nonce", "output"):
        command.add_argument("--" + name, required=True)
    for name in ("readreports", "cleanup"):
        command = modes.add_parser(name)
        for value in ("owner", "owner-sha256", "output"):
            command.add_argument("--" + value, required=True)
        if name == "cleanup":
            group = command.add_mutually_exclusive_group()
            group.add_argument("--executor-closed", action="store_true")
            group.add_argument("--executor-not-started", action="store_true")
    args = parser.parse_args()
    require(
        os.name == "nt"
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and re.fullmatch(r"[0-9a-f]{40}", os.environ.get("GITHUB_SHA", "")),
        "Disposable same-source Windows CI only",
    )
    windows = Windows()
    if args.mode == "prepare":
        result = prepare(args, windows)
        passed = result["ready"]
    else:
        require(not Path(args.output).exists(), "Diagnostic output must be fresh")
        owner = load_owner(args, windows)
        result = (
            read_reports(owner, windows)
            if args.mode == "readreports"
            else cleanup(args, owner, windows)
        )
        passed = result.get("complete", result.get("cleanupComplete", False))
        try:
            save(Path(args.output), result)
        except Exception as error:
            result["receiptWriteError"] = detail(error)
            passed = False
    print(
        json.dumps(
            {
                "output": args.output,
                "mode": args.mode,
                "passed": passed,
                "status": result.get("status"),
                "ready": result.get("ready"),
                "cleanupComplete": result.get("cleanupComplete"),
                "primaryError": result.get("primaryError"),
                "errors": result.get("errors", []),
                "receiptWriteError": result.get("receiptWriteError"),
            }
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
