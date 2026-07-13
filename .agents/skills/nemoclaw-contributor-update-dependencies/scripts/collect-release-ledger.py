#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Collect deterministic adjacent-release Git evidence for a dependency upgrade."""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from dataclasses import dataclass
from functools import total_ordering
from pathlib import Path
from typing import Any


SEMVER_RE = re.compile(
    r"^v?(?P<major>0|[1-9][0-9]*)\."
    r"(?P<minor>0|[1-9][0-9]*)\."
    r"(?P<patch>0|[1-9][0-9]*)"
    r"(?:-(?P<prerelease>[0-9A-Za-z.-]+))?"
    r"(?:\+(?P<build>[0-9A-Za-z.-]+))?$"
)


class LedgerError(RuntimeError):
    """Raised when the requested release range cannot be proven."""


@total_ordering
@dataclass(frozen=True)
class Version:
    major: int
    minor: int
    patch: int
    prerelease: str | None = None

    @classmethod
    def parse(cls, value: str) -> Version | None:
        match = SEMVER_RE.fullmatch(value)
        if not match:
            return None
        return cls(
            int(match.group("major")),
            int(match.group("minor")),
            int(match.group("patch")),
            match.group("prerelease"),
        )

    def __lt__(self, other: object) -> bool:
        if not isinstance(other, Version):
            return NotImplemented
        core = (self.major, self.minor, self.patch)
        other_core = (other.major, other.minor, other.patch)
        if core != other_core:
            return core < other_core
        if self.prerelease is None:
            return False
        if other.prerelease is None:
            return True
        return self._prerelease_is_less(self.prerelease, other.prerelease)

    @staticmethod
    def _prerelease_is_less(left: str, right: str) -> bool:
        left_parts = left.split(".")
        right_parts = right.split(".")
        for left_part, right_part in zip(left_parts, right_parts):
            if left_part == right_part:
                continue
            left_numeric = left_part.isdigit()
            right_numeric = right_part.isdigit()
            if left_numeric and right_numeric:
                return int(left_part) < int(right_part)
            if left_numeric != right_numeric:
                return left_numeric
            return left_part < right_part
        return len(left_parts) < len(right_parts)

    def render(self) -> str:
        base = f"{self.major}.{self.minor}.{self.patch}"
        return f"{base}-{self.prerelease}" if self.prerelease else base


def git(repo: Path, *args: str, allow_failure: bool = False) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode != 0 and not allow_failure:
        detail = result.stderr.strip() or result.stdout.strip() or "unknown Git failure"
        raise LedgerError(f"git {' '.join(args)} failed: {detail}")
    return result.stdout.rstrip("\n")


def resolve_commit(repo: Path, ref: str) -> str:
    sha = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise LedgerError(f"{ref!r} did not resolve to a full commit SHA")
    return sha


def is_ancestor(repo: Path, older: str, newer: str) -> bool:
    result = subprocess.run(
        ["git", "-C", str(repo), "merge-base", "--is-ancestor", older, newer],
        check=False,
        capture_output=True,
        text=True,
    )
    if result.returncode not in (0, 1):
        detail = result.stderr.strip() or "unknown merge-base failure"
        raise LedgerError(f"could not compare {older} and {newer}: {detail}")
    return result.returncode == 0


def version_and_tag_for_start(repo: Path, ref: str, sha: str) -> tuple[Version, str]:
    tags = git(repo, "tag", "--points-at", sha).splitlines()
    direct_tag = ref.removeprefix("refs/tags/")
    direct_version = Version.parse(direct_tag)
    if direct_tag in tags and direct_version is not None:
        return direct_version, direct_tag

    versions = [
        (parsed, tag)
        for tag in tags
        if (parsed := Version.parse(tag)) is not None
    ]
    if not versions:
        raise LedgerError(
            "--from must be a semantic-version tag or resolve to a commit carrying one"
        )
    stable = [(version, tag) for version, tag in versions if version.prerelease is None]
    return max(stable or versions, key=lambda item: (item[0], item[1]))


def tag_kind(repo: Path, tag: str) -> str:
    object_type = git(repo, "cat-file", "-t", f"refs/tags/{tag}")
    if object_type == "tag":
        return "annotated"
    if object_type == "commit":
        return "lightweight"
    raise LedgerError(f"tag {tag!r} points to unsupported object type {object_type!r}")


def tag_date(repo: Path, tag: str) -> str:
    return git(
        repo,
        "for-each-ref",
        "--format=%(creatordate:iso-strict)",
        f"refs/tags/{tag}",
    )


def parse_commits(repo: Path, older: str, newer: str) -> list[dict[str, str]]:
    raw = git(
        repo,
        "log",
        "--reverse",
        "--format=%H%x1f%aI%x1f%s",
        f"{older}..{newer}",
    )
    commits: list[dict[str, str]] = []
    for line in raw.splitlines():
        if not line:
            continue
        parts = line.split("\x1f", 2)
        if len(parts) != 3:
            raise LedgerError(f"could not parse commit record: {line!r}")
        commits.append({"sha": parts[0], "authoredAt": parts[1], "subject": parts[2]})
    return commits


def parse_changed_paths(repo: Path, older: str, newer: str) -> list[dict[str, Any]]:
    raw = git(repo, "diff", "--name-status", "--find-renames", older, newer)
    paths: list[dict[str, Any]] = []
    for line in raw.splitlines():
        fields = line.split("\t")
        if len(fields) < 2:
            raise LedgerError(f"could not parse changed path record: {line!r}")
        status = fields[0]
        record: dict[str, Any] = {"status": status, "path": fields[-1]}
        if status.startswith(("R", "C")):
            if len(fields) != 3:
                raise LedgerError(f"could not parse renamed path record: {line!r}")
            record["previousPath"] = fields[1]
        paths.append(record)
    return paths


def endpoint_for_tag(repo: Path, tag: str, version: Version) -> dict[str, Any]:
    sha = resolve_commit(repo, f"refs/tags/{tag}")
    return {
        "ref": tag,
        "sha": sha,
        "version": version.render(),
        "tagKind": tag_kind(repo, tag),
        "createdAt": tag_date(repo, tag),
    }


def collect(args: argparse.Namespace) -> dict[str, Any]:
    repo = Path(args.repo).expanduser().resolve()
    if git(repo, "rev-parse", "--is-inside-work-tree") != "true":
        raise LedgerError(f"not a Git worktree: {repo}")

    start_sha = resolve_commit(repo, args.from_ref)
    target_sha = resolve_commit(repo, args.to_ref)
    if not is_ancestor(repo, start_sha, target_sha):
        raise LedgerError(f"{args.from_ref!r} is not an ancestor of {args.to_ref!r}")

    start_version, start_tag = version_and_tag_for_start(repo, args.from_ref, start_sha)
    endpoints: list[dict[str, Any]] = [
        {
            "ref": args.from_ref,
            "sha": start_sha,
            "version": start_version.render(),
            "tagKind": tag_kind(repo, start_tag),
            "createdAt": tag_date(repo, start_tag),
        }
    ]

    candidates: list[tuple[Version, str]] = []
    for tag in git(repo, "tag", "--merged", target_sha).splitlines():
        version = Version.parse(tag)
        if version is None:
            continue
        if version.prerelease and not args.include_prereleases:
            continue
        if version <= start_version:
            continue
        tag_sha = resolve_commit(repo, f"refs/tags/{tag}")
        if not is_ancestor(repo, start_sha, tag_sha):
            continue
        candidates.append((version, tag))

    candidates.sort(key=lambda item: (item[0], item[1]))
    endpoints.extend(endpoint_for_tag(repo, tag, version) for version, tag in candidates)

    if all(endpoint["sha"] != target_sha for endpoint in endpoints):
        endpoints.append(
            {
                "ref": args.to_ref,
                "sha": target_sha,
                "version": None,
                "tagKind": None,
                "createdAt": git(repo, "show", "-s", "--format=%cI", target_sha),
            }
        )

    ranges: list[dict[str, Any]] = []
    for older, newer in zip(endpoints, endpoints[1:]):
        if not is_ancestor(repo, older["sha"], newer["sha"]):
            raise LedgerError(
                "semantic-version tag order conflicts with commit ancestry: "
                f"{older['ref']} is not an ancestor of {newer['ref']}"
            )
        commits = parse_commits(repo, older["sha"], newer["sha"])
        ranges.append(
            {
                "from": older,
                "to": newer,
                "commitCount": len(commits),
                "commits": commits,
                "changedPaths": parse_changed_paths(repo, older["sha"], newer["sha"]),
                "shortstat": git(
                    repo,
                    "diff",
                    "--shortstat",
                    older["sha"],
                    newer["sha"],
                ),
            }
        )

    return {
        "schemaVersion": 1,
        "repository": str(repo),
        "start": endpoints[0],
        "target": {"ref": args.to_ref, "sha": target_sha},
        "releaseEndpoints": endpoints,
        "ranges": ranges,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Collect adjacent semantic-version tag ranges and their exact Git evidence."
    )
    parser.add_argument("--repo", required=True, help="Upstream dependency Git worktree")
    parser.add_argument("--from", dest="from_ref", required=True, help="Current dependency ref")
    parser.add_argument("--to", dest="to_ref", required=True, help="Candidate dependency ref")
    parser.add_argument(
        "--include-prereleases",
        action="store_true",
        help="Include prerelease semantic-version tags between the endpoints",
    )
    parser.add_argument("--output", default="-", help="Output JSON path, or - for stdout")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    try:
        args = parse_args(argv)
        payload = json.dumps(collect(args), indent=2, sort_keys=True) + "\n"
        if args.output == "-":
            sys.stdout.write(payload)
        else:
            output = Path(args.output).expanduser()
            try:
                with output.open("x", encoding="utf-8") as output_file:
                    output_file.write(payload)
            except FileExistsError as error:
                raise LedgerError(f"refusing to overwrite output path: {output}") from error
        return 0
    except (LedgerError, OSError) as error:
        print(f"collect-release-ledger: error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
