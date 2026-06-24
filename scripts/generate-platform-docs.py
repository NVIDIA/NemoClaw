#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Generate platform and provider tables from ci/platform-matrix.json.

Reads the single-source-of-truth metadata and patches Markdown or MDX tables
between sentinel comments in target files.

Sentinel pairs:
  <!-- platform-matrix:begin --> / <!-- platform-matrix:end -->  (Markdown only)
  {/* platform-matrix:begin */} / {/* platform-matrix:end */}  (MDX)
  {/* provider-status:begin */} / {/* provider-status:end */}  (MDX)

Usage:
    python3 scripts/generate-platform-docs.py                  # patch files in place
    python3 scripts/generate-platform-docs.py --check          # exit 1 if out of sync
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MATRIX_PATH = REPO_ROOT / "ci" / "platform-matrix.json"

# Each entry: (sentinel_name, table_generator_key, list of target files)
TABLES = [
    (
        "platform-matrix",
        "platforms",
        [
            REPO_ROOT / "docs" / "get-started" / "prerequisites.mdx",
        ],
    ),
    (
        "provider-status",
        "providers",
        [
            REPO_ROOT / "docs" / "inference" / "inference-options.mdx",
        ],
    ),
    (
        "platform-matrix-full",
        "platforms_full",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "provider-status-full",
        "providers_full",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "agent-status",
        "agents",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "integration-status",
        "integrations",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "deployment-status",
        "deployment_paths",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "capability-status",
        "capabilities",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "out-of-scope",
        "out_of_scope",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "project-status",
        "project_status",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "matrix-owners",
        "owners",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
    (
        "status-vocabulary",
        "status_vocabulary",
        [
            REPO_ROOT / "docs" / "reference" / "platform-support.mdx",
        ],
    ),
]




def _sentinel_pairs(name: str) -> list[tuple[str, str]]:
    return [
        (f"<!-- {name}:begin -->", f"<!-- {name}:end -->"),
        (f"{{/* {name}:begin */}}", f"{{/* {name}:end */}}"),
    ]


def _sentinel_re(begin: str, end: str) -> re.Pattern:
    return re.compile(
        rf"({re.escape(begin)})\n.*?\n({re.escape(end)})",
        re.DOTALL,
    )


def load_matrix() -> dict:
    with open(MATRIX_PATH) as f:
        return json.load(f)


# Strings that should never reach a generated page as a real value. Owner
# fields are reviewed gates for launch-facing claims; placeholder text means
# the gate is undefined and the docs would ship with an unresolved sign-off
# path. Matched case-insensitively against the raw field value.
_PLACEHOLDER_OWNER_VALUES = (
    "",
    "tbd",
    "todo",
    "fixme",
    "see pr review",
    "n/a",
    "none",
)


def _is_placeholder_owner(value: str) -> bool:
    raw = (value or "").strip().lower()
    if not raw:
        return True
    if raw in _PLACEHOLDER_OWNER_VALUES:
        return True
    # Catch composite forms like "TBD (see PR review)" or "TODO: pick someone".
    for marker in ("tbd", "todo", "fixme", "see pr review"):
        if marker in raw:
            return True
    return False


def _escape_cell(value) -> str:
    """Escape Markdown table cells for safe MDX rendering.

    `|` breaks the column count and literal newlines break the row layout
    regardless of context, so those are normalized everywhere.

    `<`, `>`, `{`, and `}` are MDX-meaningful glyphs that would be parsed
    as JSX or expression delimiters in prose. They are encoded outside
    inline code spans only. Inside backtick-delimited code spans MDX
    treats the content as literal, and encoding there would corrupt
    rendered command placeholders like `$$nemoclaw <name> policy-add`.
    Backtick splitting alternates inside/outside segments starting with
    outside at index 0.
    """
    text = "" if value is None else str(value)
    text = text.replace("\r\n", " ").replace("\n", " ").replace("\r", " ")
    text = text.replace("|", "\\|")
    parts = text.split("`")
    # An odd number of backticks means an unmatched span. Treating the trailing
    # segment as "inside a code span" (the parity branch) would leave its
    # control characters unencoded, so any escape we would otherwise apply
    # would be silently skipped. Encode every segment instead; the matrix is
    # validated to reject unmatched backticks at load time so the well-formed
    # path still hits the alternating-segment optimization.
    everything_encoded = (text.count("`") % 2) != 0
    for i in range(len(parts)):
        if everything_encoded or i % 2 == 0:
            parts[i] = (
                parts[i]
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("{", "&#123;")
                .replace("}", "&#125;")
            )
    return "`".join(parts)


def _validate_matrix(matrix: dict) -> None:
    """Fail fast on shapes that would silently corrupt generated docs.

    Required keys are explicit so the generator doesn't render `None` or
    crash mid-row. Status values are checked against the declared vocabulary
    so unknown statuses surface as an error instead of being silently
    title-cased into the output.
    """
    allowed_statuses = set(matrix.get("statuses", {}).keys())
    if not allowed_statuses:
        raise ValueError("ci/platform-matrix.json: 'statuses' vocabulary is required")

    def _check_status(section: str, idx: int, status: str) -> None:
        if status not in allowed_statuses:
            raise ValueError(
                f"ci/platform-matrix.json: {section}[{idx}] has unknown status "
                f"{status!r}; allowed: {sorted(allowed_statuses)}"
            )

    def _require_keys(section: str, idx: int, entry: dict, keys: tuple[str, ...]) -> None:
        missing = [k for k in keys if k not in entry or entry[k] in (None, "")]
        if missing:
            raise ValueError(
                f"ci/platform-matrix.json: {section}[{idx}] missing required keys: {missing}"
            )

    sections = {
        "platforms": ("name", "runtimes", "status", "notes"),
        "providers": ("name", "status", "endpoint_type", "notes"),
        "agents": ("name", "status", "notes"),
        "integrations": ("name", "status", "notes"),
        "deployment_paths": ("name", "status", "notes"),
        "capabilities": ("name", "status", "notes"),
        "out_of_scope": ("name", "status", "notes"),
    }
    # Assert every generator-backed top-level section is present as a list
    # before iterating. matrix.get(section, []) would otherwise silently
    # accept a missing or wrong-typed section and render an empty table,
    # losing the drift signal this validator is supposed to provide.
    for section in sections:
        if section not in matrix:
            raise ValueError(
                f"ci/platform-matrix.json: required top-level section {section!r} is missing"
            )
        if not isinstance(matrix[section], list):
            raise ValueError(
                f"ci/platform-matrix.json: top-level section {section!r} must be a list, "
                f"got {type(matrix[section]).__name__}"
            )
    for section, keys in sections.items():
        for idx, entry in enumerate(matrix[section]):
            _require_keys(section, idx, entry, keys)
            _check_status(section, idx, entry["status"])

    owners = matrix.get("owners") or {}
    engineering = owners.get("engineering")
    if not engineering or _is_placeholder_owner(engineering):
        raise ValueError(
            "ci/platform-matrix.json: owners.engineering must be a real reviewer "
            f"alias; got {engineering!r}"
        )
    # Reject any other owner field that snuck back in as a placeholder.
    for key, value in owners.items():
        if key in ("engineering", "$comment"):
            continue
        if _is_placeholder_owner(value):
            raise ValueError(
                f"ci/platform-matrix.json: owners.{key} is a placeholder ({value!r}); "
                "remove the field or set a real value before generating docs"
            )

    # generate_project_status_block subscripts these four keys; without the
    # check a typo at the source crashes with raw KeyError later instead of
    # the controlled ValueError this hardening adds.
    project_status = matrix.get("project_status") or {}
    project_status_keys = ("stage", "label", "since", "notes")
    missing_status = [
        k for k in project_status_keys if k not in project_status or project_status[k] in (None, "")
    ]
    if missing_status:
        raise ValueError(
            f"ci/platform-matrix.json: project_status missing required keys: {missing_status}"
        )

    # Reject unmatched backticks in every notes field. The cell escaper relies
    # on alternating in/out-of-code-span segments to leave inline code intact
    # while still encoding MDX hazards in prose; an odd backtick count is
    # ambiguous and would either bypass escaping or corrupt rendered code.
    for section in sections:
        for idx, entry in enumerate(matrix[section]):
            note = entry.get("notes") or ""
            if note.count("`") % 2 != 0:
                raise ValueError(
                    f"ci/platform-matrix.json: {section}[{idx}].notes has an odd number "
                    "of backticks; pair every code span before regenerating docs"
                )


def generate_platform_table(platforms: list[dict]) -> str:
    """Build a markdown table from platform entries.

    Deferred entries are tracked in the metadata but excluded from
    user-facing tables because they have no validated setup path yet.
    """
    header = "| OS | Container runtime | Status | Notes |"
    separator = "|----|-------------------|--------|-------|"
    rows = []
    for p in platforms:
        if p["status"] == "deferred":
            continue
        runtimes = ", ".join(p["runtimes"])
        rows.append(
            f"| {_escape_cell(p['name'])} | {_escape_cell(runtimes)} | "
            f"{_escape_cell(_label(p['status']))} | {_escape_cell(p['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_provider_table(providers: list[dict]) -> str:
    """Build a markdown table from provider entries.

    Deferred entries are excluded from user-facing tables.
    """
    header = "| Provider | Status | Endpoint type | Notes |"
    separator = "|----------|--------|---------------|-------|"
    rows = []
    for p in providers:
        if p["status"] == "deferred":
            continue
        rows.append(
            f"| {_escape_cell(p['name'])} | {_escape_cell(_label(p['status']))} | "
            f"{_escape_cell(p['endpoint_type'])} | {_escape_cell(p['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


STATUS_LABELS = {
    "tested": "Tested",
    "caveated": "Tested with limitations",
    "experimental": "Experimental",
    "deferred": "Deferred",
    "hermes only": "Hermes only",
}


def _label(status: str) -> str:
    return STATUS_LABELS.get(status, status.capitalize())


def generate_platform_table_full(platforms: list[dict]) -> str:
    """Full platform table including deferred entries.

    Used by the canonical launch claims page. Includes PRD priority and
    CI columns and exposes deferred entries so the page reflects the
    complete support surface, not just shippable rows. The CI column
    distinguishes "Tested with limitations + in CI" from "Tested with
    limitations + not in CI", a caveat that the status label alone
    does not carry.
    """
    header = "| OS | Container runtime | Status | PRD priority | CI | Notes |"
    separator = "|----|-------------------|--------|--------------|----|-------|"
    rows = []
    for p in platforms:
        runtimes = ", ".join(p["runtimes"])
        priority = p.get("prd_priority", "Unset")
        ci = "Yes" if p.get("ci_tested") else "No"
        rows.append(
            f"| {_escape_cell(p['name'])} | {_escape_cell(runtimes)} | "
            f"{_escape_cell(_label(p['status']))} | {_escape_cell(priority)} | "
            f"{_escape_cell(ci)} | {_escape_cell(p['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_provider_table_full(providers: list[dict]) -> str:
    """Full provider table including deferred entries.

    Used by the canonical launch claims page.
    """
    header = "| Provider | Status | Endpoint type | Notes |"
    separator = "|----------|--------|---------------|-------|"
    rows = []
    for p in providers:
        rows.append(
            f"| {_escape_cell(p['name'])} | {_escape_cell(_label(p['status']))} | "
            f"{_escape_cell(p['endpoint_type'])} | {_escape_cell(p['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_agent_table(agents: list[dict]) -> str:
    header = "| Agent | Status | Default | Notes |"
    separator = "|-------|--------|---------|-------|"
    rows = []
    for a in agents:
        default = "Yes" if a.get("default") else "No"
        rows.append(
            f"| {_escape_cell(a['name'])} | {_escape_cell(_label(a['status']))} | "
            f"{_escape_cell(default)} | {_escape_cell(a['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_integration_table(integrations: list[dict]) -> str:
    header = "| Channel | Status | Notes |"
    separator = "|---------|--------|-------|"
    rows = []
    for i in integrations:
        rows.append(
            f"| {_escape_cell(i['name'])} | {_escape_cell(_label(i['status']))} | "
            f"{_escape_cell(i['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_deployment_table(deployment_paths: list[dict]) -> str:
    header = "| Path | Status | Notes |"
    separator = "|------|--------|-------|"
    rows = []
    for d in deployment_paths:
        rows.append(
            f"| {_escape_cell(d['name'])} | {_escape_cell(_label(d['status']))} | "
            f"{_escape_cell(d['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_capability_table(capabilities: list[dict]) -> str:
    header = "| Capability | Status | Notes |"
    separator = "|------------|--------|-------|"
    rows = []
    for c in capabilities:
        rows.append(
            f"| {_escape_cell(c['name'])} | {_escape_cell(_label(c['status']))} | "
            f"{_escape_cell(c['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_out_of_scope_table(out_of_scope: list[dict]) -> str:
    header = "| Item | Status | Why |"
    separator = "|------|--------|-----|"
    rows = []
    for o in out_of_scope:
        rows.append(
            f"| {_escape_cell(o['name'])} | {_escape_cell(_label(o['status']))} | "
            f"{_escape_cell(o['notes'])} |"
        )
    return "\n".join([header, separator, *rows])


def generate_project_status_block(status: dict) -> str:
    lines = [
        f"- **Stage:** {_escape_cell(status['stage'])}",
        f"- **Label:** {_escape_cell(status['label'])}",
        f"- **Since:** {_escape_cell(status['since'])}",
        f"- **Notes:** {_escape_cell(status['notes'])}",
    ]
    return "\n".join(lines)


def generate_owners_block(owners: dict) -> str:
    return (
        f"- **Engineering owner:** {_escape_cell(owners['engineering'])} "
        "(reviews through CODEOWNERS and signs off on launch-facing claim changes "
        "before they reach demos or sales material)."
    )


def generate_status_vocabulary_table(statuses: dict) -> str:
    """Render the status vocabulary directly from the matrix `statuses` dict.

    The doc table that listed each status and its meaning used to be hand
    authored, so the matrix `statuses` definition and the docs prose drifted
    independently. Generate the table here so the two stay aligned by
    construction.
    """
    header = "| Status | Meaning |"
    separator = "|--------|---------|"
    rows = [
        f"| {_escape_cell(_label(key))} | {_escape_cell(meaning)} |"
        for key, meaning in statuses.items()
    ]
    return "\n".join([header, separator, *rows])


TABLE_GENERATORS = {
    "platforms": generate_platform_table,
    "providers": generate_provider_table,
    "platforms_full": generate_platform_table_full,
    "providers_full": generate_provider_table_full,
    "agents": generate_agent_table,
    "integrations": generate_integration_table,
    "deployment_paths": generate_deployment_table,
    "capabilities": generate_capability_table,
    "out_of_scope": generate_out_of_scope_table,
    "project_status": generate_project_status_block,
    "owners": generate_owners_block,
    "status_vocabulary": generate_status_vocabulary_table,
}

# The generator key isn't always the matrix dict key. The "full" tables
# read the same JSON arrays as the partial views but render them differently.
GENERATOR_MATRIX_KEY = {
    "platforms_full": "platforms",
    "providers_full": "providers",
    "status_vocabulary": "statuses",
}


def patch_file(path: Path, sentinel_name: str, table: str, check_only: bool) -> bool:
    """Replace content between sentinels. Returns True if file was changed."""
    text = path.read_text()
    for begin, end in _sentinel_pairs(sentinel_name):
        if begin not in text:
            continue

        if end not in text:
            raise ValueError(
                f"{path.relative_to(REPO_ROOT)} has '{begin}' but no matching '{end}'"
            )

        pattern = _sentinel_re(begin, end)
        replacement = f"{begin}\n{table}\n{end}"
        new_text, count = pattern.subn(replacement, text, count=1)
        if count != 1:
            raise ValueError(
                f"{path.relative_to(REPO_ROOT)} has malformed '{sentinel_name}' sentinels"
            )

        if new_text == text:
            return False

        if check_only:
            print(f"  DIFF {path.relative_to(REPO_ROOT)} [{sentinel_name}]")
            return True

        path.write_text(new_text)
        print(f"  PATCH {path.relative_to(REPO_ROOT)} [{sentinel_name}]")
        return True

    supported = " or ".join(begin for begin, _ in _sentinel_pairs(sentinel_name))
    raise ValueError(
        f"{path.relative_to(REPO_ROOT)} is configured for '{sentinel_name}' "
        f"but contains no supported begin sentinel ({supported})"
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Check mode: exit 1 if any file is out of sync (no writes)",
    )
    args = parser.parse_args()

    if not MATRIX_PATH.exists():
        print(f"Error: {MATRIX_PATH} not found", file=sys.stderr)
        sys.exit(1)

    matrix = load_matrix()
    try:
        _validate_matrix(matrix)
    except ValueError as exc:
        print(f"Error: {exc}", file=sys.stderr)
        sys.exit(1)

    print(f"{'Checking' if args.check else 'Patching'} tables from {MATRIX_PATH.name}:")
    diffs = []
    missing = []
    ok = []

    for sentinel_name, data_key, target_files in TABLES:
        generator = TABLE_GENERATORS[data_key]
        matrix_key = GENERATOR_MATRIX_KEY.get(data_key, data_key)
        table = generator(matrix[matrix_key])
        for path in target_files:
            if not path.exists():
                print(f"  MISS {path.relative_to(REPO_ROOT)}", file=sys.stderr)
                missing.append(path)
                continue
            changed = patch_file(path, sentinel_name, table, check_only=args.check)
            if changed:
                diffs.append(path)
            else:
                ok.append(path)

    for path in ok:
        print(f"  OK   {path.relative_to(REPO_ROOT)}")

    if missing:
        print(f"\n{len(missing)} configured target file(s) missing.", file=sys.stderr)
        sys.exit(1)

    if args.check and diffs:
        print(f"\n{len(diffs)} file(s) out of sync. Run: python3 scripts/generate-platform-docs.py")
        sys.exit(1)

    if not args.check and diffs:
        print(f"\n{len(diffs)} file(s) patched.")
    elif not diffs:
        print("\nAll files in sync.")


if __name__ == "__main__":
    main()
