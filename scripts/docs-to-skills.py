#!/usr/bin/env python3
"""Convert documentation files into Agent Skills (agentskills.io spec).

Reads a directory of Markdown or Fern MDX documentation, parses YAML frontmatter
and content structure, groups related pages into coherent skill units, and
generates SKILL.md files following the Agent Skills specification:
https://agentskills.io/specification

Usage:

Make sure to run this script using the following command to generate the skills and keep the locations and names consistent.

```bash
python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --doc-platform fern-mdx
```

What it does:
  1. Scans a docs directory for Markdown or Fern MDX files with YAML frontmatter.
     Pages with ``exclude-from-skills-gen: true`` are skipped.
  2. Classifies each page by content type (how_to, concept, reference,
     get_started) using the frontmatter `content.type` field.
  3. Groups pages into skills using one of two strategies:
       - grouped (default): groups by parent directory; the highest-priority
         procedure page (``how_to``, ``get_started``, or ``tutorial``) becomes
         the full SKILL.md body and siblings go to ``references/``. Groups
         with no procedure page put every sibling in ``references/`` only.
       - individual: each ``how_to``, ``get_started``, or ``tutorial`` page
         becomes its own skill; ``concept`` pages collect into
         ``nemoclaw-user-concept`` and ``reference`` pages (plus other
         non-procedure types) collect into ``nemoclaw-user-reference``.
  4. Generates a skill directory per group containing:
       - SKILL.md with frontmatter (name, description), the lead page body,
         a References section linking sibling pages, and Related Skills links.
       - references/ with full sibling page content for progressive disclosure.
  5. Resolves all relative doc paths to repo-root-relative paths, and
     converts cross-references between docs into skill-to-skill pointers
     so agents can navigate between skills.

Naming:
  Use --prefix to keep skill names consistent across the project. The prefix
  is prepended to every generated skill name (e.g. --prefix nemoclaw-user produces
  nemoclaw-user-get-started, nemoclaw-user-manage-policy). Action verbs are derived
  automatically from page titles and content types. Use --name-map to
  override specific names when the heuristic doesn't produce the right result.

Usage:
    python3 scripts/docs-to-skills.py docs/ .agents/skills/ skills/ --prefix nemoclaw-user --doc-platform fern-mdx
    python3 scripts/docs-to-skills.py docs/ .agents/skills/ skills/ --prefix nemoclaw-user --doc-platform fern-mdx --dry-run
    python3 scripts/docs-to-skills.py docs/ .agents/skills/ --strategy individual --prefix nemoclaw-user --doc-platform fern-mdx
    python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --name-map about=overview --doc-platform fern-mdx
    python3 scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw-user --exclude "release-notes.mdx" --doc-platform fern-mdx
"""

from __future__ import annotations

import argparse
import ast
import json
import os
import re
import shutil
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path

# Image asset extensions that the rewriter copies alongside the
# generated skill file. Local copies keep skills self-contained so they
# render even when the docs site is offline or unpublished.
IMAGE_EXTENSIONS = frozenset({".png", ".jpg", ".jpeg", ".svg", ".gif", ".webp"})


def load_html_baseurl(docs_dir: Path) -> str | None:
    """Read ``html_baseurl`` from a Sphinx ``conf.py`` without executing it.

    Skill files must be self-contained and must not reference repository
    paths (for example, ``../../../docs/...``). When an inter-doc link
    points at a page that has no corresponding skill, the rewriter
    substitutes the page's published HTTPS URL derived from
    ``html_baseurl``. Parsing the assignment with :mod:`ast` avoids the
    side effects of ``exec``-ing conf.py (which pulls in Sphinx, modifies
    ``sys.path``, reads JSON, and so on).
    """
    conf_py = docs_dir / "conf.py"
    if not conf_py.exists():
        return None
    try:
        tree = ast.parse(conf_py.read_text(encoding="utf-8"))
    except (OSError, SyntaxError):
        return None
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if (
            isinstance(target, ast.Name)
            and target.id == "html_baseurl"
            and isinstance(node.value, ast.Constant)
            and isinstance(node.value.value, str)
        ):
            url = node.value.value
            return url if url.endswith("/") else url + "/"
    return None


# ---------------------------------------------------------------------------
# Heading normalization
# ---------------------------------------------------------------------------


def normalize_heading_levels(text: str) -> str:
    """Ensure markdown headings increment by at most one level at a time.

    After resolving includes the document may contain heading-level gaps
    (e.g. ``# Title`` followed by ``### Sub`` with no intervening ``##``).
    This function promotes headings so the nesting never skips a level,
    preserving the relative depth of sibling and child headings.
    """
    lines = text.split("\n")
    heading_re = re.compile(r"^(#{1,6})\s")
    # First pass: collect all heading levels in order.
    heading_levels: list[tuple[int, int]] = []  # (line_index, level)
    for i, line in enumerate(lines):
        m = heading_re.match(line)
        if m:
            heading_levels.append((i, len(m.group(1))))

    if not heading_levels:
        return text

    # Second pass: compute the minimum level each heading should have
    # so that no heading exceeds its predecessor by more than 1.
    max_allowed = 0
    remap: dict[int, int] = {}  # line_index -> new_level
    for idx, level in heading_levels:
        new_level = min(level, max_allowed + 1)
        remap[idx] = new_level
        max_allowed = new_level

    # Third pass: rewrite headings.
    for idx, new_level in remap.items():
        m = heading_re.match(lines[idx])
        if m:
            old_prefix = m.group(1)
            lines[idx] = "#" * new_level + lines[idx][len(old_prefix) :]

    return space_anchor_headings("\n".join(lines))


def space_anchor_headings(text: str) -> str:
    """Keep standalone HTML anchors from tripping heading spacing lint."""
    return re.sub(r'(?m)^(<a\s+id="[^"]+"></a>)\n(#{1,6}\s)', r"\1\n\n\2", text)


def collapse_consecutive_blank_lines(text: str) -> str:
    """Collapse runs of blank lines to a single blank line (markdownlint MD012)."""
    return re.sub(r"\n{3,}", "\n\n", text)


def append_markdown_section(lines: list[str], heading: str) -> None:
    """Append a section heading, avoiding duplicate blank lines before it."""
    if lines and lines[-1] != "":
        lines.append("")
    lines.append(heading)
    lines.append("")


# ---------------------------------------------------------------------------
# Frontmatter / doc parsing
# ---------------------------------------------------------------------------

DOC_PLATFORMS = ("myst-md", "fern-mdx")
DOC_EXTENSIONS = {
    "myst-md": ".md",
    "fern-mdx": ".mdx",
}


@dataclass
class DocPage:
    """A single documentation page with parsed metadata and content."""

    path: Path
    raw: str
    frontmatter: dict = field(default_factory=dict)
    body: str = ""

    # Derived fields populated after parsing
    title: str = ""
    description: str = ""
    description_is_agent: bool = False
    content_type: str = ""  # concept, how_to, reference, get_started, tutorial
    difficulty: str = ""
    keywords: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    audience: list[str] = field(default_factory=list)
    skill_priority: int = 100
    sections: list[tuple[str, str]] = field(default_factory=list)  # (heading, body)
    category: str = ""  # parent directory name


def parse_yaml_frontmatter(text: str) -> tuple[dict, str]:
    """Extract YAML frontmatter from a markdown file.

    Returns (frontmatter_dict, body_text). Uses a minimal parser to avoid
    requiring PyYAML as a dependency.
    """
    if not text.startswith("---"):
        return {}, text

    end = text.find("\n---", 3)
    if end == -1:
        return {}, text

    fm_text = text[4:end].strip()
    body = text[end + 4 :].strip()
    fm = _parse_simple_yaml(fm_text)
    return fm, body


def _parse_simple_yaml(text: str) -> dict:
    """Minimal YAML parser for doc frontmatter. Handles nested keys, lists."""
    result: dict = {}
    current_key: str | None = None
    parent_stack: list[tuple[str, dict, int]] = []

    for line in text.split("\n"):
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue

        indent = len(line) - len(line.lstrip())

        # Handle list items
        if stripped.startswith("- "):
            value = stripped[2:].strip().strip('"').strip("'")
            if current_key and current_key in _current_dict(result, parent_stack):
                target = _current_dict(result, parent_stack)
                if not isinstance(target[current_key], list):
                    target[current_key] = []
                target[current_key].append(value)
            continue

        # Handle inline list: key: ["a", "b"]
        if ":" in stripped:
            key, _, val = stripped.partition(":")
            key = key.strip()
            val = val.strip()

            # Pop parent stack if we've dedented
            while parent_stack and indent <= parent_stack[-1][2]:
                parent_stack.pop()

            target = _current_dict(result, parent_stack)

            if val.startswith("[") and val.endswith("]"):
                items = [
                    v.strip().strip('"').strip("'")
                    for v in val[1:-1].split(",")
                    if v.strip()
                ]
                target[key] = items
                current_key = key
            elif val:
                target[key] = val.strip('"').strip("'")
                current_key = key
            else:
                target[key] = {}
                parent_stack.append((key, target, indent))
                current_key = None

    return result


def _current_dict(root: dict, stack: list[tuple[str, dict, int]]) -> dict:
    """Walk the parent stack to find the current insertion dict."""
    d = root
    for key, _, _ in stack:
        d = d[key]
    return d


def _as_string(value: object) -> str:
    """Return a stripped string for scalar frontmatter values."""
    return str(value or "").strip()


def _as_list(value: object) -> list[str]:
    """Normalize YAML scalar/list frontmatter values into a string list."""
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return []


def _as_bool(value: object) -> bool:
    """Normalize common YAML boolean spellings parsed by the minimal parser."""
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return False


def _title_from_body(body: str, fallback: str) -> str:
    """Read the first H1 from a page body, falling back to the file stem."""
    match = re.search(r"^#\s+(.+)$", body, flags=re.MULTILINE)
    return match.group(1).strip() if match else fallback


def strip_commented_out_blocks(text: str) -> str:
    """Remove hidden Markdown/MDX comments while preserving fenced examples."""
    chunks: list[tuple[bool, str]] = []
    current: list[str] = []
    in_fence = False

    for line in text.splitlines(keepends=True):
        if line.lstrip().startswith("```"):
            if not in_fence:
                if current:
                    chunks.append((False, "".join(current)))
                    current = []
                in_fence = True
            current.append(line)
            if in_fence and len(current) > 1:
                chunks.append((True, "".join(current)))
                current = []
                in_fence = False
            continue
        current.append(line)

    if current:
        chunks.append((in_fence, "".join(current)))

    def _strip(chunk: str) -> str:
        chunk = re.sub(r"<!--.*?-->", "", chunk, flags=re.DOTALL)
        chunk = re.sub(r"\{/\*.*?\*/\}", "", chunk, flags=re.DOTALL)
        chunk = re.sub(r"<!--.*\Z", "", chunk, flags=re.DOTALL)
        chunk = re.sub(r"\{/\*.*\Z", "", chunk, flags=re.DOTALL)
        return chunk

    return "".join(chunk if is_fence else _strip(chunk) for is_fence, chunk in chunks)


def _populate_myst_markdown_fields(page: DocPage, fm: dict, body: str) -> None:
    """Populate DocPage fields from legacy MyST Markdown frontmatter."""
    title_block = fm.get("title", {})
    if isinstance(title_block, dict):
        page.title = _as_string(title_block.get("page") or title_block.get("nav"))
    elif isinstance(title_block, str):
        page.title = title_block.strip()
    if not page.title:
        page.title = _title_from_body(body, page.path.stem)

    desc = fm.get("description", "")
    if isinstance(desc, dict):
        main = _as_string(desc.get("main"))
        agent = _as_string(desc.get("agent"))
        if agent:
            page.description = agent
            page.description_is_agent = True
        else:
            page.description = main
    else:
        page.description = _as_string(desc)

    page.keywords = _as_list(fm.get("keywords", []))
    page.tags = _as_list(fm.get("tags", []))

    content = fm.get("content", {})
    if isinstance(content, dict):
        page.content_type = _as_string(content.get("type"))
        page.difficulty = _as_string(content.get("difficulty"))
        page.audience = _as_list(content.get("audience", []))

    skill = fm.get("skill", {})
    if isinstance(skill, dict):
        page.skill_priority = _parse_skill_priority(skill.get("priority"), page.path)
    else:
        page.skill_priority = _parse_skill_priority(fm.get("skill_priority"), page.path)


def _populate_fern_mdx_fields(page: DocPage, fm: dict, body: str) -> None:
    """Populate DocPage fields from Fern MDX frontmatter.

    Fern pages use flat metadata. ``description-agent`` is the Fern equivalent
    of legacy MyST ``description.agent`` and should drive skill routing.
    """
    page.title = _as_string(fm.get("title") or fm.get("sidebar-title"))
    if not page.title:
        page.title = _title_from_body(body, page.path.stem)

    agent_description = _as_string(
        fm.get("description-agent") or fm.get("description_agent")
    )
    if agent_description:
        page.description = agent_description
        page.description_is_agent = True
    else:
        page.description = _as_string(fm.get("description"))

    page.keywords = _as_list(fm.get("keywords", []))
    page.tags = _as_list(fm.get("tags", []))

    content = fm.get("content", {})
    if isinstance(content, dict):
        page.content_type = _as_string(content.get("type"))
        page.difficulty = _as_string(content.get("difficulty"))
        page.audience = _as_list(content.get("audience", []))

    skill = fm.get("skill", {})
    if isinstance(skill, dict):
        page.skill_priority = _parse_skill_priority(skill.get("priority"), page.path)
    else:
        page.skill_priority = _parse_skill_priority(fm.get("skill_priority"), page.path)


def parse_doc(path: Path, doc_platform: str = "myst-md") -> DocPage:
    """Parse a documentation file into a DocPage."""
    raw = path.read_text(encoding="utf-8")
    fm, body = parse_yaml_frontmatter(raw)
    if doc_platform == "fern-mdx":
        body = body.replace("$$nemoclaw", "nemoclaw")
    body = strip_commented_out_blocks(body)

    page = DocPage(path=path, raw=raw, frontmatter=fm, body=body)

    if doc_platform == "myst-md":
        _populate_myst_markdown_fields(page, fm, body)
    elif doc_platform == "fern-mdx":
        _populate_fern_mdx_fields(page, fm, body)
    else:
        raise ValueError(f"unsupported doc platform: {doc_platform}")

    page.category = path.parent.name if path.parent.name != "docs" else "root"
    page.sections = _extract_sections(body)

    return page


def _parse_skill_priority(value: object, path: Path) -> int:
    """Parse the frontmatter priority used to choose SKILL.md lead pages."""
    default = 100
    if value is None or value == "":
        return default
    try:
        return int(str(value).strip())
    except ValueError:
        print(
            f"  warning: invalid skill.priority for {path}; using default {default}",
            file=sys.stderr,
        )
        return default


def _extract_sections(body: str) -> list[tuple[str, str]]:
    """Split markdown body into (heading, content) pairs at H2 level."""
    sections: list[tuple[str, str]] = []
    current_heading = ""
    current_lines: list[str] = []

    for line in body.split("\n"):
        if line.startswith("## "):
            if current_heading or current_lines:
                sections.append((current_heading, "\n".join(current_lines).strip()))
            current_heading = line[3:].strip()
            current_lines = []
        else:
            current_lines.append(line)

    if current_heading or current_lines:
        sections.append((current_heading, "\n".join(current_lines).strip()))

    return sections


# ---------------------------------------------------------------------------
# Content transformation
# ---------------------------------------------------------------------------


def _format_admonition(title: str, body: str) -> str:
    """Format an admonition-like block as portable markdown."""
    clean_title = title.strip() or "Note"
    lines = [
        line
        for line in body.strip().split("\n")
        if not re.match(r"^\s*:[a-z_-]+:", line)
    ]
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if not lines:
        return f"**{clean_title}**"
    return f"**{clean_title}:**\n\n" + "\n".join(lines).strip()


def _format_markdown_table(rows: list[list[str]], header_rows: int = 1) -> str:
    """Format parsed directive table rows as standard Markdown."""
    if not rows:
        return ""
    width = max(len(row) for row in rows)
    normalized_rows = [row + [""] * (width - len(row)) for row in rows]
    header = normalized_rows[0] if header_rows else [""] * width
    body_rows = normalized_rows[1:] if header_rows else normalized_rows

    lines = [
        "| " + " | ".join(cell.strip() for cell in header) + " |",
        "| " + " | ".join("---" for _ in range(width)) + " |",
    ]
    for row in body_rows:
        lines.append("| " + " | ".join(cell.strip() for cell in row) + " |")
    return "\n".join(lines)


def _format_myst_list_table(block: str) -> str:
    """Convert a MyST ``list-table`` directive into a Markdown table."""
    option_lines: list[str] = []
    content_lines: list[str] = []
    for line in block.split("\n"):
        stripped = line.strip()
        if stripped.startswith(":"):
            option_lines.append(stripped)
        else:
            content_lines.append(line)

    header_rows = 1
    for option in option_lines:
        if option.startswith(":header-rows:"):
            _, _, value = option.partition(":header-rows:")
            try:
                header_rows = int(value.strip())
            except ValueError:
                header_rows = 1

    rows: list[list[str]] = []
    current_row: list[str] | None = None
    for line in content_lines:
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith("* - "):
            current_row = [stripped[4:].strip()]
            rows.append(current_row)
        elif stripped.startswith("- ") and current_row is not None:
            current_row.append(stripped[2:].strip())
        elif current_row is not None:
            current_row[-1] = f"{current_row[-1]} {stripped}".strip()

    return _format_markdown_table(rows, header_rows=header_rows)


def _format_myst_figure(block: str) -> str:
    """Convert a MyST ``figure`` directive into Markdown image syntax."""
    first_line, _, rest = block.partition("\n")
    image_path = first_line.strip()
    alt = ""
    for line in rest.split("\n"):
        stripped = line.strip()
        if stripped.startswith(":alt:"):
            alt = stripped[len(":alt:") :].strip()
            break
    return f"![{alt}]({image_path})"


def clean_myst_directives(text: str) -> str:
    """Convert MyST/Sphinx directives to standard markdown equivalents."""
    text = strip_commented_out_blocks(text)

    # MyST explicit anchors -> HTML anchors, matching Fern MDX source.
    text = re.sub(r"(?m)^\(([-A-Za-z0-9_:.]+)\)=\s*$", r'<a id="\1"></a>', text)

    # Multi-line {include} directives with :start-after: etc.
    text = re.sub(
        r"```\{include\}\s*([^\n]+)\n(?::[^\n]+\n)*```",
        r"> *Content included from \1 — see the original doc for full text.*",
        text,
    )

    # Single-line {include} directives
    text = re.sub(
        r"```\{include\}\s*([^\n]+)\n```",
        r"> *Content included from \1 — see the original doc for full text.*",
        text,
    )

    # {figure} blocks -> standard image syntax.
    text = re.sub(
        r"```\{figure\}\s*([^\n]+(?:\n(?::[^\n]+|[ \t]*))*?)\n```",
        lambda m: _format_myst_figure(m.group(1)),
        text,
    )

    # {mermaid} blocks -> standard mermaid code fence
    text = re.sub(
        r"```\{mermaid\}",
        "```mermaid",
        text,
    )

    # {toctree} blocks -> remove entirely (navigation, not content)
    text = re.sub(
        r"```\{toctree\}[^\n]*\n(?::[^\n]+\n)*(?:[^\n]*\n)*?```",
        "",
        text,
    )

    # :::{list-table} ... ::: -> Markdown table.
    text = re.sub(
        r":{3,}\{list-table\}[^\n]*\n(.*?)\n:{3,}",
        lambda m: _format_myst_list_table(m.group(1)),
        text,
        flags=re.DOTALL,
    )

    # :::{admonition} with optional :class: etc. — must come before note/tip/warning
    text = re.sub(
        r":{3,}\{admonition\}\s*([^\n]*)\n(.*?)\n:{3,}",
        lambda m: _format_admonition(m.group(1).strip(), m.group(2)),
        text,
        flags=re.DOTALL,
    )

    # :::{note} ... ::: -> **Note:** ...
    text = re.sub(
        r":{3,}\{note\}[ \t]*([^\n]*)\n(.*?)\n:{3,}",
        lambda m: _format_admonition(m.group(1).strip() or "Note", m.group(2)),
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r":{3,}\{tip\}[ \t]*([^\n]*)\n(.*?)\n:{3,}",
        lambda m: _format_admonition(m.group(1).strip() or "Tip", m.group(2)),
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r":{3,}\{warning\}[ \t]*([^\n]*)\n(.*?)\n:{3,}",
        lambda m: _format_admonition(m.group(1).strip() or "Warning", m.group(2)),
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r":{3,}\{caution\}[ \t]*([^\n]*)\n(.*?)\n:{3,}",
        lambda m: _format_admonition(m.group(1).strip() or "Warning", m.group(2)),
        text,
        flags=re.DOTALL,
    )

    # :::{dropdown} ... ::: -> bold titled details block.
    text = re.sub(
        r":{3,}\{dropdown\}[ \t]*([^\n]*)\n(.*?)\n:{3,}",
        lambda m: _format_admonition(m.group(1).strip() or "Details", m.group(2)),
        text,
        flags=re.DOTALL,
    )

    # Strip "Contents" TOC sections (navigation artifacts, not content)
    text = re.sub(
        r"^#{2,3}\s+Contents\s*\n+(?:- [^\n]+\n?)+\n*",
        "",
        text,
        flags=re.MULTILINE,
    )

    # Clean up excessive blank lines
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text.strip()


def _mdx_title_attr(attrs: str, default: str) -> str:
    """Extract a simple Fern component title attr."""
    match = re.search(
        r"""\btitle=(?:"([^"]+)"|'([^']+)'|\{["']([^"']+)["']\})""",
        attrs,
    )
    if not match:
        return default
    for group in match.groups():
        if group:
            return group
    return default


def clean_fern_mdx(text: str) -> str:
    """Convert Fern MDX components to portable markdown equivalents."""
    text = strip_commented_out_blocks(text)

    for component, default_title in (
        ("Warning", "Warning"),
        ("Tip", "Tip"),
        ("Note", "Note"),
        ("Info", "Note"),
        ("Accordion", "Details"),
    ):
        text = re.sub(
            rf"<{component}\b((?:\"[^\"]*\"|'[^']*'|[^'\">])*)>\s*(.*?)\s*</{component}>",
            lambda m, default=default_title: _format_admonition(
                _mdx_title_attr(m.group(1), default), m.group(2)
            ),
            text,
            flags=re.DOTALL,
        )

    # Collapse excess blank lines.
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def resolve_includes(text: str, source_dir: Path) -> str:
    """Resolve MyST {include} directives by inlining referenced file content.

    Handles :start-after: and :end-before: markers for partial content
    extraction. Falls back to a placeholder when the file cannot be read.
    """
    pattern = re.compile(r"```\{include\}\s*([^\n]+)\n((?::[^\n]+\n)*)```")

    def _resolve(match: re.Match) -> str:
        raw_path = match.group(1).strip()
        directives = match.group(2)

        start_after = None
        end_before = None
        for line in directives.strip().split("\n"):
            line = line.strip()
            if line.startswith(":start-after:"):
                start_after = line[len(":start-after:") :].strip()
            elif line.startswith(":end-before:"):
                end_before = line[len(":end-before:") :].strip()

        resolved = (source_dir / raw_path).resolve()
        if not resolved.is_file():
            return f"> *Content included from {raw_path} — see the original doc for full text.*"

        try:
            content = resolved.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return f"> *Content included from {raw_path} — see the original doc for full text.*"

        if start_after:
            idx = content.find(start_after)
            if idx != -1:
                content = content[idx + len(start_after) :]
        if end_before:
            idx = content.find(end_before)
            if idx != -1:
                content = content[:idx]

        return content.strip()

    return pattern.sub(_resolve, text)


def resolve_page_includes(pages: list[DocPage]) -> None:
    """Resolve {include} directives in all pages and re-extract sections."""
    for page in pages:
        resolved = resolve_includes(page.body, page.path.parent)
        if resolved != page.body:
            page.body = resolved
            page.sections = _extract_sections(resolved)


def rewrite_doc_paths(
    text: str,
    source_page: DocPage,
    docs_dir: Path,
    doc_to_skill: dict[str, str],
    local_doc_links: dict[str, str] | None = None,
    html_baseurl: str | None = None,
    doc_platform: str = "myst-md",
) -> tuple[str, list[tuple[Path, str]]]:
    """Resolve relative doc paths to skill cross-refs or published URLs.

    Skill files are meant to be self-contained, so the rewriter never
    emits filesystem paths back into ``docs/`` (or anywhere else in the
    repo). Rewrite precedence for each Markdown link ``[text](path)``:

    1. If the target is an external URL, an anchor, or a ``mailto:``
       reference, or the target is not a recognized doc link for the selected
       platform, leave it untouched.
    2. If the target is an image asset that exists under ``docs/``,
       record a copy task and rewrite the link to ``images/<basename>``.
       The caller is responsible for copying the recorded files into the
       skill output directory after writing the markdown body.
    3. If the target resolves to a doc emitted in the current skill
       directory, rewrite the link to that local file.
    4. If the target resolves to a doc that has a generated skill,
       replace the whole link with ``text (use the `<skill>` skill)``.
    5. If the target is a page inside ``docs/``, emit
       ``[text](<html_baseurl><page>.html)`` using the base URL read
       from ``conf.py``.
    6. Otherwise (target outside ``docs/``, or no base URL available),
       strip the hyperlink and keep the link text. Self-containment wins
       over navigability in the fallback.

    Include placeholders that referenced ``docs/``-relative paths are
    rewritten the same way: published URL if available, else dropped.

    Returns the rewritten text plus the list of ``(source_path, basename)``
    image-copy tasks recorded during rewriting.
    """
    repo_root = docs_dir.parent
    source_dir = source_page.path.parent

    doc_extension = DOC_EXTENSIONS.get(doc_platform, ".md")
    image_copies: list[tuple[Path, str]] = []

    def _record_image_copy(resolved: Path) -> str:
        """Record an image-copy task and return the link target for it."""
        image_copies.append((resolved, resolved.name))
        return f"images/{resolved.name}"

    def _to_html_url(resolved: Path, frag: str) -> str | None:
        """Published URL for a doc under ``docs/``; ``None`` otherwise."""
        if not html_baseurl:
            return None
        try:
            rel_to_docs = resolved.relative_to(docs_dir)
        except ValueError:
            return None
        html_path = rel_to_docs.with_suffix(".html").as_posix()
        return f"{html_baseurl}{html_path}{frag}"

    def _candidate_doc_paths(path_no_frag: str) -> list[Path]:
        """Resolve a Markdown/Fern link target to possible source files."""
        if doc_platform == "fern-mdx":
            route = path_no_frag.lstrip("/")
            if path_no_frag.startswith("/"):
                if not route:
                    return []
                base = docs_dir / route
            else:
                base = source_dir / path_no_frag
            if base.suffix:
                return [base.resolve()]
            return [
                base.with_suffix(doc_extension).resolve(),
                (base / f"index{doc_extension}").resolve(),
            ]

        suffix = Path(path_no_frag).suffix
        if suffix not in {".md", ".mdx", ".html", ".png", ".jpg", ".jpeg", ".svg"}:
            return []

        resolved = (source_dir / path_no_frag).resolve()
        if suffix == ".html":
            return [resolved.with_suffix(doc_extension)]
        return [resolved]

    def _resolve_link(match: re.Match) -> str:
        link_text = match.group(1)
        raw_path = match.group(2)

        # Skip external URLs and anchors
        if raw_path.startswith(("http://", "https://", "#", "mailto:")):
            return match.group(0)

        # Preserve fragment anchors across the rewrite
        if "#" in raw_path:
            path_no_frag, _, frag = raw_path.partition("#")
            frag = "#" + frag
        else:
            path_no_frag = raw_path
            frag = ""

        if "?" in path_no_frag:
            path_no_frag, _, _query = path_no_frag.partition("?")

        candidates = _candidate_doc_paths(path_no_frag)
        if not candidates:
            return match.group(0)

        # Image assets that exist under docs/ are copied alongside the
        # skill file so the rendered link works offline. Fragments are
        # meaningless on local images, so they are dropped.
        for resolved in candidates:
            if resolved.suffix.lower() not in IMAGE_EXTENSIONS:
                continue
            try:
                resolved.relative_to(docs_dir)
            except ValueError:
                continue
            if not resolved.is_file():
                continue
            return f"[{link_text}]({_record_image_copy(resolved)})"

        # Prefer same-skill reference files over self-referential skill hints.
        for resolved in candidates:
            try:
                rel_to_repo = resolved.relative_to(repo_root)
            except ValueError:
                continue
            rel_str = rel_to_repo.as_posix()
            if local_doc_links and rel_str in local_doc_links:
                return f"[{link_text}]({local_doc_links[rel_str]}{frag})"

        # Check if target doc maps to a generated skill
        for resolved in candidates:
            try:
                rel_to_repo = resolved.relative_to(repo_root)
            except ValueError:
                continue
            rel_str = rel_to_repo.as_posix()
            if rel_str in doc_to_skill:
                skill_name = doc_to_skill[rel_str]
                return f"{link_text} (use the `{skill_name}` skill)"

        # Self-contained fallback: published URL or strip the hyperlink.
        for resolved in candidates:
            url = _to_html_url(resolved, frag)
            if url is not None:
                return f"[{link_text}]({url})"
        return link_text

    # Rewrite markdown links: [text](path). Keep matches on one line so
    # ordinary bracketed prose, such as version ranges, cannot consume a later
    # link and corrupt the generated skill text.
    text = re.sub(r"\[([^\[\]\n]+)\]\(([^)\n]+)\)", _resolve_link, text)

    # Rewrite include placeholders: "Content included from <path>"
    def _resolve_include(match: re.Match) -> str:
        raw_path = match.group(1).strip()
        resolved = (source_dir / raw_path).resolve()
        url = _to_html_url(resolved, "")
        if url is not None:
            return f"> *Content included from [{raw_path}]({url}) — see the original doc for full text.*"
        # No base URL available; drop the breadcrumb so the skill stays
        # self-contained. The included content itself is already inlined.
        return ""

    text = re.sub(
        r"> \*Content included from ([^\n]+) — see the original doc for full text\.\*",
        _resolve_include,
        text,
    )

    return text, image_copies


def extract_related_skills(text: str) -> tuple[str, list[str]]:
    """Extract skill references from Next Steps / Related Topics sections.

    Returns (cleaned_text, list_of_skill_entries) where skill_entries are
    formatted as "- `skill-name` — description".
    """
    seen_skills: set[str] = set()
    entries: list[str] = []

    # Match H2 or H3 "Next Steps" / "Related Topics" sections and their content
    pattern = re.compile(
        r"^(#{2,3})\s+(Next Steps|Related Topics)\s*\n+"
        r"(?:.*?\n)*?"  # optional intro line
        r"((?:- .+\n?)+)",  # the bullet list
        re.MULTILINE,
    )

    def _collect(match: re.Match) -> str:
        block = match.group(3)
        for line in block.strip().split("\n"):
            line = line.strip()
            if not line.startswith("- "):
                continue
            # Extract skill name from "(see the `skill-name` skill)" pattern
            skill_match = re.search(r"`([a-z0-9-]+)`\s+skill\)", line)
            if skill_match:
                skill_name = skill_match.group(1)
                if skill_name in seen_skills:
                    continue
                seen_skills.add(skill_name)
                desc = re.sub(r"\s*\(see the `[^`]+` skill\)", "", line[2:]).strip()
                desc = desc.rstrip(".")
                entries.append(f"- `{skill_name}` — {desc}")
            elif re.search(r"\[.+\]\(https?://", line):
                # External link — keep as-is
                entries.append(line)
            else:
                entries.append(line)
        return ""

    cleaned = pattern.sub(_collect, text)
    # Clean up any leftover blank lines from removed sections
    cleaned = re.sub(r"\n{3,}", "\n\n", cleaned)
    return cleaned, entries


def _split_description_trigger(desc: str) -> tuple[str, str]:
    """Split a page description into (covers, trigger) halves.

    Doc frontmatter tends to phrase ``description.agent`` as
    ``"<what it covers>. Use when <trigger>."`` (or ``"Use for ..."``).
    Splitting on that marker lets the References section lead each
    bullet with the *when* so the agent sees the activation trigger
    before the descriptive text — the pattern the skill-creation
    best-practices guide recommends for progressive disclosure.

    Returns ``(covers, trigger)`` where ``trigger`` starts with
    ``"when "`` or ``"for "`` (no leading ``"Use "``), or an empty
    string when no marker is found. Trailing periods are stripped from
    both halves so callers can add punctuation as needed.
    """
    text = (desc or "").strip()
    if not text:
        return "", ""

    lowest_idx = -1
    for marker in (". Use when ", ". Use for "):
        idx = text.find(marker)
        if idx != -1 and (lowest_idx == -1 or idx < lowest_idx):
            lowest_idx = idx
    if lowest_idx == -1:
        return text.rstrip("."), ""

    covers = text[:lowest_idx].strip().rstrip(".")
    # Len of ". Use " is 6; keep the "when ..." / "for ..." tail.
    trigger = text[lowest_idx + 6 :].strip().rstrip(".")
    return covers, trigger


_MYST_WARNING_BLOCK_RE = re.compile(
    r":{3,}\{(?:warning|caution)\}(?:[ \t]+([^\n]+))?\n(.*?)\n:{3,}",
    re.DOTALL,
)
_FERN_WARNING_BLOCK_RE = re.compile(r"<Warning\b([^>]*)>(.*?)</Warning>", re.DOTALL)


def _warning_blocks(page: DocPage, doc_platform: str) -> list[tuple[str, str]]:
    """Return ``(title, body)`` pairs for warning-like source blocks."""
    body = strip_commented_out_blocks(page.body)
    if doc_platform == "fern-mdx":
        return [
            (_mdx_title_attr(m.group(1), ""), m.group(2))
            for m in _FERN_WARNING_BLOCK_RE.finditer(body)
        ]
    return [
        ((m.group(1) or "").strip(), m.group(2))
        for m in _MYST_WARNING_BLOCK_RE.finditer(body)
    ]


def _extract_gotchas(pages: list[DocPage], doc_platform: str = "myst-md") -> list[str]:
    """Pull warning admonitions out of the source pages.

    Returns a list of markdown bullets suitable for a top-level
    ``## Gotchas`` section. The admonition stays in place inline, but
    surfacing its first sentence up front means the agent sees the
    correction before it picks a path through the steps — per the
    best-practices guide, gotchas are highest-value when they live
    above the procedures they correct.

    Uses the admonition's inline title when present; otherwise leads
    with the first sentence of the body. Deduplicates across pages so
    repeated warnings collapse to one bullet.
    """
    bullets: list[str] = []
    seen: set[str] = set()
    for page in pages:
        for raw_title, raw_body in _warning_blocks(page, doc_platform):
            title = raw_title.strip().rstrip(".!?")
            body = raw_body.strip()
            # Strip any directive metadata lines such as ``:class: ...``
            body_lines = [
                ln
                for ln in body.split("\n")
                if not re.match(r"^\s*:[a-z_-]+:", ln)
            ]
            body = "\n".join(body_lines).strip()
            if not body:
                continue
            first = re.split(r"(?<=[.!?])\s+", body, maxsplit=1)[0].strip()
            # Collapse intra-sentence whitespace — source docs wrap at ~80
            # chars, so without this the bullet breaks across lines.
            first = re.sub(r"\s+", " ", first)
            if title:
                bullet = f"- **{title}.** {first}"
            else:
                bullet = f"- {first}"
            key = bullet.lower()
            if key in seen:
                continue
            seen.add(key)
            bullets.append(bullet)
    return bullets


def _safe_truncation_point(lines: list[str], target: int) -> int:
    """Find a safe truncation point that doesn't break code fences."""
    in_fence = False
    last_safe = target
    for i, line in enumerate(lines[: target + 20]):
        if line.strip().startswith("```"):
            in_fence = not in_fence
        if i >= target and not in_fence:
            last_safe = i
            break
    if in_fence:
        # Still inside a fence — find the closing fence
        for i in range(target, min(target + 30, len(lines))):
            if lines[i].strip().startswith("```"):
                return i + 1
    return last_safe


TITLE_VERBS = {
    "customize": "manage",
    "approve": "manage",
    "switch": "configure",
    "set up": "setup",
    "set-up": "setup",
    "deploy": "deploy",
    "monitor": "monitor",
    "install": "install",
    "configure": "configure",
    "create": "create",
    "troubleshoot": "troubleshoot",
    "debug": "debug",
    "connect": "connect",
    "update": "update",
    "manage": "manage",
    "add": "manage",
    "remove": "manage",
    "enable": "configure",
    "disable": "configure",
    "run": "run",
    "start": "setup",
    "build": "build",
    "test": "test",
    "use": "use",
    "migrate": "migrate",
    "upgrade": "upgrade",
}

CATEGORY_VERBS = {
    "deployment": "deploy",
    "monitoring": "monitor",
    "network-policy": "manage",
    "inference": "configure",
    "security": "configure",
    "installation": "install",
    "setup": "setup",
    "configuration": "configure",
    "administration": "manage",
    "operations": "manage",
    "development": "develop",
    "testing": "test",
    "debugging": "debug",
    "migration": "migrate",
}

CATEGORY_NOUNS = {
    "about": "overview",
    "concept": "concept",
    "reference": "reference",
    "get-started": "get-started",
    "root": "overview",
    "network-policy": "policy",
    "deployment": "remote",
    "monitoring": "sandbox",
    "inference": "inference",
    "security": "security",
}

NOUN_STOP = {
    "the",
    "a",
    "an",
    "and",
    "or",
    "for",
    "to",
    "in",
    "of",
    "it",
    "how",
    "what",
    "with",
    "from",
    "by",
    "on",
    "is",
    "your",
    "that",
    "this",
    "its",
    "use",
    "using",
    "at",
    "runtime",
    "activity",
    "issues",
    "guide",
    "configuration",
    "settings",
    "options",
    "models",
    "providers",
    "requests",
    "resources",
    "instances",
    "debug",
    "troubleshoot",
    "fix",
    "check",
    "verify",
    "test",
    "deny",
    "approve",
    "enable",
    "disable",
    "manage",
    "works",
}

PROJECT_STOP = set()  # Populated at runtime from --prefix


def _extract_verb_from_title(title: str) -> str | None:
    """Extract the canonical action verb from a page title."""
    lower = title.lower().strip()
    for phrase, canonical in sorted(TITLE_VERBS.items(), key=lambda x: -len(x[0])):
        if lower.startswith(phrase):
            return canonical
    return None


def _extract_noun_from_title(title: str) -> str | None:
    """Extract the primary noun/object from a page title."""
    lower = title.lower().strip()

    # Strip the leading verb phrase
    for phrase in sorted(TITLE_VERBS, key=lambda x: -len(x)):
        if lower.startswith(phrase):
            lower = lower[len(phrase) :].strip()
            break

    # Strip everything after em-dash, en-dash, or colon (subtitle)
    lower = re.split(r"\s*[—–]\s*|\s*:\s*|\s*-{2,}\s*", lower)[0]

    words = re.sub(r"[^a-z\s]", "", lower).split()
    nouns = [
        w for w in words if w not in NOUN_STOP and w not in PROJECT_STOP and len(w) > 2
    ]

    if len(nouns) >= 2:
        return "-".join(nouns[:2])
    elif nouns:
        return nouns[0]
    return None


def generate_skill_name(
    category: str,
    pages: list[DocPage],
    prefix: str = "",
    name_overrides: dict[str, str] | None = None,
) -> str:
    """Generate a valid skill name with optional prefix and action verbs.

    Naming strategy by group size:
    - Multi-page groups: verb from category mapping + noun from category mapping
    - Single-page groups: verb + noun extracted from the page title
    - Overrides always win
    """
    if name_overrides and category in name_overrides:
        name = name_overrides[category]
    elif category in CATEGORY_NOUNS and not CATEGORY_VERBS.get(category):
        # Pure noun categories (about → overview, reference → reference)
        name = CATEGORY_NOUNS[category]
    elif len(pages) > 1:
        # Multi-page group: use category-level mappings
        verb = CATEGORY_VERBS.get(category, "")
        noun = CATEGORY_NOUNS.get(category, category)
        name = f"{verb}-{noun}" if verb else noun
    else:
        # Single page: extract verb+noun from the title
        page = pages[0]
        verb = _extract_verb_from_title(page.title) if page.title else None
        noun = _extract_noun_from_title(page.title) if page.title else None

        if verb and noun:
            name = f"{verb}-{noun}"
        elif noun:
            name = noun
        elif verb:
            # No useful noun extracted — fall back to file stem
            stem = page.path.stem
            stem_clean = re.sub(r"[^a-z0-9-]", "-", stem.lower()).strip("-")
            name = stem_clean
        else:
            name = page.path.stem

    name = re.sub(r"[^a-z0-9-]", "-", name.lower())
    name = re.sub(r"-+", "-", name).strip("-")

    if prefix:
        clean_prefix = re.sub(r"[^a-z0-9-]", "-", prefix.lower()).strip("-")
        prefix_parts = clean_prefix.split("-")
        name_parts = name.split("-")
        cleaned = []
        i = 0
        while i < len(name_parts):
            if name_parts[i : i + len(prefix_parts)] == prefix_parts:
                i += len(prefix_parts)
            else:
                cleaned.append(name_parts[i])
                i += 1
        name = "-".join(cleaned) if cleaned else name
        name = f"{clean_prefix}-{name}"

    return name


BRAND_WORDS: dict[str, str] = {
    "nemoclaw": "NemoClaw",
    "openclaw": "OpenClaw",
    "openshell": "OpenShell",
    "nvidia": "NVIDIA",
    "gpu": "GPU",
    "cli": "CLI",
    "tui": "TUI",
    "api": "API",
    "llm": "LLM",
    "llms": "LLMs",
}


def _brand_case(text: str) -> str:
    """Replace generic title-cased words with their brand-correct forms."""
    for wrong, right in BRAND_WORDS.items():
        text = re.sub(rf"\b{re.escape(wrong)}\b", right, text, flags=re.IGNORECASE)
    return text


def build_skill_description(name: str, pages: list[DocPage]) -> str:
    """Build the description field for the skill frontmatter.

    Uses the lead page's ``description.agent`` (or third-person-normalized
    legacy ``description``) verbatim, then merges every page's frontmatter
    ``keywords`` list into a single ``Trigger keywords - ...`` clause so
    the host surfaces the skill on matching user queries. The ``## References``
    section inside SKILL.md already lists every reference file the skill
    ships, so that information is not duplicated in the description.

    Keeps description under 1024 characters.
    """
    if not pages:
        return f"Documentation-derived skill for {name.replace('-', ' ')}."

    lead = pages[0]
    if lead.description:
        lead_desc = (
            lead.description
            if lead.description_is_agent
            else _to_third_person(lead.description)
        )
        lead_desc = lead_desc.rstrip().rstrip(".") + "."
    else:
        lead_desc = f"Documentation-derived skill for {name.replace('-', ' ')}."

    # Merge keywords from every page, preserving lead-page order and
    # deduplicating case-insensitively.
    seen_keywords: set[str] = set()
    merged_keywords: list[str] = []
    for page in pages:
        for kw in page.keywords or []:
            kw_clean = str(kw).strip()
            if not kw_clean:
                continue
            key = kw_clean.lower()
            if key in seen_keywords:
                continue
            seen_keywords.add(key)
            merged_keywords.append(kw_clean)
    if merged_keywords:
        lead_desc += " Trigger keywords - " + ", ".join(merged_keywords) + "."

    if len(lead_desc) > 1024:
        print(
            f"  warning: description for skill '{name}' truncated from "
            f"{len(lead_desc)} to 1023 characters; consider shortening the "
            f"lead page's description.agent or removing redundant keywords",
            file=sys.stderr,
        )
        lead_desc = lead_desc[:1020] + "..."
    return lead_desc


def yaml_scalar(value: str) -> str:
    """Return a YAML-safe quoted scalar using JSON string escaping.

    JSON strings are valid YAML 1.2 double-quoted scalars, which makes this a
    lightweight way to safely emit frontmatter without adding a YAML library.
    """
    return json.dumps(value, ensure_ascii=False)


def _to_third_person(sentence: str) -> str:
    """Convert an imperative sentence to third-person.

    "Install NemoClaw" -> "Installs NemoClaw"
    "Change the model"  -> "Changes the model"
    "Access the API"    -> "Accesses the API"
    Already third-person sentences are returned unchanged.
    """
    if not sentence:
        return sentence
    first_word, _, rest = sentence.partition(" ")
    suffix = (" " + rest) if rest else ""

    # Strip trailing punctuation so "Add," doesn't become "Add,s"
    trailing_punct = ""
    while first_word and first_word[-1] in ".,;:!?":
        trailing_punct = first_word[-1] + trailing_punct
        first_word = first_word[:-1]
    if not first_word:
        return sentence

    _BASE_VERBS_ENDING_IN_S = {
        "access",
        "process",
        "address",
        "discuss",
        "bypass",
        "express",
        "compress",
        "assess",
        "stress",
        "progress",
        "focus",
        "canvas",
    }
    if first_word.endswith("ing"):
        return first_word + trailing_punct + suffix
    if first_word.endswith("s") and first_word.lower() not in _BASE_VERBS_ENDING_IN_S:
        return first_word + trailing_punct + suffix
    if first_word.endswith(("ch", "sh", "x", "ss", "zz")):
        return first_word + "es" + trailing_punct + suffix
    if (
        first_word.endswith("y")
        and len(first_word) > 1
        and first_word[-2] not in "aeiou"
    ):
        return first_word[:-1] + "ies" + trailing_punct + suffix
    return first_word + "s" + trailing_punct + suffix


# ---------------------------------------------------------------------------
# Skill generation
# ---------------------------------------------------------------------------

CONTENT_TYPE_ROLE = {
    "how_to": "procedure",
    "get_started": "procedure",
    "tutorial": "procedure",
    "concept": "context",
    "reference": "reference",
}
PROCEDURE_CONTENT_TYPES = frozenset({"how_to", "get_started", "tutorial"})
SKIP_SKILL_SECTIONS = frozenset({"prerequisites", "before you begin", "troubleshooting"})
RELATED_SKILL_SECTIONS = frozenset({"related topics", "next steps"})
SKILL_FRONTMATTER_LICENSE = "Apache-2.0"

_SECTION_HEADING_RE = re.compile(r"(?m)^(#{2,6})\s+(.+)$")


def _section_similarity(left: str, right: str) -> float:
    """Return token overlap ratio for generated duplicate-section detection."""
    left_tokens = set(re.findall(r"[a-z0-9_./:-]+", left.lower()))
    right_tokens = set(re.findall(r"[a-z0-9_./:-]+", right.lower()))
    if not left_tokens or not right_tokens:
        return 0.0
    return len(left_tokens & right_tokens) / min(len(left_tokens), len(right_tokens))


def dedupe_repeated_heading_sections(text: str) -> str:
    """Drop later same-heading sections when generated content substantially overlaps."""
    matches = list(_SECTION_HEADING_RE.finditer(text))
    if not matches:
        return text

    chunks: list[str] = [text[: matches[0].start()]]
    seen: dict[str, str] = {}
    for idx, match in enumerate(matches):
        end = matches[idx + 1].start() if idx + 1 < len(matches) else len(text)
        section = text[match.start() : end]
        key = re.sub(r"\s+", " ", match.group(2).strip().lower())
        previous = seen.get(key)
        if previous is not None and _section_similarity(previous, section) >= 0.35:
            continue
        seen[key] = section
        chunks.append(section)

    return "".join(chunks).strip()


def canonicalize_leading_h1(body: str, title: str) -> str:
    """Replace a source page's leading H1 with the canonical frontmatter title."""
    if not title:
        return body
    if re.match(r"^#\s+.+(?:\n|$)", body):
        return re.sub(r"^#\s+.+(?:\n|$)", f"# {title}\n", body, count=1)
    return f"# {title}\n\n{body}".rstrip()



def partition_skill_pages(pages: list[DocPage]) -> tuple[DocPage, list[DocPage]]:
    """Split a skill group into the lead page and reference siblings.

    The lead page has the lowest ``skill.priority`` value (highest priority).
    Used by the ``individual`` strategy.
    """
    ordered = sorted(pages, key=lambda p: (p.skill_priority, str(p.path)))
    return ordered[0], ordered[1:]


def partition_grouped_skill_pages(
    pages: list[DocPage],
) -> tuple[DocPage | None, list[DocPage]]:
    """Split a grouped skill into an optional inline lead and reference siblings.

    When the group contains a procedure page (``how_to``, ``get_started``, or
    ``tutorial``), the one with the lowest ``skill.priority`` becomes the
    SKILL.md body and siblings go to ``references/``. Otherwise every page is
    reference-only progressive disclosure.
    """
    ordered = sorted(pages, key=lambda p: (p.skill_priority, str(p.path)))
    candidates = [p for p in pages if p.content_type in PROCEDURE_CONTENT_TYPES]
    if not candidates:
        return None, ordered
    lead = min(candidates, key=lambda p: (p.skill_priority, str(p.path)))
    refs = [p for p in ordered if p is not lead]
    return lead, refs


def _append_page_sections_to_skill(
    page: DocPage,
    lines: list[str],
    *,
    clean_fn,
    skill_md_images: list[tuple[Path, str]],
    skill_md_local_links: dict[str, str],
    collected_related: list[str],
) -> None:
    """Append a doc page body to SKILL.md lines."""
    for heading, content in page.sections:
        heading_lower = heading.lower()
        if heading_lower in SKIP_SKILL_SECTIONS:
            continue
        if heading_lower in RELATED_SKILL_SECTIONS:
            collected_related.append(
                clean_fn(content, page, skill_md_images, skill_md_local_links)
            )
            continue
        cleaned = clean_fn(content, page, skill_md_images, skill_md_local_links)
        if not heading:
            cleaned = re.sub(r"^#\s+.+(?:\n|$)", "", cleaned)
            if cleaned.strip():
                lines.append(cleaned.strip())
                lines.append("")
            continue
        lines.append(f"## {heading}")
        lines.append("")
        if cleaned.strip():
            lines.append(cleaned.strip())
            lines.append("")


def generate_skill(
    name: str,
    pages: list[DocPage],
    output_dirs: list[Path],
    *,
    docs_dir: Path | None = None,
    doc_to_skill: dict[str, str] | None = None,
    html_baseurl: str | None = None,
    doc_platform: str = "myst-md",
    strategy: str = "grouped",
    dry_run: bool = False,
) -> dict:
    """Generate a complete skill directory from a group of doc pages."""
    skill_md_images: list[tuple[Path, str]] = []
    ref_images: dict[str, list[tuple[Path, str]]] = {}

    def _clean(
        text: str,
        source: DocPage,
        image_acc: list[tuple[Path, str]],
        local_doc_links: dict[str, str] | None = None,
    ) -> str:
        if doc_platform == "fern-mdx":
            result = clean_fern_mdx(text)
        else:
            result = clean_myst_directives(text)
        if docs_dir and doc_to_skill is not None:
            result, copies = rewrite_doc_paths(
                result,
                source,
                docs_dir,
                doc_to_skill,
                local_doc_links=local_doc_links,
                html_baseurl=html_baseurl,
                doc_platform=doc_platform,
            )
            image_acc.extend(copies)
        return result

    if strategy == "grouped":
        primary_page, reference_pages = partition_grouped_skill_pages(pages)
    else:
        primary_page, reference_pages = partition_skill_pages(pages)

    ordered_pages = sorted(pages, key=lambda p: (p.skill_priority, str(p.path)))
    description_pages = (
        [primary_page, *reference_pages] if primary_page is not None else ordered_pages
    )

    def _page_rel(page: DocPage) -> str | None:
        if docs_dir is None:
            return None
        try:
            return page.path.resolve().relative_to(docs_dir.parent).as_posix()
        except ValueError:
            return None

    skill_md_local_links: dict[str, str] = {}
    reference_local_links: dict[str, str] = {}
    for page in reference_pages:
        rel = _page_rel(page)
        if rel is None:
            continue
        ref_name = page.path.stem + ".md"
        skill_md_local_links[rel] = f"references/{ref_name}"
        reference_local_links[rel] = ref_name
    if primary_page is not None:
        primary_rel = _page_rel(primary_page)
        if primary_rel is not None:
            reference_local_links[primary_rel] = "../SKILL.md"

    description = build_skill_description(name, description_pages)
    lines: list[str] = []

    lines.append("---")
    lines.append(f"name: {yaml_scalar(name)}")
    lines.append(f"description: {yaml_scalar(description)}")
    lines.append(f"license: {yaml_scalar(SKILL_FRONTMATTER_LICENSE)}")
    lines.append("---")
    lines.append("")

    skill_title = (
        primary_page.title
        if primary_page is not None and primary_page.title
        else _brand_case(name.replace("-", " ").title())
    )
    lines.append(f"# {skill_title}")
    if primary_page is not None:
        lines.append("")

    if primary_page is not None:
        gotchas = _extract_gotchas([primary_page], doc_platform=doc_platform)
        if gotchas:
            lines.append("## Gotchas")
            lines.append("")
            for gotcha in gotchas:
                lines.append(gotcha)
            lines.append("")

        prereq_items: list[str] = []
        seen_prereqs: set[str] = set()
        for heading, content in primary_page.sections:
            if heading.lower() not in ("prerequisites", "before you begin"):
                continue
            cleaned = _clean(content, primary_page, skill_md_images, skill_md_local_links)
            for item_line in cleaned.split("\n"):
                stripped = item_line.strip()
                if stripped.startswith("- "):
                    if prereq_items and not prereq_items[-1].startswith("- "):
                        prereq_items.append("")
                    norm = stripped.lower().strip("- .")
                    if norm not in seen_prereqs:
                        seen_prereqs.add(norm)
                        prereq_items.append(stripped)
                elif stripped and not prereq_items:
                    prereq_items.append(stripped)

        if prereq_items:
            lines.append("## Prerequisites")
            lines.append("")
            for item in prereq_items:
                lines.append(item)
            lines.append("")

        collected_related: list[str] = []
        _append_page_sections_to_skill(
            primary_page,
            lines,
            clean_fn=_clean,
            skill_md_images=skill_md_images,
            skill_md_local_links=skill_md_local_links,
            collected_related=collected_related,
        )

        raw_md = "\n".join(lines)
        raw_md, body_related = extract_related_skills(raw_md)
        lines = raw_md.rstrip("\n").split("\n")

        all_related_text = "\n".join(
            f"## Related Topics\n\n{block}" for block in collected_related
        )
        _, section_related = extract_related_skills(all_related_text)

        seen_skills: set[str] = set()
        merged_entries: list[str] = []
        for entry in section_related + body_related:
            skill_match = re.search(r"`([a-z0-9-]+)`", entry)
            key = skill_match.group(1) if skill_match else entry
            if key == name:
                continue
            if key not in seen_skills:
                seen_skills.add(key)
                merged_entries.append(entry)
    else:
        merged_entries = []

    if reference_pages:
        append_markdown_section(lines, "## References")
        for ref_page in reference_pages:
            ref_name = ref_page.path.stem + ".md"
            file_link = f"[references/{ref_name}](references/{ref_name})"
            covers, trigger = _split_description_trigger(ref_page.description or "")
            if trigger:
                bullet = f"- **Load {file_link}** {trigger}."
                if covers:
                    bullet += f" {covers}."
            elif covers:
                bullet = f"- **{file_link}** — {covers}."
            else:
                bullet = f"- {file_link}"
            lines.append(bullet)

    if merged_entries:
        append_markdown_section(lines, "## Related Skills")
        for entry in merged_entries:
            lines.append(entry)
        lines.append("")

    skill_md = collapse_consecutive_blank_lines(
        normalize_heading_levels("\n".join(lines))
    )

    ref_files: dict[str, str] = {}
    for ref_page in reference_pages:
        ref_name = ref_page.path.stem + ".md"
        ref_image_acc: list[tuple[Path, str]] = []
        body = _clean(ref_page.body, ref_page, ref_image_acc, reference_local_links)
        if doc_platform == "myst-md" and ref_page.title:
            body = canonicalize_leading_h1(body, ref_page.title)
        elif doc_platform == "fern-mdx" and ref_page.title and not body.startswith("# "):
            body = f"# {ref_page.title}\n\n{body}".rstrip()
        body = normalize_heading_levels(body)
        body = dedupe_repeated_heading_sections(body)
        ref_files[ref_name] = body
        ref_images[ref_name] = ref_image_acc

    summary = {
        "name": name,
        "dirs": [str(d / name) for d in output_dirs],
        "pages": [str(p.path) for p in pages],
        "skill_md_lines": len(skill_md.split("\n")),
        "reference_files": list(ref_files.keys()),
    }

    if dry_run:
        summary["dry_run"] = True
        return summary

    for output_dir in output_dirs:
        skill_dir = output_dir / name
        skill_dir.mkdir(parents=True, exist_ok=True)
        (skill_dir / "SKILL.md").write_text(
            skill_md.rstrip("\n") + "\n", encoding="utf-8"
        )
        _copy_skill_images(skill_dir, skill_md_images)

        refs_dir = skill_dir / "references"
        if ref_files:
            refs_dir.mkdir(exist_ok=True)
            for existing in refs_dir.glob("*.md"):
                if existing.name not in ref_files:
                    existing.unlink()
            for fname, content in ref_files.items():
                (refs_dir / fname).write_text(
                    content.rstrip("\n") + "\n", encoding="utf-8"
                )
                _copy_skill_images(refs_dir, ref_images.get(fname, []))
        elif refs_dir.is_dir():
            shutil.rmtree(refs_dir)

    return summary


def _copy_skill_images(target_dir: Path, copies: list[tuple[Path, str]]) -> None:
    """Copy recorded image assets next to the skill file that references them.

    ``target_dir`` is the directory containing the markdown file that
    references the images (e.g. the skill root for ``SKILL.md`` or the
    ``references/`` directory for sibling reference files). Images land
    in ``target_dir / "images" / basename`` so the rewritten link
    ``images/<basename>`` resolves correctly.
    """
    if not copies:
        return
    images_dir = target_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)
    seen: set[str] = set()
    for src, basename in copies:
        if basename in seen:
            continue
        seen.add(basename)
        dest = images_dir / basename
        try:
            if dest.exists() and dest.read_bytes() == src.read_bytes():
                continue
            shutil.copyfile(src, dest)
        except OSError as exc:
            print(f"  warning: failed to copy {src} -> {dest}: {exc}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Grouping strategies
# ---------------------------------------------------------------------------


def group_by_directory(pages: list[DocPage]) -> dict[str, list[DocPage]]:
    """Group pages by their parent directory."""
    groups: dict[str, list[DocPage]] = {}
    for page in pages:
        cat = page.category
        groups.setdefault(cat, []).append(page)
    return groups


def group_individual(pages: list[DocPage]) -> dict[str, list[DocPage]]:
    """Give each procedure page its own skill; bucket concept and reference pages."""
    groups: dict[str, list[DocPage]] = {}
    concept_pages: list[DocPage] = []
    reference_pages: list[DocPage] = []
    for page in pages:
        if page.content_type in PROCEDURE_CONTENT_TYPES:
            groups[page.path.stem] = [page]
        elif page.content_type == "concept":
            concept_pages.append(page)
        else:
            reference_pages.append(page)
    if concept_pages:
        groups["concept"] = concept_pages
    if reference_pages:
        groups["reference"] = reference_pages
    return groups


STRATEGIES = {
    "grouped": group_by_directory,
    "individual": group_individual,
}


# ---------------------------------------------------------------------------
# Scanning and filtering
# ---------------------------------------------------------------------------

EXCLUDED_PATTERNS = {
    "CONTRIBUTING.md",
    "README.md",
    "SETUP.md",
    "CHANGELOG.md",
    "LICENSE.md",
    "license.md",
    # Maintainer-only content consumed directly by skills/dashboards;
    # not user-facing documentation.
    "triage-instructions.md",
}


def _is_excluded_doc(path: Path, doc_platform: str) -> bool:
    """Return whether a page should be skipped for the selected source format."""
    if path.name.endswith(".generated.mdx"):
        return True
    if path.name in EXCLUDED_PATTERNS:
        return True
    if doc_platform == "fern-mdx" and path.with_suffix(".md").name in EXCLUDED_PATTERNS:
        return True
    return False


def _is_excluded_from_skills_gen(page: DocPage) -> bool:
    """Return whether a parsed page opted out of skill generation."""
    return _as_bool(
        page.frontmatter.get("exclude-from-skills-gen")
        or page.frontmatter.get("exclude_from_skills_gen")
    )


def scan_docs(docs_dir: Path, doc_platform: str = "myst-md") -> list[DocPage]:
    """Recursively scan a directory for documentation markdown files."""
    pages: list[DocPage] = []
    doc_extension = DOC_EXTENSIONS[doc_platform]
    docs_root_index = (docs_dir / f"index{doc_extension}").resolve()
    for doc_path in sorted(docs_dir.rglob(f"*{doc_extension}")):
        # Skip excluded files
        if _is_excluded_doc(doc_path, doc_platform):
            continue
        # Skip the top-level docs/index.md (Sphinx landing page — mostly
        # boilerplate). Subdirectory index.md files (for example
        # docs/get-started/platform-setup/index.md) are hub pages with
        # real content and should be included so links to them can
        # resolve to a generated skill instead of a file path.
        if doc_path.resolve() == docs_root_index:
            continue
        # Skip include fragments and templates
        if doc_path.parent.name.startswith("_"):
            continue
        # Skip build artifacts
        if "_build" in doc_path.parts:
            continue

        try:
            page = parse_doc(doc_path, doc_platform=doc_platform)
            if _is_excluded_from_skills_gen(page):
                continue
            pages.append(page)
        except Exception as e:
            print(f"  warning: failed to parse {doc_path}: {e}", file=sys.stderr)

    return pages


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def main():
    parser = argparse.ArgumentParser(
        description="Convert documentation files into Agent Skills.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=textwrap.dedent("""\
            Strategies:
              grouped     Group docs by parent directory (default)
              individual  One skill per how_to/get_started/tutorial page;
                          concept pages -> nemoclaw-user-concept;
                          reference pages -> nemoclaw-user-reference

            Examples:
              %(prog)s docs/ .agents/skills/ --prefix nemoclaw-user --doc-platform fern-mdx
              %(prog)s docs/ .agents/skills/ --strategy individual --prefix nemoclaw-user --doc-platform fern-mdx
              %(prog)s docs/ .agents/skills/ --prefix nemoclaw-user --name-map about=overview --doc-platform fern-mdx
              %(prog)s docs/ .agents/skills/ --prefix nemoclaw-user --doc-platform fern-mdx --dry-run
        """),
    )
    parser.add_argument(
        "docs_dir", type=Path, help="Path to the documentation directory"
    )
    parser.add_argument(
        "output_dirs",
        type=Path,
        nargs="+",
        help="Output directories for generated skills (e.g. .agents/skills/ .claude/skills/)",
    )
    parser.add_argument(
        "--strategy",
        choices=list(STRATEGIES.keys()),
        default="grouped",
        help="Grouping strategy (default: grouped)",
    )
    parser.add_argument(
        "--doc-platform",
        choices=DOC_PLATFORMS,
        default="myst-md",
        help="Documentation source format to parse (default: myst-md)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show what would be generated without writing files",
    )
    parser.add_argument(
        "--prefix",
        default="",
        help="Prefix for all skill names (e.g. 'nemoclaw')",
    )
    parser.add_argument(
        "--name-map",
        nargs="*",
        default=[],
        metavar="CAT=NAME",
        help="Override names: --name-map about=overview deployment=deploy-remote",
    )
    parser.add_argument(
        "--exclude",
        nargs="*",
        default=[],
        help="Additional file patterns to exclude",
    )

    args = parser.parse_args()

    # Parse name overrides
    name_overrides: dict[str, str] = {}
    for mapping in args.name_map:
        if "=" not in mapping:
            print(
                f"Error: --name-map entries must be CAT=NAME, got '{mapping}'",
                file=sys.stderr,
            )
            sys.exit(1)
        cat, _, nm = mapping.partition("=")
        name_overrides[cat.strip()] = nm.strip()

    if not args.docs_dir.is_dir():
        print(f"Error: {args.docs_dir} is not a directory", file=sys.stderr)
        sys.exit(1)

    # Add custom exclusions
    EXCLUDED_PATTERNS.update(args.exclude)

    # Populate project stop words from prefix
    if args.prefix:
        PROJECT_STOP.update(args.prefix.lower().split("-"))
        PROJECT_STOP.update(args.prefix.lower().split("_"))

    print(f"Scanning {args.docs_dir} as {args.doc_platform}...")
    pages = scan_docs(args.docs_dir, doc_platform=args.doc_platform)
    print(f"  Found {len(pages)} documentation pages")

    # Resolve {include} directives so inlined content is available for
    # section extraction and skill generation
    resolve_page_includes(pages)

    if not pages:
        print("No documentation pages found. Check the docs directory path.")
        sys.exit(1)

    # Print page inventory
    print("\nPages by content type:")
    type_counts: dict[str, int] = {}
    for p in pages:
        ct = p.content_type or "untyped"
        type_counts[ct] = type_counts.get(ct, 0) + 1
    for ct, count in sorted(type_counts.items()):
        print(f"  {ct}: {count}")

    # Group pages
    strategy_fn = STRATEGIES[args.strategy]
    groups = strategy_fn(pages)
    print(f"\nGrouping strategy '{args.strategy}' produced {len(groups)} skill(s):")
    for group_name, group_pages in sorted(groups.items()):
        page_list = ", ".join(p.path.name for p in group_pages)
        print(f"  {group_name}: {page_list}")

    # Build doc-path → skill-name mapping for cross-references
    docs_dir_resolved = args.docs_dir.resolve()
    repo_root = docs_dir_resolved.parent
    skill_names: dict[str, str] = {}  # group_name → skill_name
    for group_name, group_pages in sorted(groups.items()):
        sname = generate_skill_name(
            group_name,
            group_pages,
            prefix=args.prefix,
            name_overrides=name_overrides,
        )
        skill_names[group_name] = sname

    doc_to_skill: dict[str, str] = {}
    for group_name, group_pages in groups.items():
        sname = skill_names[group_name]
        for page in group_pages:
            try:
                rel = page.path.resolve().relative_to(repo_root)
                doc_to_skill[rel.as_posix()] = sname
            except ValueError:
                pass

    # Published-URL fallback for inter-doc links that do not map to a
    # generated skill. Only the legacy MyST/Sphinx path uses ``conf.py``
    # for ``html_baseurl``; Fern docs copy assets locally instead and
    # have no equivalent base URL to load.
    if args.doc_platform == "myst-md":
        html_baseurl = load_html_baseurl(docs_dir_resolved)
        if html_baseurl is None:
            print(
                f"  warning: no html_baseurl found in {docs_dir_resolved}/conf.py; "
                "inter-doc links without a skill mapping will be stripped to plain "
                "text to keep skills self-contained.",
                file=sys.stderr,
            )
    else:
        html_baseurl = None

    # Generate skills
    dirs_str = ", ".join(str(d) for d in args.output_dirs)
    print(f"\n{'[DRY RUN] ' if args.dry_run else ''}Generating skills to {dirs_str}")
    summaries: list[dict] = []
    for group_name, group_pages in sorted(groups.items()):
        name = skill_names[group_name]
        summary = generate_skill(
            name,
            group_pages,
            args.output_dirs,
            docs_dir=docs_dir_resolved,
            doc_to_skill=doc_to_skill,
            html_baseurl=html_baseurl,
            doc_platform=args.doc_platform,
            strategy=args.strategy,
            dry_run=args.dry_run,
        )
        summaries.append(summary)

    # Ensure .claude/skills symlink exists
    if not args.dry_run:
        claude_skills = Path(".claude/skills")
        for out_dir in args.output_dirs:
            # Only create symlink if output is under .agents/skills
            if ".agents/skills" in str(out_dir):
                agents_skills = Path(out_dir)
                if claude_skills.is_symlink():
                    if claude_skills.resolve() == agents_skills.resolve():
                        break  # already correct
                    else:
                        claude_skills.unlink()
                elif claude_skills.is_dir():
                    print(f"\n⚠ {claude_skills} is a real directory, not a symlink.")
                    print(
                        f"  Remove it and re-run, or manually symlink to {agents_skills}"
                    )
                    break
                # Create parent and symlink
                claude_skills.parent.mkdir(parents=True, exist_ok=True)
                rel = os.path.relpath(agents_skills, claude_skills.parent)
                claude_skills.symlink_to(rel)
                print(f"\n✔ Created symlink: {claude_skills} → {rel}")
                break

    # Report
    print("\n" + "=" * 60)
    print("Generation Summary")
    print("=" * 60)
    total_lines = 0
    total_refs = 0
    for s in summaries:
        lines = s["skill_md_lines"]
        refs = len(s["reference_files"])
        total_lines += lines
        total_refs += refs
        status = " (dry run)" if s.get("dry_run") else ""
        warning = " ⚠ >500 lines" if lines > 500 else ""
        print(f"  {s['name']:30s}  {lines:4d} lines  {refs} refs{warning}{status}")

    print(
        f"\nTotal: {len(summaries)} skills, {total_lines} lines, {total_refs} reference files"
    )

    if any(s["skill_md_lines"] > 500 for s in summaries):
        print("\nNote: Skills over 500 lines should be trimmed. Move detailed")
        print("content to references/ and add conditional load instructions.")
        print("See: https://agentskills.io/specification#progressive-disclosure")

    if args.dry_run:
        print("\nDry run complete. No files were written.")
        print(f"Re-run without --dry-run to generate skills in {dirs_str}")


if __name__ == "__main__":
    main()
