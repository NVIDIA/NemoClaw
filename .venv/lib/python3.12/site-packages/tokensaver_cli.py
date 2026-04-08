#!/usr/bin/env python3
"""
TokenSaver CLI — Compile repositories into minimal agent context.

Usage:
  tokensaver scan <path>
  tokensaver init <path> [--output-dir <dir>] [--force]
  tokensaver build <path> [--output-dir <dir>] [--force]
  tokensaver impact <path> [--output-dir <dir>] [--files file1,file2,...]
  tokensaver serve <path> [--output-dir <dir>]
  tokensaver metrics <path> [--output-dir <dir>]
  tokensaver benchmark <path> [--output-dir <dir>]
  tokensaver benchmark-suite <manifest.json> [--output-dir <dir>] [--previous <snapshot.json>] [--public-only]
  tokensaver diff-snapshots <old.json> <new.json>
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from tokensaver.build import OUTPUT_DIRNAME, build_project
from tokensaver.benchmark import (
    benchmark_project,
    benchmark_suite,
    diff_snapshots,
)
from tokensaver.eval import load_metrics, print_metrics
from tokensaver.impact import compute_impact
from tokensaver.scanner import scan_project


def cmd_scan(project_path: str):
    """Inspect a project and report exact source token counts."""
    result = scan_project(project_path)

    print(f"\n{'=' * 60}")
    print(f"TokenSaver Scan: {result.project_name}")
    print(f"{'=' * 60}\n")

    print(f"Framework:         {result.framework}")
    print(f"Tokenizer:         {result.tokenizer}")
    print(f"Package managers:  {', '.join(result.package_managers) if result.package_managers else 'none detected'}")
    print(f"Files:             {result.total_files:,}")
    print(f"Lines:             {result.total_lines:,}")
    print(f"Bytes:             {result.total_bytes:,}")
    print(f"Exact tokens:      {result.total_tokens:,}")

    if result.entrypoints:
        print(f"\nEntrypoints:")
        for entrypoint in result.entrypoints:
            print(f"  {entrypoint}")

    print(f"\nLanguages:")
    for language, info in result.languages.items():
        print(f"  {language:<15} {info['files']:>6} files  {info['tokens']:>10,} tokens")

    print(f"\nTop files by tokens:")
    for file_info in result.top_files[:10]:
        print(f"  {file_info['tokens']:>8,} tok  {file_info['path']}")

    print(f"\nTop directories by tokens:")
    for dir_info in result.top_dirs[:10]:
        print(f"  {dir_info['tokens']:>8,} tok  {dir_info['dir']}/")

    return result


def cmd_build(project_path: str, output_dir: str | None = None, *, force: bool = False):
    """Generate all context artifacts for a project."""
    result = build_project(project_path, output_dir=output_dir, force=force)
    metrics = result["metrics"]
    skipped = set(result.get("skipped", []))

    print(f"\nBuilt TokenSaver artifacts in {result['output_dir']}\n")
    for artifact in metrics["artifacts"]:
        ratio = artifact["compression_ratio"]
        ratio_text = f"{ratio:.2f}x" if ratio else "n/a"
        status = "  (cached)" if artifact["name"] in skipped else ""
        print(
            f"  {artifact['name']:<20} "
            f"{artifact['source_tokens']:>10,} -> {artifact['output_tokens']:>10,} "
            f"({ratio_text}){status}"
        )

    if skipped:
        print(f"\n  {len(skipped)} artifact(s) unchanged, {len(result.get('rebuilt', []))} rebuilt")

    integrations = result.get("integrations", {})
    if integrations:
        print(f"\nInstalled agent integrations:")
        labels = {
            "cursor": "Cursor",
            "claude": "Claude Code",
            "codex": "Codex",
            "cursor_mcp": "Cursor MCP",
            "claude_mcp": "Claude MCP",
            "windsurf": "Windsurf",
        }
        for key, path in integrations.items():
            print(f"  {labels.get(key, key):<14} {path}")

    print()
    print_metrics(metrics)
    return result


def cmd_init(project_path: str, output_dir: str | None = None, *, force: bool = False):
    """One-shot repo onboarding: build artifacts and install agent integrations."""
    result = build_project(project_path, output_dir=output_dir, force=force)
    scan = result["scan"]
    metrics = result["metrics"]
    integrations = result.get("integrations", {})
    rebuilt = result.get("rebuilt", [])
    skipped = result.get("skipped", [])

    print(f"\n{'=' * 60}")
    print(f"TokenSaver Init:    {scan.project_name}")
    print(f"{'=' * 60}\n")

    print(f"Repo:              {Path(project_path).resolve()}")
    print(f"Framework:         {scan.framework}")
    print(f"Plugin:            {result['plugin']}")
    print(f"Artifacts:         {result['output_dir']}")
    print(f"Compression:       {metrics['repo']['compression_ratio']:.2f}x")
    print(f"Union tokens:      {metrics['repo']['union_source_tokens']:,}")
    print(f"Bundle tokens:     {metrics['repo']['bundle_tokens']:,}")

    if rebuilt or skipped:
        print(f"\nArtifacts:")
        if rebuilt:
            print(f"  rebuilt:         {', '.join(sorted(rebuilt))}")
        if skipped:
            print(f"  cached:          {', '.join(sorted(skipped))}")

    if integrations:
        print(f"\nInstalled integrations:")
        labels = {
            "cursor": "Cursor",
            "claude": "Claude Code",
            "codex": "Codex",
            "cursor_mcp": "Cursor MCP",
            "claude_mcp": "Claude MCP",
            "windsurf": "Windsurf",
        }
        for key, path in integrations.items():
            print(f"  {labels.get(key, key):<14} {path}")

    print(f"\nNext steps:")
    print(f"  1. Open your agent/IDE in this repo.")
    print(f"  2. Ask architecture/API/navigation questions from the generated bundle first.")
    print(f"  3. Re-run `tokensaver build {project_path}` after meaningful code changes.")
    print(f"  4. Run `tokensaver impact {project_path}` to inspect change blast radius.")

    print()
    return result


def cmd_impact(project_path: str, output_dir: str | None = None, files: str | None = None):
    """Blast-radius change-impact analysis."""
    changed_files = files.split(",") if files else None
    result = compute_impact(project_path, output_dir=output_dir, changed_files=changed_files)
    summary = result["summary"]

    print(f"\n{'=' * 60}")
    print("TokenSaver Impact Analysis")
    print(f"{'=' * 60}\n")

    print(f"Changed files:     {summary['files_changed']}")
    print(f"Modules affected:  {summary['modules_affected']}")
    print(f"APIs affected:     {summary['apis_affected']}")
    print(f"Routes affected:   {summary['routes_affected']}")
    print(f"Configs affected:  {summary['configs_affected']}")

    if result["affected_modules"]:
        print(f"\nAffected modules:")
        for mod in result["affected_modules"]:
            print(f"  {mod['name']:<30} {mod['changed_files']} changed / {mod['total_files']} total files")

    if result["affected_apis"]:
        print(f"\nAffected API endpoints ({len(result['affected_apis'])}):")
        for api in result["affected_apis"][:20]:
            print(f"  {api['method']:>4}  {api['endpoint']}")
            print(f"        -> {api['name']}  ({api['file']})")
        if len(result["affected_apis"]) > 20:
            print(f"  ... and {len(result['affected_apis']) - 20} more")

    if result["affected_routes"]:
        print(f"\nAffected routes ({len(result['affected_routes'])}):")
        for route in result["affected_routes"][:20]:
            print(f"  {route['route']:<40} ({route['file']})")
        if len(result["affected_routes"]) > 20:
            print(f"  ... and {len(result['affected_routes']) - 20} more")

    if result["affected_configs"]:
        print(f"\nAffected configs ({len(result['affected_configs'])}):")
        for cfg in result["affected_configs"][:20]:
            print(f"  {cfg['key']:<30} type={cfg['type']}  ({cfg['file']})")

    if summary["files_changed"] == 0:
        print("\n  No changes detected. Specify --files or make changes first.")

    print()
    return result


def cmd_metrics(project_path: str, output_dir: str | None = None):
    """Print compression metrics for an existing build."""
    resolved_output_dir = Path(output_dir).resolve() if output_dir else (Path(project_path).resolve() / OUTPUT_DIRNAME)
    metrics_path = resolved_output_dir / "METRICS.json"
    if not metrics_path.exists():
        print(f"Missing {metrics_path}. Run 'python tokensaver_cli.py build {project_path}' first.")
        return None

    metrics = load_metrics(resolved_output_dir)
    print_metrics(metrics)
    return metrics


def cmd_benchmark(project_path: str, output_dir: str | None = None):
    """Run a reproducible benchmark and persist BENCHMARK.json."""
    result = benchmark_project(project_path, output_dir=output_dir)
    benchmark = result["benchmark"]

    print(f"\nBenchmarked TokenSaver against {benchmark['project']}")
    print(f"Plugin:            {benchmark['plugin']}")
    print(f"Runtime:           {benchmark['runtime_seconds']:.2f}s")
    print(f"Scan tokens:       {benchmark['scan']['total_tokens']:,}")
    print(f"Benchmark output:  {result['output_dir'] / 'BENCHMARK.json'}")
    print_metrics(benchmark["metrics"])
    return result


def cmd_benchmark_suite(
    manifest_path: str,
    output_dir: str | None = None,
    previous: str | None = None,
    *,
    public_only: bool = False,
):
    """Run a benchmark suite from a manifest and persist suite outputs."""
    result = benchmark_suite(
        manifest_path,
        output_root=output_dir,
        previous_snapshot_path=previous,
        public_only=public_only,
    )
    suite = result["suite_results"]
    summary = suite.get("summary", {})

    print(f"\n{'=' * 60}")
    print(f"Benchmark suite:   {suite['suite']}")
    print(f"{'=' * 60}\n")

    print(f"Manifest:          {result['manifest']}")
    if result.get("suite_path"):
        print(f"Results:           {result['suite_path']}")
    print(f"Public results:    {result['public_path']}")
    print(f"Markdown:          {result['md_path']}")
    if result.get("snapshot_path"):
        print(f"Snapshot:          {result['snapshot_path']}")
    if public_only:
        print(f"Mode:              public-only")
    print()

    print(f"Benchmarks:  {summary.get('benchmark_count', 0)}")
    print(f"Succeeded:   {summary.get('success_count', 0)}")
    print(f"Failed:      {summary.get('failed_count', 0)}")
    print(f"Unsupported: {summary.get('unsupported_count', 0)}")
    print(f"Partial:     {summary.get('partial_count', 0)}")
    print(f"Success rate: {summary.get('success_rate', 0):.1%}\n")

    fda = summary.get("framework_detection_accuracy")
    if fda is not None:
        print(f"Framework detection accuracy: {fda:.1%}")

    print(f"\n{'Label':<28} {'Framework':<15} {'Status':<12} {'Runtime':>8} {'Ratio':>10}")
    print(f"{'-' * 28} {'-' * 15} {'-' * 12} {'-' * 8} {'-' * 10}")
    for item in suite["results"]:
        repo_ratio = item.get("repo", {}).get("compression_ratio")
        ratio_text = f"{repo_ratio:.2f}x" if repo_ratio else "n/a"
        rt = f"{item['runtime_seconds']:.2f}s" if item.get("runtime_seconds") else "n/a"
        fw = item.get("detected_framework") or ""
        print(
            f"{item.get('publish_label', item.get('label', item['id'])):<28} "
            f"{fw:<15} "
            f"{item['status']:<12} "
            f"{rt:>8} "
            f"{ratio_text:>10}"
        )

    failures = [r for r in suite["results"] if r["status"] in {"failed", "partial"}]
    if failures:
        print(f"\nFailures / Partial:")
        for f in failures:
            reason = f.get("failure_reason") or "partial artifacts"
            label = f.get("publish_label") if f.get("private") else f.get("label", f["id"])
            print(f"  {label}: {reason}")

    if previous:
        print(f"\nComparing against previous snapshot: {previous}")
        try:
            diff = diff_snapshots(previous, result["suite_path"])
            _print_diff(diff)
        except Exception as exc:
            print(f"  Error comparing snapshots: {exc}")

    print()
    return result


def cmd_diff_snapshots(old_path: str, new_path: str):
    """Compare two suite snapshots and print a regression report."""
    diff = diff_snapshots(old_path, new_path)

    print(f"\n{'=' * 60}")
    print("Snapshot Diff Report")
    print(f"{'=' * 60}\n")

    _print_diff(diff)
    return diff


def _print_diff(diff: dict):
    """Print diff results to stdout."""
    if diff.get("new_failures"):
        print(f"\nNew failures ({len(diff['new_failures'])}):")
        for f in diff["new_failures"]:
            print(f"  {f.get('label', f['id'])}: {f.get('failure_reason', 'unknown')}")

    if diff.get("fixed_failures"):
        print(f"\nFixed failures ({len(diff['fixed_failures'])}):")
        for f in diff["fixed_failures"]:
            print(f"  {f.get('label', f['id'])}: now {f.get('new_status', 'ok')}")

    if diff.get("compression_ratio_delta"):
        print(f"\nCompression ratio changes:")
        for rid, d in sorted(diff["compression_ratio_delta"].items(), key=lambda x: x[1]["delta"]):
            label = d.get("label", rid)
            print(f"  {label}: {d['old']:.2f}x -> {d['new']:.2f}x ({d['delta']:+.2f})")

    if diff.get("runtime_delta"):
        print(f"\nRuntime changes:")
        for rid, d in sorted(diff["runtime_delta"].items(), key=lambda x: x[1]["delta"]):
            label = d.get("label", rid)
            print(f"  {label}: {d['old']:.2f}s -> {d['new']:.2f}s ({d['delta']:+.2f}s)")

    if diff.get("framework_detection_changes"):
        print(f"\nFramework detection changes:")
        for c in diff["framework_detection_changes"]:
            print(f"  {c.get('label', c['id'])}: {c['old']} -> {c['new']}")

    if not any(diff.get(k) for k in ("new_failures", "fixed_failures", "compression_ratio_delta", "runtime_delta", "framework_detection_changes")):
        print("  No significant changes detected.")


def _parse_output_dir(argv: list[str]) -> str | None:
    if "--output-dir" not in argv:
        return None
    index = argv.index("--output-dir")
    if index + 1 >= len(argv):
        print("Error: --output-dir requires a directory path")
        sys.exit(1)
    return argv[index + 1]


def _parse_flag(argv: list[str], flag: str) -> str | None:
    if flag not in argv:
        return None
    index = argv.index(flag)
    if index + 1 >= len(argv):
        print(f"Error: {flag} requires a value")
        sys.exit(1)
    return argv[index + 1]


def main():
    if len(sys.argv) < 2 or sys.argv[1] in {"-h", "--help", "help"}:
        print(__doc__)
        sys.exit(0)

    if len(sys.argv) < 3:
        print(__doc__)
        sys.exit(1)

    command = sys.argv[1]
    target = sys.argv[2]
    remaining = sys.argv[3:]
    output_dir = _parse_output_dir(remaining)

    if command == "scan":
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        cmd_scan(target)
    elif command == "init":
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        force = "--force" in remaining
        cmd_init(target, output_dir=output_dir, force=force)
    elif command in {"build", "generate"}:
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        force = "--force" in remaining
        cmd_build(target, output_dir=output_dir, force=force)
    elif command == "serve":
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        from tokensaver.mcp_server import main as serve_main
        serve_main(project_path=target, output_dir=output_dir)
    elif command == "impact":
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        files_arg = _parse_flag(remaining, "--files")
        cmd_impact(target, output_dir=output_dir, files=files_arg)
    elif command in {"metrics", "eval"}:
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        cmd_metrics(target, output_dir=output_dir)
    elif command == "benchmark":
        if not os.path.isdir(target):
            print(f"Error: {target} is not a directory")
            sys.exit(1)
        cmd_benchmark(target, output_dir=output_dir)
    elif command == "benchmark-suite":
        if not os.path.isfile(target):
            print(f"Error: {target} is not a file")
            sys.exit(1)
        previous = _parse_flag(remaining, "--previous")
        public_only = "--public-only" in remaining
        cmd_benchmark_suite(target, output_dir=output_dir, previous=previous, public_only=public_only)
    elif command == "diff-snapshots":
        if len(sys.argv) < 4:
            print("Usage: python tokensaver_cli.py diff-snapshots <old.json> <new.json>")
            sys.exit(1)
        new_target = sys.argv[3]
        cmd_diff_snapshots(target, new_target)
    else:
        print(f"Unknown command: {command}")
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
