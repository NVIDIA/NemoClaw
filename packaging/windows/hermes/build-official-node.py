# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Build upstream's CLI workspaces outside the runtime; retain exact production outputs."""

import hashlib
import json
import os
from pathlib import Path
import shutil

PROFILE = "official-prebuilt-cli-web-tui"
SIDECARS = ("plugins/platforms/photon/sidecar", "scripts/whatsapp-bridge")
OUTPUTS = ("ui-tui/dist", "hermes_cli/web_dist")


def digest(file):
    with Path(file).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def regular_inventory(directory):
    directory = Path(directory)
    rows = []
    for current, dirs, files in os.walk(directory, followlinks=False):
        for name in [*dirs, *files]:
            entry = Path(current) / name
            if (
                entry.is_symlink()
                or getattr(entry.lstat(), "st_file_attributes", 0) & 0x400
            ):
                raise ValueError("A production output contains a link or reparse point")
        for name in sorted(files):
            file = Path(current) / name
            if not file.is_file():
                raise ValueError("A production output is not a regular file")
            rows.append(
                {
                    "path": file.relative_to(directory).as_posix(),
                    "bytes": file.stat().st_size,
                    "sha256": digest(file),
                }
            )
    if not rows:
        raise ValueError("The official production output is empty")
    return sorted(rows, key=lambda row: row["path"])


def copy_output(build, source, relative):
    origin, target = Path(build) / relative, Path(source) / relative
    rows = regular_inventory(origin)
    if target.exists():
        raise ValueError("The production output destination is not fresh")
    shutil.copytree(origin, target, symlinks=False)
    if regular_inventory(target) != rows:
        raise ValueError("The production output changed while it was copied")
    return {"path": relative, "files": rows, "bytes": sum(row["bytes"] for row in rows)}


def preserve_notices(build, runtime):
    """Keep the complete installed compiler graph's declared licenses and notice files."""
    build, runtime = Path(build), Path(runtime)
    lock = json.loads((build / "package-lock.json").read_text(encoding="utf-8"))
    target = runtime / "licenses/hermes-node-build"
    target.mkdir(parents=True)
    packages = []
    for location, package in sorted(lock["packages"].items()):
        if not location.startswith("node_modules/") or package.get("link"):
            continue
        folder = build / location
        if not folder.is_dir():
            continue
        metadata = json.loads((folder / "package.json").read_text(encoding="utf-8"))
        if metadata["version"] != package["version"]:
            raise ValueError("A bundled compiler input differs from the official lock")
        files = []
        for file in sorted(folder.iterdir()):
            if file.is_file() and file.name.lower().startswith(
                ("license", "licence", "notice", "copying", "copyright")
            ):
                relative = Path(location) / file.name
                output = target / relative
                output.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(file, output)
                files.append({"path": relative.as_posix(), "sha256": digest(output)})
        packages.append(
            {
                "location": location,
                "name": metadata["name"],
                "version": metadata["version"],
                "license": metadata.get("license"),
                "files": files,
            }
        )
    if not packages:
        raise ValueError("No build dependency notices were retained")
    (target / "packages.json").write_text(
        json.dumps(packages, indent=2) + "\n", encoding="utf-8"
    )
    return {
        "path": str(target.relative_to(runtime)),
        "packages": len(packages),
        "sha256": digest(target / "packages.json"),
    }


def build_selected(*, runtime, evidence, source_archive, npm_root, extract, invoke):
    runtime, evidence, npm_root = Path(runtime), Path(evidence), Path(npm_root)
    source, build = runtime / "hermes-agent", evidence / "node-build"
    node, npm_cli = runtime / "node/node.exe", npm_root / "bin/npm-cli.js"
    if (
        json.loads((npm_root / "package.json").read_text(encoding="utf-8"))["version"]
        != "12.0.2"
    ):
        raise ValueError("The official CI compiler npm version differs")
    extract(source_archive, build, "tar.gz")
    lock_hash = digest(build / "package-lock.json")
    invoke(
        node,
        [
            npm_cli,
            "ci",
            "--workspace",
            "ui-tui",
            "--workspace",
            "web",
            "--include-workspace-root",
            "--no-audit",
            "--no-fund",
        ],
        cwd=build,
        label="official-cli-npm-ci",
    )
    for workspace in ("ui-tui", "web"):
        invoke(
            node,
            [npm_cli, "run", "build", "--workspace", workspace],
            cwd=build,
            label="build-" + workspace,
        )
    if (
        digest(build / "package-lock.json") != lock_hash
        or digest(source / "package-lock.json") != lock_hash
    ):
        raise ValueError("The official CLI build changed its locked graph")
    for relative in (
        "apps/desktop/node_modules/electron",
        "node_modules/electron",
        "node_modules/get-windows",
    ):
        if (build / relative).exists():
            raise ValueError("The CLI build unexpectedly selected desktop dependencies")
    if (
        not (build / "ui-tui/dist/entry.js").is_file()
        or not (build / "hermes_cli/web_dist/index.html").is_file()
    ):
        raise ValueError("The official CLI build omitted its TUI or static dashboard")
    outputs = [copy_output(build, source, relative) for relative in OUTPUTS]
    notices = preserve_notices(build, runtime)
    # This is the canonical prebuilt launch branch: no build workspace is an
    # ancestor and no node_modules tree is installed beside either output.
    if (source / "node_modules").exists() or (source / "ui-tui/node_modules").exists():
        raise ValueError("Build-only dependencies leaked into the production CLI")
    invoke(
        node,
        ["--check", source / "ui-tui/dist/entry.js"],
        cwd=runtime,
        label="prebuilt-tui-syntax",
    )
    result = invoke(
        node,
        [source / "ui-tui/dist/entry.js"],
        cwd=runtime,
        label="prebuilt-tui-nontty",
    )
    output = Path(result["stdout"]).read_text(encoding="utf-8") + Path(
        result["stderr"]
    ).read_text(encoding="utf-8")
    if "hermes-tui: no TTY" not in output:
        raise ValueError(
            "The isolated prebuilt TUI did not reach its official non-TTY guard"
        )
    sidecars = []
    for relative in SIDECARS:
        folder = source / relative
        original = digest(folder / "package-lock.json")
        invoke(
            node,
            [npm_cli, "ci", "--omit=dev", "--no-audit", "--no-fund"],
            cwd=folder,
            label="sidecar-install-" + folder.name,
        )
        graph = invoke(
            node,
            [npm_cli, "ls", "--omit=dev", "--all", "--json"],
            cwd=folder,
            label="sidecar-graph-" + folder.name,
        )
        imports = (
            "spectrum-ts"
            if relative == "plugins/platforms/photon/sidecar"
            else "@whiskeysockets/baileys"
        )
        invoke(
            node,
            [
                "--input-type=module",
                "-e",
                "await import("
                + json.dumps(imports)
                + "); console.log('HERMES_SIDECAR_IMPORT_OK')",
            ],
            cwd=folder,
            label="sidecar-import-" + folder.name,
        )
        if digest(folder / "package-lock.json") != original:
            raise ValueError("The official sidecar lock changed")
        if relative == "scripts/whatsapp-bridge":
            # Exact existing adapter stamp contract: first 16 hex SHA256(package.json).
            (folder / "node_modules/.hermes-pkg-hash").write_text(
                digest(folder / "package.json")[:16], encoding="utf-8"
            )
        sidecars.append(
            {
                "path": relative,
                "lockSha256": original,
                "graphSha256": digest(graph["stdout"]),
                "networkQualification": False,
            }
        )
    return {
        "schemaVersion": 1,
        "profile": PROFILE,
        "npmVersion": "12.0.2",
        "lockSha256": lock_hash,
        "upstreamLockUnchanged": True,
        "outputs": outputs,
        "notices": notices,
        "sidecars": sidecars,
        "neighboringBuildDependenciesAbsent": True,
        "tuiNonTtyImports": True,
        "interactiveTuiQualified": False,
        "browserQualified": False,
        "desktopSelected": False,
    }
