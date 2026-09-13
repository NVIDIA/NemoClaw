# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Prepare one fresh, empty public CI runtime root before verified extraction."""

import ctypes as C
import hashlib
import json
import os
from pathlib import Path
import struct

PUBLIC_ROOT = r"C:\NemoClawHermesProbe-274d797050ea"
APP_PACKAGES_SID = bytes.fromhex("010200000000000f0200000001000000")
RX_MASK = 0x001200A9
RX_ACE = (
    struct.pack("<BBHI", 0, 3, 8 + len(APP_PACKAGES_SID), RX_MASK) + APP_PACKAGES_SID
)


def acl_entries(raw):
    if not 8 <= len(raw) <= 32768:
        raise ValueError("The public runtime DACL exceeds its bound")
    revision, reserved, size, count, reserved2 = struct.unpack_from("<BBHHH", raw)
    if (
        revision not in (2, 4)
        or reserved
        or reserved2
        or size != len(raw)
        or count > 128
    ):
        raise ValueError("The public runtime DACL header is unsupported")
    offset, entries = 8, []
    for _ in range(count):
        if offset + 4 > size:
            raise ValueError("The public runtime DACL is truncated")
        length = struct.unpack_from("<H", raw, offset + 2)[0]
        if length < 4 or length % 4 or offset + length > size:
            raise ValueError("The public runtime ACE is truncated")
        entries.append(raw[offset : offset + length])
        offset += length
    return revision, entries


def append_public_rx(raw):
    """Insert one explicit Allow before inherited ACEs; preserve existing ACEs."""
    revision, entries = acl_entries(raw)
    # This fixed preparation expects the observed missing prerequisite. Do not
    # merge or replace an existing grant, denial, or unfamiliar SID ACE shape.
    if any(APP_PACKAGES_SID in entry[4:] for entry in entries):
        raise ValueError("The empty runtime already has an AppPackages ACE")
    inherited = next(
        (i for i, ace in enumerate(entries) if ace[1] & 0x10), len(entries)
    )
    if any(not ace[1] & 0x10 for ace in entries[inherited:]):
        raise ValueError("The empty runtime DACL interleaves explicit/inherited ACEs")
    updated = entries[:inherited] + [RX_ACE] + entries[inherited:]
    size = 8 + sum(map(len, updated))
    if size > 32768 or len(updated) > 128:
        raise ValueError("The updated public runtime DACL exceeds its bound")
    return struct.pack("<BBHHH", revision, 0, size, len(updated), 0) + b"".join(updated)


def verify_delta(before, after, expected):
    # SetSecurityInfo maintains DEFAULTED/AUTO_INHERIT_REQ/AUTO_INHERITED
    # bookkeeping. Protection and every unrelated control bit must stay exact.
    _, expected_entries = acl_entries(expected)
    if (
        after["acesHex"] != [ace.hex() for ace in expected_entries]
        or any(
            after[key] != before[key]
            for key in ("ownerSidHex", "groupSidHex", "revision")
        )
        or (after["control"] ^ before["control"]) & ~0x0508
    ):
        raise ValueError("Public runtime DACL change exceeded its one-ACE contract")


def prepare(runtime, receipt_file):
    """The extraction owner's callback is the sole caller; no existing tree."""
    if (
        os.name != "nt"
        or os.environ.get("GITHUB_ACTIONS") != "true"
        or str(runtime) != PUBLIC_ROOT
        or runtime.is_symlink()
        or not runtime.is_dir()
        or any(runtime.iterdir())
    ):
        raise ValueError("Public RX preparation requires the fresh empty CI runtime")
    record = {
        "schemaVersion": 1,
        "classification": "fresh-public-runtime-rx-preparation",
        "sourceRevision": os.environ["GITHUB_SHA"],
        "runtimeRoot": str(runtime),
        "emptyBeforeExtraction": True,
        "sourceSha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "status": "failed",
        "stage": "open-empty-root",
        "requestedAccess": "0x00060080 (READ_CONTROL|WRITE_DAC|FILE_READ_ATTRIBUTES)",
        "securityInformationWritten": "DACL_SECURITY_INFORMATION only",
        "addedAce": {
            "sid": "S-1-15-2-1",
            "mask": RX_MASK,
            "flags": 3,
            "hex": RX_ACE.hex(),
        },
        "writeAttempted": False,
        "setSecurityStatus": None,
        "exactDeltaVerified": False,
        "handleClosed": False,
        "error": None,
        "cleanupErrors": [],
    }
    kernel = C.WinDLL("kernel32", use_last_error=True)
    security = C.WinDLL("advapi32", use_last_error=True)
    ptr, dword, word, boolean = C.c_void_p, C.c_uint32, C.c_uint16, C.c_int32
    kernel.CreateFileW.argtypes = [C.c_wchar_p, dword, dword, ptr, dword, dword, ptr]
    kernel.CreateFileW.restype = ptr
    kernel.CloseHandle.argtypes = [ptr]
    kernel.CloseHandle.restype = boolean
    kernel.LocalFree.argtypes = [ptr]
    kernel.LocalFree.restype = ptr
    kernel.GetFileInformationByHandle.argtypes = [ptr, ptr]
    kernel.GetFileInformationByHandle.restype = boolean
    security.GetSecurityInfo.argtypes = [ptr, dword, dword] + [C.POINTER(ptr)] * 5
    security.GetSecurityInfo.restype = dword
    security.SetSecurityInfo.argtypes = [ptr, dword, dword, ptr, ptr, ptr, ptr]
    security.SetSecurityInfo.restype = dword
    security.GetSecurityDescriptorControl.argtypes = [
        ptr,
        C.POINTER(word),
        C.POINTER(dword),
    ]
    security.GetSecurityDescriptorControl.restype = boolean
    security.GetSecurityDescriptorLength.argtypes = [ptr]
    security.GetSecurityDescriptorLength.restype = dword
    security.GetLengthSid.argtypes = [ptr]
    security.GetLengthSid.restype = dword

    def snapshot(handle):
        owner, group, dacl, sacl, descriptor = (ptr() for _ in range(5))
        status = security.GetSecurityInfo(
            handle,
            1,
            7,
            C.byref(owner),
            C.byref(group),
            C.byref(dacl),
            C.byref(sacl),
            C.byref(descriptor),
        )
        if status:
            raise OSError(status, "GetSecurityInfo(public runtime)")
        snapshot_error = None
        try:
            control, revision = word(), dword()
            if not security.GetSecurityDescriptorControl(
                descriptor, C.byref(control), C.byref(revision)
            ):
                raise C.WinError(C.get_last_error())
            if not dacl or not control.value & 4 or not owner or not group:
                raise ValueError(
                    "Public runtime requires a non-NULL DACL, owner and group"
                )
            length = security.GetSecurityDescriptorLength(descriptor)
            if not 20 <= length <= 32768:
                raise ValueError(
                    "The public runtime security descriptor exceeds its bound"
                )
            acl_size = struct.unpack_from("<H", C.string_at(dacl, 8), 2)[0]
            if not 8 <= acl_size <= 32768:
                raise ValueError("The public runtime ACL exceeds its bound")
            raw = C.string_at(dacl, acl_size)
            _, entries = acl_entries(raw)
            sids = []
            for sid in owner, group:
                size = security.GetLengthSid(sid)
                if not 8 <= size <= 68:
                    raise ValueError(
                        "The public runtime owner/group SID exceeds its bound"
                    )
                sids.append(C.string_at(sid, size).hex())
            return {
                "ownerSidHex": sids[0],
                "groupSidHex": sids[1],
                "control": control.value,
                "revision": revision.value,
                "descriptorHex": C.string_at(descriptor, length).hex(),
                "daclHex": raw.hex(),
                "acesHex": [ace.hex() for ace in entries],
            }
        except BaseException as error:
            snapshot_error = error
            raise
        finally:
            if kernel.LocalFree(descriptor):
                code = C.get_last_error()
                detail = {"api": "LocalFree(security descriptor)", "winerror": code}
                record["cleanupErrors"].append(detail)
                if snapshot_error is not None:
                    snapshot_error.add_note(
                        "Security descriptor cleanup also failed: " + repr(detail)
                    )
                else:
                    raise OSError(code, "LocalFree(security descriptor)")

    handle, primary = None, None
    try:
        # Deny directory replacement while holding this exact metadata handle.
        handle = kernel.CreateFileW(str(runtime), 0x60080, 3, None, 3, 0x02200000, None)
        if handle in (None, C.c_void_p(-1).value):
            handle = None
            raise C.WinError(C.get_last_error())
        record["stage"] = "verify-held-empty-root"
        info = C.create_string_buffer(
            52
        )  # BY_HANDLE_FILE_INFORMATION, fixed DWORD layout.
        if not kernel.GetFileInformationByHandle(handle, info):
            raise C.WinError(C.get_last_error())
        attributes = struct.unpack_from("<I", info.raw)[0]
        if attributes & 0x400 or not attributes & 0x10 or any(runtime.iterdir()):
            raise ValueError(
                "The held public runtime is not an empty ordinary directory"
            )
        record["directoryIdentityHex"] = info.raw.hex()
        record["stage"] = "read-before-security"
        before = snapshot(handle)
        record["before"] = before
        expected = append_public_rx(bytes.fromhex(before["daclHex"]))
        buffer = C.create_string_buffer(expected)
        record["stage"] = "set-dacl"
        record["writeAttempted"] = True
        status = security.SetSecurityInfo(handle, 1, 4, None, None, buffer, None)
        record["setSecurityStatus"] = status
        if status:
            raise OSError(status, "SetSecurityInfo(public runtime DACL)")
        record["stage"] = "read-after-security"
        after = snapshot(handle)
        record["after"] = after
        record["controlBitsChanged"] = before["control"] ^ after["control"]
        record["permittedDaclBookkeepingChangeMask"] = 0x0508
        record["stage"] = "verify-exact-delta"
        verify_delta(before, after, expected)
        record["exactDeltaVerified"] = True
        record["status"] = "prepared"
    except BaseException as error:
        primary = error
        record["error"] = repr(error)
    finally:
        if handle is not None:
            record["handleClosed"] = bool(kernel.CloseHandle(handle))
            if not record["handleClosed"]:
                record["cleanupErrors"].append(
                    {"api": "CloseHandle", "winerror": C.get_last_error()}
                )
                record["status"] = "failed"
        try:
            receipt_file.write_text(
                json.dumps(record, indent=2) + "\n", encoding="utf-8"
            )
        except BaseException as receipt_error:
            record["receiptWriteError"] = repr(receipt_error)
            if primary is None:
                raise
            primary.add_note(
                "Public runtime ACL receipt also failed: " + repr(receipt_error)
            )
    if primary:
        raise primary
    if record["cleanupErrors"]:
        raise ValueError("The public runtime ACL owner did not close")
    return record
