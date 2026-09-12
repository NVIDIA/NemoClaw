# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Adapt only generated metadata in a complete official Windows Hermes runtime.

Run before the first Python launch at the destination root. This never installs
or resolves packages, edits upstream source, or rewrites executable bytes.
"""

from __future__ import annotations

import argparse
import ast
import base64
import csv
import configparser
from email.parser import Parser
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import uuid

REVISION = "2237be355906fbe6065ce1815711eee52b2d646e"
MARKER = "nemoclaw-windows-runtime.json"
HOOK = "nemoclaw_native_windows.py"
PTH = "000_nemoclaw_native_windows.pth"
MAX_METADATA = 1024 * 1024

# One explicit CI transition from the complete canonical candidate (47d8907).
PREVIOUS_ADAPTER_SHA256 = (
    "3f8f0b14af77dedee4504bc112869a90fe89b0c8f93c434d0f29313e74bfd1fd"
)
UPGRADED_ADAPTER_SHA256 = (
    "58a55abda6045e4919da5e56042d21768e72bab3be1e7444a4f65eb850941f65"
)
PREVIOUS_MARKER_SHA256 = (
    "659227b44a6a75ac8436c995ab5b8e719b2ad06f5116c49f19032a14b0b09136"
)
UPGRADE_HOOK_PATHS = (
    "hermes-agent/.hermes-runtime/python/cpython-3.11.16-windows-aarch64-none/Lib/site-packages/"
    + HOOK,
    "hermes-agent/venv/Lib/site-packages/" + HOOK,
    "tools/browser-use/Lib/site-packages/" + HOOK,
)


def adapter_upgrade_record():
    return {
        "schemaVersion": 1,
        "baseCandidateSource": "47d890728482cca05e840edd27e33e3d495aeabf",
        "previousMarkerSha256": PREVIOUS_MARKER_SHA256,
        "beforeSha256": PREVIOUS_ADAPTER_SHA256,
        "afterSha256": UPGRADED_ADAPTER_SHA256,
        "hookPaths": list(UPGRADE_HOOK_PATHS),
    }


class AdaptationError(Exception):
    pass


def read_metadata(path: Path, root: Path) -> bytes:
    try:
        path.resolve(strict=True).relative_to(root)
        info = path.lstat()
    except (OSError, ValueError) as error:
        raise AdaptationError(
            "Generated metadata is outside the owned runtime or missing."
        ) from error
    if (
        not stat.S_ISREG(info.st_mode)
        or getattr(info, "st_file_attributes", 0) & 0x400
        or info.st_size > MAX_METADATA
    ):
        raise AdaptationError("Generated metadata is not a bounded ordinary file.")
    with path.open("rb") as stream:
        data = stream.read(MAX_METADATA + 1)
    if len(data) > MAX_METADATA:
        raise AdaptationError("Generated metadata exceeded its actual read bound.")
    return data


def owned_relative(value: str, root: Path) -> Path:
    try:
        path = Path(value)
        if not path.is_absolute():
            raise ValueError("absolute source path required")
        relative = path.relative_to(root)
        if ".." in relative.parts:
            raise ValueError("parent traversal is not allowed")
        return relative
    except ValueError as error:
        raise AdaptationError(
            "A generated path does not belong to the declared source runtime."
        ) from error


def relative_expression(value: str, project: Path) -> str:
    relative = owned_relative(value, project)
    args = ", ".join(repr(part) for part in relative.parts)
    return f"str(_NemoClawSource.joinpath({args}))"


def relocate_finder(data: bytes, project: Path) -> bytes:
    text = data.decode("utf-8-sig")
    tree = ast.parse(text)
    replacements = []
    found_mapping = False
    lines = text.splitlines(keepends=True)
    offsets = [0]
    for line in lines:
        offsets.append(offsets[-1] + len(line))
    for node in tree.body:
        name = (
            node.target.id
            if isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name)
            else None
        )
        if name not in {"MAPPING", "NAMESPACES"}:
            continue
        value = ast.literal_eval(node.value)
        if not isinstance(value, dict) or not all(
            isinstance(key, str) for key in value
        ):
            raise AdaptationError(
                "The generated editable finder has an unsupported mapping."
            )
        if name == "MAPPING":
            found_mapping = True
            if not value or not all(isinstance(item, str) for item in value.values()):
                raise AdaptationError(
                    "The generated editable source mapping is incomplete."
                )
            fields = [
                repr(key) + ": " + relative_expression(item, project)
                for key, item in value.items()
            ]
        else:
            if not all(
                isinstance(items, list) and all(isinstance(item, str) for item in items)
                for items in value.values()
            ):
                raise AdaptationError(
                    "The generated editable namespaces are unsupported."
                )
            fields = [
                repr(key)
                + ": ["
                + ", ".join(relative_expression(item, project) for item in items)
                + "]"
                for key, items in value.items()
            ]
        start = offsets[node.value.lineno - 1] + len(
            lines[node.value.lineno - 1]
            .encode("utf-8")[: node.value.col_offset]
            .decode("utf-8")
        )
        end = offsets[node.value.end_lineno - 1] + len(
            lines[node.value.end_lineno - 1]
            .encode("utf-8")[: node.value.end_col_offset]
            .decode("utf-8")
        )
        replacements.append((start, end, "{" + ", ".join(fields) + "}"))
    if not found_mapping:
        raise AdaptationError("No canonical editable source mapping was found.")
    for start, end, value in reversed(replacements):
        text = text[:start] + value + text[end:]
    tree = ast.parse(text)
    futures = [
        node
        for node in tree.body
        if isinstance(node, ast.ImportFrom) and node.module == "__future__"
    ]
    lines = text.splitlines(keepends=True)
    insertion = futures[-1].end_lineno if futures else 0
    # The installer and native lease validate the final, nonredirected tree.
    # Guest Python must not ask GetFinalPathNameByHandle to rediscover that path:
    # MXC can permit ordinary reads while rejecting that unrelated operation.
    lines.insert(
        insertion,
        "from pathlib import Path as _NemoClawPath\n"
        "_NemoClawFile = _NemoClawPath(__file__)\n"
        "if not _NemoClawFile.is_absolute() or '..' in _NemoClawFile.parts:\n"
        "    raise ImportError('The generated Hermes finder requires its absolute installed path')\n"
        "_NemoClawSource = _NemoClawFile.parents[3]\n",
    )
    updated = "".join(lines)
    ast.parse(updated)
    return updated.encode("utf-8")


def relocate_pth(
    data: bytes, source_project: Path, site_packages: Path, runtime_project: Path
) -> bytes:
    lines = data.decode("utf-8-sig").splitlines()
    result = []
    for line in lines:
        if not line.strip() or line.startswith(("#", "import ", "import\t")):
            result.append(line)
        else:
            relative = owned_relative(line, source_project)
            result.append(os.path.relpath(runtime_project / relative, site_packages))
    return ("\n".join(result) + "\n").encode("utf-8")


def prepare_plan(
    runtime_root: Path,
    source_root: Path,
    target_root: Path,
    environments: list[str],
    browser_use_outer_inventory: dict | None = None,
    *,
    ci_upgrade_startup_adapter: bool = False,
) -> tuple[dict[Path, bytes], dict]:
    root = runtime_root.resolve(strict=True)
    if not source_root.is_absolute() or not target_root.is_absolute():
        raise AdaptationError("Source and target roots must be absolute.")
    if len(environments) > 8 or len(set(environments)) != len(environments):
        raise AdaptationError("The environment inventory is invalid.")
    source_root = source_root.resolve()
    target_root = target_root.resolve()
    changes: dict[Path, bytes] = {}
    source_project = source_root / "hermes-agent"
    runtime_project = root / "hermes-agent"
    hook_bytes = (Path(__file__).parent / HOOK).read_bytes()
    prepared = None
    upgrade = None
    marker_path = root / MARKER
    if ci_upgrade_startup_adapter and (
        sys.platform != "win32"
        or os.environ.get("GITHUB_ACTIONS") != "true"
        or target_root != root
        or environments != ["hermes-agent/venv", "tools/browser-use"]
        or not marker_path.is_file()
    ):
        raise AdaptationError(
            "Startup adapter upgrade requires the complete CI copy before relocation."
        )
    if marker_path.exists():
        marker_bytes = read_metadata(marker_path, root)
        prepared = json.loads(marker_bytes)
        if ci_upgrade_startup_adapter:
            if (
                hashlib.sha256(marker_bytes).hexdigest() != PREVIOUS_MARKER_SHA256
                or hashlib.sha256(hook_bytes).hexdigest() != UPGRADED_ADAPTER_SHA256
            ):
                raise AdaptationError(
                    "Startup adapter upgrade does not match the pinned old/new candidate bytes."
                )
            upgrade = adapter_upgrade_record()
        if (
            type(prepared.get("schemaVersion")) is not int
            or prepared.get("schemaVersion") != 1
            or prepared.get("manager") != "nemoclaw-windows"
            or prepared.get("hermesRevision") != REVISION
            or prepared.get("layoutVersion") != 1
            or prepared.get("startupAdapterSha256")
            != (
                PREVIOUS_ADAPTER_SHA256
                if upgrade
                else hashlib.sha256(hook_bytes).hexdigest()
            )
            or prepared.get("environments") != environments
            or not isinstance(prepared.get("generatedFiles"), dict)
        ):
            raise AdaptationError(
                "Existing native adaptation metadata does not match this adapter."
            )
        if upgrade and (
            sorted(
                path for path in prepared["generatedFiles"] if path.endswith("/" + HOOK)
            )
            != list(UPGRADE_HOOK_PATHS)
            or any(
                prepared["generatedFiles"].get(path) != PREVIOUS_ADAPTER_SHA256
                for path in UPGRADE_HOOK_PATHS
            )
        ):
            raise AdaptationError(
                "Startup adapter upgrade requires the exact three prior hooks."
            )
        if (
            "startupAdapterUpgrade" in prepared
            and prepared["startupAdapterUpgrade"] != adapter_upgrade_record()
        ):
            raise AdaptationError(
                "The recorded startup adapter upgrade provenance changed."
            )
        for relative, digest in prepared["generatedFiles"].items():
            if (
                hashlib.sha256(read_metadata(root / relative, root)).hexdigest()
                != digest
            ):
                raise AdaptationError(
                    "Previously adapted metadata changed outside its recorded plan."
                )

    def read_required(path: Path) -> bytes:
        data = read_metadata(path, root)
        if (
            prepared
            and prepared["generatedFiles"].get(path.relative_to(root).as_posix())
            != hashlib.sha256(data).hexdigest()
        ):
            raise AdaptationError(
                "Required adapted metadata is absent from its verified prior plan."
            )
        return data

    python_homes: set[Path] = set()
    environment_homes = {}
    site_packages: list[Path] = []
    for relative in environments:
        if relative != "hermes-agent/venv" and relative != "tools/browser-use":
            raise AdaptationError(
                "Only the declared official Hermes and Browser Use environments may be adapted."
            )
        environment = root / relative
        cfg_path = environment / "pyvenv.cfg"
        text = read_required(cfg_path).decode("utf-8-sig")
        entries = [line.partition("=") for line in text.splitlines() if "=" in line]
        values = {key.strip().lower(): value.strip() for key, _, value in entries}
        if values.get("relocatable", "").lower() != "true":
            raise AdaptationError(
                "The official environment has absolute executable trampolines. Regenerate them through supported uv tooling before relocation; do not merely set the flag."
            )
        if sum(key.strip().lower() == "home" for key, _, _ in entries) != 1:
            raise AdaptationError(
                "The generated environment has no unique Python home."
            )
        home_relative = (
            Path(prepared["environmentHomes"][relative])
            if prepared
            else owned_relative(values["home"], source_root)
        )
        if (
            home_relative.is_absolute()
            or ".." in home_relative.parts
            or home_relative.parts[:3] != ("hermes-agent", ".hermes-runtime", "python")
        ):
            raise AdaptationError(
                "The environment does not use the official managed Python tree."
            )
        physical_home = root / home_relative
        physical_home.resolve(strict=True).relative_to(root)
        if not (physical_home / "python.exe").is_file():
            raise AdaptationError("The official managed interpreter is missing.")
        python_homes.add(home_relative)
        environment_homes[relative] = home_relative.as_posix()
        new_home = str(target_root / home_relative)
        changes[cfg_path] = re.sub(
            r"(?im)^\s*home\s*=.*$", lambda _: "home = " + new_home, text
        ).encode("utf-8")
        site_packages.append(environment / "Lib" / "site-packages")
    if "hermes-agent/venv" not in environments:
        raise AdaptationError("The canonical Hermes environment is required.")
    hermes_site = root / "hermes-agent/venv/Lib/site-packages"
    editable = sorted(hermes_site.glob("__editable__*hermes*"))
    if not editable or len(editable) > 8:
        raise AdaptationError(
            "The canonical editable Hermes metadata is missing or ambiguous."
        )
    for path in editable:
        if prepared and path.suffix in {".pth", ".py"}:
            changes[path] = read_required(path)
        elif path.suffix == ".pth":
            changes[path] = relocate_pth(
                read_required(path), source_project, hermes_site, runtime_project
            )
        elif path.name.endswith("_finder.py"):
            changes[path] = relocate_finder(read_required(path), source_project)
    for name in ("hermes", "hermes-acp"):
        outer = root / "bin" / (name + ".cmd")
        if not outer.is_file():
            raise AdaptationError(
                "Expected canonical relocatable command wrapper is missing; executable bytes will not be rewritten."
            )
        text = read_required(outer).decode("ascii").replace("\r\n", "\n").strip()
        relative_wrapper = (
            '@echo off\n"%~dp0..\\hermes-agent\\venv\\Scripts\\' + name + '.exe" %*'
        )
        expected = (
            relative_wrapper
            if prepared
            else '@echo off\n"'
            + str(source_project / "venv/Scripts" / (name + ".exe"))
            + '" %*'
        )
        if text.casefold() != expected.casefold():
            raise AdaptationError(
                "The generated command wrapper does not match its canonical source path."
            )
        if not (runtime_project / "venv/Scripts" / (name + ".exe")).is_file():
            raise AdaptationError("The canonical in-venv command launcher is missing.")
        changes[outer] = (
            '@echo off\r\n"%~dp0..\\hermes-agent\\venv\\Scripts\\'
            + name
            + '.exe" %*\r\n'
        ).encode("ascii")
    retirements = []
    browser_identity = None
    if "tools/browser-use" in environments:
        tool = root / "tools/browser-use"
        distributions = list(
            (tool / "Lib/site-packages").glob("browser_use-*.dist-info")
        )
        if len(distributions) != 1:
            raise AdaptationError(
                "The official Browser Use distribution identity is ambiguous."
            )
        package = Parser().parsestr(
            read_metadata(distributions[0] / "METADATA", root).decode("utf-8")
        )
        entry_bytes = read_metadata(distributions[0] / "entry_points.txt", root)
        entrypoints = configparser.ConfigParser(interpolation=None)
        entrypoints.optionxform = str
        entrypoints.read_string(entry_bytes.decode("utf-8"))
        aliases = (
            sorted(entrypoints["console_scripts"])
            if entrypoints.has_section("console_scripts")
            else []
        )
        if (
            package.get("Name", "").replace("_", "-").lower() != "browser-use"
            or not aliases
            or len(aliases) > 16
            or entrypoints.has_section("gui_scripts")
            or any(
                not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}", name)
                for name in aliases
            )
        ):
            raise AdaptationError(
                "The official Browser Use console entrypoint inventory is invalid."
            )
        browser_identity = {
            "version": package.get("Version"),
            "entryPointsSha256": hashlib.sha256(entry_bytes).hexdigest(),
            "aliases": aliases,
        }
        if prepared:
            if prepared.get("browserUse") != browser_identity:
                raise AdaptationError(
                    "The official Browser Use entrypoint inventory changed after adaptation."
                )
        elif (
            not isinstance(browser_use_outer_inventory, dict)
            or type(browser_use_outer_inventory.get("schemaVersion")) is not int
            or browser_use_outer_inventory.get("schemaVersion") != 1
            or browser_use_outer_inventory.get("package") != "browser-use"
            or browser_use_outer_inventory.get("version") != package.get("Version")
            or not isinstance(browser_use_outer_inventory.get("launchers"), dict)
            or sorted(browser_use_outer_inventory["launchers"]) != aliases
        ):
            raise AdaptationError(
                "The recorded original outer launchers must match every official Browser Use alias."
            )
        for name in aliases:
            read_metadata(tool / "Scripts" / (name + ".exe"), root)
            outer_executable = root / "bin" / (name + ".exe")
            outer_command = root / "bin" / (name + ".cmd")
            delegator = (
                '@echo off\r\n"%~dp0..\\tools\\browser-use\\Scripts\\'
                + name
                + '.exe" %*\r\n'
            ).encode("ascii")
            if prepared:
                if (
                    outer_executable.exists()
                    or read_required(outer_command) != delegator
                ):
                    raise AdaptationError(
                        "A retired absolute Browser Use launcher reappeared or its delegator changed."
                    )
            else:
                identity = browser_use_outer_inventory["launchers"][name]
                if (
                    not isinstance(identity, dict)
                    or not isinstance(identity.get("sha256"), str)
                    or not re.fullmatch(r"[a-f0-9]{64}", identity["sha256"])
                    or type(identity.get("bytes")) is not int
                    or identity["bytes"] <= 0
                ):
                    raise AdaptationError(
                        "An original Browser Use launcher has no bounded recorded identity."
                    )
                original_launcher = read_metadata(outer_executable, root)
                if (
                    hashlib.sha256(original_launcher).hexdigest() != identity["sha256"]
                    or len(original_launcher) != identity["bytes"]
                    or outer_command.exists()
                ):
                    raise AdaptationError(
                        "An original Browser Use launcher does not match its declared build identity."
                    )
                retirements.append(
                    {
                        "path": "bin/" + name + ".exe",
                        "sha256": identity["sha256"],
                        "bytes": len(original_launcher),
                        "archive": name + "-" + identity["sha256"] + ".exe",
                    }
                )
            changes[outer_command] = delegator
    distributions = list(hermes_site.glob("hermes_agent-*.dist-info"))
    if len(distributions) != 1:
        raise AdaptationError(
            "The official editable distribution identity is ambiguous."
        )
    direct_url = distributions[0] / "direct_url.json"
    record = json.loads(read_required(direct_url))
    if record.get("dir_info", {}).get("editable") is not True or (
        not prepared and record.get("url") != source_project.as_uri()
    ):
        raise AdaptationError(
            "The official source install is not the expected editable checkout."
        )
    record["url"] = (target_root / "hermes-agent").as_uri()
    changes[direct_url] = (json.dumps(record, indent=2) + "\n").encode("utf-8")
    record_file = distributions[0] / "RECORD"
    rows = list(csv.reader(io.StringIO(read_required(record_file).decode("utf-8"))))
    for row in rows:
        if len(row) != 3:
            raise AdaptationError("The generated editable RECORD is malformed.")
        file = hermes_site / row[0]
        if file in changes:
            data = changes[file]
            row[1] = "sha256=" + base64.urlsafe_b64encode(
                hashlib.sha256(data).digest()
            ).decode().rstrip("=")
            row[2] = str(len(data))
    output = io.StringIO(newline="")
    csv.writer(output, lineterminator="\n").writerows(rows)
    changes[record_file] = output.getvalue().encode("utf-8")
    site_packages.extend(root / home / "Lib/site-packages" for home in python_homes)
    for directory in site_packages:
        directory.resolve().relative_to(root)
        for name, data in (
            (HOOK, hook_bytes),
            (
                PTH,
                b"import nemoclaw_native_windows; nemoclaw_native_windows.install()\n",
            ),
        ):
            path = directory / name
            if path.exists():
                before = read_required(path)
                reviewed_upgrade = (
                    upgrade is not None
                    and name == HOOK
                    and path.relative_to(root).as_posix() in UPGRADE_HOOK_PATHS
                    and hashlib.sha256(before).hexdigest() == PREVIOUS_ADAPTER_SHA256
                )
                if before != data and not reviewed_upgrade:
                    raise AdaptationError(
                        "An additive startup file collides with existing runtime content."
                    )
            changes[path] = data
    marker = {
        "schemaVersion": 1,
        "manager": "nemoclaw-windows",
        "hermesRevision": REVISION,
        "layoutVersion": 1,
        "pythonHomes": sorted(path.as_posix() for path in python_homes),
        "environments": environments,
        "environmentHomes": environment_homes,
        "browserUse": browser_identity,
        "retiredEntrypoints": prepared.get("retiredEntrypoints", [])
        if prepared
        else retirements,
        "startupAdapterSha256": hashlib.sha256(hook_bytes).hexdigest(),
        "generatedFiles": {
            path.relative_to(root).as_posix(): hashlib.sha256(data).hexdigest()
            for path, data in changes.items()
        },
    }
    lineage = upgrade or (prepared or {}).get("startupAdapterUpgrade")
    if lineage:
        marker["startupAdapterUpgrade"] = lineage
    if len(json.dumps(marker).encode("utf-8")) > 16 * 1024:
        raise AdaptationError("The native startup marker exceeds its bound.")
    changes[root / MARKER] = (json.dumps(marker, indent=2) + "\n").encode("utf-8")
    report = {
        "schemaVersion": 1,
        "classification": "native-hermes-generated-metadata-adaptation",
        "hermesRevision": REVISION,
        "environments": environments,
        "requiresMovedRootProbe": True,
        "runtimeExecutionQualified": False,
        "retirements": retirements,
        "files": [
            {
                "path": path.relative_to(root).as_posix(),
                "beforeSha256": hashlib.sha256(read_metadata(path, root)).hexdigest()
                if path.exists()
                else None,
                "sha256": hashlib.sha256(data).hexdigest(),
                "bytes": len(data),
            }
            for path, data in changes.items()
        ],
    }
    if lineage:
        report["startupAdapterUpgrade"] = lineage
        report["startupAdapterUpgradeApplied"] = upgrade is not None
    return changes, report


def apply_plan(
    changes: dict[Path, bytes],
    *,
    runtime_root: Path | None = None,
    retirements: list[dict] | None = None,
    diagnostics_directory: Path | None = None,
) -> None:
    # All validation finishes before writing. Each replacement is atomic;
    # any later I/O failure still leaves the overall build unqualified.
    if retirements:
        if runtime_root is None or diagnostics_directory is None:
            raise AdaptationError(
                "Retired generated launchers require an owned diagnostics directory."
            )
        runtime_root = runtime_root.resolve(strict=True)
        diagnostics_directory = diagnostics_directory.resolve()
        if diagnostics_directory.is_relative_to(runtime_root):
            raise AdaptationError(
                "Retired launchers must be archived outside the runtime payload."
            )
        diagnostics_directory.mkdir(parents=True, exist_ok=True)
        for record in retirements:
            source = runtime_root / record["path"]
            data = read_metadata(source, runtime_root)
            if hashlib.sha256(data).hexdigest() != record["sha256"]:
                raise AdaptationError(
                    "The generated launcher changed before retirement."
                )
            archive = diagnostics_directory / record["archive"]
            if archive.exists():
                if read_metadata(archive, diagnostics_directory) != data:
                    raise AdaptationError(
                        "The generated-launcher archive identity conflicts."
                    )
            else:
                with archive.open("xb") as stream:
                    stream.write(data)
                    stream.flush()
                    os.fsync(stream.fileno())
            if (
                hashlib.sha256(
                    read_metadata(archive, diagnostics_directory)
                ).hexdigest()
                != record["sha256"]
            ):
                raise AdaptationError(
                    "The original generated launcher archive could not be verified."
                )
            if (
                hashlib.sha256(read_metadata(source, runtime_root)).hexdigest()
                != record["sha256"]
            ):
                raise AdaptationError(
                    "The generated launcher changed before unlinking."
                )
            source.unlink()
    for path, data in changes.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(path.name + ".native-" + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("xb") as stream:
                stream.write(data)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--runtime-root", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--target-root", type=Path, required=True)
    parser.add_argument("--environment", action="append", default=[])
    parser.add_argument("--receipt", type=Path, required=True)
    parser.add_argument("--diagnostics-directory", type=Path)
    parser.add_argument("--browser-use-outer-inventory", type=Path)
    parser.add_argument("--ci-upgrade-startup-adapter", action="store_true")
    args = parser.parse_args()
    outer_inventory = (
        json.loads(
            read_metadata(
                args.browser_use_outer_inventory,
                args.browser_use_outer_inventory.parent.resolve(),
            )
        )
        if args.browser_use_outer_inventory
        else None
    )
    changes, report = prepare_plan(
        args.runtime_root,
        args.source_root,
        args.target_root,
        args.environment or ["hermes-agent/venv"],
        outer_inventory,
        ci_upgrade_startup_adapter=args.ci_upgrade_startup_adapter,
    )
    apply_plan(
        changes,
        runtime_root=args.runtime_root,
        retirements=report["retirements"],
        diagnostics_directory=args.diagnostics_directory,
    )
    args.receipt.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(
        "Prepared generated metadata and native startup policy; moved-root execution remains unqualified."
    )


if __name__ == "__main__":
    main()
