# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Prepare only native host components in Windows CI; never restore legacy agents."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import urllib.request

SDK_URL = "https://registry.npmjs.org/@microsoft/mxc-sdk/-/mxc-sdk-0.8.0.tgz"
SDK_SHA256 = "06bb2399d7e98ab1907acf851e12a4e44748dd467b79d3e53c2f2fbf569da14e"
NODE_SHA256 = "97cce5301a815d2dce07ac5bfd1e6039eae88185ec1d10ae4f8cb712f1732878"
OPENSHELL_SOURCE = "bcd517bbe08cc80860c9be57699390cd32e8445f"
OPENSHELL_FILES = {
    "openshell.exe": "09e9b07a10c5ee181b4a1827e4fb4510b1eb72714c7d0d76dd79d8001e26eeda",
    "openshell-gateway.exe": "d51599b47ce66d99fb8652e918f1f4d28f6417e87aa439f75edd90fcdfe5684b",
}
OPENSHELL_LICENSE_URL = "https://raw.githubusercontent.com/NVIDIA/OpenShell/bcd517bbe08cc80860c9be57699390cd32e8445f/LICENSE"
OPENSHELL_LICENSE_SHA256 = (
    "b967d1c87b93b7d61ebcf4f8737e6ad79e5433e743e49dff395a36fb3c327047"
)


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


def extract_mxc(archive: Path, output: Path):
    selected = ("wxc-exec.exe", "wxc-host-prep.exe")
    output.mkdir()
    with tarfile.open(archive, "r:gz") as tar:
        members = tar.getmembers()
        for name in selected:
            matches = [
                entry for entry in members if entry.name == "package/bin/arm64/" + name
            ]
            if (
                len(matches) != 1
                or not matches[0].isfile()
                or matches[0].size > 256 * 1024 * 1024
            ):
                raise ValueError(
                    "The pinned MXC native member is missing, duplicated or redirected."
                )
            with (
                tar.extractfile(matches[0]) as source,
                (output / name).open("xb") as target,
            ):
                shutil.copyfileobj(source, target, 1024 * 1024)
            arm64(output / name)


def obtain_sdk(cache: Path):
    cache.mkdir(parents=True, exist_ok=True)
    archive = cache / "mxc-sdk-0.8.0.tgz"
    if not archive.exists():
        total = 0
        with (
            urllib.request.urlopen(SDK_URL, timeout=180) as response,
            archive.open("xb") as output,
        ):
            while block := response.read(1024 * 1024):
                total += len(block)
                if total > 512 * 1024 * 1024:
                    raise ValueError(
                        "The pinned MXC archive exceeds its download bound."
                    )
                output.write(block)
    if digest(archive) != SDK_SHA256:
        raise ValueError("The MXC archive differs from its exact input pin.")
    return archive


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source-root", "openshell-binaries", "node-root", "output", "cache"):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    if os.name != "nt" or os.environ.get("GITHUB_ACTIONS") != "true":
        raise ValueError("Native host preparation is a Windows CI build operation.")
    source = args.source_root
    expected = os.environ["GITHUB_SHA"]
    actual = subprocess.check_output(
        ["git", "-C", str(source), "rev-parse", "HEAD"], text=True
    ).strip()
    reuse = json.loads(
        (args.openshell_binaries / "openshell-reuse.json").read_text(encoding="utf-8")
    )
    if (
        actual != expected
        or args.output.exists()
        or reuse.get("classification") != "ci-reused-openshell-host-binaries"
        or reuse.get("requestedSourceRevision") != expected
        or reuse.get("openshellRevision") != OPENSHELL_SOURCE
        or reuse.get("portableProof") is not False
        or reuse.get("derivativePatchSha256")
        != digest(source / "packaging/windows/openshell-2721-node-ui.patch")
    ):
        raise ValueError(
            "Native host preparation requires exact source/reuse evidence and a fresh output."
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
    for name, expected_digest in OPENSHELL_FILES.items():
        arm64(native / name)
        if digest(native / name) != expected_digest:
            raise ValueError(
                "A reused native host binary differs from its fixed content identity."
            )
    archive = obtain_sdk(args.cache)
    args.output.mkdir()
    (args.output / "bin").mkdir()
    shutil.copy2(node, args.output / "bin/node.exe")
    for name in ("openshell.exe", "openshell-gateway.exe"):
        shutil.copy2(native / name, args.output / "bin" / name)
    extract_mxc(archive, args.output / "mxc")
    if digest(args.output / "bin/node.exe") != NODE_SHA256 or any(
        digest(args.output / "bin" / name) != expected_digest
        for name, expected_digest in OPENSHELL_FILES.items()
    ):
        raise ValueError("A native host binary changed during its exact build copy.")
    (args.output / "config").mkdir()
    executor = str(
        Path(os.environ["ProgramFiles"]) / "NVIDIA/NemoClaw/mxc/wxc-exec.exe"
    )
    (args.output / "config/mxc-gateway.toml").write_text(
        "[openshell.drivers.mxc]\nwxc_exec_path = "
        + json.dumps(executor)
        + '\nbackend = "process_container"\n'
        'default_configuration_id = "composable"\npc_least_privilege = false\n'
        'pc_capabilities = ["privateNetworkClientServer"]\ndebug = false\n',
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
        source / "packaging/windows/MXC-LICENSE.txt", args.output / "MXC-LICENSE.txt"
    )
    (args.output / "NATIVE-PREVIEW.txt").write_text(
        "NemoClaw finished native Windows preview.\nAgent qualification is continuing.\n"
        "Application code and dependencies are built in CI; settings do not install them.\n"
        "Use NemoClaw Setup for application updates.\n",
        encoding="utf-8",
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
        "openshellReuse": reuse,
        "openshellLicenseSha256": OPENSHELL_LICENSE_SHA256,
        "openshellPatchSha256": digest(
            source / "packaging/windows/openshell-2721-node-ui.patch"
        ),
        "nodeInput": record,
        "mxcArchiveSha256": SDK_SHA256,
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
