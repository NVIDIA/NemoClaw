"""MCP server for TokenSaver — exposes bundle artifacts as queryable tools."""

from __future__ import annotations

import json
import sys
from pathlib import Path

try:
    from fastmcp import FastMCP
except ImportError:
    FastMCP = None  # type: ignore[assignment, misc]

from tokensaver.build import OUTPUT_DIRNAME

_artifact_cache: dict[str, dict] = {}
_root: Path = Path(".")
_output_dir: Path = Path(".")

INSTRUCTIONS = (
    "TokenSaver provides compressed, structured context for a codebase. "
    "Use these tools to query modules, APIs, routes, configs, and impact "
    "analysis instead of reading raw source files."
)


def _load(name: str) -> dict:
    if name not in _artifact_cache:
        path = _output_dir / name
        if path.exists():
            _artifact_cache[name] = json.loads(path.read_text())
        else:
            _artifact_cache[name] = {}
    return _artifact_cache[name]


def _create_server() -> "FastMCP":
    if FastMCP is None:
        print("Error: fastmcp is required. Install with: pip install 'tokensaver[mcp]'", file=sys.stderr)
        sys.exit(1)

    mcp = FastMCP("tokensaver", instructions=INSTRUCTIONS)

    @mcp.tool()
    def project_summary() -> dict:
        """Get project overview: framework, languages, entrypoints, and manifests."""
        return _load("PROJECT_SUMMARY.json")

    @mcp.tool()
    def commands() -> dict:
        """Get build, run, test, and lint commands for the project."""
        return _load("COMMANDS.json")

    @mcp.tool()
    def query_modules(name: str | None = None) -> dict:
        """Query module graph. Pass a name to filter, or omit to list all modules."""
        data = _load("MODULE_GRAPH.json")
        modules = data.get("modules", [])
        if name:
            query = name.lower()
            modules = [m for m in modules if query in m.get("name", "").lower()]
        return {"modules": modules, "count": len(modules)}

    @mcp.tool()
    def query_apis(query: str | None = None, module: str | None = None) -> dict:
        """Search API endpoints by keyword or module name."""
        data = _load("API_INDEX.json")
        results = []
        for file_entry in data.get("files", []):
            fname, mod, entries = file_entry[0], file_entry[1], file_entry[2]
            if module and module.lower() not in mod.lower():
                continue
            for entry in entries:
                endpoint, name, method = entry[0], entry[1], entry[2]
                if query and query.lower() not in f"{endpoint} {name}".lower():
                    continue
                results.append({
                    "endpoint": endpoint,
                    "name": name,
                    "method": method or "POST",
                    "file": fname,
                    "module": mod,
                })
        return {"apis": results, "count": len(results)}

    @mcp.tool()
    def query_routes(query: str | None = None, module: str | None = None) -> dict:
        """Search navigation routes by keyword or module."""
        data = _load("ROUTE_INDEX.json")
        results = []
        for file_entry in data.get("files", []):
            fname, entries = file_entry[0], file_entry[1]
            for entry in entries:
                route_path = entry[0]
                navigated_from = entry[4] if len(entry) > 4 else ""
                if module and module.lower() not in navigated_from.lower() and module.lower() not in fname.lower():
                    continue
                if query and query.lower() not in f"{route_path} {fname}".lower():
                    continue
                results.append({
                    "route": route_path,
                    "file": fname,
                    "usage_count": entry[2] if len(entry) > 2 else 0,
                    "navigated_from": navigated_from,
                })
        return {"routes": results, "count": len(results)}

    @mcp.tool()
    def query_config(query: str | None = None) -> dict:
        """Search configuration entries and feature flags."""
        data = _load("CONFIG_INDEX.json")
        results = []
        for file_entry in data.get("files", []):
            if not isinstance(file_entry, list) or len(file_entry) < 2:
                continue
            fname = file_entry[0]
            entries = file_entry[1] if len(file_entry) == 2 else file_entry[2]
            if not isinstance(entries, list):
                continue
            for entry in entries:
                if not isinstance(entry, list) or len(entry) < 2:
                    continue
                key = entry[0]
                if query and query.lower() not in key.lower():
                    continue
                results.append({
                    "key": key,
                    "type": entry[1] if len(entry) > 1 else "unknown",
                    "file": fname,
                })
        return {"configs": results, "count": len(results)}

    @mcp.tool()
    def metrics() -> dict:
        """Get compression stats and per-artifact token ratios."""
        return _load("METRICS.json")

    @mcp.tool()
    def impact_analysis(files: list[str] | None = None) -> dict:
        """Blast-radius analysis: which modules, APIs, and routes are affected by changed files.
        Pass specific file paths, or omit to auto-detect from git diff."""
        from tokensaver.impact import compute_impact
        return compute_impact(str(_root), output_dir=str(_output_dir), changed_files=files)

    return mcp


def main(project_path: str | None = None, output_dir: str | None = None) -> None:
    """Start the TokenSaver MCP server in stdio mode."""
    global _root, _output_dir, _artifact_cache

    _root = Path(project_path or ".").resolve()
    _output_dir = Path(output_dir).resolve() if output_dir else (_root / OUTPUT_DIRNAME)
    _artifact_cache = {}

    if not (_output_dir / "METRICS.json").exists():
        print(
            f"Error: No TokenSaver build found at {_output_dir}. "
            f"Run 'tokensaver build {_root}' first.",
            file=sys.stderr,
        )
        sys.exit(1)

    server = _create_server()
    server.run(transport="stdio")
