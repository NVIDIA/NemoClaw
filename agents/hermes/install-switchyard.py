# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Install the reviewed, disabled Switchyard release without loading native code."""

import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import sys
import tarfile
import tomllib

RELEASES = {
    "x86_64": {
        "archive": "d0306ee11bf44e1845f24f4fb56e4e11986ef6ac751f3abf303aef9fe1e798d2",
        "library": "9b53b057eae53bd1893282e958153d6f353d44405e1b86ab6966d6033cfc102d",
        "machine": 62,
    },
    "aarch64": {
        "archive": "267c4fa1b0ea07a9fdff019f4791e5042f4f68093ae27a7afb7541d323b2f720",
        "library": "07f7b9c8051dede541d7d0dfc73bf10a702c33bf8c93f1e222ee2e1d6b471897",
        "machine": 183,
    },
}
LIBRARY = "libswitchyard_nemo_relay_plugin.so"
FILES = {
    "relay-plugin.toml", "config.schema.json", LIBRARY,
    "LICENSE", "NOTICE", "ATTRIBUTIONS-Rust.md", "THIRD_PARTY_NOTICES.md",
    "notices/protocol/LICENSE", "notices/protocol/NOTICE",
    "notices/switchyard-translation/LICENSE", "notices/switchyard-translation/NOTICE",
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def read_bundle(archive, release):
    require(sha256(archive.read_bytes()) == release["archive"], "Switchyard archive digest mismatch")
    root = "switchyard-plugin"
    directories = {root, f"{root}/notices", f"{root}/notices/protocol", f"{root}/notices/switchyard-translation"}
    files = {}
    seen = set()
    with tarfile.open(archive, "r:gz") as bundle:
        for member in bundle.getmembers():
            require(member.name not in seen, "duplicate Switchyard archive member")
            seen.add(member.name)
            if member.isdir():
                require(member.name in directories, "unexpected Switchyard archive directory")
                continue
            name = member.name.removeprefix(f"{root}/")
            require(member.isfile() and member.name == f"{root}/{name}" and name in FILES,
                    "unsafe or unexpected Switchyard archive member")
            require(0 < member.size <= 64 * 1024 * 1024, "invalid Switchyard member size")
            with bundle.extractfile(member) as source:
                files[name] = source.read()
    require(files.keys() == FILES, "incomplete Switchyard bundle")
    return files


def validate_bundle(files, release):
    manifest = tomllib.loads(files["relay-plugin.toml"].decode("utf-8"))
    expected = {
        "manifest_version": 1,
        "plugin": {"id": "nvidia.switchyard", "kind": "rust_dynamic"},
        "compat": {"relay": ">=0.8.0, <1.0.0", "native_api": "1"},
        "defaults": {"enabled": False},
        "capabilities": {"items": ["plugin_native", "config_schema"]},
        "config_schema": {"path": "config.schema.json"},
        "source": {"artifact": LIBRARY},
        "integrity": {"sha256": f"sha256:{release['library']}"},
        "load": {"library": LIBRARY, "symbol": "nemo_relay_register_plugin"},
    }
    require(manifest == expected, "incompatible Switchyard manifest")
    require(isinstance(json.loads(files["config.schema.json"]), dict), "invalid Switchyard schema")
    library = files[LIBRARY]
    require(sha256(library) == release["library"], "Switchyard library digest mismatch")
    require(len(library) >= 64 and library[:7] == b"\x7fELF\x02\x01\x01"
            and int.from_bytes(library[16:18], "little") == 3
            and int.from_bytes(library[18:20], "little") == release["machine"],
            "Switchyard library is not the expected Linux ELF shared object")


def install(archive, destination, architecture, hermes_version, relay_version):
    require(architecture in RELEASES, "unsupported Switchyard architecture")
    require((hermes_version, relay_version) == ("0.21.3", "0.8.3"),
            "Switchyard requires the reviewed Hermes 0.21.3 / Relay 0.8.3 pair")
    release = RELEASES[architecture]
    files = read_bundle(archive, release)
    validate_bundle(files, release)
    # Never extract archive paths, modes, ownership, or links into the image.
    # The root-only build uses a fresh destination and installs only reviewed files.
    destination.mkdir(mode=0o755)
    for name, data in sorted(files.items()):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o755)
        with target.open("xb") as output:
            output.write(data)
        target.chmod(0o444)
        require(sha256(target.read_bytes()) == sha256(data), "installed Switchyard file digest mismatch")
    for directory in destination.rglob("*"):
        if directory.is_dir():
            directory.chmod(0o755)
    destination.chmod(0o755)
    require(sha256((destination / LIBRARY).read_bytes()) == release["library"],
            "installed Switchyard library digest mismatch")


if __name__ == "__main__":
    install(Path(sys.argv[1]), Path(sys.argv[2]), platform.machine(),
            importlib.metadata.version("hermes-agent"), importlib.metadata.version("nemo-relay"))
