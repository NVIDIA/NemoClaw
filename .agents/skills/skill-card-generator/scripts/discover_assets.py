#!/usr/bin/env python3
"""
discover_assets.py — Skill Card Asset Discoverer

Given a path to a skill directory (e.g. <repo>/.agents/skills/<name>/),
walks up to find the repo root and emits a signal summary the agent uses
to fill the skill card context. Output is bounded and redacted; use the
structured summary first, then read only targeted source files if more
detail is needed.

Usage: python3 discover_assets.py <skill_directory>
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

# ─── Constants ────────────────────────────────────────────────────────────

FILE_CHAR_LIMIT = int("1800")
TOTAL_CHAR_LIMIT = int("14000")
README_CHAR_LIMIT = int("1200")
EVAL_DOC_CHAR_LIMIT = int("1500")
EVAL_DOC_LIMIT = int("2")
CHANGELOG_BODY_CHAR_LIMIT = int("1800")
LICENSE_SCAN_LINE_LIMIT = int("5")
LICENSE_IDENTIFIER_CHAR_LIMIT = int("120")
GIT_TIMEOUT_SECONDS = int("3")
FRONTMATTER_DELIMITER = "---"
FRONTMATTER_MARKER_OFFSET = len(FRONTMATTER_DELIMITER)
CONSTRAINT_SENTENCE_CHAR_LIMIT = int("300")
MCP_REF_LIMIT = int("10")
CONSTRAINT_LIMIT = int("25")
DOC_H1_SCAN_LINE_LIMIT = int("40")
CHANGELOG_BODY_OUTPUT_LINE_LIMIT = int("40")
URL_PLATFORM_OUTPUT_LIMIT = int("10")
DOCS_INDEX_LIMIT = int("30")
REFERENCE_APPENDIX_CHAR_LIMIT = int("1800")
MIN_EXPECTED_ARGS = int("2")
USAGE_ERROR_EXIT_CODE = int("1")
NOT_FOUND_INDEX = -int("1")
SUCCESS_EXIT_CODE = int("0")
FIRST_MATCH_GROUP = int("1")
SECOND_MATCH_GROUP = int("2")
FIRST_ITEM_INDEX = int("0")
SECOND_ITEM_INDEX = int("1")
MAX_SPLITS = int("1")
PARENT_PARTS_SLICE_END = -int("1")
INITIAL_CHAR_COUNT = int("0")
SECTION_RULE_WIDTH = int("70")
TARGET_ARG_INDEX = int("1")
SINGULAR_COUNT = int("1")
SKILL_DEF_FULL = True  # Skill definition always extracted in full

REPO_ROOT_MARKERS = [".git", "pyproject.toml", "package.json", "LICENSE", "LICENSE.md"]

LICENSE_FILENAMES = {
    "license",
    "license.md",
    "license.txt",
    "copying",
    "notice",
    "notice.md",
}

KNOWN_AGENTS = [
    "Amp",
    "Astra",
    "Blackbox",
    "Claude Code",
    "Codex",
    "Cursor",
    "Gemini Command Line Interface",
    "Gemini CLI",
    "GitHub Copilot",
    "Goose",
    "Junie",
    "OpenCode",
    "OpenClaw",
    "Hermes",
    "Kiro",
    "Roo Code",
]

PLATFORM_DOMAINS = {
    "Build.Nvidia.com": ["build.nvidia.com", "nvcr.io"],
    "GitHub": ["github.com"],
    "Hugging Face": ["huggingface.co", "hf.co"],
    "NGC": ["ngc.nvidia.com", "catalog.ngc.nvidia.com"],
}

API_KEY_PATTERNS = [
    r"\b[A-Z][A-Z0-9_]{2,}_API_KEY\b",
    r"\bHF_TOKEN\b",
    r"\bNGC_API_KEY\b",
    r"\bOPENAI_API_KEY\b",
    r"\bANTHROPIC_API_KEY\b",
    r"\bGITHUB_TOKEN\b",
    r"\bAWS_[A-Z_]+_KEY\b",
]

MCP_PATTERNS = [r"\bmcp__[a-z0-9_\-]+", r"MCP\s+server"]

CONSTRAINT_KEYWORDS = [
    "not supported",
    "not yet available",
    "must be disabled",
    "only supported",
    "cannot",
    "unsupported",
    "requires",
    "limited to",
]

EVAL_KEYWORDS = [
    "eval",
    "evaluation",
    "benchmark",
    "performance",
    "accuracy",
    "testing",
    "metric",
    "metrics",
    "validation",
    "red-team",
    "red team",
    "red_teaming",
    "redteam",
    "network security",
    "product security",
]

# Legal/process links that should NOT be emitted as release channels.
LEGAL_URL_FRAGMENTS = [
    "sharepoint.com",
    "confluence.nvidia.com",
    "nvbugspro.nvidia.com",
    "forms.office.com",
    "app.intigriti.com",
    "nvidia.com/object/submit",
    "psirt",
]

SENSITIVE_REDACTION = "[REDACTED]"

IGNORED_DIRECTORY_PARTS = {
    "__pycache__",
    ".aws",
    ".azure",
    ".config",
    ".git",
    ".gnupg",
    ".gcloud",
    ".kube",
    ".ssh",
    ".venv",
    "node_modules",
}

SENSITIVE_FILENAMES = {
    ".dockerconfigjson",
    ".env",
    ".env.local",
    ".envrc",
    ".netrc",
    ".npmrc",
    ".pypirc",
    "credentials",
    "credentials.json",
    "id_dsa",
    "id_ecdsa",
    "id_ed25519",
    "id_rsa",
    "secrets.json",
    "secrets.yaml",
    "secrets.yml",
}

SENSITIVE_NAME_PREFIXES = (
    ".env.",
    ".env-",
    "credentials.",
    "credentials-",
    "secret.",
    "secret-",
    "secrets.",
    "secrets-",
)
SENSITIVE_NAME_SUFFIXES = (".key", ".pem", ".p12", ".pfx")

SENSITIVE_VALUE_PATTERNS = [
    (
        re.compile(
            r"(?i)\b([\"']?(?:password|passwd|pwd|secret|token|api[_-]?key|"
            r"access[_-]?key|private[_-]?key|client[_-]?secret)[\"']?\s*[:=]\s*)"
            r"([^\s\"'`]+|\"[^\"]*\"|'[^']*')"
        ),
        rf"\1{SENSITIVE_REDACTION}",
    ),
    (
        re.compile(r"(?i)\b(authorization\s*:\s*bearer\s+)([A-Za-z0-9._~+/=-]+)"),
        rf"\1{SENSITIVE_REDACTION}",
    ),
    (
        re.compile(
            r"(?i)([?&](?:token|api_key|key|secret|password|access_token)=)"
            r"[^&\s)>\]\"'`]+"
        ),
        rf"\1{SENSITIVE_REDACTION}",
    ),
    (
        re.compile(
            r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|"
            r"\b(?:sk|hf|ghp|glpat|nvapi)-?[A-Za-z0-9_=-]{20,}\b|"
            r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"
        ),
        SENSITIVE_REDACTION,
    ),
]

# ─── Helpers ──────────────────────────────────────────────────────────────


def should_skip_path(path: Path) -> bool:
    """Return True for credential files and ignored implementation folders."""
    parts = [part.lower() for part in path.parts]
    if any(part in IGNORED_DIRECTORY_PARTS for part in parts):
        return True

    name = path.name.lower()
    return (
        name in SENSITIVE_FILENAMES
        or any(name.startswith(prefix) for prefix in SENSITIVE_NAME_PREFIXES)
        or any(name.endswith(suffix) for suffix in SENSITIVE_NAME_SUFFIXES)
    )


def redact_sensitive_text(text: str) -> str:
    """Mask credential-like values before emitting text to stdout."""
    redacted = text
    for pattern, replacement in SENSITIVE_VALUE_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


def find_repo_root(start: Path) -> Path:
    """Walk up from start until we find a repo-root marker. Fall back to start."""
    current = start.resolve()
    while current != current.parent:
        for marker in REPO_ROOT_MARKERS:
            if (current / marker).exists():
                return current
        current = current.parent
    return start


def has_yaml_frontmatter(path: Path) -> bool:
    try:
        text = path.read_text(errors="ignore")
        if not text.startswith(FRONTMATTER_DELIMITER):
            return False
        end = text.find(f"\n{FRONTMATTER_DELIMITER}", FRONTMATTER_MARKER_OFFSET)
        if end == NOT_FOUND_INDEX:
            return False
        header = text[FRONTMATTER_MARKER_OFFSET:end]
        return "name:" in header and "description:" in header
    except Exception:
        return False


def read_content(path: Path, limit=None) -> str:
    if should_skip_path(path):
        return "[sensitive file skipped]"
    try:
        text = redact_sensitive_text(path.read_text(errors="ignore"))
        if limit is None or len(text) <= limit:
            return text
        return text[:limit] + f"\n... [truncated at {limit} chars]"
    except Exception:
        return "[unreadable]"


def parse_frontmatter(path: Path) -> dict:
    out = {}
    try:
        text = path.read_text(errors="ignore")
        if not text.startswith(FRONTMATTER_DELIMITER):
            return out
        end = text.find(f"\n{FRONTMATTER_DELIMITER}", FRONTMATTER_MARKER_OFFSET)
        if end == NOT_FOUND_INDEX:
            return out
        header = text[FRONTMATTER_MARKER_OFFSET:end]
        for line in header.splitlines():
            m = re.match(r"^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$", line)
            if m:
                key = m.group(FIRST_MATCH_GROUP)
                val = redact_sensitive_text(
                    m.group(SECOND_MATCH_GROUP).strip().strip('"').strip("'")
                )
                if val:
                    out[key] = val
    except Exception:
        pass
    return out


def parse_license_identifier(license_path: Path) -> str | None:
    """Identify the license from the first non-empty line of a LICENSE file."""
    try:
        text = license_path.read_text(errors="ignore")
        for line in text.splitlines()[:LICENSE_SCAN_LINE_LIMIT]:
            line = line.strip()
            if not line:
                continue
            # Common short-form identifiers
            patterns = [
                (r"BSD[- ]?2[- ]?Clause", "BSD 2-Clause"),
                (r"BSD[- ]?3[- ]?Clause", "BSD 3-Clause"),
                (r"Apache\s+License.*2\.0", "Apache 2.0"),
                (r"MIT License", "MIT"),
                (r"GNU GENERAL PUBLIC LICENSE.*Version 3", "GPL-3.0"),
                (r"GNU GENERAL PUBLIC LICENSE.*Version 2", "GPL-2.0"),
                (r"Mozilla Public License", "MPL-2.0"),
                (
                    r"NVIDIA AI Foundation Models Community License",
                    "NVIDIA AI Foundation Models Community License",
                ),
            ]
            for pat, name in patterns:
                if re.search(pat, line, re.IGNORECASE):
                    return name
            # If no pattern hits, return the first line verbatim (capped)
            return line[:LICENSE_IDENTIFIER_CHAR_LIMIT]
    except Exception:
        return None
    return None


def parse_pyproject_version(pyproject_path: Path) -> str | None:
    try:
        text = pyproject_path.read_text(errors="ignore")
        m = re.search(r'^\s*version\s*=\s*["\'](.+?)["\']', text, re.MULTILINE)
        if m:
            return m.group(FIRST_MATCH_GROUP)
    except Exception:
        pass
    return None


def parse_package_json_version(pkg_path: Path) -> str | None:
    try:
        data = json.loads(pkg_path.read_text(errors="ignore"))
        return data.get("version")
    except Exception:
        return None


def parse_changelog_top_entry(changelog_path: Path) -> dict:
    """Return {version, date, body} from the top entry of a Keep-a-Changelog file."""
    out = {}
    try:
        text = redact_sensitive_text(changelog_path.read_text(errors="ignore"))
        # Match first version header: ## [1.2.3] - 2026-03-03  (or similar)
        m = re.search(
            r"^##\s*\[?([0-9][^\]\s]*)\]?\s*[-–]\s*(\d{4}-\d{2}-\d{2})",
            text,
            re.MULTILINE,
        )
        if m:
            out["version"] = m.group(FIRST_MATCH_GROUP)
            out["date"] = m.group(SECOND_MATCH_GROUP)
            # Body: from end of header line until next ## or EOF.
            start = m.end()
            next_heading = re.search(r"\n##\s", text[start:])
            body_end = start + next_heading.start() if next_heading else len(text)
            body = text[start:body_end].strip()
            out["body"] = body[:CHANGELOG_BODY_CHAR_LIMIT]
    except Exception:
        pass
    return out


def git_info(root: Path) -> dict:
    out = {}
    try:
        r = subprocess.run(
            ["git", "-C", str(root), "describe", "--tags", "--always"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
        if r.returncode == SUCCESS_EXIT_CODE and r.stdout.strip():
            out["describe"] = r.stdout.strip()
    except Exception:
        pass
    try:
        r = subprocess.run(
            ["git", "-C", str(root), "log", "-1", "--format=%H|%ai"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
        if r.returncode == SUCCESS_EXIT_CODE and r.stdout.strip():
            parts = r.stdout.strip().split("|", MAX_SPLITS)
            out["last_commit_sha"] = parts[FIRST_ITEM_INDEX]
            if len(parts) > SINGULAR_COUNT:
                out["last_commit_date"] = parts[SECOND_ITEM_INDEX]
    except Exception:
        pass
    try:
        r = subprocess.run(
            ["git", "-C", str(root), "remote", "get-url", "origin"],
            capture_output=True,
            text=True,
            timeout=GIT_TIMEOUT_SECONDS,
        )
        if r.returncode == SUCCESS_EXIT_CODE and r.stdout.strip():
            out["remote_url"] = redact_sensitive_text(r.stdout.strip())
    except Exception:
        pass
    return out


def find_urls(text: str) -> list:
    return re.findall(r"https?://[^\s)>\]\"'`]+", text)


def group_urls_by_platform(urls: list) -> dict:
    groups = {p: [] for p in PLATFORM_DOMAINS}
    groups["Other"] = []
    for url in urls:
        if any(frag in url for frag in LEGAL_URL_FRAGMENTS):
            continue  # Legal boilerplate URLs are not release channels
        matched = False
        for platform, domains in PLATFORM_DOMAINS.items():
            if any(d in url for d in domains):
                if url not in groups[platform]:
                    groups[platform].append(url)
                matched = True
                break
        if not matched and url not in groups["Other"]:
            groups["Other"].append(url)
    return groups


def find_agents(text: str) -> list:
    found = []
    for agent in KNOWN_AGENTS:
        if re.search(r"\b" + re.escape(agent) + r"\b", text, re.IGNORECASE):
            if agent not in found:
                found.append(agent)
    return found


def find_api_keys(text: str) -> list:
    keys = []
    for pat in API_KEY_PATTERNS:
        for m in re.findall(pat, text):
            if m not in keys:
                keys.append(m)
    return keys


def find_mcp_refs(text: str) -> list:
    refs = []
    for pat in MCP_PATTERNS:
        for m in re.findall(pat, text, re.IGNORECASE):
            if m not in refs:
                refs.append(m)
    return refs[:MCP_REF_LIMIT]


def find_constraints(text: str) -> list:
    sentences = re.split(r"(?<=[.!?])\s+|\n", text)
    hits = []
    for s in sentences:
        s_clean = s.strip()
        if not s_clean or len(s_clean) > CONSTRAINT_SENTENCE_CHAR_LIMIT:
            continue
        lower = s_clean.lower()
        if any(kw in lower for kw in CONSTRAINT_KEYWORDS):
            if s_clean not in hits:
                hits.append(s_clean)
    return hits[:CONSTRAINT_LIMIT]


def count_arguments_usage(text: str) -> int:
    return len(re.findall(r"\$ARGUMENTS", text))


# ─── Skill-dir categorization (unchanged role logic, repo-scope added) ───


def categorize_skill_dir(skill_root: Path) -> dict:
    roles = {
        "Skill definition": [],
        "Documentation": [],
        "Reference material": [],
        "Scripts": [],
        "Config": [],
        "Other": [],
    }
    for path in sorted(skill_root.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(skill_root)
        if should_skip_path(rel):
            continue
        parts = rel.parts
        suffix = path.suffix.lower()
        if "references" in parts[:PARENT_PARTS_SLICE_END]:
            roles["Reference material"].append(path)
            continue
        if "scripts" in parts[:PARENT_PARTS_SLICE_END] or suffix in {
            ".py",
            ".sh",
            ".js",
            ".ts",
            ".bash",
        }:
            roles["Scripts"].append(path)
            continue
        if suffix in {".md", ".yaml", ".yml"} and has_yaml_frontmatter(path):
            roles["Skill definition"].append(path)
            continue
        if suffix in {".md", ".rst", ".txt"}:
            roles["Documentation"].append(path)
            continue
        if suffix in {".yaml", ".yml", ".toml", ".json", ".ini", ".env", ".cfg"}:
            roles["Config"].append(path)
            continue
        roles["Other"].append(path)
    return roles


# ─── Repo-root signal collection ──────────────────────────────────────────


def collect_repo_signals(repo_root: Path, skill_root: Path) -> dict:
    """Pull governance-relevant signals from the repo above the skill."""
    out = {
        "repo_root": str(repo_root),
        "is_nested": repo_root != skill_root,
    }

    # LICENSE file (first match)
    for fname in ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]:
        lic = repo_root / fname
        if lic.exists():
            out["license_file"] = str(lic.relative_to(repo_root))
            out["license_identifier"] = parse_license_identifier(lic)
            break

    # Version signals — try multiple sources, report all
    versions = {}
    py = repo_root / "pyproject.toml"
    if py.exists():
        v = parse_pyproject_version(py)
        if v:
            versions["pyproject"] = v
    pkg = repo_root / "package.json"
    if pkg.exists():
        v = parse_package_json_version(pkg)
        if v:
            versions["package_json"] = v
    cl = repo_root / "CHANGELOG.md"
    if cl.exists():
        entry = parse_changelog_top_entry(cl)
        if entry.get("version"):
            versions["changelog"] = entry["version"]
            out["changelog_top_entry"] = entry
    if versions:
        out["versions"] = versions

    # Git
    git = git_info(repo_root)
    if git:
        out["git"] = git

    # Known-issue / docs scan
    docs_dir = repo_root / "docs"
    if docs_dir.is_dir():
        doc_files = []
        eval_docs = []
        for p in sorted(docs_dir.rglob("*.md")):
            rel = p.relative_to(repo_root)
            title = _first_h1(p) or p.stem
            entry = {"path": str(rel), "title": title}
            doc_files.append(entry)
            # Flag as evaluation-relevant by name or title
            name_lower = p.stem.lower()
            title_lower = title.lower()
            if any(kw in name_lower or kw in title_lower for kw in EVAL_KEYWORDS):
                eval_docs.append(entry)
        if doc_files:
            out["docs"] = doc_files
        if eval_docs:
            out["evaluation_docs"] = eval_docs

    # README at repo root
    for fname in ["README.md", "README.rst", "README.txt"]:
        rm = repo_root / fname
        if rm.exists():
            out["readme"] = str(rm.relative_to(repo_root))
            break

    # Security policy
    sec = repo_root / "SECURITY.md"
    if sec.exists():
        out["security_md"] = str(sec.relative_to(repo_root))

    # Third-party license file presence (useful for Database Type context)
    for fname in ["third_party_oss_license.txt", "third_party_licenses.txt", "NOTICE"]:
        tp = repo_root / fname
        if tp.exists():
            out.setdefault("third_party_license_files", []).append(
                str(tp.relative_to(repo_root))
            )

    return out


def _first_h1(path: Path) -> str | None:
    try:
        for line in path.read_text(errors="ignore").splitlines()[
            :DOC_H1_SCAN_LINE_LIMIT
        ]:
            m = re.match(r"^#\s+(.+?)\s*$", line)
            if m:
                return m.group(FIRST_MATCH_GROUP)
    except Exception:
        pass
    return None


# ─── Content extraction for the agent ─────────────────────────────────────


def extract_skill_contents(roles: dict) -> list:
    """Extract skill-local file contents, prioritized and budgeted."""
    extracted = []
    total = INITIAL_CHAR_COUNT
    priority = [
        "Skill definition",
        "Documentation",
        "Reference material",
        "Scripts",
        "Config",
    ]
    for role in priority:
        for path in roles.get(role, []):
            if role == "Skill definition" and SKILL_DEF_FULL:
                content = read_content(path, limit=None)
                extracted.append((role, path, content))
                total += len(content)
                continue
            if total >= TOTAL_CHAR_LIMIT:
                break
            remaining = TOTAL_CHAR_LIMIT - total
            content = read_content(path, min(FILE_CHAR_LIMIT, remaining))
            extracted.append((role, path, content))
            total += len(content)
        if total >= TOTAL_CHAR_LIMIT and role != "Skill definition":
            break
    return extracted


def extract_repo_contents(repo_signals: dict, repo_root: Path) -> list:
    """Extract a small set of repo-root governance files in full."""
    extracted = []
    # CHANGELOG top entry is already parsed; don't re-emit full file.
    # README: enough for description + audience.
    if readme := repo_signals.get("readme"):
        extracted.append(
            (
                "Repo README",
                repo_root / readme,
                read_content(repo_root / readme, limit=README_CHAR_LIMIT),
            )
        )
    # Evaluation docs: small sample with capped content.
    for d in repo_signals.get("evaluation_docs", [])[:EVAL_DOC_LIMIT]:
        p = repo_root / d["path"]
        extracted.append(
            ("Repo eval doc", p, read_content(p, limit=EVAL_DOC_CHAR_LIMIT))
        )
    return extracted


# ─── Output ───────────────────────────────────────────────────────────────


def emit_signal_summary(
    skill_root: Path,
    repo_root: Path,
    roles: dict,
    skill_extracted: list,
    repo_extracted: list,
    repo_signals: dict,
) -> None:
    print("\n" + "=" * SECTION_RULE_WIDTH)
    print("\n=== STRUCTURED SIGNAL SUMMARY ===")
    print("# These are the pre-extracted signals for card context assembly.")
    print("# Consult this section before scanning raw file contents.")
    print("=" * SECTION_RULE_WIDTH + "\n")

    # Skill frontmatter
    fm = {}
    if roles["Skill definition"]:
        fm = parse_frontmatter(roles["Skill definition"][FIRST_ITEM_INDEX])
    print("## Skill definition frontmatter")
    if fm:
        for k, v in fm.items():
            print(f"  {k}: {v}")
    else:
        print("  [no parseable frontmatter]")
    print()

    # Repo signals
    print("## Repo-root signals")
    if repo_signals.get("is_nested"):
        print(f"  repo_root: {repo_signals['repo_root']}")
    else:
        print("  [skill directory IS the repo root — no nesting]")
    if lic := repo_signals.get("license_identifier"):
        print(f"  license_identifier: {lic}  (from {repo_signals.get('license_file')})")
    if versions := repo_signals.get("versions"):
        for src, v in versions.items():
            print(f"  version.{src}: {v}")
    if git := repo_signals.get("git"):
        for k, v in git.items():
            print(f"  git.{k}: {v}")
    if cl := repo_signals.get("changelog_top_entry"):
        print(f"  changelog.version: {cl.get('version')}")
        print(f"  changelog.date: {cl.get('date')}")
        if body := cl.get("body"):
            print("  changelog.body: |")
            for line in body.splitlines()[:CHANGELOG_BODY_OUTPUT_LINE_LIMIT]:
                print(f"    {line}")
    if readme := repo_signals.get("readme"):
        print(f"  readme: {readme}")
    if sec := repo_signals.get("security_md"):
        print(f"  security_md: {sec}")
    if tp := repo_signals.get("third_party_license_files"):
        for t in tp:
            print(f"  third_party_license_file: {t}")
    print()

    # Collect full text for pattern scans
    all_text = "\n".join(c for _, _, c in skill_extracted + repo_extracted)
    if fm:
        all_text += "\n" + " ".join(f"{k}: {v}" for k, v in fm.items())
    # CHANGELOG top-entry body is extracted separately; include it in the scan
    if cl := repo_signals.get("changelog_top_entry"):
        if body := cl.get("body"):
            all_text += "\n" + body

    # URLs
    urls = find_urls(all_text)
    groups = group_urls_by_platform(urls)
    print("## Detected URLs by platform  (legal/process URLs excluded)")
    any_urls = False
    for platform, items in groups.items():
        if items:
            any_urls = True
            print(f"  {platform}:")
            for u in items[:URL_PLATFORM_OUTPUT_LIMIT]:
                print(f"    - {u}")
    if not any_urls:
        print("  [no release-channel URLs detected]")
    print()

    # Agents
    agents = find_agents(all_text)
    print("## Agents mentioned anywhere in sources")
    if agents:
        for a in agents:
            print(f"  - {a}")
    else:
        print("  [none detected]")
    print()

    # Credentials
    keys = find_api_keys(all_text)
    print("## Detected API-key / credential env vars")
    if keys:
        for k in keys:
            print(f"  - {k}")
    else:
        print("  [none detected]")
    print()

    # MCP references
    mcps = find_mcp_refs(all_text)
    print("## MCP / tool references")
    if mcps:
        for m in mcps:
            print(f"  - {m}")
    else:
        print("  [none detected]")
    print()

    # $ARGUMENTS
    arg_count = count_arguments_usage(all_text)
    print(f"## $ARGUMENTS usage count: {arg_count}")
    print()

    # Constraint sentences
    constraints = find_constraints(all_text)
    print("## Constraint sentences (candidates for Known Technical Limitations)")
    if constraints:
        for c in constraints:
            print(f"  - {c}")
    else:
        print("  [none detected]")
    print()

    # Evaluation docs
    print("## Evaluation artifacts")
    eval_docs = repo_signals.get("evaluation_docs", [])
    if eval_docs:
        for d in eval_docs:
            print(f"  - {d['path']}  ({d['title']})")
    else:
        print(
            "  [none detected — omit optional evaluation fields unless user provides details]"
        )
    print()

    # Docs index
    if docs := repo_signals.get("docs"):
        print("## Repo docs/ index")
        for d in docs[:DOCS_INDEX_LIMIT]:
            print(f"  - {d['path']}  ({d['title']})")
        print()


def emit_read_next_guidance(
    skill_root: Path,
    repo_root: Path,
    roles: dict,
    repo_signals: dict,
    helper_skill_dir: Path,
) -> None:
    """Print compact guidance for targeted reads after summary review."""
    print("\n" + "=" * SECTION_RULE_WIDTH)
    print("\n=== READ NEXT ONLY IF NEEDED ===")
    print("=" * SECTION_RULE_WIDTH + "\n")
    print(
        "# Use these paths for targeted follow-up reads instead of reloading this report."
    )
    if roles["Skill definition"]:
        rel = roles["Skill definition"][FIRST_ITEM_INDEX].relative_to(skill_root)
        print(f"- Target skill definition: {rel}")
    if readme := repo_signals.get("readme"):
        print(f"- Repo README excerpt source: {repo_root / readme}")
    for d in repo_signals.get("evaluation_docs", [])[:EVAL_DOC_LIMIT]:
        print(f"- Evaluation source: {repo_root / d['path']}")
    print(f"- Style guide: {helper_skill_dir / 'references' / 'style-guide.md'}")
    print(f"- Card template: {helper_skill_dir / 'references' / 'skill-card.md.j2'}")
    print()


def main():
    if len(sys.argv) < MIN_EXPECTED_ARGS:
        print("Usage: python3 discover_assets.py <skill_directory>", file=sys.stderr)
        sys.exit(USAGE_ERROR_EXIT_CODE)

    skill_root = Path(sys.argv[TARGET_ARG_INDEX]).expanduser().resolve()
    if not skill_root.exists():
        print(f"Error: directory not found: {skill_root}", file=sys.stderr)
        sys.exit(USAGE_ERROR_EXIT_CODE)
    if not skill_root.is_dir():
        print(f"Error: not a directory: {skill_root}", file=sys.stderr)
        sys.exit(USAGE_ERROR_EXIT_CODE)

    repo_root = find_repo_root(skill_root)
    roles = categorize_skill_dir(skill_root)

    print(f"# Asset Discovery Report — Skill Card")
    print(f"# Skill target: {skill_root}")
    print(f"# Repo root:    {repo_root}")
    if repo_root == skill_root:
        print("# (Skill directory is the repo root — no parent signals.)")
    print()

    for role, files in roles.items():
        if files:
            print(
                f"## {role} ({len(files)} file{'s' if len(files) != SINGULAR_COUNT else ''})"
            )
            for f in files:
                print(f"  - {f.relative_to(skill_root)}")
            print()

    if not roles["Skill definition"]:
        print("STOP: No skill definition file found. Cannot proceed.")
        return

    # Repo-root scope
    repo_signals = collect_repo_signals(repo_root, skill_root)

    # Extract contents
    skill_extracted = extract_skill_contents(roles)
    repo_extracted = extract_repo_contents(repo_signals, repo_root)

    skill_dir = Path(__file__).parent.parent

    emit_signal_summary(
        skill_root, repo_root, roles, skill_extracted, repo_extracted, repo_signals
    )
    emit_read_next_guidance(skill_root, repo_root, roles, repo_signals, skill_dir)

    print("\n" + "=" * SECTION_RULE_WIDTH)
    print("\n=== CAPPED FILE EXCERPTS (skill scope) ===")
    print("=" * SECTION_RULE_WIDTH + "\n")
    for role, path, content in skill_extracted:
        try:
            rel = path.relative_to(skill_root)
        except ValueError:
            rel = path
        print(f"### [{role}] {rel}")
        print("```")
        print(content)
        print("```\n")

    if repo_extracted:
        print("\n" + "=" * SECTION_RULE_WIDTH)
        print("\n=== CAPPED FILE EXCERPTS (repo scope) ===")
        print("=" * SECTION_RULE_WIDTH + "\n")
        for role, path, content in repo_extracted:
            try:
                rel = path.relative_to(repo_root)
            except ValueError:
                rel = path
            print(f"### [{role}] {rel}")
            print("```")
            print(content)
            print("```\n")

    # Append capped reference excerpts; agents can read targeted files if needed.
    for label, fname in [
        ("STYLE GUIDE EXCERPT", "style-guide.md"),
        ("JINJA TEMPLATE EXCERPT", "skill-card.md.j2"),
    ]:
        fpath = skill_dir / "references" / fname
        print("\n" + "=" * SECTION_RULE_WIDTH)
        print(f"\n=== {label} ===")
        print("=" * SECTION_RULE_WIDTH + "\n")
        if fpath.exists():
            print(f"# Source: {fpath}")
            print(
                "# Excerpt capped; read the source file directly if more detail is needed.\n"
            )
            print(read_content(fpath, limit=REFERENCE_APPENDIX_CHAR_LIMIT))
        else:
            print(f"[{fname} not found — check skill installation at {skill_dir}]")


if __name__ == "__main__":
    main()