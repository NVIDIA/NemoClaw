"""IDE integration generators for TokenSaver.

After `tokensaver build` produces JSON artifacts, this module writes
agent-rule files so that Cursor, Claude Code, Codex, and Windsurf
automatically read the compressed bundle instead of crawling raw source.
It also writes MCP server configs where applicable.
"""

from __future__ import annotations

import json
from pathlib import Path


def _relative_artifact_dir(root: Path, output_dir: Path) -> str:
    """Return the artifact directory as a path relative to the repo root."""
    try:
        return str(output_dir.relative_to(root))
    except ValueError:
        return str(output_dir)


def _build_rule_body(artifact_dir: str, artifacts: list[dict]) -> str:
    """Build the shared instruction text used by all three IDE integrations."""
    artifact_table = "\n".join(
        f"   | {a['question']:<55} | `{artifact_dir}/{a['file']}` |"
        for a in artifacts
    )

    file_tree = "\n".join(f"  {a['file']:<28} — {a['desc']}" for a in artifacts)

    return (
        f"This repository has a **TokenSaver context bundle** at `{artifact_dir}/`.\n"
        f"It contains compressed, structured JSON artifacts that summarise the entire\n"
        f"codebase. Always prefer reading these artifacts over raw source files.\n"
        f"\n"
        f"## Workflow\n"
        f"\n"
        f"1. **Read the relevant TokenSaver artifact first.** Match the question to the\n"
        f"   artifact:\n"
        f"\n"
        f"   | Question about …{' ' * 39} | Artifact |\n"
        f"   |{'-' * 57}|{'-' * (len(artifact_dir) + 35)}|\n"
        f"{artifact_table}\n"
        f"\n"
        f"2. **Answer from the bundle when possible.** For architecture, navigation,\n"
        f"   API surface, and cross-cutting questions the bundle is sufficient.\n"
        f"\n"
        f"3. **Only read raw source files** when you need implementation details the\n"
        f"   bundle does not cover (function bodies, widget build methods, test\n"
        f"   assertions, etc.).\n"
        f"\n"
        f"## Artifact Quick Reference\n"
        f"\n"
        f"```\n"
        f"{artifact_dir}/\n"
        f"{file_tree}\n"
        f"```\n"
    )


_ARTIFACT_CATALOG = [
    {"file": "PROJECT_SUMMARY.json", "question": "Project overview, framework, languages, entrypoint", "desc": "framework, languages, entrypoints, manifests"},
    {"file": "COMMANDS.json",        "question": "How to build, run, test, lint",                     "desc": "build / run / test / lint commands"},
    {"file": "MODULE_GRAPH.json",    "question": "Module structure, dependencies, file counts",       "desc": "modules with file counts and token sizes"},
    {"file": "API_INDEX.json",       "question": "API endpoints, backend services",                   "desc": "API endpoints grouped by file and module"},
    {"file": "ROUTE_INDEX.json",     "question": "Navigation routes, screens, pages",                 "desc": "navigation routes with screen mappings"},
    {"file": "CONFIG_INDEX.json",    "question": "Feature flags, remote config, env config",          "desc": "config entries and feature flags"},
    {"file": "METRICS.json",         "question": "Token counts, compression stats",                   "desc": "compression stats and per-artifact ratios"},
]


def install_cursor_rule(root: Path, output_dir: Path) -> Path | None:
    """Write `.cursor/rules/tokensaver.mdc` in the repo root."""
    artifact_dir = _relative_artifact_dir(root, output_dir)
    rules_dir = root / ".cursor" / "rules"
    rules_dir.mkdir(parents=True, exist_ok=True)
    rule_path = rules_dir / "tokensaver.mdc"

    body = _build_rule_body(artifact_dir, _ARTIFACT_CATALOG)
    content = (
        "---\n"
        "description: Auto-load TokenSaver compressed context for codebase questions\n"
        "globs:\n"
        "alwaysApply: true\n"
        "---\n"
        "\n"
        "# TokenSaver Context — Always Read First\n"
        "\n"
        f"{body}"
    )
    rule_path.write_text(content)
    return rule_path


def install_claude_md(root: Path, output_dir: Path) -> Path | None:
    """Append or create `CLAUDE.md` in the repo root with TokenSaver instructions."""
    artifact_dir = _relative_artifact_dir(root, output_dir)
    claude_path = root / "CLAUDE.md"

    marker = "<!-- tokensaver:start -->"
    marker_end = "<!-- tokensaver:end -->"

    body = _build_rule_body(artifact_dir, _ARTIFACT_CATALOG)
    section = f"{marker}\n# TokenSaver Context\n\n{body}\n{marker_end}\n"

    if claude_path.exists():
        existing = claude_path.read_text()
        if marker in existing:
            import re
            existing = re.sub(
                rf"{re.escape(marker)}.*?{re.escape(marker_end)}\n?",
                section,
                existing,
                flags=re.DOTALL,
            )
            claude_path.write_text(existing)
        else:
            claude_path.write_text(existing.rstrip() + "\n\n" + section)
    else:
        claude_path.write_text(section)
    return claude_path


def install_codex_md(root: Path, output_dir: Path) -> Path | None:
    """Append or create `AGENTS.md` in the repo root with TokenSaver instructions."""
    artifact_dir = _relative_artifact_dir(root, output_dir)
    agents_path = root / "AGENTS.md"

    marker = "<!-- tokensaver:start -->"
    marker_end = "<!-- tokensaver:end -->"

    body = _build_rule_body(artifact_dir, _ARTIFACT_CATALOG)
    section = f"{marker}\n# TokenSaver Context\n\n{body}\n{marker_end}\n"

    if agents_path.exists():
        existing = agents_path.read_text()
        if marker in existing:
            import re
            existing = re.sub(
                rf"{re.escape(marker)}.*?{re.escape(marker_end)}\n?",
                section,
                existing,
                flags=re.DOTALL,
            )
            agents_path.write_text(existing)
        else:
            agents_path.write_text(existing.rstrip() + "\n\n" + section)
    else:
        agents_path.write_text(section)
    return agents_path


def _mcp_server_entry() -> dict:
    """Build the MCP server config entry for tokensaver."""
    return {
        "command": "tokensaver",
        "args": ["serve", "."],
    }


def _has_fastmcp() -> bool:
    try:
        import fastmcp  # noqa: F401
        return True
    except ImportError:
        return False


def _merge_mcp_config(path: Path, server_name: str, entry: dict) -> None:
    """Write or merge an MCP server entry into a JSON config file."""
    existing: dict = {}
    if path.exists():
        try:
            existing = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError):
            existing = {}

    servers = existing.setdefault("mcpServers", {})
    servers[server_name] = entry
    path.write_text(json.dumps(existing, indent=2) + "\n")


def install_cursor_mcp(root: Path) -> Path | None:
    """Write/merge `.cursor/mcp.json` with the tokensaver MCP server."""
    if not _has_fastmcp():
        return None
    mcp_dir = root / ".cursor"
    mcp_dir.mkdir(parents=True, exist_ok=True)
    mcp_path = mcp_dir / "mcp.json"
    _merge_mcp_config(mcp_path, "tokensaver", _mcp_server_entry())
    return mcp_path


def install_claude_mcp(root: Path) -> Path | None:
    """Write/merge `.mcp.json` with the tokensaver MCP server."""
    if not _has_fastmcp():
        return None
    mcp_path = root / ".mcp.json"
    _merge_mcp_config(mcp_path, "tokensaver", _mcp_server_entry())
    return mcp_path


def install_windsurf_rule(root: Path, output_dir: Path) -> Path | None:
    """Write `.windsurfrules` in the repo root with TokenSaver instructions."""
    artifact_dir = _relative_artifact_dir(root, output_dir)
    rule_path = root / ".windsurfrules"

    body = _build_rule_body(artifact_dir, _ARTIFACT_CATALOG)
    marker = "<!-- tokensaver:start -->"
    marker_end = "<!-- tokensaver:end -->"
    section = f"{marker}\n# TokenSaver Context — Always Read First\n\n{body}\n{marker_end}\n"

    if rule_path.exists():
        existing = rule_path.read_text()
        if marker in existing:
            import re
            existing = re.sub(
                rf"{re.escape(marker)}.*?{re.escape(marker_end)}\n?",
                section,
                existing,
                flags=re.DOTALL,
            )
            rule_path.write_text(existing)
        else:
            rule_path.write_text(existing.rstrip() + "\n\n" + section)
    else:
        rule_path.write_text(section)
    return rule_path


def install_integrations(root: Path, output_dir: Path) -> dict[str, Path]:
    """Install all IDE integration files. Returns a map of name -> path written."""
    results: dict[str, Path] = {}

    cursor_path = install_cursor_rule(root, output_dir)
    if cursor_path:
        results["cursor"] = cursor_path

    claude_path = install_claude_md(root, output_dir)
    if claude_path:
        results["claude"] = claude_path

    codex_path = install_codex_md(root, output_dir)
    if codex_path:
        results["codex"] = codex_path

    windsurf_path = install_windsurf_rule(root, output_dir)
    if windsurf_path:
        results["windsurf"] = windsurf_path

    cursor_mcp = install_cursor_mcp(root)
    if cursor_mcp:
        results["cursor_mcp"] = cursor_mcp

    claude_mcp = install_claude_mcp(root)
    if claude_mcp:
        results["claude_mcp"] = claude_mcp

    return results
