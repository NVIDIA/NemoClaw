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
import subprocess

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
HERMES_CORE_PYTHON = "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/python.exe"
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
AGENT_RUNTIME_CONTRACT = {
    "openclaw": ("OpenClaw Control UI", ["NemoClaw.Runtime.exe", "openclaw gateway"]),
    "hermes": ("Hermes dashboard and native terminal UI", ["Microsoft Edge", "Hermes Python", "OpenShell gateway"]),
    "langchain-deepagents-code": ("Deep Agents Code terminal UI", ["Deep Agents Python", "ConPTY host"]),
    "pi": ("Pi native terminal UI", ["Pi Node", "ConPTY host"]),
    "nemocua": ("NemoCUA computer-use runtime", ["NemoCUA Python", "owned visible browser"]),
}


def pe_architecture(path: Path):
    with path.open("rb") as stream:
        header = stream.read(4096)
    if len(header) < 64 or header[:2] != b"MZ":
        return None
    offset = int.from_bytes(header[60:64], "little")
    if offset < 64 or offset > len(header) - 6 or header[offset : offset + 4] != b"PE\0\0":
        return None
    return {0xAA64: "arm64", 0x8664: "x64", 0x14C: "x86"}.get(
        int.from_bytes(header[offset + 4 : offset + 6], "little"), "other"
    )


def selected_agent_audit(agent, source_rows, root, installed_root, bytecode=None):
    rows = inventory(root)
    files = [row for row in rows if row["kind"] == "file"]
    source_files = [row for row in source_rows if row["kind"] == "file"]
    support = read_json(Path(__file__).parents[1] / "agent-support.json")
    metadata = next(row for row in support["agents"] if row["id"] == agent)
    final_paths = [str(PureWindowsPath(installed_root) / row["path"]) for row in rows]
    longest = max(final_paths, key=len)
    native = []
    for row in files:
        if not row["path"].lower().endswith((".exe", ".dll", ".pyd", ".node")):
            continue
        architecture = pe_architecture(root / row["path"])
        if architecture:
            native.append({"path": row["path"], "architecture": architecture, "sha256": row["sha256"]})
    licenses = [
        {"path": row["path"], "sha256": row["sha256"]}
        for row in files
        if re.search(r"(^|[._-])(licen[cs]e|copying|notice|copyright)($|[._-])", Path(row["path"]).name, re.I)
        or row["path"] == "THIRD-PARTY-LICENSES.tar.gz"
    ]
    return {
        "schemaVersion": 1,
        "classification": "selected-agent-finished-runtime-audit",
        "countsScope": "selected runtime before and after production preparation; excludes this audit receipt",
        "agent": agent,
        "upstream": {"version": metadata["version"], "source": metadata["source"], "lockSha256": metadata.get("lockSha256")},
        "interface": AGENT_RUNTIME_CONTRACT[agent][0],
        "expectedIdleProcesses": AGENT_RUNTIME_CONTRACT[agent][1],
        "before": {"files": len(source_files), "logicalBytes": sum(row["bytes"] for row in source_files)},
        "after": {"files": len(files), "logicalBytes": sum(row["bytes"] for row in files)},
        "removed": {"files": len(source_files) - len(files), "logicalBytes": sum(row["bytes"] for row in source_files) - sum(row["bytes"] for row in files)},
        "maximumFinalInstalledPath": {"characters": len(longest), "path": longest},
        "omittedGeneratedBytecode": (bytecode or {}).get("skippedLongPathSourceFiles", 0),
        "nativeExecutables": native,
        "retainedLicenses": licenses,
        "runtimeBytesCopiedPerLaunch": 0,
        "installedQualification": False,
    }


def python_workers(build_root: Path, agents: dict[str, Path]):
    selected = []
    for agent in agents:
        if agent not in PYTHON_WORKERS:
            continue
        version, names = PYTHON_WORKERS[agent]
        root = build_root / "python" / agent
        receipt = read_json(root / "bytecode.json", 16 * 1024 * 1024)
        if agent == "hermes":
            python = agents[agent] / HERMES_CORE_PYTHON
            ordinary(python, False)
            arm64_executable(python)
            if receipt.get("pythonSha256") != hash_file(python)[1]:
                raise ValueError(
                    "The Hermes workers were not compiled by the exact shipping Python."
                )
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
    if agent == "pi":
        receipt = read_json(root / "selected-agent-build.json", 1024 * 1024)
        if (
            receipt.get("classification") != "finished-selected-node-agent"
            or receipt.get("agent") != "pi"
            or receipt.get("upstream")
            != {"package": "@earendil-works/pi-coding-agent", "version": "0.84.1"}
            or receipt.get("sourceLockSha256")
            != "6267ec58e69fc6cd53d3c753f28b0e25c00f4befdcae63e8e4924bee2abf0712"
            or receipt.get("customerBuildRequired") is not False
            or receipt.get("runtimeLaunchCopiesRequired") is not False
            or (root / "package-lock.json").exists()
        ):
            raise ValueError("Pi requires its exact finished CI dependency tree.")
    # All links are rejected until the official archive's actual workspace
    # representation is reviewed. Never flatten links or accept curated Hermes.
    result = inventory(root)
    if agent == "openclaw":
        verify_openclaw_input(root, result)
    return result


def verify_hermes_input(root: Path, actual: list[dict], candidate_receipt: Path):
    candidate, candidate_document = bound_document(candidate_receipt)
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
    recorded, inventory_document = bound_document(
        source_inventory, limit=256 * 1024 * 1024
    )
    if inventory_document[1][1] != candidate.get("inventorySha256"):
        raise ValueError("The official complete runtime inventory changed.")
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
    return candidate, candidate_document, inventory_document


def hermes_final_path_plan(module, root, target, browser_use_adapter):
    # The pinned candidate predates the current reviewed startup adapter. Upgrade
    # that adapter in-place on the complete CI copy, then perform the ordinary
    # final-path relocation and Browser Use addition against the upgraded marker.
    # Neither phase installs or resolves packages.
    upgrade, _ = module.prepare_plan(
        root,
        root,
        root,
        ["hermes-agent/venv", "tools/browser-use"],
        ci_upgrade_edge_adapter=True,
    )
    module.apply_plan(upgrade)
    changes, receipt = module.prepare_plan(
        root,
        root,
        Path(str(target)),
        ["hermes-agent/venv", "tools/browser-use"],
        ci_browser_use_adapter={
            key: browser_use_adapter[key] for key in ("bytes", "sha256")
        },
    )
    return changes, receipt


def finalize_hermes(
    root: Path,
    target: PureWindowsPath,
    source_inventory: Path,
    diagnostics: Path,
    browser_use_adapter: dict,
):
    if os.name != "nt":
        raise ValueError("Official Hermes final-path adaptation must run on Windows.")
    helper = Path(__file__).parents[1] / "hermes/prepare-native-runtime.py"
    spec = importlib.util.spec_from_file_location("hermes_final_metadata", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    changes, receipt = hermes_final_path_plan(module, root, target, browser_use_adapter)
    node_contract = root / "nemoclaw-hermes-node.json"
    node = json.loads(node_contract.read_text())
    chromium = node.pop("chromium", None)
    if (
        not isinstance(chromium, str)
        or not re.fullmatch(
            r"browsers/chromium-[0-9]+/chrome-win64/chrome\.exe", chromium
        )
        or node.get("agentBrowser")
        != "agent-browser/bin/agent-browser-win32-x64.exe"
    ):
        raise ValueError("The canonical browser input contract differs")
    node["browserHost"] = "native-edge-cdp"
    changes[node_contract] = (json.dumps(node, indent=2) + "\n").encode()
    receipt["browserDelivery"] = {
        "host": "native-arm64-microsoft-edge",
        "transport": "authenticated-session-cdp-relay",
        "bundledChromiumRemoved": True,
        "agentBrowserClientPreserved": True,
    }
    module.apply_plan(changes)
    pruning = Path(__file__).parents[1] / "hermes/prepare-production-runtime.py"
    pruning_spec = importlib.util.spec_from_file_location(
        "hermes_production_partition", pruning
    )
    pruning_module = importlib.util.module_from_spec(pruning_spec)
    pruning_spec.loader.exec_module(pruning_module)
    receipt["productionPartition"] = pruning_module.prepare(
        root, source_inventory, diagnostics
    )
    return receipt


def prepare_hermes_bytecode(root: Path, evidence: Path):
    helper = Path(__file__).parents[1] / "hermes/prepare-official-bytecode.py"
    spec = importlib.util.spec_from_file_location("hermes_bytecode", helper)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # Only the already-proven shipping interpreter compiles the finished tree.
    # -S avoids running site hooks while preparing bytes; no Hermes source runs.
    environment = {
        name: os.environ[name]
        for name in (
            "SystemRoot",
            "WINDIR",
            "SystemDrive",
            "TEMP",
            "TMP",
            "OS",
            "GITHUB_ACTIONS",
        )
        if name in os.environ
    }
    subprocess.run(
        [
            str(root / module.PYTHON),
            "-I",
            "-S",
            "-B",
            str(helper),
            "--runtime-root",
            str(root),
            "--receipt",
            str(evidence),
        ],
        env=environment,
        check=True,
        timeout=600,
    )
    compiled = read_json(evidence, 64 * 1024 * 1024)
    module.validate_receipt(root, compiled)
    result = {key: value for key, value in compiled.items() if key != "files"}
    result["fullReceiptSha256"] = hash_file(evidence)[1]
    write_json(root / "nemoclaw-python-bytecode.json", result)
    return result


def bound_document(file: Path, expected=None, limit=64 * 1024 * 1024):
    ordinary(file, False)
    with file.open("rb") as stream:
        data = stream.read(limit + 1)
    if len(data) > limit:
        raise ValueError("Hermes provenance exceeds its document bound.")
    identity = (len(data), hashlib.sha256(data).hexdigest())
    if expected is not None and identity != expected:
        raise ValueError("Hermes provenance bytes changed: " + file.name)
    value = json.loads(data)
    if not isinstance(value, dict):
        raise ValueError("Hermes provenance must be a JSON object.")
    return value, (file, identity)


def reference_document(parent: Path, record, name: str):
    if not isinstance(record, dict) or record.get("file") != name:
        raise ValueError("Hermes provenance reference differs: " + name)
    return bound_document(parent / name, (record.get("bytes"), record.get("sha256")))


def validate_hermes_executor_build(build, source_revision: str):
    if (
        build.get("classification") != "mxc-owned-token-inspection-build"
        or build.get("status") != "built"
        or build.get("candidateRevision") != source_revision
        or build.get("sourceCommit") != "7dac1a952f0c9ad13f0a4cb089c4e0e8b3e0013a"
        or build.get("sourceSha256")
        != "814659a1db0b4cd06854066705f274bba2b2702f563735d69ba72a407c0ad258"
        or build.get("target") != "aarch64-pc-windows-msvc"
        or build.get("compilerClosed") is not True
        or build.get("compilerForced") is not False
        or build.get("compilerExitCode") != 0
        or build.get("compilerCleanupErrors") != []
        or build.get("tokenQueryRepairSupported") is not True
        or build.get("tokenAccessMode") != "owned-child-query-only"
        or len(build.get("files", [])) != 1
    ):
        raise ValueError("The same-source Hermes executor build did not complete.")
    executable = build["files"][0]
    if executable.get("file") != "wxc-exec.exe" or executable.get("machine") != 0xAA64:
        raise ValueError(
            "The canonical Hermes executor is not the expected ARM64 file."
        )
    return executable


def hermes_executor_files(directory: Path, build_file: Path, source_revision: str):
    """Verify finished executor bytes from the same-source native proof."""
    build, document = bound_document(build_file)
    executable = validate_hermes_executor_build(build, source_revision)
    ordinary(directory, True)
    result = []
    for name, expected in (
        ("wxc-exec.exe", executable.get("sha256")),
        ("MXC-LICENSE.txt", build.get("licenseSha256")),
        ("NEMOCLAW-LICENSE.txt", build.get("nemoClawLicenseSha256")),
    ):
        source = directory / name
        ordinary(source, False)
        size, sha = hash_file(source)
        if (
            not isinstance(expected, str)
            or not re.fullmatch(r"[a-f0-9]{64}", expected)
            or sha != expected
        ):
            raise ValueError("A canonical Hermes executor input changed: " + name)
        if name == "wxc-exec.exe":
            if size != executable.get("bytes"):
                raise ValueError("The canonical Hermes executor size changed.")
            arm64_executable(source)
        result.append((source, "mxc-compat/" + name, (size, sha), None))
    result.append((document[0], "mxc-compat/mxc-build.json", document[1], None))
    return build, result


NATIVE_SOURCE_ROOT = Path(__file__).parents[1] / "mxc-bash"
NATIVE_SOURCE_FILES = {
    "compat-launcher.cpp",
    "process-propagation.cpp",
    "process-propagation.h",
    "namespace-compat.cpp",
    "namespace-path.h",
    "namespace-security.h",
    "namespace-controls.cpp",
    "compat.def",
}
COMPATIBILITY_MEMBERS = {
    "NemoClawMsysLauncher.exe": "arm64",
    "NemoClawMsysCompat-arm64.dll": "arm64",
    "NemoClawMsysCompat-x64.dll": "x64",
}

# The replay is of one already-exported complete runtime, never a general
# permission to mix a candidate with an unrelated Personal controller.
PERSONAL_REPLAY_BASE = {
    "artifactId": 10293082661,
    "runId": 34679482914,
    "sourceRevision": "8d78fe458e9268a7afdc8ed06b85c23306452036",
    "bytes": 1073328197,
    "sha256": "753aa3e7addcc1c274b4a59b6785706715ccba661eaa31bfe77a95e20271bda1",
    "candidateReceiptSha256": "c682b3cd2f9691ad7d65312682522b59a5a5105c19688621153261d92c4f1c4f",
    "inventorySha256": "f4df172630b7f5ae6ec9cc9cf9c54b4744c2b0046cb15859f9469ff9bfe7a0e2",
    "startupAdapterSha256": "58a55abda6045e4919da5e56042d21768e72bab3be1e7444a4f65eb850941f65",
    "runtimeRoot": r"C:\NemoClawHermesProbe-274d797050ea",
}


def personal_replay_lineage(personal, candidate, candidate_identity, actual, parent):
    replay = personal.get("runtimeReplay")
    if replay is None:
        if personal.get("sourceRevision") != candidate.get("controllerSource"):
            raise ValueError(
                "A different Personal controller requires the exact finished replay."
            )
        return []
    if (
        replay.get("schemaVersion") != 1
        or replay.get("classification") != "immutable-canonical-hermes-personal-replay"
        or replay.get("base") != PERSONAL_REPLAY_BASE
        or not re.fullmatch(r"[a-f0-9]{40}", personal.get("sourceRevision", ""))
        or replay.get("controllerSource") != personal.get("sourceRevision")
        or replay.get("runtimeRoot") != PERSONAL_REPLAY_BASE["runtimeRoot"]
        or personal.get("runtime") != replay.get("runtimeRoot")
        or candidate.get("controllerSource") != PERSONAL_REPLAY_BASE["sourceRevision"]
        or candidate_identity[1] != PERSONAL_REPLAY_BASE["candidateReceiptSha256"]
        or candidate.get("inventorySha256") != PERSONAL_REPLAY_BASE["inventorySha256"]
        or candidate.get("startupAdapterSha256")
        != PERSONAL_REPLAY_BASE["startupAdapterSha256"]
        or any(
            replay.get(key) is not True
            for key in (
                "completeZipVerified",
                "completeNestedArchiveVerified",
                "sourceBuildProvenanceVerified",
                "nativeComponentUnchanged",
            )
        )
        or any(
            replay.get(key) is not False
            for key in (
                "runtimeRebuilt",
                "runtimeRelocated",
                "runtimeExported",
                "runtimeExecutionQualified",
                "installedAcceptance",
            )
        )
    ):
        raise ValueError(
            "The Personal replay is not bound to the exact immutable canonical base."
        )
    for key in ("before", "after"):
        scan = replay.get(key, {})
        if (
            not isinstance(scan, dict)
            or scan.get("allFilesAndDirectoriesVerified") is not True
            or scan.get("inventorySha256") != candidate["inventorySha256"]
            or scan.get("files") != candidate.get("fileCount")
            or scan.get("logicalBytes") != candidate.get("logicalBytes")
        ):
            raise ValueError(
                "The Personal replay requires its complete before/after inventory."
            )

    native = replay.get("nativeComponent", {})
    references = native.get("documents", {})
    documents = {}
    lineage = []
    for key, name in (
        ("proof", "current-native-proof.json"),
        ("compatibility", "current-msys-build.json"),
        ("mxc", "current-mxc-build.json"),
    ):
        value, document = reference_document(parent, references.get(key), name)
        documents[key] = value
        lineage.append((*document, "personal-replay/" + name))
    proof, build, mxc = (documents[key] for key in ("proof", "compatibility", "mxc"))
    source = native.get("sourceRevision", "")
    if (
        not re.fullmatch(r"[a-f0-9]{40}", source)
        or proof.get("classification") != "small-msys-appcontainer-compatibility-proof"
        or proof.get("sourceRevision") != source
        or proof.get("passed") is not True
        or proof.get("normalCleanup") is not True
        or proof.get("phase") != "two-container-isolation"
        or build.get("classification") != "mxc-msys-compatibility-prototype-build"
        or build.get("status") != "built"
        or build.get("sourceRevision") != source
        or build.get("cleanupErrors") != []
        or proof.get("inputs", {}).get("compatibility") != build
        or proof.get("inputs", {}).get("mxcBuild") != mxc
    ):
        raise ValueError(
            "The Personal replay current native proof did not pass or differs."
        )
    executor = validate_hermes_executor_build(mxc, source)
    before = {row["path"]: row for row in actual if row["kind"] == "file"}
    git = proof.get("inputs", {}).get("git", {})
    if set(git) != {
        "bin/bash.exe",
        "bin/sh.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/msys-2.0.dll",
    } or any(
        before.get("git/" + name, {}).get("sha256") != sha for name, sha in git.items()
    ):
        raise ValueError("The Personal replay used different canonical Git images.")
    members = build.get("files", [])
    license_record = build.get("license", {})
    if (
        len(members) != 3
        or {row.get("file") for row in members} != set(COMPATIBILITY_MEMBERS)
        or any(
            row.get("machine") != COMPATIBILITY_MEMBERS[row["file"]] for row in members
        )
        or license_record.get("file") != "DETOURS-LICENSE.txt"
    ):
        raise ValueError("The Personal replay native file set differs.")
    for key in ("proof", "build"):
        reference = references["compatibility" if key == "build" else key]
        identity = native.get(key, {})
        if (identity.get("bytes"), identity.get("sha256")) != (
            reference["bytes"],
            reference["sha256"],
        ):
            raise ValueError("The Personal replay executed input document differs.")
    executed = native.get("executor", {})
    host = personal.get("hostInputs", {})
    if (
        executed != host.get("mxc")
        or personal.get("execution", {}).get("executable") != executed.get("path")
        or executed.get("bytes") != executor.get("bytes")
        or executed.get("sha256") != executor.get("sha256")
        or executed.get("peMachine") != 0xAA64
        or PureWindowsPath(executed.get("path", "")).name != "wxc-exec.exe"
        or proof.get("inputs", {}).get("mxcSha256") != executor.get("sha256")
        or host.get("compatibility")
        != {
            "sourceRevision": source,
            "files": members,
            "license": license_record,
            "mxcFile": executor,
            "gitPins": git,
        }
    ):
        raise ValueError(
            "The Personal replay executed native identities differ from their proof."
        )
    nonce = personal.get("workload", {}).get("nonce", "")
    if not re.fullmatch(r"[a-f0-9]{24}", nonce):
        raise ValueError("The Personal replay owned launch nonce is missing.")
    native_root = "C:\\NemoClawPersonalCompat-" + nonce[:12]
    staged = native.get("files", [])
    expected = [
        *members,
        license_record,
        {**references["compatibility"], "file": "build-receipt.json"},
    ]
    if (
        native.get("root") != native_root
        or len(staged) != len(expected)
        or {row.get("file") for row in staged} != {row["file"] for row in expected}
    ):
        raise ValueError("The Personal replay staged native component differs.")
    indexed = {row["file"]: row for row in staged}
    for row in expected:
        copied = indexed[row["file"]]
        if copied.get("path") != str(PureWindowsPath(native_root) / row["file"]) or any(
            copied.get(key) != row.get(key) for key in ("bytes", "sha256", "machine")
        ):
            raise ValueError("The Personal replay staged native file identity differs.")
    # The request is retained by the CI controller before execution. Bind its
    # selected launcher and read-only stage without reopening deleted CI paths.
    request, document = bound_document(
        parent / "personal-request.json", limit=64 * 1024
    )
    if document[1][1] != personal.get("requestSha256"):
        raise ValueError("The Personal replay executed request differs.")
    command = request.get("process", {}).get("commandLine", "")
    readonly = request.get("filesystem", {}).get("readonlyPaths", [])
    state = "C:\\NemoClawMsysProof-" + nonce[:12] + "-state-start"
    if (
        not command.startswith('"' + native_root + '\\NemoClawMsysLauncher.exe" "--" ')
        or native_root not in readonly
        or replay["runtimeRoot"] not in readonly
        or request.get("containerId") != "nm-" + nonce[:12] + "-start"
        or request.get("process", {}).get("cwd") != state
        or request.get("filesystem", {}).get("readwritePaths") != [state]
    ):
        raise ValueError(
            "The Personal replay did not execute its proved read-only launcher."
        )
    lineage.append((*document, "personal-replay/personal-request.json"))
    return lineage


def hermes_composition(
    root,
    actual,
    candidate_file,
    personal_file,
    compatibility_directory,
    proof_file,
    executor_directory,
    source_revision,
):
    candidate, candidate_document, inventory_document = verify_hermes_input(
        root, actual, candidate_file
    )
    personal, personal_document = bound_document(personal_file)
    edge_mode = personal.get("browserMode") == "host-native-edge-cdp"
    expected_personal_pass = not edge_mode
    recorded_candidate = personal.get("derivedRuntime", {}).get("candidate", {})
    components = personal.get("workload", {}).get("components", [])
    execution = personal.get("execution", {})
    if (
        personal.get("classification") != "canonical-personal-mxc-feasibility"
        or personal.get("feasibilityPassed") is not expected_personal_pass
        or personal.get("candidateSource") != candidate.get("controllerSource")
        or recorded_candidate.get("value") != candidate
        or (recorded_candidate.get("bytes"), recorded_candidate.get("sha256"))
        != candidate_document[1]
        or personal.get("privateStateLeaseTested") is not False
        or personal.get("installedAcceptance") is not False
        or personal.get("fullAgentQualified") is not False
        or personal.get("cleanupErrors") != []
        or (not edge_mode and personal.get("error") is not None)
        or personal.get("workload", {}).get("passed") is not expected_personal_pass
        or len(components) != 4
        or {row.get("component") for row in components}
        != {"python", "bash", "conpty", "browser"}
        or any(
            row.get("passed") is not True
            or row.get("result", {}).get("passed") is not True
            or row.get("result", {}).get("component") != row.get("component")
            or row.get("execution", {}).get("exitCode") != 0
            or row.get("execution", {}).get("childClosed") is not True
            or row.get("execution", {}).get("timedOut") is not False
            or row.get("execution", {}).get("outputExceeded") is not False
            for row in components
            if not edge_mode or row.get("component") != "browser"
        )
        or (not edge_mode and execution.get("exitCode") != 0)
        or execution.get("childClosed") is not True
        or execution.get("timedOut") is not False
        or execution.get("outputExceeded") is not False
        or any(
            personal.get("cleanup", {}).get(key) is not True
            for key in (
                "executorClosed",
                "hostDiagnosticChildrenClosed",
                "profileDeleted",
                "ownedRootsRemoved",
            )
        )
    ):
        raise ValueError(
            "Hermes requires its exact passing Personal component proof and cleanup."
        )
    if edge_mode:
        browser_failure = next(row for row in components if row["component"] == "browser")
        edge = personal.get("edgePrerequisite", {})
        if (
            personal.get("installedAcceptanceRequired") is not True
            or browser_failure.get("passed") is not False
            or browser_failure.get("execution", {}).get("childClosed") is not True
            or browser_failure.get("execution", {}).get("timedOut") is not False
            or browser_failure.get("execution", {}).get("outputExceeded") is not False
            or edge.get("classification") != "native-arm64-microsoft-edge"
            or edge.get("architecture") != "arm64"
            or edge.get("machine") != 0xAA64
            or edge.get("signatureStatus") != "Valid"
            or edge.get("provenance") != "standard-windows-microsoft-edge-installation"
            or edge.get("executed") is not False
        ):
            raise ValueError("Hermes host Edge build admission differs.")
    browser_helper = Path(__file__).parents[1] / "hermes/nemoclaw_browser_use.py"
    helper_bytes, helper_sha = hash_file(browser_helper)
    adapter = personal.get("browserUseLaunchAdapter", {})
    browser = next(row for row in components if row["component"] == "browser")
    applied = browser.get("result", {}).get("browserLauncherAdaptation", {})
    identities = [adapter.get(key, {}) for key in ("source", "staged", "document")]
    identities.append(applied.get("source", {}))
    if (
        any(
            (row.get("bytes"), row.get("sha256")) != (helper_bytes, helper_sha)
            for row in identities
        )
        or applied.get("classification") != "owned-browser-use-module-launch"
        or applied.get("trampolineBypassed") is not True
        or applied.get("runtimeBytesModified") is not False
    ):
        raise ValueError(
            "Installed Browser Use must use the same helper that passed Personal."
        )
    browser_use_adapter = {
        "file": browser_helper.name,
        "bytes": helper_bytes,
        "sha256": helper_sha,
        "personalSource": personal["sourceRevision"],
        "personalProofSha256": personal_document[1][1],
        "entryPointsSha256": applied.get("entryPointsSha256"),
        "moduleSha256": applied.get("moduleSha256"),
        "executionQualified": False,
    }
    replay_lineage = personal_replay_lineage(
        personal, candidate, candidate_document[1], actual, personal_file.parent
    )
    # Inventory validation precedes every copy and replacement. Its expected
    # receipt is pinned by the already-passed Personal candidate above.
    if hash_file(candidate_file) != candidate_document[1]:
        raise ValueError("Canonical Hermes receipt changed during preflight.")
    parent = candidate_file.parent
    derivation, derivation_document = reference_document(
        parent, candidate.get("derivation"), "candidate-derivation.json"
    )
    if derivation != personal.get("derivedRuntime", {}).get("derivation", {}).get(
        "value"
    ):
        raise ValueError("Canonical Hermes derivation differs from the Personal proof.")
    lineage = [
        (*candidate_document, "runtime-candidate.json"),
        (*derivation_document, "candidate-derivation.json"),
        (*personal_document, "personal-feasibility.json"),
        *replay_lineage,
    ]
    lineage.append((*inventory_document, "payload-inventory.json"))
    for key, name in (
        ("pywinpty", "pywinpty-rebuild.json"),
        ("git", "canonical-git-derivation.json"),
        ("compatibility", "msys-build.json"),
        ("compatibilityProof", "bash-compatibility-proof.json"),
        ("mxc", "mxc-build.json"),
    ):
        _, document = reference_document(parent, derivation.get(key), name)
        lineage.append((*document, name))
    proof, proof_document = bound_document(proof_file)
    compatibility_file = compatibility_directory / "build-receipt.json"
    compatibility, compatibility_document = bound_document(compatibility_file)
    build_file = executor_directory / "mxc-token-inspection-build.json"
    executor, files = hermes_executor_files(
        executor_directory, build_file, source_revision
    )
    if (
        proof.get("classification") != "small-msys-appcontainer-compatibility-proof"
        or proof.get("sourceRevision") != source_revision
        or proof.get("passed") is not True
        or proof.get("normalCleanup") is not True
        or proof.get("phase") != "two-container-isolation"
        or compatibility.get("classification")
        != "mxc-msys-compatibility-prototype-build"
        or compatibility.get("status") != "built"
        or compatibility.get("sourceRevision") != source_revision
        or compatibility.get("cleanupErrors") != []
        or proof.get("inputs", {}).get("compatibility") != compatibility
        or proof.get("inputs", {}).get("mxcBuild") != executor
        or proof.get("inputs", {}).get("mxcSha256") != executor["files"][0]["sha256"]
        or executor.get("patchSha256")
        != hash_file(NATIVE_SOURCE_ROOT / "mxc-token-inspection.patch")[1]
    ):
        raise ValueError(
            "Hermes compatibility requires the same-source passed native proof."
        )
    source_files = compatibility.get("sourceFiles", [])
    if (
        len(source_files) != len(NATIVE_SOURCE_FILES)
        or {row.get("path") for row in source_files} != NATIVE_SOURCE_FILES
    ):
        raise ValueError("The compatibility source-file set changed.")
    for row in source_files:
        if hash_file(NATIVE_SOURCE_ROOT / row["path"])[1] != row.get("sha256"):
            raise ValueError("The native compatibility source differs from its proof.")
    before = {
        row["path"]: (row["bytes"], row["sha256"])
        for row in actual
        if row["kind"] == "file"
    }
    git = proof.get("inputs", {}).get("git", {})
    if set(git) != {
        "bin/bash.exe",
        "bin/sh.exe",
        "usr/bin/bash.exe",
        "usr/bin/sh.exe",
        "usr/bin/msys-2.0.dll",
    } or any(
        before.get("git/" + name, (None, None))[1] != sha for name, sha in git.items()
    ):
        raise ValueError("The new native proof used different canonical Git images.")
    members = compatibility.get("files", [])
    if (
        len(members) != 3
        or {row.get("file") for row in members} != set(COMPATIBILITY_MEMBERS)
        or any(
            row.get("machine") != COMPATIBILITY_MEMBERS[row["file"]] for row in members
        )
    ):
        raise ValueError("The compatibility binary set changed.")
    license_record = compatibility.get("license", {})
    if license_record.get("file") != "DETOURS-LICENSE.txt":
        raise ValueError("The compatibility license is missing.")
    for row in [
        *members,
        license_record,
        {
            "file": "build-receipt.json",
            "bytes": compatibility_document[1][0],
            "sha256": compatibility_document[1][1],
        },
    ]:
        name = row["file"]
        source = compatibility_directory / name
        ordinary(source, False)
        expected = (row.get("bytes"), row.get("sha256"))
        relative = "mxc-compat/" + name
        if hash_file(source) != expected or relative not in before:
            raise ValueError(
                "A native compatibility input or canonical replacement changed."
            )
        if name == "DETOURS-LICENSE.txt":
            if before[relative] != expected:
                raise ValueError(
                    "The proved Detours license differs from the retained canonical license."
                )
            continue
        if name in COMPATIBILITY_MEMBERS:
            with source.open("rb") as stream:
                header = stream.read(4096)
            offset = int.from_bytes(header[60:64], "little")
            machine = (
                b"\x64\xaa" if COMPATIBILITY_MEMBERS[name] == "arm64" else b"\x64\x86"
            )
            if (
                len(header) < 64
                or header[:2] != b"MZ"
                or offset < 64
                or offset > len(header) - 6
                or header[offset : offset + 6] != b"PE\0\0" + machine
            ):
                raise ValueError(
                    "A compatibility binary has a different PE architecture."
                )
        files.append((source, relative, expected, before[relative]))
    for source, expected, name in lineage:
        files.append(
            (source, "mxc-compat/provenance/canonical/" + name, expected, None)
        )
    files.append(
        (
            proof_document[0],
            "mxc-compat/native-compatibility-proof.json",
            proof_document[1],
            None,
        )
    )
    receipt = {
        "schemaVersion": 1,
        "classification": "installed-hermes-native-composition",
        "sourceRevision": source_revision,
        "canonicalSource": candidate["controllerSource"],
        "canonicalCandidateSha256": candidate_document[1][1],
        "personalProofSha256": personal_document[1][1],
        "personalSource": personal["sourceRevision"],
        "browserMode": "host-native-edge-cdp" if edge_mode else "contained-canonical-browser",
        "browserUseAdapter": browser_use_adapter,
        "nativeProofSha256": proof_document[1][1],
        "compatibilityBuildSha256": compatibility_document[1][1],
        "executorBuildSha256": files[3][2][1],
        "privateStateLeaseTested": False,
        "installedAcceptance": False,
        "fullAgentQualified": False,
        "canonicalBaseVerifiedBeforeCopy": True,
        "nousFilesReplaced": False,
        "detoursLicensePreserved": license_record,
        "files": [
            {
                "path": relative,
                "bytes": expected[0],
                "sha256": expected[1],
                "before": None if old is None else {"bytes": old[0], "sha256": old[1]},
            }
            for _, relative, expected, old in files
        ],
    }
    return files, receipt


def copy_hermes_composition(destination: Path, files):
    for source, relative, expected, previous in files:
        ordinary(source, False)
        if hash_file(source) != expected:
            raise ValueError("A Hermes composition input changed after preflight.")
        target = destination / relative
        if previous is None:
            if target.exists() or target.is_symlink():
                raise ValueError("A Hermes composition destination already exists.")
        else:
            ordinary(target, False)
            if hash_file(target) != previous:
                raise ValueError("A canonical Hermes replacement changed after copy.")
            target.unlink()
        target.parent.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as incoming, target.open("xb") as outgoing:
            shutil.copyfileobj(incoming, outgoing)
        if hash_file(source) != expected or hash_file(target) != expected:
            raise ValueError("A Hermes composition input changed during copy.")


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
    hermes_executor: Path | None = None,
    hermes_personal_proof: Path | None = None,
    hermes_compatibility: Path | None = None,
    hermes_compatibility_proof: Path | None = None,
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
    native_inputs = (
        hermes_executor,
        hermes_personal_proof,
        hermes_compatibility,
        hermes_compatibility_proof,
    )
    if ("hermes" in sources and any(value is None for value in native_inputs)) or (
        "hermes" not in sources and any(value is not None for value in native_inputs)
    ):
        raise ValueError(
            "Only selected Hermes requires its explicit canonical Personal and native compatibility proofs."
        )
    application_files += python_workers(worker_build, sources)
    # Preflight every selected tree before creating output. Unselected agents
    # are not inspected, copied, or required to build an OpenClaw-only candidate.
    inputs = {agent: prepare_agent(agent, root) for agent, root in sources.items()}
    target = None
    composition_files = []
    composition_receipt = None
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
        composition_files, composition_receipt = hermes_composition(
            sources["hermes"],
            inputs["hermes"],
            hermes_receipt,
            hermes_personal_proof,
            hermes_compatibility,
            hermes_compatibility_proof,
            hermes_executor,
            source_revision,
        )
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
            bytecode = None
            if agent == "hermes":
                copy_hermes_composition(destination, composition_files)
                write_json(
                    destination / "mxc-compat/composition.json", composition_receipt
                )
                adaptation = finalize_hermes(
                    destination,
                    target / "hermes",
                    destination
                    / "mxc-compat/provenance/canonical/payload-inventory.json",
                    output / "hermes-production-diagnostics",
                    composition_receipt["browserUseAdapter"],
                )
                adaptation["nativeCompatibilityComposition"] = composition_receipt
                adaptation["executorBuildSha256"] = composition_receipt[
                    "executorBuildSha256"
                ]
                # Keep failure evidence outside the disposable assembly output.
                bytecode = prepare_hermes_bytecode(
                    destination, output.with_name(output.name + "-hermes-bytecode.json")
                )
            installed_agent_root = (
                PureWindowsPath(target_install_root or r"C:\Program Files\NVIDIA\NemoClaw")
                / "runtimes"
                / runtime_id
                / LAYOUT[agent][0]
            )
            audit = selected_agent_audit(
                agent, before, destination, installed_agent_root, bytecode
            )
            if audit["maximumFinalInstalledPath"]["characters"] >= 260:
                raise ValueError(
                    "A selected-agent final installed path exceeds the Windows limit."
                )
            write_json(destination / "nemoclaw-runtime-audit.json", audit)
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
                    **({"pythonBytecodePreparation": bytecode} if bytecode else {}),
                    "runtimeAudit": audit,
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
    parser.add_argument("--hermes-executor-directory", type=Path)
    parser.add_argument("--canonical-hermes-personal-proof", type=Path)
    parser.add_argument("--hermes-compatibility-directory", type=Path)
    parser.add_argument("--hermes-compatibility-proof", type=Path)
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
                hermes_executor=args.hermes_executor_directory,
                hermes_personal_proof=args.canonical_hermes_personal_proof,
                hermes_compatibility=args.hermes_compatibility_directory,
                hermes_compatibility_proof=args.hermes_compatibility_proof,
                target_install_root=args.target_install_root,
            )
        )
    )


if __name__ == "__main__":
    main()
