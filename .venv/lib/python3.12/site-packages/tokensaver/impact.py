"""Blast-radius change-impact analysis using TokenSaver artifacts."""

from __future__ import annotations

import json
import subprocess
from pathlib import Path

from tokensaver.build import OUTPUT_DIRNAME
from tokensaver.core.helpers import module_name_for_file


def detect_changed_files(root: Path) -> list[str]:
    """Auto-detect changed files from git diff against HEAD."""
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode != 0:
            result = subprocess.run(
                ["git", "diff", "--name-only", "--cached"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=10,
            )
        files = [f.strip() for f in result.stdout.strip().splitlines() if f.strip()]
        if not files:
            result = subprocess.run(
                ["git", "status", "--porcelain"],
                cwd=root,
                capture_output=True,
                text=True,
                timeout=10,
            )
            for line in result.stdout.strip().splitlines():
                if len(line) > 3:
                    files.append(line[3:].strip())
        return files
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return []


def _load_artifact(output_dir: Path, name: str) -> dict | None:
    path = output_dir / name
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def compute_impact(
    root: str | Path,
    output_dir: str | Path | None = None,
    changed_files: list[str] | None = None,
) -> dict:
    """Compute blast-radius impact for changed files using the TokenSaver bundle."""
    root = Path(root).resolve()
    output_dir = Path(output_dir).resolve() if output_dir else (root / OUTPUT_DIRNAME)

    if changed_files is None:
        changed_files = detect_changed_files(root)

    if not changed_files:
        return {
            "changed_files": [],
            "affected_modules": [],
            "affected_apis": [],
            "affected_routes": [],
            "affected_configs": [],
            "summary": {
                "files_changed": 0,
                "modules_affected": 0,
                "apis_affected": 0,
                "routes_affected": 0,
                "configs_affected": 0,
            },
        }

    changed_set = set(changed_files)

    module_graph = _load_artifact(output_dir, "MODULE_GRAPH.json")
    api_index = _load_artifact(output_dir, "API_INDEX.json")
    route_index = _load_artifact(output_dir, "ROUTE_INDEX.json")
    config_index = _load_artifact(output_dir, "CONFIG_INDEX.json")

    affected_module_names: dict[str, dict] = {}
    for f in changed_files:
        mod_name = module_name_for_file(root, root / f)
        if mod_name != "root":
            affected_module_names.setdefault(mod_name, {"changed_files": 0})
            affected_module_names[mod_name]["changed_files"] += 1

    affected_modules = []
    if module_graph:
        for mod in module_graph.get("modules", []):
            short_name = mod["name"].split("/")[-1] if "/" in mod["name"] else mod["name"]
            full_name = mod["name"]
            match = affected_module_names.get(short_name) or affected_module_names.get(full_name)
            if match:
                affected_modules.append({
                    "name": mod["name"],
                    "changed_files": match["changed_files"],
                    "total_files": mod.get("file_count", 0),
                    "total_tokens": mod.get("tokens", 0),
                })

    affected_apis = []
    if api_index:
        for file_entry in api_index.get("files", []):
            fname, module, entries = file_entry[0], file_entry[1], file_entry[2]
            if fname in changed_set:
                for entry in entries:
                    affected_apis.append({
                        "endpoint": entry[0],
                        "name": entry[1],
                        "method": entry[2] or "POST",
                        "file": fname,
                        "module": module,
                    })

    affected_routes = []
    if route_index:
        for file_entry in route_index.get("files", []):
            fname, entries = file_entry[0], file_entry[1]
            if fname in changed_set:
                for entry in entries:
                    affected_routes.append({
                        "route": entry[0],
                        "file": fname,
                        "usage_count": entry[2] if len(entry) > 2 else 0,
                    })

    affected_configs = []
    if config_index:
        for file_entry in config_index.get("files", []):
            if not isinstance(file_entry, list) or len(file_entry) < 2:
                continue
            fname = file_entry[0]
            if fname in changed_set:
                entries = file_entry[1] if len(file_entry) == 2 else file_entry[2]
                if isinstance(entries, list):
                    for entry in entries:
                        if isinstance(entry, list) and len(entry) >= 2:
                            affected_configs.append({
                                "key": entry[0],
                                "type": entry[1] if len(entry) > 1 else "unknown",
                                "file": fname,
                            })

    return {
        "changed_files": changed_files,
        "affected_modules": affected_modules,
        "affected_apis": affected_apis,
        "affected_routes": affected_routes,
        "affected_configs": affected_configs,
        "summary": {
            "files_changed": len(changed_files),
            "modules_affected": len(affected_modules),
            "apis_affected": len(affected_apis),
            "routes_affected": len(affected_routes),
            "configs_affected": len(affected_configs),
        },
    }
