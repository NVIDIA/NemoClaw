#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Validate Cursor/agent skills under .agents/skills/<id>/SKILL.md (YAML frontmatter + body)."""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path


def split_frontmatter(text: str) -> tuple[str | None, str]:
    if not text.startswith("---"):
        return None, text
    lines = text.splitlines()
    if len(lines) < 2 or lines[0].strip() != "---":
        return None, text
    end = -1
    for i in range(1, len(lines)):
        if lines[i].strip() == "---":
            end = i
            break
    if end < 0:
        return None, text
    fm = "\n".join(lines[1:end])
    body = "\n".join(lines[end + 1 :])
    return fm, body


def parse_scalar(field: str, fm: str) -> str | None:
    # Single-line `key: value` (quoted or not); good enough for skill frontmatter in this repo.
    m = re.search(rf"^{re.escape(field)}:\s*(.+)$", fm, re.MULTILINE)
    if not m:
        return None
    val = m.group(1).strip()
    if (val.startswith('"') and val.endswith('"')) or (val.startswith("'") and val.endswith("'")):
        val = val[1:-1]
    return val.strip() or None


def validate_skill_file(path: Path) -> list[str]:
    errs: list[str] = []
    raw = path.read_text(encoding="utf-8")
    fm, body = split_frontmatter(raw)
    if fm is None:
        errs.append("missing or invalid YAML frontmatter (expected --- ... ---)")
        return errs
    name = parse_scalar("name", fm)
    desc = parse_scalar("description", fm)
    if not name:
        errs.append("frontmatter missing non-empty 'name:'")
    if not desc:
        errs.append("frontmatter missing non-empty 'description:'")
    body_stripped = body.strip()
    if len(body_stripped) < 20:
        errs.append("body too short after frontmatter (expected real SKILL content)")
    return errs


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--repo",
        type=Path,
        default=Path.cwd(),
        help="Repository root (default: cwd)",
    )
    args = ap.parse_args()
    root: Path = args.repo.resolve()
    skills_root = root / ".agents" / "skills"
    if not skills_root.is_dir():
        print(f"validate_repo_skills: FAIL: missing directory {skills_root}", file=sys.stderr)
        return 1

    paths = sorted(skills_root.glob("*/SKILL.md"))
    if not paths:
        print(f"validate_repo_skills: FAIL: no SKILL.md under {skills_root}", file=sys.stderr)
        return 1

    failed = False
    for p in paths:
        rel = p.relative_to(root)
        issues = validate_skill_file(p)
        if issues:
            failed = True
            print(f"{rel}: FAIL", file=sys.stderr)
            for it in issues:
                print(f"  - {it}", file=sys.stderr)
        else:
            print(f"{rel}: OK")

    if failed:
        return 1
    print(f"validate_repo_skills: {len(paths)} skill(s) OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
