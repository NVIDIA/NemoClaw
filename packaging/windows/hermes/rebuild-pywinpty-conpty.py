# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Rebuild one pinned wheel in CI; preserve the complete reused runtime around it."""

import argparse
import base64
import csv
from email.parser import Parser
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path, PurePosixPath, PureWindowsPath
import platform
import re
import shutil
import stat
import sys
import tomllib
import zipfile

HERE = Path(__file__).parent
BASE_HEAD = "47d890728482cca05e840edd27e33e3d495aeabf"
BASE_ZIP_BYTES = 1099892587
BASE_ZIP_SHA = "b6e3683f4248b62e6ba3594d8ecab11d6958a23f161b526a1d11ec07d146d6ed"
PYTHON_SHA = "54e17da389d3aae8c56b08a06fea5cd2f5acd57d2a7acb4061fc572964d4108b"
UV_SHA = "dbef885dac7790485a24cf4f67355d63e9ee1eba2e2182bb232a08f9e5d6e729"
SOURCE = {
    "file": "pywinpty-2.0.15.tar.gz",
    "url": "https://files.pythonhosted.org/packages/2d/7c/917f9c4681bb8d34bfbe0b79d36bbcd902651aeab48790df3d30ba0202fb/pywinpty-2.0.15.tar.gz",
    "size": 29017,
    "sha256": "312cf39153a8736c617d45ce8b6ad6cd2107de121df91c455b10ce6bba7a39b2",
}
CARGO_LOCK_SHA = "5f1f6a9425315621a84757b410ad2e1621c85c34128c092cb572f9a15562450b"
SITE = "hermes-agent/venv/Lib/site-packages/"
DIST = "pywinpty-2.0.15.dist-info/"
PACKAGE_ROOTS = (SITE + "winpty", SITE + DIST.rstrip("/"))
NATIVE = SITE + "winpty/winpty.cp311-win_arm64.pyd"
OLD_NATIVE_SHA = "c81591d40779ef1a66b6ad60eac31f23834b34d0b82164c4f1342850ad33f374"
INSTALL_METADATA = {
    SITE + DIST + name
    for name in (
        "INSTALLER",
        "REQUESTED",
        "direct_url.json",
        "uv_cache.json",
        "uv_build.json",
        "RECORD",
    )
}


def require(value, message):
    if not value:
        raise ValueError(message)


def load(name):
    spec = importlib.util.spec_from_file_location(
        name.replace("-", "_"), HERE / (name + ".py")
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def save(file, value):
    with Path(file).open("x", encoding="utf-8") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def in_package(relative):
    return any(
        relative == root or relative.startswith(root + "/") for root in PACKAGE_ROOTS
    )


def identities(inventory, raw_links=True):
    result = {}
    for row in inventory["files"]:
        name = row["path"]
        require(name not in result, "Duplicate inventory path")
        keys = ("bytes", "sha256", "linkTarget") + (
            ("originalLinkTarget", "reparseTag") if raw_links else ()
        )
        result[name] = {key: row[key] for key in keys if key in row}
    return result


def validate_delta(before, after, wheel_files):
    old, new = identities(before), identities(after)
    old_package = {name for name in old if in_package(name)}
    new_package = {name for name in new if in_package(name)}
    caches = {
        name
        for name in old_package
        if "/__pycache__/" in name and name.endswith(".pyc")
    }
    permitted = caches | set(wheel_files) | INSTALL_METADATA
    require(
        new_package <= permitted,
        "Unlisted new pywinpty file: " + json.dumps(sorted(new_package - permitted)),
    )
    require(
        {k: v for k, v in old.items() if not in_package(k)}
        == {k: v for k, v in new.items() if not in_package(k)},
        "A file outside pywinpty changed",
    )
    require(
        {p for p in before["directories"] if not in_package(p)}
        == {p for p in after["directories"] if not in_package(p)},
        "A directory outside pywinpty changed",
    )
    permitted_directories = {p for p in before["directories"] if in_package(p)}
    for name in wheel_files:
        permitted_directories.update(
            str(parent)
            for parent in PurePosixPath(name).parents
            if in_package(str(parent))
        )
    require(
        {p for p in after["directories"] if in_package(p)} <= permitted_directories,
        "Unlisted new pywinpty directory",
    )
    for name, identity in wheel_files.items():
        if name != SITE + DIST + "RECORD":
            require(
                new.get(name) == identity, "Installed wheel member mismatch: " + name
            )
    for name in before.get("licenseFiles", []):
        require(
            new.get(name) == old[name],
            "An existing license changed or disappeared: " + name,
        )
    return {
        "installedFiles": [{"path": name, **new[name]} for name in sorted(new_package)],
        "changed": sorted(
            name for name in old.keys() & new.keys() if old[name] != new[name]
        ),
        "added": sorted(new.keys() - old.keys()),
        "removed": sorted(old.keys() - new.keys()),
    }


def arm64(data):
    require(len(data) >= 64 and data[:2] == b"MZ", "Missing native PE header")
    offset = int.from_bytes(data[60:64], "little")
    require(
        data[offset : offset + 4] == b"PE\0\0"
        and int.from_bytes(data[offset + 4 : offset + 6], "little") == 0xAA64,
        "Expected native ARM64 image",
    )


def verify_wheel(file):
    require(
        file.name == "pywinpty-2.0.15-cp311-cp311-win_arm64.whl"
        and file.stat().st_size <= 64 * 1024 * 1024,
        "Unexpected wheel identity or size",
    )
    with zipfile.ZipFile(file) as archive:
        all_entries = archive.infolist()
        require(len(all_entries) <= 512, "Wheel directory count exceeds its bound")
        for entry in all_entries:
            name = entry.filename.rstrip("/")
            require(
                name == PurePosixPath(name).as_posix()
                and "\\" not in name
                and ":" not in name
                and ".." not in PurePosixPath(name).parts
                and (
                    name in {"winpty", DIST.rstrip("/")}
                    or name.startswith(("winpty/", DIST))
                ),
                "Wheel directory/member escapes the exact distribution",
            )
            require(
                stat.S_IFMT(entry.external_attr >> 16) != stat.S_IFLNK,
                "Wheel links are forbidden",
            )
        entries = [entry for entry in all_entries if not entry.is_dir()]
        require(
            0 < len(entries) <= 256
            and sum(e.file_size for e in entries) <= 64 * 1024 * 1024,
            "Wheel exceeds its file/byte bound",
        )
        names = [e.filename for e in entries]
        require(
            len(names) == len(set(n.casefold() for n in names)),
            "Duplicate wheel member",
        )
        for entry in entries:
            name = entry.filename
            require(
                name == PurePosixPath(name).as_posix()
                and "\\" not in name
                and ":" not in name
                and ".." not in PurePosixPath(name).parts
                and name.startswith(("winpty/", DIST)),
                "Wheel member escapes the exact distribution",
            )
            require(
                stat.S_IFMT(entry.external_attr >> 16) != stat.S_IFLNK,
                "Wheel links are forbidden",
            )
        content = {name: archive.read(name) for name in names}
    metadata = Parser().parsestr(content[DIST + "METADATA"].decode())
    require(
        metadata["Name"] == "pywinpty" and metadata["Version"] == "2.0.15",
        "Wheel package/version changed",
    )
    wheel = Parser().parsestr(content[DIST + "WHEEL"].decode())
    require(
        wheel.get_all("Tag") == ["cp311-cp311-win_arm64"]
        and wheel["Root-Is-Purelib"].lower() == "false",
        "Wheel ABI/platform changed",
    )
    native = NATIVE.removeprefix(SITE)
    require(
        [n for n in names if n.endswith(".pyd")] == [native],
        "Wheel native extension set changed",
    )
    arm64(content[native])
    rows = list(csv.reader(io.StringIO(content[DIST + "RECORD"].decode())))
    require(
        all(len(row) == 3 for row in rows)
        and len(rows) == len({r[0] for r in rows})
        and {r[0] for r in rows} == set(names),
        "Wheel RECORD is incomplete or duplicate",
    )
    for name, encoded, size in rows:
        if name == DIST + "RECORD":
            require(encoded == size == "", "Wheel RECORD self-entry changed")
        else:
            expected = (
                base64.urlsafe_b64encode(hashlib.sha256(content[name]).digest())
                .decode()
                .rstrip("=")
            )
            require(
                encoded == "sha256=" + expected and size == str(len(content[name])),
                "Wheel RECORD hash/size mismatch",
            )
    return {
        SITE + name: {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for name, data in content.items()
    }


def validate_installed_record(runtime, installed):
    indexed = {row["path"]: row for row in installed}
    rows = list(
        csv.reader(io.StringIO((runtime / (SITE + DIST + "RECORD")).read_text()))
    )
    require(all(len(row) == 3 for row in rows), "Installed RECORD is malformed")
    seen = set()
    for relative, encoded, size in rows:
        name = SITE + relative
        require(
            name in indexed and name not in seen,
            "Installed RECORD has unknown/duplicate members",
        )
        seen.add(name)
        if name == SITE + DIST + "RECORD":
            require(encoded == size == "", "Installed RECORD self-entry changed")
            continue
        if "/__pycache__/" in name and encoded == size == "":
            continue
        expected = (
            base64.urlsafe_b64encode(bytes.fromhex(indexed[name]["sha256"]))
            .decode()
            .rstrip("=")
        )
        require(
            encoded == "sha256=" + expected and size == str(indexed[name]["bytes"]),
            "Installed RECORD hash/size mismatch",
        )
    require(
        all(
            name in seen or ("/__pycache__/" in name and name.endswith(".pyc"))
            for name in indexed
        ),
        "Installed RECORD omits distribution files",
    )


def validate_base(base_zip, adaptation_file, before):
    admission, metadata, owner = (
        load("verify-personal-candidate"),
        load("prepare-native-runtime"),
        load("official-runtime-inventory"),
    )
    admission.verify_zip(base_zip, BASE_ZIP_BYTES, BASE_ZIP_SHA)
    with zipfile.ZipFile(base_zip) as archive:
        _, candidate_bytes, candidate = admission.document(
            archive, "runtime-candidate.json", 65536
        )
        _, inventory_bytes, original = admission.document(
            archive, "payload-inventory.json"
        )
        _, prior_bytes, prior = admission.document(archive, "native-adaptation.json")
        _, build_bytes, build = admission.document(
            archive, "official-runtime-build.json"
        )
    require(
        candidate["controllerSource"] == BASE_HEAD
        and candidate["inventorySha256"] == hashlib.sha256(inventory_bytes).hexdigest()
        and candidate["adaptationReceiptSha256"]
        == hashlib.sha256(prior_bytes).hexdigest()
        and candidate["buildReceiptSha256"] == hashlib.sha256(build_bytes).hexdigest(),
        "Original candidate provenance changed",
    )
    owner.validate_build_receipt(build)
    adapted = json.loads(adaptation_file.read_text())
    require(
        adapted["startupAdapterUpgradeApplied"] is True
        and adapted["startupAdapterUpgrade"] == metadata.adapter_upgrade_record()
        and adapted["classification"] == "native-hermes-generated-metadata-adaptation",
        "Missing exact first upgrade/relocation receipt",
    )
    expected, actual = identities(original, False), identities(before, False)
    prior_paths = {row["path"] for row in prior["files"]}
    require(
        len(adapted["files"]) == len(prior_paths)
        and {row["path"] for row in adapted["files"]} == prior_paths,
        "Unexpected adapted metadata set",
    )
    for row in adapted["files"]:
        require(
            expected[row["path"]]["sha256"] == row["beforeSha256"],
            "Adaptation preimage differs from complete base",
        )
        expected[row["path"]] = {key: row[key] for key in ("bytes", "sha256")}
    require(
        actual == expected and before["directories"] == original["directories"],
        "Runtime is not the complete base plus the exact metadata plan",
    )
    require(
        actual[NATIVE]["sha256"] == OLD_NATIVE_SHA,
        "Expected original pywinpty extension",
    )
    return {
        "artifactId": 10181796438,
        "runId": 34551706967,
        "sourceRevision": BASE_HEAD,
        "zipSha256": BASE_ZIP_SHA,
        "candidateReceiptSha256": hashlib.sha256(candidate_bytes).hexdigest(),
        "inventorySha256": candidate["inventorySha256"],
        "buildReceiptSha256": candidate["buildReceiptSha256"],
    }


def validate_rebuild_receipt(runtime, receipt, evidence_directory):
    evidence_directory, runtime = Path(evidence_directory), Path(runtime)
    require(
        receipt["schemaVersion"] == 1
        and receipt["classification"] == "ci-targeted-pywinpty-conpty-rebuild"
        and receipt["status"] == "pass",
        "Targeted wheel build did not pass",
    )
    for key in (
        "allOtherFilesUnchanged",
        "allOtherDirectoriesUnchanged",
        "buildToolsOutsideRuntime",
        "noRuntimeDependencyResolution",
    ):
        require(receipt[key] is True, "Incomplete targeted replacement: " + key)
    require(
        receipt["installedAcceptance"] is False
        and receipt["fullAgentQualified"] is False
        and receipt["base"]["zipSha256"] == BASE_ZIP_SHA,
        "Unexpected base or qualification claim",
    )
    require(
        receipt["allOwnedProcessesClosed"] is True,
        "Targeted build has unclosed processes",
    )
    expected_processes = {
        name + ".process.json"
        for name in (
            "rust-version",
            "cargo-version",
            "build-environment",
            "build-requirements",
            "build-wheel",
            "replace-pywinpty",
            "conpty-smoke",
        )
    }
    require(
        len(receipt["processReceipts"]) == len(expected_processes)
        and {r["file"] for r in receipt["processReceipts"]} == expected_processes,
        "Build process receipt set changed",
    )
    for row in receipt["processReceipts"]:
        file = evidence_directory / row["file"]
        require(digest(file) == row["sha256"], "Process receipt changed")
        result = json.loads(file.read_text())
        require(
            result["passed"] is True
            and type(result["exitCode"]) is int
            and result["exitCode"] == 0
            and result["cleanupErrors"] == [],
            "Build process failed or did not close",
        )
    require(
        receipt["base"]["artifactId"] == 10181796438
        and receipt["base"]["runId"] == 34551706967
        and receipt["base"]["sourceRevision"] == BASE_HEAD,
        "Complete base identity changed",
    )
    require(
        all(receipt["source"].get(key) == value for key, value in SOURCE.items())
        and receipt["source"]["cargoLockSha256"] == CARGO_LOCK_SHA
        and receipt["source"]["sourceUnchanged"] is True,
        "Targeted source provenance changed",
    )
    configuration = receipt["configuration"]
    require(
        configuration["maturinBuildArgs"] == "--features winpty-rs/conpty --locked"
        and configuration["upstreamUvSettingsPreserved"] is True
        and configuration["globalRustFlagsChanged"] is False
        and configuration["upstreamSourcesChanged"] is False,
        "ConPTY build configuration changed",
    )
    config = evidence_directory / "pywinpty-build.uv.toml"
    require(
        digest(config) == configuration["configurationSha256"]
        and tomllib.loads(config.read_text())["config-settings-package"]["pywinpty"]
        == {"build-args": "--features winpty-rs/conpty --locked"},
        "Configuration file changed",
    )
    before_file, after_file = (
        evidence_directory / "before-inventory.json",
        evidence_directory / "after-inventory.json",
    )
    require(
        digest(before_file) == receipt["beforeInventorySha256"]
        and digest(after_file) == receipt["afterInventorySha256"],
        "Replacement inventory evidence changed",
    )
    wheel = receipt["wheel"]
    require(
        PurePosixPath(wheel["file"]).parts
        == ("wheels", "pywinpty-2.0.15-cp311-cp311-win_arm64.whl"),
        "Wheel receipt path changed",
    )
    wheel_path = evidence_directory / wheel["file"]
    require(
        wheel_path.stat().st_size == wheel["bytes"]
        and digest(wheel_path) == wheel["sha256"],
        "Built wheel bytes changed",
    )
    files = verify_wheel(wheel_path)
    replacement = validate_delta(
        json.loads(before_file.read_text()), json.loads(after_file.read_text()), files
    )
    require(replacement == receipt["replacement"], "Replacement evidence changed")
    current_files = []
    current_directories = set()
    owner = load("official-runtime-inventory")
    for prefix in PACKAGE_ROOTS:
        package_root = runtime / prefix
        require(
            package_root.is_dir()
            and not package_root.is_symlink()
            and not getattr(package_root.lstat(), "st_file_attributes", 0) & 0x400
            and package_root.resolve().is_relative_to(runtime.resolve()),
            "Current pywinpty root is redirected",
        )
        part = owner.inventory(package_root)
        current_files.extend(
            {**row, "path": prefix + "/" + row["path"]} for row in part["files"]
        )
        current_directories.update(
            {prefix, *(prefix + "/" + name for name in part["directories"])}
        )
    require(
        identities({"files": current_files})
        == identities({"files": replacement["installedFiles"]}),
        "Current pywinpty closure changed",
    )
    expected_directories = {
        name
        for name in json.loads(after_file.read_text())["directories"]
        if in_package(name)
    }
    require(
        current_directories == expected_directories,
        "Current pywinpty directory closure changed",
    )
    validate_installed_record(runtime, replacement["installedFiles"])
    for row in replacement["installedFiles"]:
        file = runtime / row["path"]
        require(
            file.is_file()
            and not file.is_symlink()
            and file.stat().st_size == row["bytes"]
            and digest(file) == row["sha256"],
            "Current pywinpty distribution changed",
        )
    smoke = json.loads((evidence_directory / "conpty-smoke.json").read_text())
    require(
        receipt["smoke"]["file"] == "conpty-smoke.json"
        and digest(evidence_directory / "conpty-smoke.json")
        == receipt["smoke"]["sha256"],
        "Smoke receipt changed",
    )
    require(
        smoke["classification"] == "ci-built-pywinpty-conpty-smoke"
        and smoke["status"] == "pass"
        and smoke["backend"] == "ConPTY"
        and smoke["pythonVersion"] == "3.11.16"
        and smoke["pywinptyVersion"] == "2.0.15"
        and smoke["nativeModuleMachine"] == "0xaa64"
        and type(smoke["exitCode"]) is int
        and smoke["exitCode"] == 0,
        "Native smoke identity/result changed",
    )
    for key in (
        "constructorSucceeded",
        "spawnSucceeded",
        "outputContainsSentinel",
        "childExitObserved",
        "cleanupPassed",
    ):
        require(smoke[key] is True, "Native smoke did not finish: " + key)
    require(
        PureWindowsPath(smoke["nativeModule"])
        .relative_to(PureWindowsPath(receipt["runtimeRoot"]))
        .as_posix()
        == NATIVE
        and digest(runtime / NATIVE)
        == smoke["nativeModuleSha256"]
        == receipt["smoke"]["nativeModuleSha256"],
        "Smoke used a different native module",
    )
    return receipt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in (
        "runtime-root",
        "base-zip",
        "adaptation-receipt",
        "artifact-directory",
        "rust-bin-directory",
    ):
        parser.add_argument("--" + name, type=Path, required=True)
    args = parser.parse_args()
    runtime, output = (
        args.runtime_root.resolve(strict=True),
        args.artifact_directory.resolve(),
    )
    bootstrap = Path(getattr(sys, "_base_executable", sys.executable)).resolve(
        strict=True
    )
    require(
        sys.platform == "win32"
        and platform.machine().lower() in {"arm64", "aarch64"}
        and sys.version_info[:3] == (3, 11, 16)
        and os.environ.get("GITHUB_ACTIONS") == "true",
        "Targeted wheel rebuilding requires pinned Windows ARM64 CI",
    )
    require(
        digest(bootstrap) == PYTHON_SHA and not bootstrap.is_relative_to(runtime),
        "Use the pinned external bootstrap interpreter",
    )
    require(
        not output.exists()
        and not output.is_relative_to(runtime)
        and not runtime.is_relative_to(output),
        "Build tools/evidence require a fresh separate directory",
    )
    require(
        re.fullmatch(r"[a-f0-9]{40}", os.environ.get("GITHUB_SHA", "")),
        "CI source revision is missing",
    )
    output.mkdir()
    owner, provision, conpty = (
        load("official-runtime-inventory"),
        load("provision-official-runtime"),
        load("pywinpty-conpty"),
    )
    receipt = {
        "schemaVersion": 1,
        "classification": "ci-targeted-pywinpty-conpty-rebuild",
        "status": "failed",
        "runtimeRoot": str(runtime),
        "sourceRevision": os.environ["GITHUB_SHA"],
        "installedAcceptance": False,
        "fullAgentQualified": False,
    }
    before = None
    reports = []
    primary = None
    try:
        before = owner.inventory(runtime)
        receipt["base"] = validate_base(args.base_zip, args.adaptation_receipt, before)
        receipt["adaptationReceiptSha256"] = digest(args.adaptation_receipt)
        save(output / "before-inventory.json", before)
        receipt["beforeInventorySha256"] = digest(output / "before-inventory.json")
        lock = json.loads((HERE / "official-python.lock.json").read_text())
        require(
            digest(HERE / lock["requirementsFile"]) == lock["requirementsSha256"],
            "Build requirements changed",
        )
        require(
            os.environ.get("VSCMD_ARG_TGT_ARCH")
            == os.environ.get("VSCMD_ARG_HOST_ARCH")
            == "arm64"
            and os.environ.get("VCToolsVersion", "").rstrip("\\") == lock["msvcToolset"]
            and os.environ.get("WindowsSDKVersion", "").rstrip("\\")
            == lock["windowsSdk"],
            "Use the existing pinned native ARM64 developer environment",
        )
        rust = args.rust_bin_directory.resolve(strict=True)
        cl_dir = (
            Path(os.environ["VCToolsInstallDir"]) / "bin/HostARM64/arm64"
        ).resolve(strict=True)
        tools = [
            bootstrap,
            rust / "rustc.exe",
            rust / "cargo.exe",
            cl_dir / "cl.exe",
            cl_dir / "link.exe",
        ]
        for tool in tools:
            require(
                not tool.is_relative_to(runtime) and not tool.is_symlink(),
                "Build tool is inside the runtime or redirected",
            )
            arm64(tool.read_bytes())
        receipt["helperSourceFiles"] = [
            {"file": name, "sha256": digest(HERE / name)}
            for name in (
                "rebuild-pywinpty-conpty.py",
                "pywinpty-conpty.py",
                "provision-official-runtime.py",
                "official-runtime-inventory.py",
                "prepare-native-runtime.py",
            )
        ]
        receipt["tools"] = {
            "files": [{"path": str(p), "sha256": digest(p)} for p in tools],
            "toolset": lock["msvcToolset"],
            "windowsSdk": lock["windowsSdk"],
            "buildRequirementsSha256": lock["requirementsSha256"],
        }
        build_paths = [rust, cl_dir]
        for value in os.environ.get("PATH", "").split(os.pathsep):
            if (
                value
                and Path(value).is_absolute()
                and any(
                    Path(value).is_relative_to(Path(os.environ[k]))
                    for k in ("VSINSTALLDIR", "WindowsSdkDir")
                    if os.environ.get(k)
                )
            ):
                build_paths.append(Path(value))
        environment = provision.clean_environment(runtime, output, build_paths)
        build_env, downloads, wheels = (
            output / "build-env",
            output / "downloads",
            output / "wheels",
        )
        downloads.mkdir()
        wheels.mkdir()
        (output / "tools").mkdir()
        environment.update(
            PATH=os.pathsep.join(
                map(
                    str,
                    [
                        build_env / "Scripts",
                        *build_paths,
                        Path(environment["SystemRoot"]) / "System32",
                    ],
                )
            ),
            GITHUB_ACTIONS="true",
            PYTHONDONTWRITEBYTECODE="1",
            MATURIN_NO_INSTALL_RUST="1",
            CARGO_HOME=str(output / "cargo-home"),
            CARGO_TARGET_DIR=str(output / "target"),
            UV_TOOL_DIR=str(output / "tools"),
            UV_TOOL_BIN_DIR=str(output / "tools"),
            UV_COMPILE_BYTECODE="0",
        )
        for key in ("OPENSSL_DIR", "OPENSSL_STATIC"):
            environment.pop(key, None)
        require(
            shutil.which("winpty-agent", path=environment["PATH"]) is None,
            "Legacy WinPTY is discoverable in build PATH",
        )

        def run(executable, arguments, label, cwd=output, timeout=600):
            reports.append(output / (label + ".process.json"))
            return provision.run_owned(
                executable, arguments, environment, cwd, output, label, timeout
            )

        run(rust / "rustc.exe", ["-vV"], "rust-version", timeout=30)
        rust_version = (output / "rust-version.stdout.log").read_text()
        require(
            "release: 1.95.0" in rust_version
            and "host: aarch64-pc-windows-msvc" in rust_version,
            "Rust toolchain differs from Python phase pin",
        )
        run(rust / "cargo.exe", ["--version"], "cargo-version", timeout=30)
        require(
            (output / "cargo-version.stdout.log")
            .read_text()
            .startswith("cargo 1.95.0 "),
            "Cargo version differs from pin",
        )
        uv = output / "tools/uv.exe"
        require(digest(runtime / "bin/uv.exe") == UV_SHA, "Pinned runtime uv changed")
        shutil.copyfile(runtime / "bin/uv.exe", uv)
        for artifact in lock["artifacts"]:
            provision.download(artifact, downloads)
        source_archive = provision.download(SOURCE, downloads)
        source = output / "source"
        provision.extract_complete(source_archive, source, "tar.gz")
        require(
            digest(source / "Cargo.lock") == CARGO_LOCK_SHA,
            "Pinned pywinpty Cargo.lock changed",
        )
        cargo_lock = tomllib.loads((source / "Cargo.lock").read_text())
        selected = [row for row in cargo_lock["package"] if row["name"] == "winpty-rs"]
        require(
            len(selected) == 1
            and selected[0]["version"] == "0.4.1"
            and selected[0]["checksum"]
            == "067bd0835c7d94e21f436c6c735a0725d63276503045a65a0e43856746b1235d",
            "Locked winpty-rs source changed",
        )
        source_before = identities(owner.inventory(source))
        config = output / "pywinpty-build.uv.toml"
        receipt["configuration"] = conpty.prepare_configuration(
            runtime / "hermes-agent/pyproject.toml",
            config,
            output / "configuration.json",
        )
        run(uv, ["venv", "--python", bootstrap, build_env], "build-environment")
        build_python = build_env / "Scripts/python.exe"
        run(
            uv,
            [
                "pip",
                "install",
                "--python",
                build_python,
                "--no-index",
                "--find-links",
                downloads,
                "--require-hashes",
                "-r",
                HERE / lock["requirementsFile"],
            ],
            "build-requirements",
        )
        # Runtime overrides do not apply to the separate pinned build-tool graph.
        environment["UV_CONFIG_FILE"] = str(config)
        environment["UV_BUILD_CONSTRAINT"] = str(HERE / lock["requirementsFile"])
        script = "import importlib.metadata,sys,tomllib,maturin; assert importlib.metadata.version('maturin')=='1.15.0'; settings=tomllib.load(open(sys.argv[2],'rb'))['config-settings-package']['pywinpty']; assert settings=={'build-args':'--features winpty-rs/conpty --locked'}; print(maturin.build_wheel(sys.argv[1],settings))"
        run(
            build_python,
            ["-I", "-B", "-c", script, wheels, config],
            "build-wheel",
            cwd=source,
        )
        require(
            identities(owner.inventory(source)) == source_before,
            "Build modified pinned pywinpty source",
        )
        produced = list(wheels.iterdir())
        require(
            len(produced) == 1 and produced[0].is_file(),
            "Build did not produce exactly one wheel",
        )
        wheel = produced[0]
        wheel_files = verify_wheel(wheel)
        require(
            identities(owner.inventory(runtime)) == identities(before),
            "Build changed runtime before replacement",
        )
        receipt["source"] = {
            **SOURCE,
            "cargoLockSha256": CARGO_LOCK_SHA,
            "sourceUnchanged": True,
        }
        receipt["wheel"] = {
            "file": "wheels/" + wheel.name,
            "bytes": wheel.stat().st_size,
            "sha256": digest(wheel),
        }
        run(
            uv,
            [
                "pip",
                "install",
                "--python",
                runtime / "hermes-agent/venv/Scripts/python.exe",
                "--no-index",
                "--no-deps",
                "--reinstall-package",
                "pywinpty",
                wheel,
            ],
            "replace-pywinpty",
        )
        run(
            runtime / "hermes-agent/venv/Scripts/python.exe",
            [
                "-I",
                "-B",
                HERE / "pywinpty-conpty.py",
                "smoke",
                "--receipt",
                output / "conpty-smoke.json",
            ],
            "conpty-smoke",
            timeout=45,
        )
        after = owner.inventory(runtime)
        save(output / "after-inventory.json", after)
        receipt["afterInventorySha256"] = digest(output / "after-inventory.json")
        installed_record = output / "installed-pywinpty-RECORD.csv"
        with installed_record.open("xb") as stream:
            stream.write((runtime / (SITE + DIST + "RECORD")).read_bytes())
        receipt["installedRecord"] = {
            "file": installed_record.name,
            "bytes": installed_record.stat().st_size,
            "sha256": digest(installed_record),
        }
        receipt["replacement"] = validate_delta(before, after, wheel_files)
        smoke = json.loads((output / "conpty-smoke.json").read_text())
        receipt["smoke"] = {
            "file": "conpty-smoke.json",
            "sha256": digest(output / "conpty-smoke.json"),
            "nativeModuleSha256": smoke["nativeModuleSha256"],
        }
        for tool in receipt["tools"]["files"]:
            require(
                digest(tool["path"]) == tool["sha256"],
                "Build tool changed during execution",
            )
        receipt.update(
            status="pass",
            allOtherFilesUnchanged=True,
            allOtherDirectoriesUnchanged=True,
            buildToolsOutsideRuntime=True,
            noRuntimeDependencyResolution=True,
        )
    except BaseException as error:
        primary = error
        receipt["status"] = "failed"
        receipt["error"] = str(error)
    finally:
        receipt["processReceipts"] = [
            {"file": p.name, "sha256": digest(p)} for p in reports if p.is_file()
        ]
        receipt["allOwnedProcessesClosed"] = len(receipt["processReceipts"]) == len(
            reports
        ) and all(
            json.loads(p.read_text())["exitCode"] is not None
            and json.loads(p.read_text())["cleanupErrors"] == []
            for p in reports
        )
        if not receipt["allOwnedProcessesClosed"]:
            receipt["status"] = "failed"
        if receipt["status"] == "pass":
            try:
                validate_rebuild_receipt(runtime, receipt, output)
            except BaseException as error:
                primary = error
                receipt["status"] = "failed"
                receipt["error"] = str(error)
        save(output / "pywinpty-rebuild.json", receipt)
    if primary:
        raise primary
    require(
        receipt["status"] == "pass",
        "Targeted rebuild did not close its owned processes",
    )


if __name__ == "__main__":
    main()
