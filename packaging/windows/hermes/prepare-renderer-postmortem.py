# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Own a temporary exact-scope AeDebug gate; never launch the application here."""

import argparse
import ctypes as c
import importlib.util
import json
import ntpath
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


def load(name, path=None):
    file = Path(path) if path else Path(__file__).with_name(name)
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


common = load("prepare-renderer-wer.py")
require, ordinary, identity, read_json, detail, save = (
    common.require,
    common.ordinary,
    common.file_identity,
    common.json_file,
    common.detail,
    common.save,
)
PYTHON_SHA = "54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b"
CHROME_SHA = "409805a16d6416087e6b2f778df1cf8f7bbb267d6b99f6b5bb0a618eace234f2"
REPORT_LIMIT = 128 * 1024


def appcontainer_sid(name, windows):
    user = c.WinDLL("userenv", use_last_error=True)
    adv = c.WinDLL("advapi32", use_last_error=True)
    user.DeriveAppContainerSidFromAppContainerName.argtypes = [
        c.c_wchar_p,
        c.POINTER(c.c_void_p),
    ]
    user.DeriveAppContainerSidFromAppContainerName.restype = c.c_long
    adv.ConvertSidToStringSidW.argtypes = [c.c_void_p, c.POINTER(c.c_void_p)]
    adv.ConvertSidToStringSidW.restype = c.c_int
    adv.FreeSid.argtypes, adv.FreeSid.restype = [c.c_void_p], c.c_void_p
    windows.k.LocalFree.argtypes, windows.k.LocalFree.restype = [c.c_void_p], c.c_void_p
    sid, text = c.c_void_p(), c.c_void_p()
    try:
        status = user.DeriveAppContainerSidFromAppContainerName(name, c.byref(sid))
        require(
            status == 0 and sid.value,
            "AppContainer SID derivation failed: " + hex(status & 0xFFFFFFFF),
        )
        if not adv.ConvertSidToStringSidW(sid, c.byref(text)):
            raise c.WinError(c.get_last_error())
        value = c.wstring_at(text)
        require(
            re.fullmatch(r"S-1-15-2(?:-[0-9]+){7}", value),
            "Unexpected derived AppContainer SID",
        )
        return value
    finally:
        if text.value and windows.k.LocalFree(text):
            windows.close_errors.append(
                {"stage": "LocalFree(SID string)", "winerror": c.get_last_error()}
            )
        if sid.value and adv.FreeSid(sid):
            windows.close_errors.append(
                {"stage": "FreeSid", "winerror": c.get_last_error()}
            )


def input_metadata(path, row):
    row["path"] = str(path)
    value = Path(path).lstat()
    row.update(
        linkCount=value.st_nlink,
        bytes=value.st_size,
        fileAttributes=getattr(value, "st_file_attributes", 0),
        fileIdentity={"device": str(value.st_dev), "inode": str(value.st_ino)},
    )
    return value


class DebuggerMetadata:
    """Read known-folder and version resources without loading a debugger image."""

    def __init__(self):
        self.shell = c.WinDLL("shell32", use_last_error=True)
        self.ole = c.WinDLL("ole32", use_last_error=True)
        self.version = c.WinDLL("version", use_last_error=True)
        self.shell.SHGetKnownFolderPath.argtypes = [
            c.c_void_p,
            c.c_uint32,
            c.c_void_p,
            c.POINTER(c.c_void_p),
        ]
        self.shell.SHGetKnownFolderPath.restype = c.c_long
        self.ole.CoTaskMemFree.argtypes, self.ole.CoTaskMemFree.restype = (
            [c.c_void_p],
            None,
        )
        self.version.GetFileVersionInfoSizeW.argtypes = [
            c.c_wchar_p,
            c.POINTER(c.c_uint32),
        ]
        self.version.GetFileVersionInfoSizeW.restype = c.c_uint32
        self.version.GetFileVersionInfoW.argtypes = [
            c.c_wchar_p,
            c.c_uint32,
            c.c_uint32,
            c.c_void_p,
        ]
        self.version.GetFileVersionInfoW.restype = c.c_int
        self.version.VerQueryValueW.argtypes = [
            c.c_void_p,
            c.c_wchar_p,
            c.POINTER(c.c_void_p),
            c.POINTER(c.c_uint32),
        ]
        self.version.VerQueryValueW.restype = c.c_int

    def known_folders(self):
        result = []
        for name, value in (
            ("ProgramFilesX86", "7c5a40ef-a0fb-4bfc-874a-c0f2e0b9fa8e"),
            ("ProgramFiles", "905e63b6-c1bf-494e-b29c-65b732d3d21a"),
        ):
            row = {"name": name, "guid": value, "path": None, "error": None}
            pointer = c.c_void_p()
            try:
                guid = c.create_string_buffer(uuid.UUID(value).bytes_le)
                status = self.shell.SHGetKnownFolderPath(
                    guid, 0, None, c.byref(pointer)
                )
                row["hresult"] = hex(status & 0xFFFFFFFF)
                require(status >= 0 and pointer.value, "Known-folder lookup failed")
                row["path"] = c.wstring_at(pointer)
                require(
                    0 < len(row["path"]) < 32768 and ntpath.isabs(row["path"]),
                    "Invalid known-folder path",
                )
            except Exception as error:
                row["error"] = detail(error)
            finally:
                if pointer.value:
                    self.ole.CoTaskMemFree(pointer)
            result.append(row)
        return result

    def file_version(self, path):
        unused = c.c_uint32()
        size = self.version.GetFileVersionInfoSizeW(str(path), c.byref(unused))
        require(
            52 <= size <= 1024 * 1024,
            "Debugger version resource size unavailable or outside bound",
        )
        buffer = c.create_string_buffer(size)
        if not self.version.GetFileVersionInfoW(str(path), 0, size, buffer):
            raise c.WinError(c.get_last_error())
        pointer, length = c.c_void_p(), c.c_uint32()
        if not self.version.VerQueryValueW(
            buffer, "\\", c.byref(pointer), c.byref(length)
        ):
            raise c.WinError(c.get_last_error())
        require(
            length.value >= 52
            and pointer.value
            and c.addressof(buffer) <= pointer.value <= c.addressof(buffer) + size - 52,
            "Invalid fixed version resource",
        )
        words = (c.c_uint32 * 13).from_address(pointer.value)
        require(words[0] == 0xFEEF04BD, "Debugger fixed version signature differs")
        return ".".join(
            str(part)
            for part in (
                words[2] >> 16,
                words[2] & 0xFFFF,
                words[3] >> 16,
                words[3] & 0xFFFF,
            )
        )


def inspect_tools(output, windows):
    del windows  # Retain the owner call interface; no process or new query handles.
    record = {
        "schemaVersion": 1,
        "classification": "renderer-postmortem-tool-inspection",
        "source": "preinstalled Windows SDK; OS known folders",
        "signatureStatus": "not-collected",
        "executedDebugger": False,
        "candidates": [],
        "selected": None,
        "status": "unavailable",
    }
    observation = {
        "execution": {
            "mode": "in-process native metadata reads",
            "subprocessStarted": False,
        },
        "value": record,
    }
    deadline = time.monotonic() + 20
    try:
        metadata = DebuggerMetadata()
        record["knownFolders"] = metadata.known_folders()
        for architecture, machine in (("x64", 0x8664), ("arm64", 0xAA64)):
            seen = set()
            for folder in record["knownFolders"]:
                if folder["error"] or ntpath.normcase(folder["path"]) in seen:
                    continue
                seen.add(ntpath.normcase(folder["path"]))
                directory = (
                    Path(folder["path"])
                    / "Windows Kits"
                    / "10"
                    / "Debuggers"
                    / architecture
                )
                candidate = {
                    "directory": str(directory),
                    "knownFolder": folder["name"],
                    "architecture": architecture,
                    "status": "unavailable",
                    "files": [],
                    "error": None,
                }
                record["candidates"].append(candidate)
                try:
                    require(
                        time.monotonic() < deadline,
                        "Debugger metadata budget exhausted",
                    )
                    ordinary(directory, True)
                    for name in (
                        "cdb.exe",
                        "dbgeng.dll",
                        "dbghelp.dll",
                        "dbgcore.dll",
                        "dbgmodel.dll",
                    ):
                        require(
                            time.monotonic() < deadline,
                            "Debugger metadata budget exhausted",
                        )
                        path = directory / name
                        row = {
                            "path": str(path),
                            "signatureStatus": "not-collected",
                            "executed": False,
                            "provenance": "preinstalled-windows-sdk",
                            "versionSource": "VS_FIXEDFILEINFO",
                        }
                        candidate["files"].append(row)
                        input_metadata(path, row)
                        reference, data = common.read_file(path, 32 * 1024 * 1024, True)
                        row.update(reference)
                        require(
                            len(data) >= 64 and data[:2] == b"MZ",
                            "Debugger DOS header differs",
                        )
                        pe = int.from_bytes(data[60:64], "little")
                        require(
                            64 <= pe <= len(data) - 24
                            and data[pe : pe + 4] == b"PE\0\0",
                            "Debugger PE header differs",
                        )
                        row["machine"] = int.from_bytes(data[pe + 4 : pe + 6], "little")
                        require(
                            row["machine"] == machine,
                            "Debugger PE architecture differs",
                        )
                        require(
                            time.monotonic() < deadline,
                            "Debugger metadata budget exhausted",
                        )
                        row["version"] = metadata.file_version(path)
                        require(
                            identity(path, 32 * 1024 * 1024) == reference,
                            "Debugger bytes changed during version read",
                        )
                        require(
                            time.monotonic() < deadline,
                            "Debugger metadata budget exhausted",
                        )
                    candidate["status"] = "available"
                    if record["selected"] is None:
                        record["selected"] = {
                            "cdb": candidate["files"][0],
                            "debuggerDlls": candidate["files"][1:],
                            "architecture": architecture,
                        }
                except Exception as error:
                    candidate["error"] = detail(error)
        if record["selected"]:
            record["status"] = "available"
        save(output, record)
        observation["receipt"] = file_tuple(output)
        return observation
    except Exception as error:
        observation["error"] = detail(error)
        error.tool_inspection = observation
        raise


def file_tuple(path):
    value = identity(path)
    return {key: value[key] for key in ("path", "bytes", "sha256")}


def prepare(args, windows):
    nonce = args.nonce
    require(re.fullmatch(r"[0-9a-f]{24}", nonce), "Invalid Personal nonce")
    runtime = Path(args.runtime_root)
    require(
        str(runtime) == r"C:\NemoClawHermesProbe-274d797050ea",
        "Unexpected canonical runtime root",
    )
    root = Path(r"C:\NemoClawRendererPostmortem-" + nonce[:12])
    output = Path(args.output)
    require(
        not root.exists() and not output.exists(),
        "Postmortem root/receipt must be fresh",
    )
    ordinary(output.parent, True)
    receipt = {
        "schemaVersion": 1,
        "classification": "renderer-postmortem-owner",
        "sourceRevision": os.environ["GITHUB_SHA"],
        "nonce": nonce,
        "root": str(root),
        "reportsRoot": str(root / "reports"),
        "dumpsRoot": str(root / "dumps"),
        "appContainerName": "nm-" + nonce[:12] + "-start",
        "status": "failed",
        "ready": False,
        "rootCreated": False,
        "registry": None,
        "primaryError": None,
        "cleanupErrors": [],
        "diagnosticOnly": True,
        "qualified": False,
        "runtimeBytesModified": False,
    }

    def checkpoint(registry=None):
        if registry is not None:
            receipt["registry"] = registry
        save(output, receipt)

    try:
        checkpoint()
        receipt["toolInspection"] = inspect_tools(
            output.with_name(output.stem + "-tools.json"), windows
        )
        tools = receipt["toolInspection"]["value"]
        require(
            tools["status"] == "available" and tools["selected"],
            "No verified preinstalled CDB toolset is available",
        )
        selected = tools["selected"]
        for tool in [selected["cdb"], *selected["debuggerDlls"]]:
            observed = identity(tool["path"])
            require(
                (observed["bytes"], observed["sha256"])
                == (tool["bytes"], tool["sha256"]),
                "Debugger input changed",
            )
            require(
                tool["signatureStatus"] == "not-collected"
                and tool["provenance"] == "preinstalled-windows-sdk"
                and tool["executed"] is False,
                "Debugger preinstalled-tool provenance differs",
            )
        inventory, rows, _ = common.selected_inventory(args.inventory)
        receipt["baseInventory"] = inventory
        chrome = runtime / "browsers/chromium-1234/chrome-win64/chrome.exe"
        expected = next(row for row in rows if row["relative"] == "chrome.exe")
        chrome_id = {**file_tuple(chrome), **windows.file_id(chrome)}
        require(
            (chrome_id["bytes"], chrome_id["sha256"])
            == (expected["bytes"], expected["sha256"])
            and chrome_id["sha256"] == CHROME_SHA,
            "Canonical Chrome identity differs",
        )
        python = file_tuple(args.python)
        require(
            python["sha256"] == PYTHON_SHA
            and identity(sys.executable)["sha256"] == PYTHON_SHA,
            "Expected the pinned ARM64 controller Python",
        )
        gate = Path(args.gate)
        require(
            gate.name == "renderer-aedebug-gate.py",
            "Unexpected postmortem gate basename",
        )
        root.mkdir()
        receipt["rootCreated"] = True
        receipt["rootIdentity"] = windows.file_id(root, True)
        checkpoint()
        for name in ("reports", "dumps"):
            (root / name).mkdir()
        staged = {}
        for name, source in (
            (gate.name, gate),
            (
                "probe-host-browser.py",
                Path(__file__).with_name("probe-host-browser.py"),
            ),
            (
                "parse-chrome-minidump.py",
                Path(__file__).with_name("parse-chrome-minidump.py"),
            ),
        ):
            reference = file_tuple(source)
            common.copy_file(source, root / name, reference)
            staged[name] = file_tuple(root / name)
        receipt["stagedFiles"] = staged
        receipt["chromeIdentity"] = chrome_id
        receipt["derivedAppContainerSid"] = appcontainer_sid(
            receipt["appContainerName"], windows
        )
        config = {
            "schemaVersion": 1,
            "classification": "renderer-postmortem-gate-config",
            "sourceRevision": receipt["sourceRevision"],
            "nonce": nonce[:12],
            "root": str(root),
            "deadlineMs": 20000,
            "chromeIdentity": chrome_id,
            "expectedAppContainerSid": receipt["derivedAppContainerSid"],
            "pythonIdentity": python,
            "cdbIdentity": {
                key: selected["cdb"][key]
                for key in ("path", "bytes", "sha256", "machine")
            },
            "debuggerDllIdentities": selected["debuggerDlls"],
            "ownerIdentity": staged["probe-host-browser.py"],
            "gateIdentity": staged[gate.name],
            "parserIdentity": staged["parse-chrome-minidump.py"],
            "reportsRoot": receipt["reportsRoot"],
            "dumpsRoot": receipt["dumpsRoot"],
        }
        save(root / "gate-config.json", config)
        receipt["config"] = file_tuple(root / "gate-config.json")
        command = [
            python["path"],
            "-I",
            "-B",
            str(root / gate.name),
            "--config",
            str(root / "gate-config.json"),
            "--config-sha256",
            receipt["config"]["sha256"],
            "--pid",
            "%ld",
            "--event-handle",
            "%ld",
            "--jit-info",
            "0x%p",
        ]
        require(
            all("%" not in part for part in command[:-6]),
            "Unexpected format character in owned debugger paths",
        )
        receipt["debuggerCommand"] = subprocess.list2cmdline(command)
        checkpoint()
        receipt["registry"] = load("renderer-aedebug-registry.py").prepare(
            receipt["debuggerCommand"], checkpoint=checkpoint
        )
        require(
            not windows.close_errors, "Postmortem preparation handles did not close"
        )
        receipt.update(status="prepared", ready=True)
    except Exception as error:
        receipt["primaryError"] = detail(error)
        if hasattr(error, "tool_inspection"):
            receipt["toolInspection"] = error.tool_inspection
        if hasattr(error, "renderer_aedebug_receipt"):
            receipt["registry"] = error.renderer_aedebug_receipt
    finally:
        receipt["cleanupErrors"].extend(windows.close_errors)
        try:
            checkpoint()
        except Exception as error:
            receipt["receiptWriteError"] = detail(error)
            receipt["ready"] = False
    return receipt


def load_owner(args, windows):
    reference, receipt = read_json(args.owner, 1024 * 1024)
    require(
        reference["sha256"] == args.owner_sha256
        and receipt["schemaVersion"] == 1
        and receipt["classification"] == "renderer-postmortem-owner"
        and receipt["sourceRevision"] == os.environ["GITHUB_SHA"]
        and re.fullmatch(r"[a-f0-9]{24}", receipt["nonce"]),
        "Owner receipt identity differs",
    )
    root = Path(r"C:\NemoClawRendererPostmortem-" + receipt["nonce"][:12])
    require(
        receipt["root"] == str(root)
        and receipt["reportsRoot"] == str(root / "reports")
        and receipt["dumpsRoot"] == str(root / "dumps"),
        "Owner paths differ",
    )
    if receipt["rootCreated"]:
        require(
            windows.file_id(root, True) == receipt["rootIdentity"],
            "Postmortem root identity changed",
        )
    if receipt.get("config"):
        require(
            file_tuple(root / "gate-config.json") == receipt["config"],
            "Immutable gate config changed",
        )
    return receipt


def read_reports(receipt):
    result = {
        "schemaVersion": 1,
        "classification": "renderer-postmortem-reports",
        "nonce": receipt["nonce"],
        "reports": [],
        "hosts": [],
        "gates": [],
        "claims": [],
        "errors": [],
        "complete": False,
    }
    try:
        root = Path(receipt["reportsRoot"])
        ordinary(root, True)
        entries = list(root.iterdir())
        require(len(entries) <= 64, "Postmortem report count exceeded its bound")
        for file in sorted(entries):
            require(
                re.fullmatch(
                    r"(?:host-[0-9]+-[0-9]+|gate-[0-9]+-[0-9]+|capture-slot-[0-3])\.json",
                    file.name,
                ),
                "Unexpected postmortem report name",
            )
            reference, value = read_json(file, REPORT_LIMIT)
            record = {"identity": reference, "value": value}
            result["reports"].append(record)
            require(
                value.get("sourceRevision") == receipt["sourceRevision"]
                and value.get("nonce") == receipt["nonce"][:12],
                "Postmortem report source/nonce differs",
            )
            require(value.get("schemaVersion") == 1, "Postmortem report schema differs")
            host = value["host"]
            require(
                type(host["pid"]) is int
                and 0 < host["pid"] < 2**32
                and re.fullmatch(r"[0-9]{1,20}", host["creationFiletime"]),
                "Invalid gate host generation",
            )
            kind = value.get("classification")
            if kind != "renderer-postmortem-capture-claim":
                require(
                    value.get("configSha256") == receipt["config"]["sha256"],
                    "Gate config binding differs",
                )
                prefix = "host" if kind == "renderer-postmortem-gate-host" else "gate"
                require(
                    file.name
                    == f"{prefix}-{host['pid']}-{host['creationFiletime']}.json",
                    "Gate filename/generation differs",
                )
            else:
                require(
                    type(value.get("slot")) is int
                    and 0 <= value["slot"] < 4
                    and file.name == f"capture-slot-{value['slot']}.json"
                    and value.get("rendererAdmissionComplete") is True,
                    "Capture claim identity differs",
                )
            if kind == "renderer-postmortem-gate-host":
                result["hosts"].append(record)
            elif kind == "renderer-postmortem-gate":
                result["gates"].append(record)
            elif kind == "renderer-postmortem-capture-claim":
                result["claims"].append(record)
            else:
                raise ValueError("Unexpected postmortem report classification")
        result["complete"] = True
    except Exception as error:
        result["errors"].append(detail(error))
    return result


def host_closed(windows, host, expected_image, deadline):
    pid, created = host["pid"], host["creationFiletime"]
    require(
        type(pid) is int
        and 0 < pid < 2**32
        and re.fullmatch(r"[0-9]{1,20}", created)
        and ntpath.normcase(host["image"]) == ntpath.normcase(expected_image),
        "Reported gate host identity differs",
    )
    result = {
        "pid": pid,
        "creationFiletime": created,
        "image": host["image"],
        "closed": False,
        "handleClosed": True,
        "error": None,
    }
    if time.monotonic() >= deadline:
        result["error"] = {"message": "Gate host closure budget exhausted"}
        return result
    handle = windows.k.OpenProcess(0x00101000, False, pid)
    if not handle:
        error = c.get_last_error()
        result.update(openError=error, absent=error == 87, closed=error == 87)
        return result
    result["handleClosed"] = False
    try:
        times = [c.c_uint64() for _ in range(4)]
        if not windows.k.GetProcessTimes(handle, *(c.byref(value) for value in times)):
            raise c.WinError(c.get_last_error())
        if str(times[0].value) != created:
            result.update(closed=True, pidReused=True)
            return result
        buffer, count = c.create_unicode_buffer(32768), c.c_uint32(32768)
        if not windows.k.QueryFullProcessImageNameW(handle, 0, buffer, c.byref(count)):
            raise c.WinError(c.get_last_error())
        require(
            ntpath.normcase(buffer.value) == ntpath.normcase(expected_image),
            "Actual gate host image differs",
        )
        wait = windows.k.WaitForSingleObject(
            handle, max(0, int((deadline - time.monotonic()) * 1000))
        )
        require(wait in (0, 258), "Gate host wait failed")
        result.update(waitResult=wait, closed=wait == 0)
    except Exception as error:
        result["error"] = detail(error)
    finally:
        count = len(windows.close_errors)
        windows.close(handle)
        result["handleClosed"] = len(windows.close_errors) == count
    return result


def cleanup(args, receipt, windows):
    result = {
        "schemaVersion": 1,
        "classification": "renderer-postmortem-cleanup",
        "nonce": receipt["nonce"],
        "cleanupComplete": False,
        "registryRestored": False,
        "hostsClosed": False,
        "rootRemoved": False,
        "rootRetained": receipt["rootCreated"],
        "hostObservations": [],
        "dumpObservations": [],
        "errors": [],
    }
    if not (args.executor_closed or args.executor_not_started):
        result["errors"] = [
            {"message": "Executor closure unconfirmed; resources retained"},
            *windows.close_errors,
        ]
        return result
    reports = None
    try:
        reports = (
            read_reports(receipt) if Path(receipt["reportsRoot"]).exists() else None
        )
        result["initialReports"] = reports
        if args.executor_not_started:
            result["hostsClosed"] = (
                reports is None or reports["complete"] and not reports["reports"]
            )
        elif reports and reports["complete"]:
            config = read_json(receipt["config"]["path"], 32768)[1]
            hosts = {
                (r["value"]["host"]["pid"], r["value"]["host"]["creationFiletime"]): r[
                    "value"
                ]["host"]
                for r in reports["hosts"]
            }
            require(
                hosts,
                "No gate host record after executor execution; host closure remains unproved",
            )
            deadline = time.monotonic() + 5
            result["hostObservations"] = [
                host_closed(windows, host, config["pythonIdentity"]["path"], deadline)
                for host in hosts.values()
            ]
            result["hostsClosed"] = all(
                x["closed"] and x["handleClosed"] and not x["error"]
                for x in result["hostObservations"]
            )
            if result["hostsClosed"]:
                reports = read_reports(receipt)
                result["finalReports"] = reports
                final_hosts = {
                    (r["value"]["host"]["pid"], r["value"]["host"]["creationFiletime"])
                    for r in reports["hosts"]
                }
                require(
                    reports["complete"] and final_hosts == set(hosts),
                    "Postmortem hosts changed during closure",
                )
                finals = {
                    (
                        r["value"]["host"]["pid"],
                        r["value"]["host"]["creationFiletime"],
                    ): r["value"]
                    for r in reports["gates"]
                }
                require(
                    set(finals) == set(hosts),
                    "An observed gate did not publish its final ownership receipt",
                )
                claim_hosts = {
                    (r["value"]["host"]["pid"], r["value"]["host"]["creationFiletime"])
                    for r in reports["claims"]
                }
                require(
                    claim_hosts <= set(hosts),
                    "Capture claim lacks its host generation receipt",
                )
                for gate in finals.values():
                    require(
                        not gate.get("cleanupErrors"), "Gate reported cleanup errors"
                    )
                    require(
                        gate.get("eventHandleClosed") is True
                        and gate.get("ownedHandlesClosed") is True,
                        "Gate handles did not close",
                    )
                    debugger = gate.get("cdb")
                    if debugger is not None:
                        require(
                            debugger.get("childrenClosed") is True
                            and debugger.get("childClosed") is True
                            and debugger.get("handlesClosed") is True
                            and debugger.get("captureClosed") is True
                            and debugger.get("jobActiveAfterCleanup") == 0
                            and not debugger.get("cleanupErrors"),
                            "CDB held-process/job/capture closure unproved",
                        )
    except Exception as error:
        result["hostsClosed"] = False
        result["errors"].append(detail(error))
    finally:
        try:
            restoration = (
                load("renderer-aedebug-registry.py").cleanup(receipt["registry"])
                if receipt.get("registry")
                else {"passed": True}
            )
            result["registry"] = restoration
            result["registryRestored"] = restoration["passed"]
        except Exception as error:
            result["errors"].append(detail(error))
    try:
        require(
            result["hostsClosed"]
            and result["registryRestored"]
            and not windows.close_errors
            and not receipt["cleanupErrors"],
            "Postmortem ownership incomplete; root retained",
        )
        root = Path(receipt["root"])
        if receipt["rootCreated"]:
            config = (
                read_json(receipt["config"]["path"], 32768)[1]
                if receipt.get("config")
                else None
            )
            expected_files = {
                "gate-config.json",
                "renderer-aedebug-gate.py",
                "probe-host-browser.py",
                "parse-chrome-minidump.py",
            }
            report_names = (
                {Path(r["identity"]["path"]).name for r in reports["reports"]}
                if reports
                else set()
            )
            dump_files = (
                list((root / "dumps").iterdir()) if (root / "dumps").exists() else []
            )
            require(len(dump_files) <= 64, "Unexpected dump count")
            # Authenticate staged executable Python bytes before loading the bounded parser.
            if config:
                require(
                    file_tuple(root / "gate-config.json") == receipt["config"],
                    "Gate configuration changed",
                )
                for reference in receipt["stagedFiles"].values():
                    require(
                        file_tuple(reference["path"]) == reference,
                        "Staged postmortem input changed",
                    )
            known_dumps = {}
            for row in reports["gates"] if reports else []:
                gate = row["value"]
                if not gate.get("dumps"):
                    continue
                target = gate["target"]
                prefix = (
                    root
                    / "dumps"
                    / f"renderer-{target['pid']}-{target['creationFiletime']}"
                )
                require(
                    gate["dumpPrefix"] == str(prefix),
                    "Dump prefix differs from admitted renderer",
                )
                require(
                    gate.get("admitted") is True and len(gate["dumps"]) <= 1,
                    "Dump does not have bounded renderer admission",
                )
                for dump in gate["dumps"]:
                    name = dump["name"]
                    suffix = name[len(prefix.name) :]
                    require(
                        Path(name).name == name
                        and name.startswith(prefix.name)
                        and (
                            suffix.lower() == ".dmp"
                            or re.fullmatch(r"_[A-Za-z0-9_.-]+\.dmp", suffix)
                        )
                        and name not in known_dumps,
                        "Unexpected dump filename",
                    )
                    known_dumps[name] = dump
            require(
                len(known_dumps) <= 4
                and {file.name for file in dump_files} == set(known_dumps),
                "Unreported postmortem dump remains",
            )
            parser = (
                load("parse-chrome-minidump.py", config["parserIdentity"]["path"])
                if dump_files and config
                else None
            )
            parse_deadline = time.monotonic() + 2
            for file in dump_files:
                observed = ordinary(file)
                require(
                    observed.st_size == known_dumps[file.name]["bytes"],
                    "Reported dump size changed",
                )
                observation = {
                    "file": file.name,
                    "bytes": observed.st_size,
                    "rawUploadAllowed": False,
                }
                try:
                    observation["parsed"] = parser.parse_minidump(
                        file, deadline=parse_deadline
                    )
                except Exception as error:
                    observation["error"] = detail(error)
                result["dumpObservations"].append(observation)
            for file in root.iterdir():
                if file.name in ("reports", "dumps"):
                    ordinary(file, True)
                else:
                    ordinary(file)
                    require(
                        file.name in expected_files,
                        "Unexpected object in postmortem root",
                    )
            if (root / "reports").exists():
                for file in (root / "reports").iterdir():
                    ordinary(file)
                    require(
                        file.name in report_names, "Unexpected late postmortem record"
                    )
            # Save sanitized evidence before removing any raw dump or gate report.
            save(Path(args.output), result)
            for directory in (root / "reports", root / "dumps"):
                if directory.exists():
                    for file in directory.iterdir():
                        file.unlink()
                    directory.rmdir()
            for file in root.iterdir():
                file.unlink()
            root.rmdir()
        result.update(rootRemoved=True, rootRetained=False)
    except Exception as error:
        result["errors"].append(detail(error))
    result["errors"].extend(windows.close_errors)
    result["cleanupComplete"] = (
        result["hostsClosed"]
        and result["registryRestored"]
        and result["rootRemoved"]
        and not result["errors"]
    )
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    prepare_parser = modes.add_parser("prepare")
    for name in ("runtime-root", "inventory", "nonce", "python", "gate", "output"):
        prepare_parser.add_argument("--" + name, required=True)
    for mode in ("readreports", "cleanup"):
        sub = modes.add_parser(mode)
        for name in ("owner", "owner-sha256", "output"):
            sub.add_argument("--" + name, required=True)
        if mode == "cleanup":
            group = sub.add_mutually_exclusive_group()
            group.add_argument("--executor-closed", action="store_true")
            group.add_argument("--executor-not-started", action="store_true")
    args = parser.parse_args()
    require(
        os.name == "nt"
        and os.environ.get("GITHUB_ACTIONS") == "true"
        and re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", "")),
        "Disposable same-source Windows CI required",
    )
    windows = common.Windows()
    if args.mode == "prepare":
        result = prepare(args, windows)
        passed = result["ready"]
    else:
        require(not Path(args.output).exists(), "Postmortem output must be fresh")
        receipt = load_owner(args, windows)
        result = (
            read_reports(receipt)
            if args.mode == "readreports"
            else cleanup(args, receipt, windows)
        )
        result["errors"].extend(windows.close_errors)
        passed = (
            result.get("complete", result.get("cleanupComplete", False))
            and not result["errors"]
        )
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
                "ready": result.get("ready"),
                "cleanupComplete": result.get("cleanupComplete"),
                "primaryError": result.get("primaryError"),
                "errors": result.get("errors"),
                "receiptWriteError": result.get("receiptWriteError"),
            }
        )
    )
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
