# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Own one clone-specific WER allowlist value; never change global WER settings."""
import copy
import os
import re

PARENT = r"Software\Microsoft\Windows"
KEYS = (PARENT + r"\Windows Error Reporting", PARENT + r"\Windows Error Reporting\RuntimeExceptionHelperModules")
CLASSIFICATION = "owned-renderer-wer-registry"
WRITTEN = {"exists": True, "type": 4, "value": 0}


class _WindowsRegistry:
    def __init__(self):
        if os.name != "nt":
            raise OSError("WER registry ownership requires Windows")
        import ctypes
        import winreg
        self.wr, self.ct = winreg, ctypes
        self.access = winreg.KEY_READ | winreg.KEY_WRITE | winreg.KEY_WOW64_64KEY
        self.create_key = ctypes.WinDLL("advapi32", use_last_error=True).RegCreateKeyExW
        self.create_key.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_wchar_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), ctypes.POINTER(ctypes.c_uint32)]
        self.create_key.restype = ctypes.c_long

    def open(self, path):
        return self.wr.OpenKey(self.wr.HKEY_CURRENT_USER, path, 0, self.access)

    def create(self, parent, name):
        handle, disposition = self.ct.c_void_p(), self.ct.c_uint32()
        status = self.create_key(int(parent), name, 0, None, 0, self.access, None, self.ct.byref(handle), self.ct.byref(disposition))
        if status:
            raise self.ct.WinError(status)
        return handle.value, disposition.value == 1

    def read(self, handle, name):
        try:
            value, kind = self.wr.QueryValueEx(handle, name)
            return {"exists": True, "type": kind, "value": value if kind == 4 else None}
        except FileNotFoundError:
            return {"exists": False}

    def write(self, handle, name):
        self.wr.SetValueEx(handle, name, 0, self.wr.REG_DWORD, 0)

    def delete_value(self, handle, name):
        self.wr.DeleteValue(handle, name)

    def key_info(self, handle):
        return self.wr.QueryInfoKey(handle)[:2]

    def delete_key(self, path):
        self.wr.DeleteKeyEx(self.wr.HKEY_CURRENT_USER, path, self.wr.KEY_WOW64_64KEY, 0)

    def close(self, handle):
        self.wr.CloseKey(handle)


def _name(value):
    if not isinstance(value, str) or not re.fullmatch(r"[A-Za-z]:\\NemoClawRendererWer-[0-9a-f]{12}\\chrome-win64\\chrome_wer\.dll", value):
        raise ValueError("WER allowlist value is not an exact owned clone DLL path")
    return value


def _close(registry, handles, errors):
    for handle in reversed(handles):
        try:
            registry.close(handle)
        except Exception as error:
            errors.append(str(error))


def prepare(value_name, *, checkpoint=None, registry=None):
    """Checkpoint JSON snapshots; partial errors carry renderer_wer_receipt."""
    name = _name(value_name)
    registry = registry if registry is not None else _WindowsRegistry()
    receipt = {"schemaVersion": 1, "classification": CLASSIFICATION, "valueName": name, "view": "64", "createdKeys": [], "before": None, "after": None, "writeIntent": False, "valueWritten": False, "closeErrors": [], "checkpointErrors": [], "status": "preparing"}
    handles, primary = [], None

    def save(stage):
        receipt["stage"] = stage
        if checkpoint is not None:
            checkpoint(copy.deepcopy(receipt))

    try:
        parent = registry.open(PARENT)
        handles.append(parent)
        try:
            existing = registry.open(KEYS[-1])
        except FileNotFoundError:
            receipt["before"] = {"exists": False}
        else:
            handles.append(existing)
            receipt["before"] = registry.read(existing, name)
        save("before")
        if receipt["before"]["exists"]:
            raise FileExistsError("The exact WER allowlist value already exists")
        for path in KEYS:
            receipt["pendingKey"] = path
            save("key-create-intent")
            parent, created = registry.create(parent, path.rsplit("\\", 1)[1])
            handles.append(parent)
            if created:
                receipt["createdKeys"].append(path)
            save("key-created")
        receipt["writeIntent"] = True
        save("write-intent")
        if registry.read(parent, name)["exists"]:
            raise FileExistsError("The exact WER allowlist value appeared during checkpoint")
        registry.write(parent, name)
        receipt["valueWritten"] = True
        receipt["after"] = registry.read(parent, name)
        if receipt["after"] != WRITTEN:
            raise RuntimeError("WER allowlist readback differs from the owned DWORD")
        receipt["status"] = "prepared"
    except Exception as error:
        primary = error
    finally:
        _close(registry, handles, receipt["closeErrors"])
        if primary is None and receipt["closeErrors"]:
            primary = RuntimeError("WER registry handle closure failed")
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
        primary.renderer_wer_receipt = receipt
        raise primary
    return receipt


def cleanup(receipt, *, registry=None):
    """Return secondary cleanup errors; leave changed/unowned values untouched."""
    result = {"valueStatus": "not-owned", "keys": [], "closeErrors": [], "errors": [], "passed": False}
    handles, created, admitted = [], [], False
    try:
        name = _name(receipt["valueName"])
        created = receipt["createdKeys"]
        if receipt.get("schemaVersion") != 1 or receipt.get("classification") != CLASSIFICATION or receipt.get("view") != "64" or not isinstance(created, list) or len(created) != len(set(created)) or any(path not in KEYS for path in created) or type(receipt.get("writeIntent")) is not bool or type(receipt.get("valueWritten")) is not bool or (receipt["valueWritten"] and not receipt["writeIntent"]):
            raise ValueError("Invalid WER mutation ownership receipt")
        admitted = True
        if receipt.get("stage") == "key-create-intent":
            result["errors"].append("WER key creation outcome is unconfirmed")
        if receipt.get("closeErrors"):
            result["errors"].append("Preparation registry handles did not all close")
        registry = registry if registry is not None else _WindowsRegistry()
        try:
            target = registry.open(KEYS[-1])
        except FileNotFoundError:
            result["valueStatus"] = "absent"
        else:
            handles.append(target)
            observed = registry.read(target, name)
            if not observed["exists"]:
                result["valueStatus"] = "absent"
            elif receipt.get("valueWritten") is True:
                if observed != WRITTEN:
                    raise RuntimeError("WER allowlist value changed; it was retained")
                try:
                    registry.delete_value(target, name)
                except FileNotFoundError:
                    pass
                if registry.read(target, name)["exists"]:
                    raise RuntimeError("WER allowlist value remains after deletion")
                result["valueStatus"] = "deleted"
            elif receipt.get("writeIntent") is True:
                raise RuntimeError("WER write outcome is unconfirmed; value was retained")
    except Exception as error:
        result["errors"].append(str(error))
    finally:
        _close(registry, handles, result["closeErrors"])
    for path in reversed(created if admitted and registry is not None else []):
        row = {"path": path, "status": "retained"}
        key_handles, close_errors = [], []
        try:
            handle = registry.open(path)
            key_handles.append(handle)
            empty = registry.key_info(handle) == (0, 0)
            _close(registry, key_handles, close_errors)
            key_handles.clear()
            if not close_errors and empty:
                registry.delete_key(path)
                row["status"] = "removed"
            elif not empty:
                row["status"] = "retained-nonempty"
        except FileNotFoundError:
            row["status"] = "absent"
        except Exception as error:
            result["errors"].append(str(error))
        finally:
            _close(registry, key_handles, close_errors)
            result["closeErrors"].extend(close_errors)
        result["keys"].append(row)
    result["passed"] = not result["errors"] and not result["closeErrors"]
    return result
