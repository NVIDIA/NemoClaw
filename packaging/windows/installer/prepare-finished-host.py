# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Prepare only native host components in Windows CI; never restore legacy agents."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import subprocess
import urllib.request

MXC_SOURCE = "7cd00d1ee6af9208322c924ef64e5113f6704639"
MXC_FILES = ("wxc-exec.exe", "wxc-host-prep.exe")
MXC_LICENSE_SHA256 = "d9a1b1e30d633d5732ea18e3cba9538d293ebc53e1a9e4e96ab739e0c5c4f1cb"
NODE_SHA256 = "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878"
OPENSHELL_SOURCE = "624f55b3c6affedd4f2757c7eb32132196b4c3e8"
_SOURCE_SPEC = importlib.util.spec_from_file_location(
    "openshell_source", Path(__file__).with_name("openshell_source.py")
)
_SOURCE_MODULE = importlib.util.module_from_spec(_SOURCE_SPEC)
_SOURCE_SPEC.loader.exec_module(_SOURCE_MODULE)
OPENSHELL_FILES = (
    "openshell.exe",
    "openshell-gateway.exe",
    "openshell-supervisor.exe",
    "openshell-windows-sandbox.exe",
    "libz3.dll",
)
OPENSHELL_LICENSE_URL = (
    f"https://raw.githubusercontent.com/NVIDIA/OpenShell/{OPENSHELL_SOURCE}/LICENSE"
)
OPENSHELL_LICENSE_SHA256 = (
    "d07c0367e2861e7fe70fa1b679f879f4fa2f9138ade4457d44ecf8b2e135bb45"
)
Z3_LICENSE_SHA256 = "cb070dd81b491334c5df7558731fe5cc8158ffcc757336e579ae4c155cc882fe"


def digest(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def arm64(path):
    with Path(path).open("rb") as stream:
        header = stream.read(4096)
    offset = int.from_bytes(header[60:64], "little")
    if (
        len(header) < 64
        or header[:2] != b"MZ"
        or offset < 64
        or header[offset : offset + 6] != b"PE\0\0\x64\xaa"
    ):
        raise ValueError("A native host component is not Windows ARM64.")


def build_files(build, approved, component):
    files = build.get("files")
    if not isinstance(files, list) or len(files) != len(approved):
        raise ValueError(f"The {component} build must contain every approved host component.")
    if any(not isinstance(item, dict) for item in files) or sorted(
        item.get("file", "") for item in files
    ) != sorted(approved):
        raise ValueError(f"The {component} build contains unexpected or duplicate files.")
    return files


def openshell_build_files(build):
    return build_files(build, OPENSHELL_FILES, "OpenShell")


def verify_openshell_build(native, expected, run_id, run_attempt):
    identity = _SOURCE_MODULE.load_lock()
    build = json.loads((native / "openshell-build.json").read_text(encoding="utf-8"))
    if (
        build.get("schemaVersion") != 1
        or build.get("classification") != "ci-built-openshell-host-binaries"
        or build.get("requestedSourceRevision") != expected
        or build.get("openshellRevision") != OPENSHELL_SOURCE
        or identity["baseRevision"] != OPENSHELL_SOURCE
        or build.get("derivativePatchSha256") != identity["patchSha256"]
        or build.get("sourceTree") != identity["patchedTree"]
        or build.get("sourceUnchanged") is not True
        or build.get("rustToolchain") != "1.95.0-aarch64-pc-windows-msvc"
        or build.get("rustTarget") != "aarch64-pc-windows-msvc"
        or not run_id
        or not run_attempt
        or build.get("workflowRunId") != run_id
        or build.get("workflowRunAttempt") != run_attempt
        or build.get("currentPackageQualification") is not False
    ):
        raise ValueError("OpenShell requires current-source, same-run ARM64 build evidence.")
    files = openshell_build_files(build)
    verify_build_files(native, files, "OpenShell")
    return build


def verify_mxc_build(native, expected, run_id, run_attempt):
    build = json.loads((native / "mxc-build.json").read_text(encoding="utf-8"))
    if (
        build.get("schemaVersion") != 1
        or build.get("classification") != "ci-built-mxc-host-binaries"
        or build.get("requestedSourceRevision") != expected
        or build.get("mxcRevision") != MXC_SOURCE
        or build.get("sourceUnchanged") is not True
        or build.get("rustToolchain") != "1.93.0-aarch64-pc-windows-msvc"
        or build.get("rustTarget") != "aarch64-pc-windows-msvc"
        or not run_id
        or not run_attempt
        or build.get("workflowRunId") != run_id
        or build.get("workflowRunAttempt") != run_attempt
        or build.get("currentPackageQualification") is not False
        or build.get("licenseSha256") != MXC_LICENSE_SHA256
    ):
        raise ValueError("MXC requires current-source, same-run ARM64 build evidence.")
    if digest(native / "LICENSE.md") != MXC_LICENSE_SHA256:
        raise ValueError("MXC requires current-source, same-run ARM64 build evidence.")
    verify_build_files(native, build_files(build, MXC_FILES, "MXC"), "MXC")
    return build


def verify_build_files(native, files, component):
    for item in files:
        binary = native / item["file"]
        info = binary.lstat()
        if (
            not stat.S_ISREG(info.st_mode)
            or info.st_nlink != 1
            or getattr(info, "st_file_attributes", 0) & 0x400
        ):
            raise ValueError(f"A {component} build binary is not an ordinary single-link file.")
        arm64(binary)
        if binary.stat().st_size != item.get("bytes") or digest(binary) != item.get(
            "sha256"
        ):
            raise ValueError(f"A {component} binary differs from its current build receipt.")


def copy_openshell_build(native, destination, build):
    # Use the verified inventory for staging as well as admission. A second
    # executable-only list would omit an approved runtime DLL after an upgrade.
    copy_build_files(native, destination, openshell_build_files(build), "OpenShell")


def copy_build_files(native, destination, files, component):
    for item in files:
        copied = destination / item["file"]
        shutil.copy2(native / item["file"], copied)
        if copied.stat().st_size != item["bytes"] or digest(copied) != item["sha256"]:
            raise ValueError(f"A {component} component changed during its build copy.")


def copy_z3_license(source, destination):
    # Both statically linked and DLL-based OpenShell builds distribute Z3.
    with (source / "packaging/windows/Z3-LICENSE.txt").open("rb") as stream:
        notice = stream.read(16385)
    if len(notice) > 16384 or hashlib.sha256(notice).hexdigest() != Z3_LICENSE_SHA256:
        raise ValueError("The Z3 license differs from the reviewed notice.")
    with (destination / "Z3-LICENSE.txt").open("xb") as output:
        output.write(notice)


def gateway_template(executor):
    return (
        "[openshell]\nversion = 2\n\n[openshell.drivers.mxc]\nwxc_exec_path = "
        + json.dumps(executor)
        + '\nbackend = "process_container"\n'
        'pc_least_privilege = false\n'
        'pc_capabilities = []\ndebug = false\n'
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "openshell-binaries", "mxc-binaries", "node-root", "output"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Native host preparation is a Windows CI build operation.")
    source = args.source_root
    expected = os.environ["GITHUB_SHA"]
    actual = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    if actual != expected or args.output.exists():
        raise ValueError(
            "Native host preparation requires exact source evidence and a fresh output."
        )
    build = verify_openshell_build(
        args.openshell_binaries,
        expected,
        os.environ["GITHUB_RUN_ID"],
        os.environ["GITHUB_RUN_ATTEMPT"],
    )
    mxc_build = verify_mxc_build(
        args.mxc_binaries,
        expected,
        os.environ["GITHUB_RUN_ID"],
        os.environ["GITHUB_RUN_ATTEMPT"],
    )
    node = args.node_root / "node.exe"
    record = json.loads(
        (args.node_root / "node-input.json").read_text(encoding="utf-8")
    )
    if (
        digest(node) != NODE_SHA256
        or record.get("nodeSha256") != NODE_SHA256
        or record.get("runtime")
        != {"version": "22.23.2", "platform": "win32", "architecture": "arm64"}
        or record.get("controllerSource") != expected
        or digest(args.node_root / "LICENSE") != record.get("licenseSha256")
    ):
        raise ValueError(
            "The shared Node is not the verified same-source application input."
        )
    arm64(node)
    native = args.openshell_binaries
    args.output.mkdir()
    (args.output / "bin").mkdir()
    shutil.copy2(node, args.output / "bin/node.exe")
    copy_openshell_build(native, args.output / "bin", build)
    (args.output / "mxc").mkdir()
    copy_build_files(
        args.mxc_binaries,
        args.output / "mxc",
        build_files(mxc_build, MXC_FILES, "MXC"),
        "MXC",
    )
    if digest(args.output / "bin/node.exe") != NODE_SHA256 or any(
        digest(args.output / "bin" / item["file"]) != item["sha256"]
        for item in build["files"]
    ):
        raise ValueError("A native host binary changed during its exact build copy.")
    (args.output / "config").mkdir()
    executor = str(
        Path(os.environ["ProgramFiles"]) / "NVIDIA/NemoClaw/mxc/wxc-exec.exe"
    )
    (args.output / "config/mxc-gateway.toml").write_text(
        gateway_template(executor),
        encoding="utf-8",
    )
    shutil.copytree(
        source / "packaging/windows/assets/desktop-icons", args.output / "desktop-icons"
    )
    shutil.copy2(
        source / "packaging/windows/agent-support.json",
        args.output / "agent-support.json",
    )
    shutil.copy2(source / "LICENSE", args.output / "LICENSE.txt")
    shutil.copy2(args.node_root / "LICENSE", args.output / "NODE-LICENSE.txt")
    copy_z3_license(source, args.output)
    with urllib.request.urlopen(OPENSHELL_LICENSE_URL, timeout=30) as response:
        license_bytes = response.read(16385)
    if (
        len(license_bytes) > 16384
        or hashlib.sha256(license_bytes).hexdigest() != OPENSHELL_LICENSE_SHA256
    ):
        raise ValueError(
            "The original OpenShell license differs from its immutable source."
        )
    (args.output / "OPENSHELL-LICENSE.txt").write_bytes(license_bytes)
    shutil.copy2(
        args.mxc_binaries / "LICENSE.md", args.output / "MXC-LICENSE.txt"
    )
    if digest(args.output / "MXC-LICENSE.txt") != MXC_LICENSE_SHA256:
        raise ValueError("The MXC license changed during its build copy.")
    shutil.copy2(
        source / "packaging/windows/NATIVE-PREVIEW.txt", args.output / "NATIVE-PREVIEW.txt"
    )
    files = [
        {
            "file": path.relative_to(args.output).as_posix(),
            "bytes": path.stat().st_size,
            "sha256": digest(path),
        }
        for path in sorted(args.output.rglob("*"))
        if path.is_file()
    ]
    receipt = {
        "schemaVersion": 1,
        "classification": "finished-native-host-components",
        "sourceRevision": expected,
        "openshellSourceRevision": OPENSHELL_SOURCE,
        "openshellBuild": build,
        "openshellLicenseSha256": OPENSHELL_LICENSE_SHA256,
        "z3LicenseSha256": Z3_LICENSE_SHA256,
        "openshellPatchSha256": None,
        "nodeInput": record,
        "mxcSourceRevision": MXC_SOURCE,
        "mxcBuild": mxc_build,
        "mxcLicenseSha256": MXC_LICENSE_SHA256,
        "files": files,
        "legacyAgentTreesPrepared": False,
        "installedAcceptance": False,
    }
    (args.output / "runtime-payload-receipt.json").write_text(
        json.dumps(receipt, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps({"hostFiles": len(files), "legacyAgentTreesPrepared": False}))


if __name__ == "__main__":
    main()
