"""Benchmark helpers for reproducible TokenSaver runs.

Provides:
- benchmark_project: single-repo benchmark
- benchmark_suite: multi-repo suite with resilient per-repo error handling
- compute_suite_summary: aggregate eval metrics
- export_public_results: strip private identifiers from suite output
- generate_suite_markdown: compact Markdown report
- save_snapshot / load_snapshot: history persistence
- diff_snapshots: regression/improvement detection between two snapshots
"""

from __future__ import annotations

import json
import re
import statistics
import tempfile
import time
from datetime import UTC, datetime
from pathlib import Path

from tokensaver import SCHEMA_VERSION
from tokensaver.build import build_project
from tokensaver.core.helpers import timestamp

_STATUS_OK = "ok"
_STATUS_PARTIAL = "partial"
_STATUS_UNSUPPORTED = "unsupported"
_STATUS_FAILED = "failed"

_LOW_VALUE_THRESHOLD = 1.2
_LOW_VALUE_EXEMPT_ARTIFACTS = {"commands", "project_summary"}
_MAJOR_ARTIFACTS = {"module_graph", "api_index", "route_index", "config_index"}
_MIN_OK_MAJOR_ARTIFACTS = 2


# ---------------------------------------------------------------------------
# Single-repo benchmark
# ---------------------------------------------------------------------------

def benchmark_project(root: str | Path, output_dir: str | Path | None = None) -> dict:
    """Run a full build and persist a benchmark summary next to the outputs."""
    started_at = time.perf_counter()
    result = build_project(root, output_dir=output_dir)
    duration_seconds = time.perf_counter() - started_at

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "extractor": "benchmark_v1",
            "generated_at": timestamp(),
        },
        "project": result["scan"].project_name,
        "root": result["scan"].root,
        "framework": result["scan"].framework,
        "plugin": result["plugin"],
        "runtime_seconds": round(duration_seconds, 2),
        "scan": {
            "total_files": result["scan"].total_files,
            "total_tokens": result["scan"].total_tokens,
            "languages": result["scan"].languages,
            "manifests": result["scan"].manifests,
            "entrypoints": result["scan"].entrypoints,
        },
        "metrics": result["metrics"],
    }

    benchmark_path = Path(result["output_dir"]) / "BENCHMARK.json"
    benchmark_path.write_text(json.dumps(payload, indent=2) + "\n")
    result["benchmark"] = payload
    return result


# ---------------------------------------------------------------------------
# Suite runner — resilient, per-repo error isolation
# ---------------------------------------------------------------------------

def benchmark_suite(
    manifest_path: str | Path,
    output_root: str | Path | None = None,
    previous_snapshot_path: str | Path | None = None,
    *,
    public_only: bool = False,
) -> dict:
    """Run a benchmark suite defined by a JSON manifest.

    One repo failure does not abort the whole suite.  Each result carries
    a status field (ok | partial | unsupported | failed) and an optional
    failure_reason.

    When *public_only* is True, only public-safe outputs are written:
    SUITE_RESULTS.public.json and SUITE_RESULTS.md.  Raw suite JSON and
    history snapshots are omitted entirely.
    """
    manifest_path = Path(manifest_path).resolve()
    manifest = json.loads(manifest_path.read_text())
    manifest_dir = manifest_path.parent

    resolved_output_root = (
        Path(output_root).resolve()
        if output_root
        else _resolve_path(
            manifest.get("output_root", "./output/benchmark-suite"),
            manifest_dir,
        )
    )
    resolved_output_root.mkdir(parents=True, exist_ok=True)

    suite_results: list[dict] = []

    for item in manifest.get("benchmarks", []):
        bench_id = item.get("id", "unknown")
        label = item.get("label", bench_id)
        publish_label = item.get("publish_label", f"Benchmark {bench_id}")
        expected_framework = item.get("expected_framework")
        tags = item.get("tags", [])
        private = item.get("private", False)
        root_raw = item.get("root", "")

        root = _resolve_path(root_raw, manifest_dir)
        if public_only:
            # Public-only mode must not leave raw benchmark artifacts under the
            # requested output root. Run each benchmark in an isolated temp dir.
            with tempfile.TemporaryDirectory(prefix=f"tokensaver-{bench_id}-") as temp_dir:
                entry = _run_single_benchmark(
                    bench_id=bench_id,
                    label=label,
                    publish_label=publish_label,
                    expected_framework=expected_framework,
                    tags=tags,
                    private=private,
                    root=root,
                    bench_output_dir=Path(temp_dir),
                )
        else:
            bench_output_dir = _resolve_path(
                item.get("output_dir", str(resolved_output_root / bench_id)),
                manifest_dir,
            )
            entry = _run_single_benchmark(
                bench_id=bench_id,
                label=label,
                publish_label=publish_label,
                expected_framework=expected_framework,
                tags=tags,
                private=private,
                root=root,
                bench_output_dir=bench_output_dir,
            )
        suite_results.append(entry)

    summary = compute_suite_summary(suite_results)

    payload = {
        "_meta": {
            "schema_version": SCHEMA_VERSION,
            "extractor": "benchmark_suite_v2",
            "generated_at": timestamp(),
            "manifest": str(manifest_path),
        },
        "suite": manifest.get("name", manifest_path.stem),
        "summary": summary,
        "results": suite_results,
    }

    public_payload = export_public_results(payload)
    public_path = resolved_output_root / "SUITE_RESULTS.public.json"
    public_path.write_text(json.dumps(public_payload, indent=2) + "\n")

    md_text = generate_suite_markdown(
        public_payload if public_only else payload,
        previous_snapshot_path=previous_snapshot_path,
    )
    md_path = resolved_output_root / "SUITE_RESULTS.md"
    md_path.write_text(md_text)

    suite_path = None
    snapshot_path = None

    if not public_only:
        suite_path = resolved_output_root / "SUITE_RESULTS.json"
        suite_path.write_text(json.dumps(payload, indent=2) + "\n")
        snapshot_path = save_snapshot(payload, resolved_output_root)

    return {
        "manifest": manifest_path,
        "output_root": resolved_output_root,
        "suite_results": payload,
        "suite_path": suite_path,
        "public_path": public_path,
        "md_path": md_path,
        "snapshot_path": snapshot_path,
    }


def _run_single_benchmark(
    *,
    bench_id: str,
    label: str,
    publish_label: str,
    expected_framework: str | None,
    tags: list[str],
    private: bool,
    root: Path,
    bench_output_dir: Path,
) -> dict:
    """Run a single benchmark with full error isolation."""
    entry: dict = {
        "id": bench_id,
        "label": label,
        "publish_label": publish_label,
        "expected_framework": expected_framework,
        "tags": tags,
        "private": private,
        "detected_framework": None,
        "plugin": None,
        "status": _STATUS_FAILED,
        "failure_reason": None,
        "runtime_seconds": None,
        "scan": {"total_files": 0, "total_tokens": 0},
        "repo": {
            "source_file_count": 0,
            "union_source_tokens": 0,
            "bundle_tokens": 0,
            "compression_ratio": None,
            "overlap_source_tokens": 0,
        },
        "artifacts": {},
    }

    if not root.is_dir():
        entry["failure_reason"] = f"root directory does not exist: {root}"
        return entry

    try:
        result = benchmark_project(root, output_dir=bench_output_dir)
    except Exception as exc:
        entry["failure_reason"] = f"{type(exc).__name__}: {exc}"
        return entry

    benchmark_data = result["benchmark"]
    scan = result["scan"]
    metrics = result["metrics"]

    entry["detected_framework"] = scan.framework
    entry["plugin"] = result["plugin"]
    entry["runtime_seconds"] = benchmark_data["runtime_seconds"]
    entry["scan"] = {
        "total_files": scan.total_files,
        "total_tokens": scan.total_tokens,
    }
    entry["repo"] = {
        "source_file_count": metrics["repo"]["source_file_count"],
        "union_source_tokens": metrics["repo"]["union_source_tokens"],
        "bundle_tokens": metrics["repo"]["bundle_tokens"],
        "compression_ratio": metrics["repo"]["compression_ratio"],
        "overlap_source_tokens": metrics["repo"]["overlap_source_tokens"],
    }

    artifacts_map: dict[str, dict] = {}
    for artifact in metrics.get("artifacts", []):
        artifacts_map[artifact["name"]] = {
            "entity_count": artifact.get("entity_count", 0),
            "source_tokens": artifact.get("source_tokens", 0),
            "output_tokens": artifact.get("output_tokens", 0),
            "compression_ratio": artifact.get("compression_ratio"),
        }
    entry["artifacts"] = artifacts_map

    entry["status"] = _determine_status(
        detected_framework=scan.framework,
        plugin=result["plugin"],
        artifacts=artifacts_map,
    )
    return entry


def _determine_status(
    *,
    detected_framework: str,
    plugin: str,
    artifacts: dict[str, dict],
) -> str:
    if detected_framework == "unknown":
        return _STATUS_UNSUPPORTED

    if not artifacts:
        return _STATUS_FAILED

    present_major = {
        name for name in _MAJOR_ARTIFACTS if name in artifacts and not _artifact_is_empty(artifacts[name])
    }
    non_empty_count = len(present_major)

    if non_empty_count == 0:
        return _STATUS_FAILED

    if non_empty_count >= _MIN_OK_MAJOR_ARTIFACTS:
        return _STATUS_OK

    return _STATUS_PARTIAL


# ---------------------------------------------------------------------------
# Eval summary metrics
# ---------------------------------------------------------------------------

def compute_suite_summary(results: list[dict]) -> dict:
    """Compute aggregate metrics across a suite of benchmark results."""
    benchmark_count = len(results)
    success_count = sum(1 for r in results if r["status"] == _STATUS_OK)
    failed_count = sum(1 for r in results if r["status"] == _STATUS_FAILED)
    unsupported_count = sum(1 for r in results if r["status"] == _STATUS_UNSUPPORTED)
    partial_count = sum(1 for r in results if r["status"] == _STATUS_PARTIAL)
    success_rate = (success_count / benchmark_count) if benchmark_count else 0.0

    detection_correct = 0
    detection_total = 0
    for r in results:
        if r.get("expected_framework"):
            detection_total += 1
            if r.get("detected_framework") == r["expected_framework"]:
                detection_correct += 1
    framework_detection_accuracy = (
        (detection_correct / detection_total) if detection_total else None
    )

    per_stack = _compute_per_stack(results)

    total_artifacts = 0
    empty_artifacts = 0
    low_value_artifacts = 0
    for r in results:
        if r["status"] == _STATUS_FAILED:
            continue
        for art_name, art in r.get("artifacts", {}).items():
            total_artifacts += 1
            if _artifact_is_empty(art):
                empty_artifacts += 1
            elif (
                art_name not in _LOW_VALUE_EXEMPT_ARTIFACTS
                and art.get("compression_ratio") is not None
                and art["compression_ratio"] < _LOW_VALUE_THRESHOLD
            ):
                low_value_artifacts += 1

    artifact_presence_rate = (
        ((total_artifacts - empty_artifacts) / total_artifacts)
        if total_artifacts
        else 0.0
    )
    empty_artifact_rate = (
        (empty_artifacts / total_artifacts) if total_artifacts else 0.0
    )
    low_value_artifact_rate = (
        (low_value_artifacts / total_artifacts) if total_artifacts else 0.0
    )

    return {
        "benchmark_count": benchmark_count,
        "success_count": success_count,
        "failed_count": failed_count,
        "unsupported_count": unsupported_count,
        "partial_count": partial_count,
        "success_rate": round(success_rate, 4),
        "framework_detection_accuracy": (
            round(framework_detection_accuracy, 4)
            if framework_detection_accuracy is not None
            else None
        ),
        "per_stack": per_stack,
        "artifact_presence_rate": round(artifact_presence_rate, 4),
        "empty_artifact_rate": round(empty_artifact_rate, 4),
        "low_value_artifact_rate": round(low_value_artifact_rate, 4),
    }


def _compute_per_stack(results: list[dict]) -> dict[str, dict]:
    stacks: dict[str, list[dict]] = {}
    for r in results:
        fw = r.get("detected_framework") or r.get("expected_framework") or "unknown"
        stacks.setdefault(fw, []).append(r)

    per_stack: dict[str, dict] = {}
    for stack, entries in sorted(stacks.items()):
        ok_entries = [e for e in entries if e["status"] in {_STATUS_OK, _STATUS_PARTIAL}]
        runtimes = [e["runtime_seconds"] for e in ok_entries if e.get("runtime_seconds")]
        ratios = [
            e["repo"]["compression_ratio"]
            for e in ok_entries
            if e.get("repo", {}).get("compression_ratio")
        ]
        per_stack[stack] = {
            "repo_count": len(entries),
            "success_count": sum(1 for e in entries if e["status"] == _STATUS_OK),
            "median_runtime_seconds": (
                round(statistics.median(runtimes), 2) if runtimes else None
            ),
            "median_compression_ratio": (
                round(statistics.median(ratios), 2) if ratios else None
            ),
        }
    return per_stack


# ---------------------------------------------------------------------------
# Safe public export
# ---------------------------------------------------------------------------

_SENSITIVE_PATTERNS = [
    re.compile(r"/Users/[^\s:]+"),
    re.compile(r"/home/[^\s:]+"),
    re.compile(r"[A-Za-z]:\\[^\s]+"),
]


def _strip_path(value: str | None) -> str | None:
    """Return None if the value looks like an absolute local path."""
    if value is None:
        return None
    if isinstance(value, str) and (
        value.startswith("/") or value.startswith("C:\\") or value.startswith("~")
    ):
        return None
    return value


def _sanitize_string(value: str) -> str:
    """Remove sensitive substrings from a string value."""
    result = value
    for pattern in _SENSITIVE_PATTERNS:
        result = pattern.sub("<redacted>", result)
    return result


def export_public_results(payload: dict) -> dict:
    """Create a copy of suite results safe for public sharing.

    Rules:
    - never include local absolute paths
    - never include raw repo names when private=true
    - use publish_label when available
    - omit root paths entirely from public output
    - strip manifest path if it points to a private local file
    """
    meta = dict(payload.get("_meta", {}))
    manifest_val = meta.get("manifest", "")
    if isinstance(manifest_val, str) and (
        manifest_val.startswith("/") or manifest_val.startswith("C:\\")
    ):
        meta.pop("manifest", None)

    public_results = []
    for index, r in enumerate(payload.get("results", []), start=1):
        is_private = r.get("private", False)
        display_label = _display_label(r, public=True)

        entry = {
            "id": _public_identifier(r, index) if is_private else r["id"],
            "label": display_label,
            "detected_framework": r.get("detected_framework"),
            "plugin": r.get("plugin"),
            "status": r.get("status"),
            "failure_reason": (
                _sanitize_string(r["failure_reason"])
                if r.get("failure_reason")
                else None
            ),
            "runtime_seconds": r.get("runtime_seconds"),
            "scan": r.get("scan", {}),
            "repo": r.get("repo", {}),
            "artifacts": r.get("artifacts", {}),
        }
        public_results.append(entry)

    summary = payload.get("summary", {})
    public_summary = {k: v for k, v in summary.items()}

    return {
        "_meta": meta,
        "suite": payload.get("suite", ""),
        "summary": public_summary,
        "results": public_results,
    }


# ---------------------------------------------------------------------------
# Snapshot history
# ---------------------------------------------------------------------------

def save_snapshot(payload: dict, output_root: Path) -> Path:
    """Save a timestamped snapshot of suite results for history tracking."""
    history_dir = output_root / "history"
    history_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    snapshot_path = history_dir / f"{ts}.json"
    snapshot_path.write_text(json.dumps(payload, indent=2) + "\n")
    return snapshot_path


def load_snapshot(path: str | Path) -> dict:
    """Load a suite snapshot from disk."""
    return json.loads(Path(path).read_text())


def diff_snapshots(
    old_path: str | Path,
    new_path: str | Path,
) -> dict:
    """Compare two suite snapshots and report regressions/improvements.

    Returns a dict with:
    - new_failures: benchmarks that failed in new but not old
    - fixed_failures: benchmarks that were failed in old but ok in new
    - compression_ratio_delta: per repo id
    - runtime_delta: per repo id
    - artifact_ratio_deltas: per repo id, per artifact name
    - framework_detection_changes: per repo id
    """
    old = load_snapshot(old_path)
    new = load_snapshot(new_path)

    old_by_id = {r["id"]: r for r in old.get("results", [])}
    new_by_id = {r["id"]: r for r in new.get("results", [])}

    all_ids = sorted(set(old_by_id) | set(new_by_id))

    new_failures: list[dict] = []
    fixed_failures: list[dict] = []
    compression_ratio_delta: dict[str, dict] = {}
    runtime_delta: dict[str, dict] = {}
    artifact_ratio_deltas: dict[str, dict] = {}
    framework_detection_changes: list[dict] = []

    for rid in all_ids:
        old_r = old_by_id.get(rid)
        new_r = new_by_id.get(rid)

        if new_r and not old_r:
            if new_r["status"] == _STATUS_FAILED:
                new_failures.append(
                    {
                        "id": rid,
                        "label": _display_label(new_r, public=True),
                        "failure_reason": new_r.get("failure_reason"),
                    }
                )
            continue

        if old_r and not new_r:
            continue

        old_status = old_r["status"]
        new_status = new_r["status"]

        if new_status == _STATUS_FAILED and old_status != _STATUS_FAILED:
            new_failures.append(
                {
                    "id": rid,
                    "label": _display_label(new_r, public=True),
                    "failure_reason": new_r.get("failure_reason"),
                }
            )
        if old_status == _STATUS_FAILED and new_status != _STATUS_FAILED:
            fixed_failures.append(
                {
                    "id": rid,
                    "label": _display_label(new_r, public=True),
                    "new_status": new_status,
                }
            )

        old_ratio = (old_r.get("repo") or {}).get("compression_ratio")
        new_ratio = (new_r.get("repo") or {}).get("compression_ratio")
        if old_ratio is not None and new_ratio is not None:
            compression_ratio_delta[rid] = {
                "label": _display_label(new_r, public=True),
                "old": round(old_ratio, 2),
                "new": round(new_ratio, 2),
                "delta": round(new_ratio - old_ratio, 2),
            }

        old_rt = old_r.get("runtime_seconds")
        new_rt = new_r.get("runtime_seconds")
        if old_rt is not None and new_rt is not None:
            runtime_delta[rid] = {
                "label": _display_label(new_r, public=True),
                "old": old_rt,
                "new": new_rt,
                "delta": round(new_rt - old_rt, 2),
            }

        old_fw = old_r.get("detected_framework")
        new_fw = new_r.get("detected_framework")
        if old_fw != new_fw:
            framework_detection_changes.append({
                "id": rid,
                "label": _display_label(new_r, public=True),
                "old": old_fw,
                "new": new_fw,
            })

        old_arts = old_r.get("artifacts", {})
        new_arts = new_r.get("artifacts", {})
        art_names = sorted(set(old_arts) | set(new_arts))
        art_deltas = {}
        for art_name in art_names:
            old_ar = (old_arts.get(art_name) or {}).get("compression_ratio")
            new_ar = (new_arts.get(art_name) or {}).get("compression_ratio")
            if old_ar is not None and new_ar is not None:
                art_deltas[art_name] = {
                    "old": round(old_ar, 2),
                    "new": round(new_ar, 2),
                    "delta": round(new_ar - old_ar, 2),
                }
        if art_deltas:
            artifact_ratio_deltas[rid] = art_deltas

    return {
        "old_snapshot": str(old_path),
        "new_snapshot": str(new_path),
        "new_failures": new_failures,
        "fixed_failures": fixed_failures,
        "compression_ratio_delta": compression_ratio_delta,
        "runtime_delta": runtime_delta,
        "artifact_ratio_deltas": artifact_ratio_deltas,
        "framework_detection_changes": framework_detection_changes,
    }


# ---------------------------------------------------------------------------
# Markdown reporting
# ---------------------------------------------------------------------------

def generate_suite_markdown(
    payload: dict,
    previous_snapshot_path: str | Path | None = None,
) -> str:
    """Generate a compact Markdown summary of suite results."""
    lines: list[str] = []
    summary = payload.get("summary", {})
    results = payload.get("results", [])
    suite_name = payload.get("suite", "Benchmark Suite")
    generated_at = payload.get("_meta", {}).get("generated_at", "")

    lines.append(f"# {suite_name}\n")
    lines.append(f"Generated: {generated_at}\n")

    lines.append("## Overview\n")
    lines.append(f"| Metric | Value |")
    lines.append(f"|--------|-------|")
    lines.append(f"| Benchmarks | {summary.get('benchmark_count', 0)} |")
    lines.append(f"| Succeeded | {summary.get('success_count', 0)} |")
    lines.append(f"| Failed | {summary.get('failed_count', 0)} |")
    lines.append(f"| Unsupported | {summary.get('unsupported_count', 0)} |")
    lines.append(f"| Partial | {summary.get('partial_count', 0)} |")
    lines.append(f"| Success rate | {summary.get('success_rate', 0):.1%} |")

    fda = summary.get("framework_detection_accuracy")
    if fda is not None:
        lines.append(f"| Framework detection accuracy | {fda:.1%} |")

    lines.append(f"| Artifact presence rate | {summary.get('artifact_presence_rate', 0):.1%} |")
    lines.append(f"| Empty artifact rate | {summary.get('empty_artifact_rate', 0):.1%} |")
    lines.append(f"| Low-value artifact rate | {summary.get('low_value_artifact_rate', 0):.1%} |")
    lines.append("")

    per_stack = summary.get("per_stack", {})
    if per_stack:
        lines.append("## Per-Stack Summary\n")
        lines.append("| Stack | Repos | Succeeded | Median Runtime | Median Compression |")
        lines.append("|-------|-------|-----------|----------------|-------------------|")
        for stack, info in sorted(per_stack.items()):
            rt = f"{info['median_runtime_seconds']:.2f}s" if info.get("median_runtime_seconds") else "n/a"
            cr = f"{info['median_compression_ratio']:.2f}x" if info.get("median_compression_ratio") else "n/a"
            lines.append(
                f"| {stack} | {info['repo_count']} | {info['success_count']} | {rt} | {cr} |"
            )
        lines.append("")

    lines.append("## Benchmark Results\n")
    lines.append("| Label | Framework | Plugin | Status | Runtime | Compression |")
    lines.append("|-------|-----------|--------|--------|---------|-------------|")
    for r in results:
        display = _display_label(r, public=True)
        fw = r.get("detected_framework", "")
        plugin = r.get("plugin", "")
        status = r.get("status", "")
        rt = f"{r['runtime_seconds']:.2f}s" if r.get("runtime_seconds") else "n/a"
        ratio = r.get("repo", {}).get("compression_ratio")
        cr = f"{ratio:.2f}x" if ratio else "n/a"
        lines.append(f"| {display} | {fw} | {plugin} | {status} | {rt} | {cr} |")
    lines.append("")

    failures = [r for r in results if r["status"] in {_STATUS_FAILED, _STATUS_PARTIAL}]
    if failures:
        lines.append("## Failures and Partial Results\n")
        for r in failures:
            display = _display_label(r, public=True)
            reason = r.get("failure_reason") or "partial artifacts"
            lines.append(f"- **{display}** ({r['status']}): {reason}")
        lines.append("")

    if previous_snapshot_path:
        try:
            new_snapshot_data = payload
            temp_new = Path("/tmp/_ts_diff_new.json")
            temp_new.write_text(json.dumps(new_snapshot_data, indent=2))
            diff = diff_snapshots(previous_snapshot_path, temp_new)
            temp_new.unlink(missing_ok=True)

            regressions = []
            improvements = []
            for rid, delta in diff.get("compression_ratio_delta", {}).items():
                if delta["delta"] < -1.0:
                    regressions.append((rid, delta))
                elif delta["delta"] > 1.0:
                    improvements.append((rid, delta))

            if regressions or improvements:
                lines.append("## Regressions and Improvements\n")
                if regressions:
                    lines.append("### Regressions\n")
                    for rid, d in sorted(regressions, key=lambda x: x[1]["delta"]):
                        label = _label_for_result_id(results, rid, public=True)
                        lines.append(
                            f"- **{label}**: compression {d['old']:.2f}x -> {d['new']:.2f}x "
                            f"(delta: {d['delta']:+.2f})"
                        )
                    lines.append("")
                if improvements:
                    lines.append("### Improvements\n")
                    for rid, d in sorted(improvements, key=lambda x: -x[1]["delta"]):
                        label = _label_for_result_id(results, rid, public=True)
                        lines.append(
                            f"- **{label}**: compression {d['old']:.2f}x -> {d['new']:.2f}x "
                            f"(delta: {d['delta']:+.2f})"
                        )
                    lines.append("")

            if diff.get("new_failures"):
                lines.append("### New Failures\n")
                for f in diff["new_failures"]:
                    label = _sanitize_string(f.get("label") or f["id"])
                    lines.append(f"- **{label}**: {f.get('failure_reason', 'unknown')}")
                lines.append("")

            if diff.get("fixed_failures"):
                lines.append("### Fixed Failures\n")
                for f in diff["fixed_failures"]:
                    label = _sanitize_string(f.get("label") or f["id"])
                    lines.append(f"- **{label}**: now {f.get('new_status', 'ok')}")
                lines.append("")
        except Exception:
            pass

    return "\n".join(lines) + "\n"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_path(value: str, base_dir: Path) -> Path:
    path = Path(value)
    if path.is_absolute():
        return path.resolve()
    return (base_dir / path).resolve()


def _artifact_is_empty(artifact: dict) -> bool:
    return artifact.get("entity_count", 0) == 0


def _display_label(result: dict, *, public: bool) -> str:
    if public and result.get("private"):
        return result.get("publish_label") or "Private Benchmark"
    return result.get("label") or result.get("id") or "unknown"


def _public_identifier(result: dict, index: int) -> str:
    publish_label = result.get("publish_label")
    if publish_label:
        slug = re.sub(r"[^a-z0-9]+", "-", publish_label.lower()).strip("-")
        if slug:
            return slug
    return f"private-benchmark-{index}"


def _label_for_result_id(results: list[dict], result_id: str, *, public: bool) -> str:
    for result in results:
        if result.get("id") == result_id:
            return _display_label(result, public=public)
    return result_id
