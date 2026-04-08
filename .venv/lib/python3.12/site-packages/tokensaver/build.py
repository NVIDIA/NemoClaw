"""Build orchestration for TokenSaver core + plugins."""

from __future__ import annotations

import json
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.core.common_artifacts import build_common_artifacts
from tokensaver.core.models import BuildContext
from tokensaver.core.registry import get_plugin
from tokensaver.integrations import install_integrations
from tokensaver.scanner import scan_project
from tokensaver.snapshot import build_snapshot, changed_artifacts, load_snapshot, save_snapshot
from tokensaver.tokenizer import count_file_tokens, tokenizer_name

OUTPUT_DIRNAME = "docs/tokensaver"


def build_project(
    root: str | Path,
    output_dir: str | Path | None = None,
    *,
    force: bool = False,
) -> dict:
    """Generate TokenSaver artifacts and metrics for a repository."""
    root = Path(root).resolve()
    output_dir = Path(output_dir).resolve() if output_dir else (root / OUTPUT_DIRNAME)
    output_dir.mkdir(parents=True, exist_ok=True)

    scan = scan_project(root)
    ctx = BuildContext(root=root, scan=scan)
    plugin = get_plugin(scan.framework)
    all_artifacts = build_common_artifacts(ctx) + plugin.build_artifacts(ctx)

    new_snapshot = build_snapshot(all_artifacts, root)
    old_snapshot = None if force else load_snapshot(output_dir)

    if old_snapshot is not None:
        dirty_names = changed_artifacts(old_snapshot, new_snapshot)
    else:
        dirty_names = {a.name for a in all_artifacts}

    rebuilt = []
    skipped = []
    for artifact in all_artifacts:
        out_path = output_dir / artifact.file_name
        if artifact.name in dirty_names or not out_path.exists():
            out_path.write_text(json.dumps(artifact.payload, indent=2) + "\n")
            artifact.output_tokens = count_file_tokens(out_path)
            rebuilt.append(artifact.name)
        else:
            artifact.output_tokens = count_file_tokens(out_path)
            skipped.append(artifact.name)

    save_snapshot(output_dir, new_snapshot)

    metrics_payload = _build_metrics(scan.project_name, scan.framework, all_artifacts)
    metrics_path = output_dir / "METRICS.json"
    metrics_path.write_text(json.dumps(metrics_payload, indent=2) + "\n")

    integration_paths = install_integrations(root, output_dir)

    return {
        "scan": scan,
        "artifacts": all_artifacts,
        "metrics": metrics_payload,
        "output_dir": output_dir,
        "plugin": plugin.name,
        "integrations": integration_paths,
        "rebuilt": rebuilt,
        "skipped": skipped,
    }


def _build_metrics(project_name: str, framework: str, artifacts: list) -> dict:
    union_files = set()
    artifact_metrics = []
    total_source_tokens = 0
    bundle_tokens = 0

    for artifact in artifacts:
        artifact_source_tokens = sum(count_file_tokens(path) for path in sorted(artifact.source_files))
        total_source_tokens += artifact_source_tokens
        bundle_tokens += artifact.output_tokens
        union_files.update(artifact.source_files)
        compression_ratio = (
            artifact_source_tokens / artifact.output_tokens
            if artifact.output_tokens and artifact_source_tokens
            else None
        )
        artifact_metrics.append(
            {
                "name": artifact.name,
                "path": artifact.path,
                "entity_count": artifact.entity_count,
                "source_file_count": len(artifact.source_files),
                "source_tokens": artifact_source_tokens,
                "output_tokens": artifact.output_tokens,
                "compression_ratio": compression_ratio,
            }
        )

    union_source_tokens = sum(count_file_tokens(path) for path in sorted(union_files))
    compression_ratio = bundle_tokens and union_source_tokens / bundle_tokens
    overlap_source_tokens = total_source_tokens - union_source_tokens

    return {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "extractor": "metrics_v1",
        },
        "project": project_name,
        "framework": framework,
        "tokenizer": tokenizer_name(),
        "artifacts": artifact_metrics,
        "repo": {
            "source_file_count": len(union_files),
            "union_source_tokens": union_source_tokens,
            "bundle_tokens": bundle_tokens,
            "compression_ratio": compression_ratio,
            "overlap_source_tokens": overlap_source_tokens,
        },
    }
