"""Incremental build support via SHA-256 file hashing."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

SNAPSHOT_FILE = ".tokensaver_snapshot.json"


def _hash_file(path: Path) -> str:
    h = hashlib.sha256()
    try:
        h.update(path.read_bytes())
    except OSError:
        return ""
    return h.hexdigest()


def build_snapshot(artifacts: list, root: Path) -> dict:
    """Build a snapshot of all source file hashes grouped by artifact."""
    artifact_snapshots = {}
    for artifact in artifacts:
        file_hashes = {}
        for source_file in sorted(artifact.source_files):
            try:
                rel = str(source_file.relative_to(root))
            except ValueError:
                rel = str(source_file)
            file_hashes[rel] = _hash_file(source_file)
        artifact_snapshots[artifact.name] = {
            "file_count": len(file_hashes),
            "files": file_hashes,
        }
    return artifact_snapshots


def load_snapshot(output_dir: Path) -> dict | None:
    snapshot_path = output_dir / SNAPSHOT_FILE
    if not snapshot_path.exists():
        return None
    try:
        return json.loads(snapshot_path.read_text())
    except (json.JSONDecodeError, OSError):
        return None


def save_snapshot(output_dir: Path, snapshot: dict) -> Path:
    snapshot_path = output_dir / SNAPSHOT_FILE
    snapshot_path.write_text(json.dumps(snapshot, indent=2) + "\n")
    return snapshot_path


def changed_artifacts(old_snapshot: dict, new_snapshot: dict) -> set[str]:
    """Return artifact names that have any changed, added, or deleted source files."""
    dirty = set()
    for artifact_name, new_data in new_snapshot.items():
        old_data = old_snapshot.get(artifact_name)
        if old_data is None:
            dirty.add(artifact_name)
            continue
        if new_data["files"] != old_data.get("files", {}):
            dirty.add(artifact_name)
    for artifact_name in old_snapshot:
        if artifact_name not in new_snapshot:
            dirty.add(artifact_name)
    return dirty
