#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Reconcile published Hermes CalVer releases with a complete local Git clone."""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


CALVER_RE = re.compile(r"^v(?P<parts>[0-9]+(?:\.[0-9]+){2,})$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
MAX_RELEASE_JSON_BYTES = 32 * 1024 * 1024
MAX_RELEASES = 10_000
MAX_TAG_REFS_JSON_BYTES = 32 * 1024 * 1024
MAX_TAG_REFS = 10_000
COMMAND_TIMEOUT_SECONDS = 120


class SupplementError(RuntimeError):
    """Raised when the Hermes release sequence cannot be proven."""


def parse_calver(tag: str) -> tuple[int, ...]:
    """Parse a three-or-more-component Hermes CalVer tag."""

    match = CALVER_RE.fullmatch(tag)
    if match is None:
        raise SupplementError(f"invalid Hermes CalVer tag: {tag!r}")
    raw_parts = match.group("parts").split(".")
    if any(len(part) > 1 and part.startswith("0") for part in raw_parts):
        raise SupplementError(
            f"Hermes CalVer tag has a leading-zero component: {tag!r}"
        )
    return tuple(int(part) for part in raw_parts)


def flatten_pages(
    value: Any, *, description: str, max_records: int
) -> list[dict[str, Any]]:
    """Accept one GitHub API page or ``gh api --slurp`` page arrays."""

    if not isinstance(value, list):
        raise SupplementError(f"{description} JSON must be an array")
    flattened: list[Any] = []
    for item in value:
        if isinstance(item, list):
            flattened.extend(item)
        else:
            flattened.append(item)
    if len(flattened) > max_records:
        raise SupplementError(f"{description} list exceeds {max_records} records")
    if any(not isinstance(item, dict) for item in flattened):
        raise SupplementError(f"{description} list contains a non-object record")
    return flattened


def load_stable_releases(path: Path) -> dict[str, dict[str, Any]]:
    """Load unique, published stable Hermes CalVer releases."""

    try:
        raw = path.read_bytes()
    except OSError as error:
        raise SupplementError(f"could not read releases JSON: {error}") from error
    if len(raw) > MAX_RELEASE_JSON_BYTES:
        raise SupplementError(f"releases JSON exceeds {MAX_RELEASE_JSON_BYTES} bytes")
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SupplementError(f"could not parse releases JSON: {error}") from error

    releases: dict[str, dict[str, Any]] = {}
    for record in flatten_pages(
        parsed, description="GitHub release", max_records=MAX_RELEASES
    ):
        tag = record.get("tag_name")
        if not isinstance(tag, str) or CALVER_RE.fullmatch(tag) is None:
            continue
        if record.get("draft") is not False or record.get("prerelease") is not False:
            continue
        if tag in releases:
            raise SupplementError(f"duplicate stable release record for {tag!r}")
        url = record.get("html_url")
        published_at = record.get("published_at")
        release_id = record.get("id")
        if (
            not isinstance(url, str)
            or not url.startswith(
                "https://github.com/NousResearch/hermes-agent/releases/tag/"
            )
            or not isinstance(published_at, str)
            or not published_at
            or not isinstance(release_id, int)
        ):
            raise SupplementError(
                f"incomplete authoritative release record for {tag!r}"
            )
        releases[tag] = {
            "releaseId": release_id,
            "publishedAt": published_at,
            "url": url,
        }
    return releases


def load_remote_tag_refs(path: Path) -> dict[str, dict[str, str]]:
    """Load unique Hermes CalVer roots from a frozen GitHub tag-ref inventory."""

    try:
        raw = path.read_bytes()
    except OSError as error:
        raise SupplementError(
            f"could not read remote tag refs JSON: {error}"
        ) from error
    if len(raw) > MAX_TAG_REFS_JSON_BYTES:
        raise SupplementError(
            f"remote tag refs JSON exceeds {MAX_TAG_REFS_JSON_BYTES} bytes"
        )
    try:
        parsed = json.loads(raw)
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise SupplementError(
            f"could not parse remote tag refs JSON: {error}"
        ) from error

    tag_refs: dict[str, dict[str, str]] = {}
    for record in flatten_pages(
        parsed, description="GitHub tag-ref", max_records=MAX_TAG_REFS
    ):
        full_ref = record.get("ref")
        if not isinstance(full_ref, str) or not full_ref.startswith("refs/tags/"):
            raise SupplementError(
                "GitHub tag-ref inventory contains an invalid tag ref"
            )
        tag = full_ref.removeprefix("refs/tags/")
        if CALVER_RE.fullmatch(tag) is None:
            continue
        if tag in tag_refs:
            raise SupplementError(f"duplicate GitHub tag-ref record for {tag!r}")

        target = record.get("object")
        if not isinstance(target, dict):
            raise SupplementError(
                f"incomplete authoritative GitHub tag-ref record for {tag!r}"
            )
        root_type = target.get("type")
        root_sha = target.get("sha")
        if root_type not in ("commit", "tag") or not isinstance(root_sha, str):
            raise SupplementError(
                f"incomplete authoritative GitHub tag-ref record for {tag!r}"
            )
        if SHA_RE.fullmatch(root_sha) is None:
            raise SupplementError(
                f"authoritative GitHub tag ref for {tag!r} has an invalid object SHA"
            )
        tag_refs[tag] = {
            "ref": full_ref,
            "rootObjectSha": root_sha,
            "rootObjectType": root_type,
        }
    return tag_refs


def resolve_git_executable(requested: str | None, repo: Path) -> str:
    """Resolve Git before consuming repository-controlled tag data."""

    candidate = requested or shutil.which("git")
    if candidate is None:
        raise SupplementError("could not resolve a trusted Git executable")
    path = Path(candidate).expanduser()
    if not path.is_absolute():
        raise SupplementError("the Git executable must be an absolute path")
    try:
        resolved = path.resolve(strict=True)
        repo_root = repo.resolve(strict=True)
    except OSError as error:
        raise SupplementError(
            f"could not resolve Git or repository path: {error}"
        ) from error
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise SupplementError("the resolved Git path is not executable")
    if resolved == repo_root or resolved.is_relative_to(repo_root):
        raise SupplementError(
            "the trusted Git executable must be outside the upstream clone"
        )
    return str(resolved)


def run_git(git_executable: str, repo: Path, *args: str, check: bool = True) -> str:
    """Run bounded Git without ambient configuration or lazy fetching."""

    environment = {
        "GIT_ATTR_NOSYSTEM": "1",
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_NOSYSTEM": "1",
        "GIT_NO_LAZY_FETCH": "1",
        "GIT_NO_REPLACE_OBJECTS": "1",
        "GIT_PAGER": "cat",
        "GIT_TERMINAL_PROMPT": "0",
        "LC_ALL": "C",
        "PATH": os.defpath,
    }
    try:
        result = subprocess.run(
            [
                git_executable,
                "--no-pager",
                "-c",
                "log.showSignature=false",
                "-c",
                "core.commitGraph=false",
                "-c",
                "core.fsmonitor=false",
                "-C",
                str(repo),
                *args,
            ],
            check=False,
            capture_output=True,
            env=environment,
            text=True,
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise SupplementError(f"could not run git {' '.join(args)}: {error}") from error
    if check and result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown Git failure"
        raise SupplementError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout.rstrip("\n") if result.returncode == 0 else ""


def tag_identity(git_executable: str, repo: Path, tag: str) -> dict[str, str]:
    """Resolve one annotated tag object and its peeled commit."""

    object_type = run_git(git_executable, repo, "cat-file", "-t", f"refs/tags/{tag}")
    if object_type != "tag":
        raise SupplementError(f"Hermes release tag {tag!r} is not annotated")
    object_sha = run_git(
        git_executable, repo, "rev-parse", "--verify", f"refs/tags/{tag}"
    )
    commit_sha = run_git(
        git_executable, repo, "rev-parse", "--verify", f"refs/tags/{tag}^{{commit}}"
    )
    if SHA_RE.fullmatch(object_sha) is None or SHA_RE.fullmatch(commit_sha) is None:
        raise SupplementError(
            f"Hermes release tag {tag!r} did not resolve to full SHAs"
        )
    return {"commitSha": commit_sha, "tagObjectSha": object_sha}


def collect(args: argparse.Namespace) -> dict[str, Any]:
    """Collect the complete published stable CalVer sequence and adjacent ranges."""

    repo = Path(args.repo).expanduser().resolve()
    git_executable = resolve_git_executable(args.git_executable, repo)
    if run_git(git_executable, repo, "rev-parse", "--is-inside-work-tree") != "true":
        raise SupplementError(f"not a Git worktree: {repo}")
    repo = Path(run_git(git_executable, repo, "rev-parse", "--show-toplevel")).resolve()

    start_version = parse_calver(args.from_tag)
    target_version = parse_calver(args.to_tag)
    if start_version >= target_version:
        raise SupplementError("--from must precede --to in Hermes CalVer order")

    releases = load_stable_releases(Path(args.releases_json).expanduser().resolve())
    remote_tag_refs = load_remote_tag_refs(
        Path(args.remote_tag_refs_json).expanduser().resolve()
    )
    for endpoint in (args.from_tag, args.to_tag):
        if endpoint not in releases:
            raise SupplementError(
                f"authoritative stable release list does not contain {endpoint!r}"
            )

    selected = sorted(
        (
            (parse_calver(tag), tag, publication)
            for tag, publication in releases.items()
            if start_version <= parse_calver(tag) <= target_version
        ),
        key=lambda item: (item[0], item[1]),
    )
    normalized_versions: set[tuple[int, ...]] = set()
    endpoints: list[dict[str, Any]] = []
    for version, tag, publication in selected:
        if version in normalized_versions:
            raise SupplementError(
                f"multiple release tags normalize to Hermes CalVer {version!r}"
            )
        normalized_versions.add(version)
        local_identity = tag_identity(git_executable, repo, tag)
        remote_identity = remote_tag_refs.get(tag)
        if remote_identity is None:
            raise SupplementError(
                f"authoritative GitHub tag-ref inventory does not contain {tag!r}"
            )
        if remote_identity["rootObjectType"] != "tag":
            raise SupplementError(
                f"authoritative GitHub tag ref for {tag!r} is not annotated"
            )
        if local_identity["tagObjectSha"] != remote_identity["rootObjectSha"]:
            raise SupplementError(
                f"local annotated tag object for {tag!r} does not match the "
                "authoritative GitHub tag ref"
            )
        endpoints.append(
            {
                "tag": tag,
                "version": ".".join(str(part) for part in version),
                **local_identity,
                "publication": publication,
                "remoteTagIdentity": {
                    "provider": "github",
                    "repository": "NousResearch/hermes-agent",
                    **remote_identity,
                },
            }
        )

    if not endpoints or endpoints[0]["tag"] != args.from_tag:
        raise SupplementError("selected release sequence does not start at --from")
    if endpoints[-1]["tag"] != args.to_tag:
        raise SupplementError("selected release sequence does not end at --to")

    ranges: list[dict[str, Any]] = []
    for older, newer in zip(endpoints, endpoints[1:]):
        ancestry = subprocess.run(
            [
                git_executable,
                "-C",
                str(repo),
                "merge-base",
                "--is-ancestor",
                older["commitSha"],
                newer["commitSha"],
            ],
            check=False,
            capture_output=True,
            env={
                "GIT_CONFIG_GLOBAL": os.devnull,
                "GIT_CONFIG_NOSYSTEM": "1",
                "GIT_NO_LAZY_FETCH": "1",
                "GIT_NO_REPLACE_OBJECTS": "1",
                "LC_ALL": "C",
                "PATH": os.defpath,
            },
            timeout=COMMAND_TIMEOUT_SECONDS,
        )
        if ancestry.returncode != 0:
            raise SupplementError(
                f"{older['tag']!r} is not an ancestor of {newer['tag']!r}"
            )
        commit_count = run_git(
            git_executable,
            repo,
            "rev-list",
            "--count",
            f"{older['commitSha']}..{newer['commitSha']}",
        )
        changed_paths = run_git(
            git_executable,
            repo,
            "diff",
            "--name-only",
            "-z",
            older["commitSha"],
            newer["commitSha"],
        )
        ranges.append(
            {
                "from": older["tag"],
                "to": newer["tag"],
                "commitCount": int(commit_count),
                "changedFileCount": len(
                    [path for path in changed_paths.split("\0") if path]
                ),
            }
        )

    return {
        "schemaVersion": 1,
        "repository": str(repo),
        "source": (
            "Frozen GitHub published non-draft non-prerelease releases and "
            "matching tag refs"
        ),
        "start": args.from_tag,
        "target": args.to_tag,
        "releaseEndpoints": endpoints,
        "ranges": ranges,
    }


def parse_args() -> argparse.Namespace:
    """Parse CLI arguments."""

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True, help="Complete Hermes Git clone")
    parser.add_argument("--from", dest="from_tag", required=True, help="Current tag")
    parser.add_argument("--to", dest="to_tag", required=True, help="Target tag")
    parser.add_argument(
        "--releases-json",
        required=True,
        help="Output of gh api --paginate --slurp for the Hermes releases endpoint",
    )
    parser.add_argument(
        "--remote-tag-refs-json",
        required=True,
        help=(
            "Output of gh api --paginate --slurp for the authoritative GitHub "
            "matching tag-refs endpoint"
        ),
    )
    parser.add_argument(
        "--git-executable",
        help="Absolute trusted Git executable resolved before reading upstream data",
    )
    parser.add_argument("--output", required=True, help="Supplement JSON output path")
    return parser.parse_args()


def main() -> int:
    """Run the collector and write deterministic JSON."""

    try:
        args = parse_args()
        supplement = collect(args)
        output = Path(args.output).expanduser().resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(
            json.dumps(supplement, indent=2, sort_keys=True) + "\n",
            encoding="utf-8",
        )
    except (OSError, SupplementError, ValueError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
