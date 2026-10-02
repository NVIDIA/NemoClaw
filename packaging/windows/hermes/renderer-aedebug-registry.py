# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Temporarily own two HKLM64 AeDebug values; the caller binds the fixed command."""

import copy
import os
import re

PARENT = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion"
KEY = PARENT + r"\AeDebug"
NAMES = ("Debugger", "Auto")
CLASSIFICATION = "owned-renderer-aedebug-registry"
MAX_VALUE_BYTES = 32768


def _snapshot(value):
    if (
        isinstance(value, dict)
        and value.get("exists") is False
        and set(value) == {"exists"}
    ):
        return dict(value)
    if (
        not isinstance(value, dict)
        or set(value) != {"exists", "type", "dataHex"}
        or value["exists"] is not True
        or type(value["type"]) is not int
        or not 0 <= value["type"] <= 0xFFFFFFFF
        or not isinstance(value["dataHex"], str)
        or len(value["dataHex"]) > MAX_VALUE_BYTES * 2
        or len(value["dataHex"]) % 2
        or not re.fullmatch(r"[0-9a-f]*", value["dataHex"])
    ):
        raise ValueError("Invalid bounded raw AeDebug value snapshot")
    return dict(value)


def _values(command):
    if (
        not isinstance(command, str)
        or not 1 <= len(command) <= 8192
        or any(not 32 <= ord(char) <= 126 for char in command)
    ):
        raise ValueError("The fixed debugger command must be bounded printable ASCII")
    return {
        name: {
            "exists": True,
            "type": 1,
            "dataHex": (text + "\0").encode("utf-16-le").hex(),
        }
        for name, text in (("Debugger", command), ("Auto", "1"))
    }


class _WindowsRegistry:
    def __init__(self):
        if os.name != "nt":
            raise OSError("AeDebug ownership requires Windows")
        import ctypes
        import winreg

        self.wr, self.c = winreg, ctypes
        self.access = winreg.KEY_READ | winreg.KEY_WRITE | winreg.KEY_WOW64_64KEY
        dll = ctypes.WinDLL("advapi32", use_last_error=True)
        ptr, word, text = ctypes.c_void_p, ctypes.c_uint32, ctypes.c_wchar_p
        self.create_key, self.query, self.set_value = (
            dll.RegCreateKeyExW,
            dll.RegQueryValueExW,
            dll.RegSetValueExW,
        )
        self.create_key.argtypes = [
            ptr,
            text,
            word,
            text,
            word,
            word,
            ptr,
            ctypes.POINTER(ptr),
            ctypes.POINTER(word),
        ]
        self.query.argtypes = [
            ptr,
            text,
            ptr,
            ctypes.POINTER(word),
            ptr,
            ctypes.POINTER(word),
        ]
        self.set_value.argtypes = [ptr, text, word, word, ptr, word]
        for function in (self.create_key, self.query, self.set_value):
            function.restype = ctypes.c_long

    def open(self, path):
        return self.wr.OpenKey(self.wr.HKEY_LOCAL_MACHINE, path, 0, self.access)

    def create(self, parent):
        handle, disposition = self.c.c_void_p(), self.c.c_uint32()
        status = self.create_key(
            int(parent),
            "AeDebug",
            0,
            None,
            0,
            self.access,
            None,
            self.c.byref(handle),
            self.c.byref(disposition),
        )
        if status:
            raise self.c.WinError(status)
        return handle.value, disposition.value == 1

    def read(self, handle, name):
        kind, size = self.c.c_uint32(), self.c.c_uint32()
        status = self.query(
            int(handle), name, None, self.c.byref(kind), None, self.c.byref(size)
        )
        if status == 2:
            return {"exists": False}
        if status:
            raise self.c.WinError(status)
        if size.value > MAX_VALUE_BYTES:
            raise ValueError("Prior AeDebug value exceeds 32 KiB")
        buffer = self.c.create_string_buffer(max(1, size.value))
        available = size.value
        status = self.query(
            int(handle), name, None, self.c.byref(kind), buffer, self.c.byref(size)
        )
        if status == 2:
            return {"exists": False}
        if status:
            raise self.c.WinError(status)
        if size.value > available:
            raise ValueError("AeDebug value grew while reading")
        return {
            "exists": True,
            "type": kind.value,
            "dataHex": buffer.raw[: size.value].hex(),
        }

    def write(self, handle, name, value):
        raw = bytes.fromhex(_snapshot(value)["dataHex"])
        buffer = self.c.create_string_buffer(raw, max(1, len(raw)))
        status = self.set_value(int(handle), name, 0, value["type"], buffer, len(raw))
        if status:
            raise self.c.WinError(status)

    def delete_value(self, handle, name):
        self.wr.DeleteValue(handle, name)

    def key_info(self, handle):
        return self.wr.QueryInfoKey(handle)[:2]

    def delete_key(self):
        self.wr.DeleteKeyEx(self.wr.HKEY_LOCAL_MACHINE, KEY, self.wr.KEY_WOW64_64KEY, 0)

    def close(self, handle):
        self.wr.CloseKey(handle)


def _close(registry, handles, errors):
    for handle in reversed(handles):
        try:
            registry.close(handle)
        except Exception as error:
            errors.append(str(error))


def prepare(debugger_command, checkpoint=None, registry=None):
    """Checkpoint mutation ownership; errors carry renderer_aedebug_receipt."""
    values = _values(debugger_command)
    registry = registry if registry is not None else _WindowsRegistry()
    receipt = {
        "schemaVersion": 1,
        "classification": CLASSIFICATION,
        "hive": "HKLM",
        "view": "64",
        "key": KEY,
        "debuggerCommand": debugger_command,
        "keyCreateIntent": False,
        "keyCreationConfirmed": False,
        "createdKey": False,
        "values": {
            name: {
                "before": None,
                "written": value,
                "writeIntent": False,
                "writeConfirmed": False,
                "after": None,
            }
            for name, value in values.items()
        },
        "status": "preparing",
        "closeErrors": [],
        "checkpointErrors": [],
    }
    handles, primary = [], None

    def save(stage):
        receipt["stage"] = stage
        if checkpoint is not None:
            checkpoint(copy.deepcopy(receipt))

    try:
        parent = registry.open(PARENT)
        handles.append(parent)
        receipt["keyCreateIntent"] = True
        save("key-create-intent")
        key, created = registry.create(parent)
        handles.append(key)
        receipt.update(keyCreationConfirmed=True, createdKey=created)
        save("key-created")
        for name in NAMES:
            receipt["values"][name]["before"] = _snapshot(registry.read(key, name))
        save("before")
        for name in NAMES:
            row = receipt["values"][name]
            receipt["activeValue"] = name
            row["writeIntent"] = True
            save("value-write-intent")
            if _snapshot(registry.read(key, name)) != row["before"]:
                raise RuntimeError(
                    "AeDebug value changed before the owned write: " + name
                )
            registry.write(key, name, row["written"])
            row["writeConfirmed"] = True
            row["after"] = _snapshot(registry.read(key, name))
            if row["after"] != row["written"]:
                raise RuntimeError("AeDebug owned write readback differs: " + name)
            save("value-written")
        receipt["status"] = "prepared"
    except Exception as error:
        primary = error
    finally:
        _close(registry, handles, receipt["closeErrors"])
        if primary is None and receipt["closeErrors"]:
            primary = RuntimeError("AeDebug preparation handles did not close")
        if primary is not None:
            receipt.update(status="failed", error=str(primary))
        try:
            save("after")
        except Exception as error:
            receipt["checkpointErrors"].append(str(error))
            if primary is None:
                primary = error
    if primary is not None:
        receipt.update(status="failed", error=str(primary))
        primary.renderer_aedebug_receipt = receipt
        raise primary
    return receipt


def cleanup(receipt, registry=None):
    """Restore each confirmed value independently; ambiguous values are retained."""
    result = {
        "values": {},
        "keyStatus": "retained",
        "errors": [],
        "closeErrors": [],
        "passed": False,
    }
    handles, admitted, empty = [], False, False
    try:
        if (
            not isinstance(receipt, dict)
            or receipt.get("schemaVersion") != 1
            or receipt.get("classification") != CLASSIFICATION
            or receipt.get("hive") != "HKLM"
            or receipt.get("view") != "64"
            or receipt.get("key") != KEY
            or not isinstance(receipt.get("values"), dict)
            or set(receipt["values"]) != set(NAMES)
            or any(
                type(receipt.get(field)) is not bool
                for field in ("keyCreateIntent", "keyCreationConfirmed", "createdKey")
            )
            or (receipt["createdKey"] and not receipt["keyCreationConfirmed"])
            or (receipt["keyCreationConfirmed"] and not receipt["keyCreateIntent"])
        ):
            raise ValueError("Invalid AeDebug ownership receipt")
        expected = _values(receipt["debuggerCommand"])
        admitted = True
        if receipt.get("closeErrors"):
            result["errors"].append("Preparation handle closure remains unresolved")
        if receipt["keyCreateIntent"] and not receipt["keyCreationConfirmed"]:
            result["errors"].append("AeDebug key creation outcome is unconfirmed")
        registry = registry if registry is not None else _WindowsRegistry()
        try:
            key = registry.open(KEY)
        except FileNotFoundError:
            key = None
            result["keyStatus"] = "absent"
        else:
            handles.append(key)
        for name in NAMES:
            row = {"status": "retained", "error": None}
            result["values"][name] = row
            try:
                ownership = receipt["values"][name]
                if (
                    not isinstance(ownership, dict)
                    or ownership.get("written") != expected[name]
                    or any(
                        type(ownership.get(field)) is not bool
                        for field in ("writeIntent", "writeConfirmed")
                    )
                    or (
                        ownership["writeConfirmed"]
                        and (
                            not ownership["writeIntent"]
                            or not receipt["keyCreationConfirmed"]
                        )
                    )
                ):
                    raise ValueError("Invalid AeDebug per-value ownership")
                if not ownership["writeIntent"]:
                    row["status"] = "not-written"
                    continue
                if not ownership["writeConfirmed"]:
                    raise RuntimeError("AeDebug write outcome is unconfirmed")
                before = _snapshot(ownership["before"])
                current = (
                    _snapshot(registry.read(key, name))
                    if key is not None
                    else {"exists": False}
                )
                if current == before:
                    row["status"] = "already-restored"
                    continue
                if current != expected[name]:
                    raise RuntimeError("AeDebug value changed; it was retained")
                if before["exists"]:
                    registry.write(key, name, before)
                else:
                    try:
                        registry.delete_value(key, name)
                    except FileNotFoundError:
                        pass
                if _snapshot(registry.read(key, name)) != before:
                    raise RuntimeError("AeDebug restoration readback differs")
                row["status"] = "restored"
            except Exception as error:
                row["error"] = str(error)
                result["errors"].append(name + ": " + str(error))
        if key is not None and receipt["createdKey"]:
            empty = registry.key_info(key) == (0, 0)
            if not empty:
                result["keyStatus"] = "retained-nonempty"
    except Exception as error:
        result["errors"].append(str(error))
    finally:
        _close(registry, handles, result["closeErrors"])
    if (
        admitted
        and registry is not None
        and receipt["createdKey"]
        and empty
        and not result["closeErrors"]
    ):
        try:
            registry.delete_key()
            result["keyStatus"] = "removed"
        except FileNotFoundError:
            result["keyStatus"] = "absent"
        except Exception as error:
            result["errors"].append(str(error))
    result["passed"] = not result["errors"] and not result["closeErrors"]
    return result
