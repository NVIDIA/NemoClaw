# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build selected Windows runtime trees at their assigned immutable namespace.

This is a build operation, never a launch cache. It neither changes permissions
nor publishes runtime-current. MSI verifies the final manifest before selection;
per-agent execution and installed acceptance remain separate evidence.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PureWindowsPath
import re
import shutil
import stat

from assign_runtime_namespace import assign
from build_runtime_manifest import build, hash_file, validate_relative, MAX_ENTRIES

LAYOUT = {
    "openclaw": (
        "openclaw",
        [
            "openclaw-app.cjs",
            "openclaw-dynamic-import.cjs",
            "package.json",
            "dist/control-ui/index.html",
            "openclaw-resource-closure.json",
        ],
    ),
    "pi": ("pi", ["node_modules/@earendil-works/pi-coding-agent/dist/cli.js"]),
    "langchain-deepagents-code": (
        "deepagents",
        [
            "site-packages/deepagents_code/main.py",
            "python/python.exe",
            "runtime-python.json",
        ],
    ),
    "nemocua": (
        "nemocua",
        [
            "run_with_harness.py",
            "run_with_harness.pyc",
            "python/python.exe",
            "runtime-python.json",
            "python-bytecode.json",
            "browser-driver/node_modules/playwright-core/package.json",
        ],
    ),
    "hermes": (
        "hermes",
        [
            "hermes-agent/venv/Scripts/python.exe",
            "hermes-agent/hermes_cli/main.py",
            "hermes-agent/ui-tui/dist/entry.js",
            "hermes-agent/hermes_cli/web_dist/index.html",
            "git/bin/bash.exe",
            "git/usr/bin/bash.exe",
            "git/usr/bin/msys-2.0.dll",
            "nemoclaw-windows-runtime.json",
        ],
    ),
}
OFFICIAL_HERMES = "2237be355906fbe6065ce1815711eee52b2d646e"
HOST_MODES = [
    "turn",
    "terminal-turn",
    "nemocua",
    "console",
    "web",
    "hermes-dashboard",
    "inference",
]
GUEST_MODES = [
    "openclaw-turn",
    "openclaw-web",
    "pi-turn",
    "hermes-turn",
    "deepagents-turn",
    "interactive",
    "nemocua",
]
PYTHON_WORKERS = {
    "hermes": (
        "3.11.16",
        [
            "hermes-turn",
            "hermes-console",
            "hermes-console-probe",
            "hermes-dashboard",
            "hermes-dashboard-probe",
        ],
    ),
    "langchain-deepagents-code": ("3.13.13", ["deepagents-turn", "deepagents-console"]),
}


def python_workers(build_root: Path, agents):
    selected = []
    for agent in agents:
        if agent not in PYTHON_WORKERS:
            continue
        version, names = PYTHON_WORKERS[agent]
        root = build_root / "python" / agent
        receipt = read_json(root / "bytecode.json", 16 * 1024 * 1024)
        if (
            receipt.get("classification") != "ci-prepared-python-bytecode"
            or receipt.get("agent") != agent
            or receipt.get("pythonVersion") != version
            or receipt.get("platform") != "win32"
            or receipt.get("architecture", "").lower() not in {"arm64", "aarch64"}
            or receipt.get("invalidationMode") != "unchecked-hash"
        ):
            raise ValueError(
                "The selected Python workers lack exact CI bytecode preparation."
            )
        records = {row["worker"]: row for row in receipt.get("workers", [])}
        if len(records) != len(receipt.get("workers", [])) or set(records) != {
            name + ".pyc" for name in names
        }:
            raise ValueError("The static Python worker inventory changed.")
        for name in names:
            file = root / (name + ".pyc")
            ordinary(file, False)
            data = file.read_bytes()
            row = records[name + ".pyc"]
            if (
                hash_file(file) != (row["bytecodeBytes"], row["bytecodeSha256"])
                or len(data) < 16
                or data[:4].hex() != receipt.get("magicHex")
                or int.from_bytes(data[4:8], "little") != 1
                or row.get("sourceSha256")
                != hash_file(build_root / "python-build-inputs" / (name + ".py"))[1]
            ):
                raise ValueError(
                    "A static Python worker differs from its source-bound bytecode."
                )
            selected.append((file, "workers/" + name + ".pyc"))
    return selected


def finished_application(
    workers: Path, executable_build: Path, node: Path, source_revision: str
):
    ordinary(workers, True)
    ordinary(executable_build, True)
    compiled = read_json(workers / "build.json")
    sea = read_json(executable_build / "build.json")
    if (
        compiled.get("classification") != "prebuilt-windows-runtime-bundles"
        or compiled.get("deliveryContract") != "finished-native-app-v1"
        or compiled.get("sourceRevision") != source_revision
        or compiled.get("userSideSourceGenerationRequired") is not False
        or compiled.get("modes") != GUEST_MODES
    ):
        raise ValueError(
            "The finished application requires its exact compiled source contract."
        )
    files = {}
    for row in compiled.get("files", []):
        name = row.get("file")
        if not isinstance(name, str) or name in files:
            raise ValueError("The compiled application inventory is ambiguous.")
        validate_relative(name)
        ordinary(workers / name, False)
        if hash_file(workers / name) != (row.get("bytes"), row.get("sha256")):
            raise ValueError("A compiled application input changed.")
        files[name] = row
    required = {
        "native-runtime.cjs",
        "openclaw-invoke.cjs",
        "native-inference-manifest.json",
    }
    if not required.issubset(files):
        raise ValueError("The finished application is missing a static worker.")
    executable = executable_build / "NemoClaw.Runtime.exe"
    arm64_executable(executable)
    if (
        sea.get("classification") != "windows-prebuilt-runtime-executable"
        or sea.get("status") != "built-and-executed"
        or sea.get("platform") != "win32"
        or sea.get("architecture") != "arm64"
        or sea.get("node") != "v22.23.2"
        or sea.get("stockNodeSha256") != hash_file(node)[1]
        or sea.get("compiledSourceSha256") != files["native-runtime.cjs"]["sha256"]
        or sea.get("useCodeCache") is not True
        or sea.get("useSnapshot") is not False
        or sea.get("execution")
        != {
            "schemaVersion": 1,
            "kind": "prebuilt-native-runtime",
            "sea": True,
            "node": "v22.23.2",
            "hostModes": HOST_MODES,
            "guestModes": GUEST_MODES,
        }
        or sea.get("executable", {}).get("file") != "NemoClaw.Runtime.exe"
        or hash_file(executable)
        != (
            sea.get("executable", {}).get("bytes"),
            sea.get("executable", {}).get("sha256"),
        )
    ):
        raise ValueError(
            "The finished executable is not bound to the exact Windows build and shared Node."
        )
    selected = [
        (executable, "app/NemoClaw.Runtime.exe"),
        (workers / "native-runtime.cjs", "workers/native-runtime.cjs"),
        (workers / "openclaw-invoke.cjs", "workers/openclaw-invoke.cjs"),
        (
            workers / "native-inference-manifest.json",
            "app/native-inference-manifest.json",
        ),
    ]
    frontend = compiled.get("onboarding", [])
    if not {"index.html", "app.js", "styles.css"}.issubset(
        {row.get("file") for row in frontend}
    ):
        raise ValueError("The application requires its CI-compiled onboarding assets.")
    seen = set()
    for row in frontend:
        name = row.get("file")
        validate_relative(name)
        if name in seen or Path(name).suffix in {".ts", ".mts", ".tsx"}:
            raise ValueError(
                "The frontend inventory contains source or duplicate assets."
            )
        seen.add(name)
        asset = workers / "onboarding" / name
        ordinary(asset, False)
        if hash_file(asset) != (row.get("bytes"), row.get("sha256")):
            raise ValueError("A compiled frontend asset changed.")
        selected.append((asset, "app/onboarding/" + name))
    return selected, {
        "workerBuildSha256": hash_file(workers / "build.json")[1],
        "executableBuildSha256": hash_file(executable_build / "build.json")[1],
        "stockNodeVersion": "22.23.2",
        "customerSourceBuildRequired": False,
    }


def verify_openclaw_input(root: Path, rows: list[dict]):
    receipt = read_json(root / "openclaw-resource-closure.json", 16 * 1024 * 1024)
    if (
        receipt.get("schemaVersion") != 1
        or receipt.get("classification") != "compiled-openclaw-resource-closure"
        or not isinstance(receipt.get("closureAdmitted"), bool)
        or receipt.get("controlUiRoot") != "dist/control-ui"
        or receipt.get("package", {}).get("name") != "openclaw"
        or receipt.get("package", {}).get("version") != "2026.7.1"
        or receipt.get("compiler", {}).get("mainSha256")
        != hash_file(root / "openclaw-app.cjs")[1]
        or receipt.get("compiler", {}).get("bridgeSha256")
        != hash_file(root / "openclaw-dynamic-import.cjs")[1]
    ):
        raise ValueError(
            "OpenClaw requires an admitted exact prebuilt resource closure."
        )
    files = {row["path"]: row for row in rows if row["kind"] == "file"}
    admitted = {
        "openclaw-app.cjs",
        "openclaw-dynamic-import.cjs",
        "openclaw-resource-closure.json",
    }
    declared = set()
    roles = {
        "metadata",
        "control-ui",
        "plugin-facade",
        "worker",
        "native-sidecar",
        "runtime-sidecar",
        "license",
    }
    for row in receipt.get("files", []):
        name = row.get("path")
        if name in declared or name not in files or row.get("role") not in roles:
            raise ValueError("The OpenClaw resource inventory is invalid.")
        actual = files[name]
        if (row.get("bytes"), row.get("sha256")) != (actual["bytes"], actual["sha256"]):
            raise ValueError("An admitted OpenClaw resource changed.")
        declared.add(name)
    if admitted | declared != set(files):
        raise ValueError("The OpenClaw asset root contains undeclared bytes.")


def prepare_model_pack(root: Path):
    catalog = read_json(
        Path(__file__).parents[1] / "runtime/native-inference-manifest.json"
    )
    pack = read_json(root / "pack.json", 16384)
    if (
        pack.get("schemaVersion") != 1
        or pack.get("classification") != "prebuilt-native-model-pack"
        or any(
            pack.get(name) != catalog[name] for name in ("id", "model", "modelRevision")
        )
        or pack.get("runtimeArchiveSha256") != catalog["runtime"]["sha256"]
        or pack.get("cudaArchiveSha256") != catalog["cuda"]["sha256"]
        or pack.get("server", {}).get("file") != "bin/llama-server.exe"
        or pack.get("weights")
        != {
            "file": "model/" + catalog["weights"]["name"],
            "bytes": catalog["weights"]["bytes"],
            "sha256": catalog["weights"]["sha256"],
        }
    ):
        raise ValueError("The prebuilt model pack differs from the pinned catalog.")
    rows = inventory(root)
    files = {row["path"]: row for row in rows if row["kind"] == "file"}
    for name in ("server", "weights"):
        selected = pack[name]
        actual = files.get(selected["file"])
        if actual is None or (actual["bytes"], actual["sha256"]) != (
            selected["bytes"],
            selected["sha256"],
        ):
            raise ValueError("The prebuilt model files differ from their pinned bytes.")
    arm64_executable(root / "bin/llama-server.exe")
    return rows, {
        "id": catalog["id"],
        "model": catalog["model"],
        "packSha256": hash_file(root / "pack.json")[1],
        "weightsSha256": catalog["weights"]["sha256"],
    }


def ordinary(path: Path, directory: bool) -> None:
    info = path.lstat()
    if (
        getattr(info, "st_file_attributes", 0) & 0x400
        or not (stat.S_ISDIR(info.st_mode) if directory else stat.S_ISREG(info.st_mode))
        or (not directory and info.st_nlink != 1)
    ):
        raise ValueError(
            "Runtime assembly requires ordinary, nonredirected single-link files."
        )


def read_json(path: Path, limit=1024 * 1024):
    ordinary(path, False)
    if path.stat().st_size > limit:
        raise ValueError("A runtime build receipt exceeds its bound.")
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("A runtime build receipt exceeds its actual read bound.")
    return json.loads(data)


def inventory(root: Path, *, generated_controls=False):
    ordinary(root, True)
    files = []
    names = set()
    for directory, subdirs, entries in os.walk(root, followlinks=False):
        for name in sorted(subdirs + entries):
            item = Path(directory) / name
            relative = item.relative_to(root).as_posix()
            if generated_controls and relative in {"runtime.manifest", "runtime.ready"}:
                ordinary(item, False)
                continue
            validate_relative(relative)
            folded = relative.casefold()
            if folded in names:
                raise ValueError("A runtime input has case-colliding Windows paths.")
            names.add(folded)
            if len(names) > MAX_ENTRIES:
                raise ValueError("A runtime input exceeds its bounded inventory.")
            info = item.lstat()
            is_directory = stat.S_ISDIR(info.st_mode)
            ordinary(item, is_directory)
            if is_directory:
                files.append({"path": relative, "kind": "directory"})
            else:
                size, digest = hash_file(item)
                files.append(
                    {"path": relative, "kind": "file", "bytes": size, "sha256": digest}
                )
    return sorted(files, key=lambda row: row["path"])


def arm64_executable(path: Path):
    ordinary(path, False)
    with path.open("rb") as stream:
        header = stream.read(4096)
    offset = int.from_bytes(header[60:64], "little")
    if (
        len(header) < 64
        or header[:2] != b"MZ"
        or offset < 64
        or offset > len(header) - 6
        or header[offset : offset + 6] != b"PE\0\0\x64\xaa"
    ):
        raise ValueError("The shared runtime executable must be Windows ARM64.")


def prepare_agent(agent: str, root: Path):
    if agent not in LAYOUT:
        raise ValueError("Unknown Windows runtime agent.")
    for relative in LAYOUT[agent][1]:
        ordinary(root / relative, False)
    if agent in {"langchain-deepagents-code", "nemocua"}:
        record = read_json(root / "runtime-python.json")
        if (
            record.get("classification") != "installer-finalized-agent-python"
            or record.get("agent") != agent
            or record.get("runtimeLaunchMutationRequired") is not False
            or record.get("interpreter") != "python/python.exe"
            or record.get("interpreterSha256")
            != hash_file(root / "python/python.exe")[1]
            or record.get("metadataPath") != "python/python313._pth"
            or record.get("metadataSha256")
            != hash_file(root / "python/python313._pth")[1]
        ):
            raise ValueError(
                "Per-agent Python metadata is missing or differs from its final bytes."
            )
        arm64_executable(root / "python/python.exe")
        if agent == "nemocua":
            compiled = read_json(root / "python-bytecode.json", 16 * 1024 * 1024)
            rows = compiled.get("directEntries", [])
            if (
                compiled.get("classification") != "ci-prepared-python-bytecode"
                or compiled.get("agent") != agent
                or compiled.get("pythonVersion") != record.get("pythonVersion")
                or compiled.get("platform") != "win32"
                or len(rows) != 1
                or rows[0].get("entry") != "run_with_harness.pyc"
                or rows[0].get("sourceSha256")
                != hash_file(root / "run_with_harness.py")[1]
                or hash_file(root / "run_with_harness.pyc")
                != (rows[0].get("bytecodeBytes"), rows[0].get("bytecodeSha256"))
            ):
                raise ValueError(
                    "The NemoCUA direct harness lacks exact precompiled bytecode."
                )
    # All links are rejected until the official archive's actual workspace
    # representation is reviewed. Never flatten links or accept curated Hermes.
    result = inventory(root)
    if agent == "openclaw":
        verify_openclaw_input(root, result)
    return result


def verify_hermes_input(root: Path, actual: list[dict], candidate_receipt: Path):
    candidate = read_json(candidate_receipt)
    if (
        candidate.get("classification") != "official-hermes-runtime-candidate-build"
        or candidate.get("status") != "candidate-bytes-exported"
        or candidate.get("completeByteInventory") is not True
        or candidate.get("upstreamCommit") != OFFICIAL_HERMES
        or candidate.get("profile") != "official-cli-web-tui-and-browser-use"
        or candidate.get("runtimeExecutionQualified") is not False
        or candidate.get("sourceArchiveSha256")
        != "c1f2401c8096e9372c46fa4ef8bdada18ed3cc84c0f5274562b86b7646ed3a87"
    ):
        raise ValueError("Hermes requires the complete official candidate provenance.")
    source_inventory = candidate_receipt.with_name("payload-inventory.json")
    if hash_file(source_inventory)[1] != candidate.get("inventorySha256"):
        raise ValueError("The official complete runtime inventory changed.")
    recorded = read_json(source_inventory, 256 * 1024 * 1024)
    expected = [
        {
            "path": row["path"],
            "kind": "file",
            "bytes": row["bytes"],
            "sha256": row["sha256"],
        }
        for row in recorded["files"]
        if "linkTarget" not in row
    ] + [{"path": name, "kind": "directory"} for name in recorded["directories"]]
    if any("linkTarget" in row for row in recorded["files"]):
        raise ValueError(
            "Official workspace links require a verified MSI representation before assembly."
        )
    if sorted(expected, key=lambda row: row["path"]) != actual:
        raise ValueError(
            "The complete official runtime bytes differ from their exported inventory."
        )
    marker = read_json(root / "nemoclaw-windows-runtime.json", 16 * 1024)
    if (
        marker.get("manager") != "nemoclaw-windows"
        or marker.get("hermesRevision") != OFFICIAL_HERMES
    ):
        raise ValueError("The official native metadata origin is invalid.")


def finalize_hermes(root: Path, target: PureWindowsPath):
    if os.name != "nt":
        raise ValueError("Official Hermes final-path adaptation must run on Windows.")
    helper = Path(__file__).parents[1] / "hermes/prepare-native-runtime.py"
    spec = importlib.util.spec_from_file_location("hermes_final_metadata", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # This consumes only an already adapted complete official tree. The helper
    # rechecks every prior generated hash, then changes pyvenv/direct_url metadata
    # once for the assigned install path. No package install or resolution occurs.
    changes, receipt = module.prepare_plan(
        root, root, Path(str(target)), ["hermes-agent/venv", "tools/browser-use"]
    )
    module.apply_plan(changes)
    return receipt


def write_json(path: Path, value):
    with path.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, indent=2)
        stream.write("\n")


def assemble(
    output: Path,
    sources: dict[str, Path],
    node: Path,
    node_version: str,
    source_revision: str,
    component_identity: str,
    namespace_receipt: Path,
    *,
    worker_build: Path,
    executable_build: Path,
    model_pack: Path | None = None,
    hermes_receipt: Path | None = None,
    target_install_root: str | None = None,
):
    if not sources or any(agent not in LAYOUT for agent in sources):
        raise ValueError("Runtime assembly requires explicit selected agent inputs.")
    if output.exists() or output.is_symlink():
        raise ValueError("Runtime assembly output must be fresh.")
    ordinary(output.parent, True)
    ordinary(namespace_receipt, False)
    namespace = assign(namespace_receipt, source_revision, component_identity)
    runtime_id = namespace["runtimeId"]
    arm64_executable(node)
    if node_version != "22.23.2":
        raise ValueError(
            "The finished application requires the pinned shared Node version."
        )
    application_files, application_identity = finished_application(
        worker_build, executable_build, node, source_revision
    )
    model_rows, model_identity = (
        prepare_model_pack(model_pack) if model_pack else (None, None)
    )
    if "hermes" in sources and hermes_receipt is None:
        raise ValueError("Curated or provenance-free Hermes cannot enter this layout.")
    application_files += python_workers(worker_build, sources)
    # Preflight every selected tree before creating output. Unselected agents
    # are not inspected, copied, or required to build an OpenClaw-only candidate.
    inputs = {agent: prepare_agent(agent, root) for agent, root in sources.items()}
    target = None
    if "hermes" in sources:
        if (
            not target_install_root
            or not re.fullmatch(
                r"[A-Za-z]:\\[^<>:\"|?*\x00-\x1f]+", target_install_root
            )
            or PureWindowsPath(target_install_root).parts[-2:] != ("NVIDIA", "NemoClaw")
            or any(
                part in {".", ".."} or part.endswith((" ", "."))
                for part in PureWindowsPath(target_install_root).parts[1:]
            )
        ):
            raise ValueError(
                "Hermes metadata needs the explicit fixed Program Files install target."
            )
        target = PureWindowsPath(target_install_root) / "runtimes" / runtime_id
        verify_hermes_input(sources["hermes"], inputs["hermes"], hermes_receipt)
    for root in sources.values():
        if output.resolve().is_relative_to(root.resolve()):
            raise ValueError("The build output cannot be nested in an input tree.")
    output.mkdir()
    content = output / "runtimes" / runtime_id
    content.mkdir(parents=True)
    records = []
    try:
        for source, relative in application_files:
            destination = content / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            before = hash_file(source)
            shutil.copy2(source, destination)
            if hash_file(source) != before or hash_file(destination) != before:
                raise ValueError(
                    "A finished application file changed during build copy."
                )
        write_json(content / "app/build-identity.json", application_identity)
        if model_pack is not None:
            destination = content / "inference" / model_identity["id"]
            destination.mkdir(parents=True)
            for row in model_rows:
                target_file = destination / row["path"]
                if row["kind"] == "directory":
                    target_file.mkdir(parents=True, exist_ok=True)
                else:
                    target_file.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(model_pack / row["path"], target_file)
            if (
                inventory(model_pack) != model_rows
                or inventory(destination) != model_rows
            ):
                raise ValueError(
                    "The prebuilt model pack changed during its build copy."
                )
        for agent, before in inputs.items():
            destination = content / LAYOUT[agent][0]
            destination.mkdir()
            for row in before:
                path = destination / row["path"]
                if row["kind"] == "directory":
                    path.mkdir(parents=True, exist_ok=True)
                else:
                    path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(sources[agent] / row["path"], path)
            if inventory(sources[agent]) != before or inventory(destination) != before:
                raise ValueError(
                    "A runtime source changed during its exact build copy."
                )
            adaptation = None
            if agent == "hermes":
                adaptation = finalize_hermes(destination, target / "hermes")
            records.append(
                {
                    "agent": agent,
                    "directory": LAYOUT[agent][0],
                    "inputInventorySha256": hashlib.sha256(
                        json.dumps(before, separators=(",", ":")).encode()
                    ).hexdigest(),
                    "filesCopiedAtBuild": sum(row["kind"] == "file" for row in before),
                    "bytesCopiedAtBuild": sum(row.get("bytes", 0) for row in before),
                    "finalMetadataAdaptation": adaptation,
                    "executionQualified": False,
                    "availability": "blocked-canonical-shell"
                    if agent == "hermes"
                    else "candidate",
                }
            )
        availability = {
            "schemaVersion": 1,
            "classification": "native-runtime-build-availability",
            "runtimeId": runtime_id,
            "sourceRevision": source_revision,
            "agents": [
                {
                    "agent": agent,
                    "included": agent in sources,
                    "executionQualified": False,
                    "status": "not-included"
                    if agent not in sources
                    else "blocked-canonical-shell"
                    if agent == "hermes"
                    else "candidate",
                }
                for agent in LAYOUT
            ],
        }
        write_json(content / "agent-availability.json", availability)
        encoded, identity = build(
            content, node, source_revision, node_version, runtime_id
        )
        (content / "runtime.manifest").write_bytes(encoded)
        (content / "runtime.ready").write_bytes(
            (
                "NEMOCLAW_RUNTIME_V1\n"
                + "\n".join(
                    identity[name]
                    for name in (
                        "runtimeId",
                        "manifestSha256",
                        "sourceRevision",
                        "nodeSha256",
                        "nodeVersion",
                    )
                )
                + "\n"
            ).encode("ascii")
        )
        receipt = {
            "schemaVersion": 1,
            "classification": "windows-immutable-runtime-assembly",
            "namespace": namespace,
            "runtime": identity,
            "sharedNode": {
                "installedPath": "bin/node.exe",
                "bytes": node.stat().st_size,
                "copied": False,
            },
            "runtimeInstalledPath": "runtimes/" + runtime_id,
            "pythonMetadataInstallRoot": target_install_root
            if "hermes" in sources
            else None,
            "installTargetEqualityRequired": "hermes" in sources,
            "agents": records,
            "application": application_identity,
            "localModel": model_identity,
            "deliveryContract": "finished-native-app-v1",
            "buildCompleteForSelectedAgents": True,
            "completePackage": False,
            "installedAcceptance": False,
            "activationAllowed": False,
            "runtimeLaunchCopiesRequired": False,
        }
        write_json(output / "assembly.json", receipt)
        write_json(output / "runtime-identity.json", identity)
        return receipt
    except BaseException:
        try:
            shutil.rmtree(output)
        except OSError:
            # Preserve the primary and leave the failed fresh build visible.
            import sys

            print(
                "The failed runtime build also retained its output directory.",
                file=sys.stderr,
            )
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument(
        "--agent", action="append", required=True, help="Exact ID=prepared-root"
    )
    parser.add_argument("--shared-node", type=Path, required=True)
    parser.add_argument("--node-version", required=True)
    parser.add_argument("--source-revision", required=True)
    parser.add_argument("--component-identity", required=True)
    parser.add_argument("--namespace-receipt", type=Path, required=True)
    parser.add_argument("--worker-build", type=Path, required=True)
    parser.add_argument("--executable-build", type=Path, required=True)
    parser.add_argument("--model-pack", type=Path)
    parser.add_argument("--canonical-hermes-receipt", type=Path)
    parser.add_argument("--target-install-root")
    args = parser.parse_args()
    sources = {}
    for value in args.agent:
        agent, separator, root = value.partition("=")
        if not separator or not root or agent in sources:
            raise ValueError("Agent inputs require unique explicit ID=path values.")
        sources[agent] = Path(root)
    print(
        json.dumps(
            assemble(
                args.output,
                sources,
                args.shared_node,
                args.node_version,
                args.source_revision,
                args.component_identity,
                args.namespace_receipt,
                worker_build=args.worker_build,
                executable_build=args.executable_build,
                model_pack=args.model_pack,
                hermes_receipt=args.canonical_hermes_receipt,
                target_install_root=args.target_install_root,
            )
        )
    )


if __name__ == "__main__":
    main()
