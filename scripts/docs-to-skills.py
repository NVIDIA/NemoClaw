#!/usr/bin/env python3
"""Convert documentation files into Agent Skills (agentskills.io spec).

Reads a directory of Markdown documentation, parses YAML frontmatter and
content structure, groups related pages into coherent skill units, and
generates SKILL.md files following the Agent Skills specification:
https://agentskills.io/specification

Usage:

Make sure to run this script using the following command to generate the skills and keep the locations and names consistent.

```bash
python scripts/docs-to-skills.py docs/ .agents/skills/docs/ --prefix nemoclaw
```

What it does:
  1. Scans a docs directory for Markdown files with YAML frontmatter.
  2. Classifies each page by content type (how_to, concept, reference,
     get_started) using the frontmatter `content.type` field.
  3. Groups pages into skills using one of three strategies:
       - smart (default): groups by directory, merges concept pages as
         context for procedure pages in the same directory.
       - grouped: groups all pages in the same parent directory.
       - individual: each doc page becomes its own skill.
  4. Generates a skill directory per group containing:
       - SKILL.md with frontmatter (name, description, trigger keywords),
         procedural steps, context sections, and a Related Skills section.
       - references/ with detailed concept and reference content for
         progressive disclosure (loaded by the agent on demand).
  5. Resolves all relative doc paths to repo-root-relative paths, and
     converts cross-references between docs into skill-to-skill pointers
     so agents can navigate between skills.

Naming:
  Use --prefix to keep skill names consistent across the project. The prefix
  is prepended to every generated skill name (e.g. --prefix nemoclaw produces
  nemoclaw-get-started, nemoclaw-manage-policy). Action verbs are derived
  automatically from page titles and content types. Use --name-map to
  override specific names when the heuristic doesn't produce the right result.

Usage:
    python scripts/docs-to-skills.py docs/ .agents/skills/ --prefix nemoclaw
    python scripts/docs-to-skills.py docs/ output/ --prefix nemoclaw --dry-run
    python scripts/docs-to-skills.py docs/ output/ --strategy individual --prefix nemoclaw
    python scripts/docs-to-skills.py docs/ output/ --prefix nemoclaw --name-map about=overview
    python scripts/docs-to-skills.py docs/ output/ --exclude "release-notes.md"
"""

from __future__ import annotations

import argparse
import re
import sys
import textwrap
from dataclasses import dataclass, field
from pathlib import Path


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

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Frontmatter / doc parsing
# ---------------------------------------------------------------------------


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
    content_type: str = ""  # concept, how_to, reference, get_started, tutorial
    difficulty: str = ""
    keywords: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    audience: list[str] = field(default_factory=list)
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


def parse_doc(path: Path) -> DocPage:
    """Parse a documentation file into a DocPage."""
    raw = path.read_text(encoding="utf-8")
    fm, body = parse_yaml_frontmatter(raw)

    page = DocPage(path=path, raw=raw, frontmatter=fm, body=body)

    # Extract metadata from frontmatter
    title_block = fm.get("title", {})
    if isinstance(title_block, dict):
        page.title = title_block.get("page", title_block.get("nav", ""))
    elif isinstance(title_block, str):
        page.title = title_block

    page.description = fm.get("description", "")
    page.keywords = fm.get("keywords", [])
    page.tags = fm.get("tags", [])

    content = fm.get("content", {})
    if isinstance(content, dict):
        page.content_type = content.get("type", "")
        page.difficulty = content.get("difficulty", "")
        page.audience = content.get("audience", [])

    page.category = path.parent.name if path.parent.name != "docs" else "root"
    page.sections = _extract_sections(body)

    return page


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


def clean_myst_directives(text: str) -> str:
    """Convert MyST/Sphinx directives to standard markdown equivalents."""
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

    def _format_admonition(title: str, body: str) -> str:
        """Format an admonition as a blockquote, stripping directive lines."""
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
            return f"> **{title}**"
        result = f"> **{title}:** {lines[0].strip()}"
        for line in lines[1:]:
            result += f"\n> {line}" if line.strip() else "\n>"
        return result

    # :::{admonition} with optional :class: etc. — must come before note/tip/warning
    text = re.sub(
        r":::\{admonition\}\s*([^\n]*)\n(.*?)\n:::",
        lambda m: _format_admonition(m.group(1).strip(), m.group(2)),
        text,
        flags=re.DOTALL,
    )

    # :::{note} ... ::: -> > **Note:** ...
    text = re.sub(
        r":::\{note\}\s*\n(.*?)\n:::",
        lambda m: _format_admonition("Note", m.group(1)),
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r":::\{tip\}\s*\n(.*?)\n:::",
        lambda m: _format_admonition("Tip", m.group(1)),
        text,
        flags=re.DOTALL,
    )
    text = re.sub(
        r":::\{warning\}\s*\n(.*?)\n:::",
        lambda m: _format_admonition("Warning", m.group(1)),
        text,
        flags=re.DOTALL,
    )

    # Remove SPDX and markdownlint comment blocks
    text = re.sub(r"<!--\s*SPDX-.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"<!--\s*markdownlint-.*?-->", "", text, flags=re.DOTALL)

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
) -> str:
    """Resolve relative doc paths to repo-root paths or skill cross-references.

    Handles:
    - Markdown links: [text](../path.md) → [text](docs/path.md) or skill ref
    - Include placeholders: "included from ../../README.md" → repo-root path
    """
    repo_root = docs_dir.parent
    source_dir = source_page.path.parent

    def _resolve_link(match: re.Match) -> str:
        link_text = match.group(1)
        raw_path = match.group(2)

        # Skip external URLs and anchors
        if raw_path.startswith(("http://", "https://", "#", "mailto:")):
            return match.group(0)

        # Skip non-doc files
        if not raw_path.endswith(".md") and not raw_path.endswith(".html"):
            return match.group(0)

        # Resolve relative path against the source doc's directory
        resolved = (source_dir / raw_path).resolve()
        try:
            rel_to_repo = resolved.relative_to(repo_root)
        except ValueError:
            return match.group(0)

        # Check if target doc maps to a generated skill
        rel_str = str(rel_to_repo)
        if rel_str in doc_to_skill:
            skill_name = doc_to_skill[rel_str]
            return f"{link_text} (see the `{skill_name}` skill)"

        # Fall back to repo-root-relative path
        return f"[{link_text}]({rel_to_repo})"

    # Rewrite markdown links: [text](path)
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", _resolve_link, text)

    # Rewrite include placeholders: "Content included from <path>"
    def _resolve_include(match: re.Match) -> str:
        raw_path = match.group(1).strip()
        resolved = (source_dir / raw_path).resolve()
        try:
            rel_to_repo = resolved.relative_to(repo_root)
        except ValueError:
            return match.group(0)
        return f"> *Content included from `{rel_to_repo}` — see the original doc for full text.*"

    text = re.sub(
        r"> \*Content included from ([^\n]+) — see the original doc for full text\.\*",
        _resolve_include,
        text,
    )

    return text


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


def extract_trigger_keywords(pages: list[DocPage]) -> list[str]:
    """Build trigger keywords from doc metadata across a group of pages."""
    keywords: set[str] = set()

    for page in pages:
        keywords.update(page.keywords)
        for tag in page.tags:
            keywords.add(tag.replace("_", " "))

        # Extract meaningful words from the title
        if page.title:
            title_words = re.sub(r"[^a-zA-Z\s]", "", page.title).lower().split()
            stop_words = {
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
            }
            title_words = [w for w in title_words if w not in stop_words and len(w) > 2]
            if len(title_words) >= 2:
                keywords.add(" ".join(title_words[:4]))

    # Remove duplicates of the skill name itself and generic terms
    generic = {"generative_ai", "generative ai", "ai_agents", "ai agents", "published"}
    keywords -= generic
    return sorted(keywords)[:15]  # Cap at 15 keywords


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
    "agent",
    "agents",
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


def build_skill_description(
    name: str, pages: list[DocPage], keywords: list[str]
) -> str:
    """Build the description field for the skill frontmatter.

    Best-practices compliance:
    - Uses third-person voice (e.g. "Installs..." not "Install...")
    - Includes "Use when..." clause instead of flat "Trigger keywords -" list
    - Keeps description under 1024 characters
    """
    descriptions = [p.description for p in pages if p.description]
    if descriptions:
        combined = _to_third_person(descriptions[0]).rstrip(".")
        if len(descriptions) > 1:
            extras = []
            for d in descriptions[1:3]:
                clean = _to_third_person(d).rstrip(".")
                if clean:
                    clean = clean[0].lower() + clean[1:]
                extras.append(clean)
            combined += ". Also covers " + "; ".join(extras) + "."
        else:
            combined += "."
    else:
        combined = f"Documentation-derived skill for {name.replace('-', ' ')}."

    kw_list = keywords[:8]
    if kw_list:
        combined += " Use when " + ", ".join(kw_list) + "."

    if len(combined) > 1024:
        combined = combined[:1020] + "..."
    return combined


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


def generate_skill(
    name: str,
    pages: list[DocPage],
    output_dir: Path,
    *,
    docs_dir: Path | None = None,
    doc_to_skill: dict[str, str] | None = None,
    dry_run: bool = False,
) -> dict:
    """Generate a complete skill directory from a group of doc pages.

    Returns a summary dict for reporting.
    """
    keywords = extract_trigger_keywords(pages)
    description = build_skill_description(name, pages, keywords)

    def _clean(text: str, source: DocPage) -> str:
        """Apply directive cleanup and path rewriting for a source page."""
        result = clean_myst_directives(text)
        if docs_dir and doc_to_skill is not None:
            result = rewrite_doc_paths(result, source, docs_dir, doc_to_skill)
        return result

    procedures = [
        p for p in pages if CONTENT_TYPE_ROLE.get(p.content_type) == "procedure"
    ]
    context_pages = [
        p for p in pages if CONTENT_TYPE_ROLE.get(p.content_type) == "context"
    ]
    reference_pages = [
        p for p in pages if CONTENT_TYPE_ROLE.get(p.content_type) == "reference"
    ]

    # Pages without a recognized content_type default to procedure
    untyped = [p for p in pages if p.content_type not in CONTENT_TYPE_ROLE]
    procedures.extend(untyped)

    # Build SKILL.md content
    lines: list[str] = []

    # Frontmatter
    lines.append("---")
    lines.append(f"name: {name}")
    lines.append(f"description: {description}")
    lines.append("---")
    lines.append("")

    # Title
    skill_title = name.replace("-", " ").title()
    lines.append(f"# {skill_title}")
    lines.append("")

    # Summary from the first page's description
    if pages[0].description:
        lines.append(pages[0].description)
        lines.append("")

    # Context section from concept pages
    if context_pages:
        lines.append("## Context")
        lines.append("")
        for cp in context_pages:
            body = _clean(cp.body, cp)
            h1_match = re.match(r"^#\s+.+\n+", body)
            if h1_match:
                body = body[h1_match.end() :]
            # Trim to keep SKILL.md concise; full content goes to references/
            body_lines = body.split("\n")
            if len(body_lines) > 60:
                cut = _safe_truncation_point(body_lines, 60)
                trimmed = "\n".join(body_lines[:cut])
                ref_name = cp.path.stem + ".md"
                trimmed += f"\n\n*Full details in `references/{ref_name}`.*"
                lines.append(trimmed)
            else:
                lines.append(body)
            lines.append("")

    # Prerequisites (merged from all procedure pages, deduplicated)
    prereq_items: list[str] = []
    seen_prereqs: set[str] = set()
    for pp in procedures:
        for heading, content in pp.sections:
            if heading.lower() in ("prerequisites", "before you begin"):
                cleaned = _clean(content, pp)
                for item_line in cleaned.split("\n"):
                    stripped = item_line.strip()
                    if stripped.startswith("- "):
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

    # Procedural steps from how_to and get_started pages
    step_num = 0
    skip_sections = {"prerequisites", "before you begin", "troubleshooting"}
    related_sections = {"related topics", "next steps"}
    collected_related: list[str] = []  # raw content from related sections
    for idx, pp in enumerate(procedures):
        # When merging multiple docs, add a transition heading
        if len(procedures) > 1 and idx > 0 and pp.title:
            lines.append("---")
            lines.append("")

        for heading, content in pp.sections:
            if heading.lower() in skip_sections:
                continue
            if heading.lower() in related_sections:
                collected_related.append(_clean(content, pp))
                continue
            if not heading:
                cleaned = _clean(content, pp)
                cleaned = re.sub(r"^#\s+.+\n+", "", cleaned)
                if cleaned.strip():
                    lines.append(cleaned)
                    lines.append("")
                continue

            step_num += 1
            cleaned_content = _clean(content, pp)
            lines.append(f"## Step {step_num}: {heading}")
            lines.append("")
            lines.append(cleaned_content)
            lines.append("")

    # Reference pages go to references/ but get a pointer in SKILL.md
    if reference_pages:
        lines.append("## Reference")
        lines.append("")
        for rp in reference_pages:
            ref_name = rp.path.stem + ".md"
            title = rp.title or rp.path.stem.replace("-", " ").title()
            lines.append(f"- [{title}](references/{ref_name})")
        lines.append("")

    # Build Related Skills from collected sections + any remaining in body
    raw_md = "\n".join(lines)
    raw_md, body_related = extract_related_skills(raw_md)
    lines = raw_md.rstrip("\n").split("\n")

    # Also extract from the collected_related content
    all_related_text = "\n".join(
        f"## Related Topics\n\n{block}" for block in collected_related
    )
    _, section_related = extract_related_skills(all_related_text)

    # Merge and deduplicate
    seen_skills: set[str] = set()
    merged_entries: list[str] = []
    for entry in section_related + body_related:
        skill_match = re.search(r"`([a-z0-9-]+)`", entry)
        key = skill_match.group(1) if skill_match else entry
        if key == name:
            continue  # skip self-references
        if key not in seen_skills:
            seen_skills.add(key)
            merged_entries.append(entry)

    if merged_entries:
        lines.append("")
        lines.append("## Related Skills")
        lines.append("")
        for entry in merged_entries:
            lines.append(entry)
        lines.append("")

    skill_md = normalize_heading_levels("\n".join(lines))

    # --- Build reference files ---
    ref_files: dict[str, str] = {}
    for rp in reference_pages + context_pages:
        ref_name = rp.path.stem + ".md"
        body = normalize_heading_levels(_clean(rp.body, rp))
        ref_files[ref_name] = body

    # --- Write output ---
    skill_dir = output_dir / name
    summary = {
        "name": name,
        "dir": str(skill_dir),
        "pages": [str(p.path) for p in pages],
        "skill_md_lines": len(skill_md.split("\n")),
        "reference_files": list(ref_files.keys()),
    }

    if dry_run:
        summary["dry_run"] = True
        return summary

    skill_dir.mkdir(parents=True, exist_ok=True)
    (skill_dir / "SKILL.md").write_text(skill_md.rstrip("\n") + "\n", encoding="utf-8")

    if ref_files:
        refs_dir = skill_dir / "references"
        refs_dir.mkdir(exist_ok=True)
        for fname, content in ref_files.items():
            (refs_dir / fname).write_text(content.rstrip("\n") + "\n", encoding="utf-8")

    return summary


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
    """Each page becomes its own skill."""
    return {page.path.stem: [page] for page in pages}


def group_by_content_type(pages: list[DocPage]) -> dict[str, list[DocPage]]:
    """Group pages by content type, merging concept+how_to for same topic."""
    # First pass: group by directory
    dir_groups = group_by_directory(pages)

    # Second pass: within each directory, merge concept pages as context
    # for procedure pages in the same directory
    result: dict[str, list[DocPage]] = {}
    for cat, group_pages in dir_groups.items():
        has_procedures = any(
            CONTENT_TYPE_ROLE.get(p.content_type) == "procedure" for p in group_pages
        )
        if has_procedures or len(group_pages) > 1:
            result[cat] = group_pages
        else:
            # Individual concept/reference pages become their own skill
            for p in group_pages:
                result[p.path.stem] = [p]

    return result


STRATEGIES = {
    "grouped": group_by_directory,
    "individual": group_individual,
    "smart": group_by_content_type,
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
    "index.md",
}


def scan_docs(docs_dir: Path) -> list[DocPage]:
    """Recursively scan a directory for documentation markdown files."""
    pages: list[DocPage] = []
    for md_path in sorted(docs_dir.rglob("*.md")):
        # Skip excluded files
        if md_path.name in EXCLUDED_PATTERNS:
            continue
        # Skip include fragments and templates
        if md_path.parent.name.startswith("_"):
            continue
        # Skip build artifacts
        if "_build" in md_path.parts:
            continue

        try:
            page = parse_doc(md_path)
            pages.append(page)
        except Exception as e:
            print(f"  warning: failed to parse {md_path}: {e}", file=sys.stderr)

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
              individual  Each doc page becomes its own skill
              smart       Group by directory, merge concept pages as context

            Examples:
              %(prog)s docs/ .agents/skills/generated/ --prefix nemoclaw
              %(prog)s docs/ output/ --strategy individual --prefix nemoclaw
              %(prog)s docs/ output/ --prefix nemoclaw --name-map about=overview
              %(prog)s docs/ output/ --strategy smart --dry-run
        """),
    )
    parser.add_argument(
        "docs_dir", type=Path, help="Path to the documentation directory"
    )
    parser.add_argument(
        "output_dir", type=Path, help="Output directory for generated skills"
    )
    parser.add_argument(
        "--strategy",
        choices=list(STRATEGIES.keys()),
        default="smart",
        help="Grouping strategy (default: smart)",
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

    print(f"Scanning {args.docs_dir}...")
    pages = scan_docs(args.docs_dir)
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
                doc_to_skill[str(rel)] = sname
            except ValueError:
                pass

    # Generate skills
    print(
        f"\n{'[DRY RUN] ' if args.dry_run else ''}Generating skills to {args.output_dir}/"
    )
    summaries: list[dict] = []
    for group_name, group_pages in sorted(groups.items()):
        name = skill_names[group_name]
        summary = generate_skill(
            name,
            group_pages,
            args.output_dir,
            docs_dir=docs_dir_resolved,
            doc_to_skill=doc_to_skill,
            dry_run=args.dry_run,
        )
        summaries.append(summary)

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
        print(f"Re-run without --dry-run to generate skills in {args.output_dir}/")


if __name__ == "__main__":
    main()
