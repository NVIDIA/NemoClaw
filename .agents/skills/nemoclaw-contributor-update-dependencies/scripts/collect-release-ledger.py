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
from datetime import datetime, timezone
from functools import cmp_to_key
from pathlib import Path
from typing import Any
from urllib.parse import quote, unquote, urlparse


SEMVER_RE = re.compile(
    r"^v?(?P<major>0|[1-9][0-9]*)\."
    r"(?P<minor>0|[1-9][0-9]*)\."
    r"(?P<patch>0|[1-9][0-9]*)"
    r"(?:-(?P<prerelease>[0-9A-Za-z.-]+))?"
    r"(?:\+(?P<build>[0-9A-Za-z.-]+))?$"
)
SHA_RE = re.compile(r"[0-9a-f]{40}")
RFC3339_RE = re.compile(
    r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}"
    r"(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})"
)
GITHUB_API_TIMEOUT_SECONDS = 30
MAX_TAG_PEEL_DEPTH = 32


class LedgerError(RuntimeError):
    """Raised when the requested release range cannot be proven."""


@dataclass(frozen=True)
class Version:
    """A SemVer identity with ordering suitable for release-ledger endpoints."""

    major: int
    minor: int
    patch: int
    prerelease: str | None = None
    build: str | None = None

    @classmethod
    def parse(cls, value: str) -> Version | None:
        """Parse a complete SemVer tag, accepting an optional leading ``v``."""

        match = SEMVER_RE.fullmatch(value)
        if not match:
            return None
        prerelease = match.group("prerelease")
        build = match.group("build")
        if prerelease is not None:
            identifiers = prerelease.split(".")
            if any(
                not identifier
                or (
                    identifier.isdigit()
                    and len(identifier) > 1
                    and identifier.startswith("0")
                )
                for identifier in identifiers
            ):
                return None
        if build is not None and any(not identifier for identifier in build.split(".")):
            return None
        return cls(
            int(match.group("major")),
            int(match.group("minor")),
            int(match.group("patch")),
            prerelease,
            build,
        )

    def compare_precedence(self, other: Version) -> int:
        """Return the SemVer precedence comparison, excluding build metadata."""

        core = (self.major, self.minor, self.patch)
        other_core = (other.major, other.minor, other.patch)
        if core != other_core:
            return -1 if core < other_core else 1
        if self.prerelease is None:
            return 0 if other.prerelease is None else 1
        if other.prerelease is None:
            return -1
        if self.prerelease == other.prerelease:
            return 0
        if self._prerelease_is_less(self.prerelease, other.prerelease):
            return -1
        return 1

    @staticmethod
    def _prerelease_is_less(left: str, right: str) -> bool:
        """Return whether one dot-delimited prerelease has lower precedence."""

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
        """Render the normalized version without a tag's optional leading ``v``."""

        base = f"{self.major}.{self.minor}.{self.patch}"
        if self.prerelease:
            base = f"{base}-{self.prerelease}"
        return f"{base}+{self.build}" if self.build else base


def compare_tagged_versions(
    left: tuple[Version, str], right: tuple[Version, str]
) -> int:
    """Order tagged versions by SemVer precedence and then exact tag identity."""

    precedence = left[0].compare_precedence(right[0])
    if precedence != 0:
        return precedence
    return (left[1] > right[1]) - (left[1] < right[1])


def git(repo: Path, *args: str, allow_failure: bool = False) -> str:
    """Run Git in ``repo`` and return stdout without its final newline."""

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
    """Resolve ``ref`` to one full commit SHA or raise ``LedgerError``."""

    sha = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}")
    if not re.fullmatch(r"[0-9a-f]{40}", sha):
        raise LedgerError(f"{ref!r} did not resolve to a full commit SHA")
    return sha


def explicitly_referenced_tag(repo: Path, ref: str, sha: str) -> str | None:
    """Return the tag named directly by ``ref`` when it resolves to ``sha``."""

    tag = ref.removeprefix("refs/tags/")
    tag_sha = git(
        repo,
        "rev-parse",
        "--verify",
        f"refs/tags/{tag}^{{commit}}",
        allow_failure=True,
    )
    return tag if tag_sha == sha else None


def is_ancestor(repo: Path, older: str, newer: str) -> bool:
    """Return whether ``older`` is an ancestor of ``newer``."""

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
    """Select the semantic-version tag that defines the starting endpoint."""

    tags = git(repo, "tag", "--points-at", sha).splitlines()
    direct_tag = ref.removeprefix("refs/tags/")
    direct_version = Version.parse(direct_tag)
    if direct_tag in tags and direct_version is not None:
        return direct_version, direct_tag

    versions = [
        (parsed, tag) for tag in tags if (parsed := Version.parse(tag)) is not None
    ]
    if not versions:
        raise LedgerError(
            "--from must be a semantic-version tag or resolve to a commit carrying one"
        )
    stable = [(version, tag) for version, tag in versions if version.prerelease is None]
    ordered = sorted(stable or versions, key=cmp_to_key(compare_tagged_versions))
    return ordered[-1]


def tag_kind(repo: Path, tag: str) -> str:
    """Classify ``tag`` as annotated or lightweight."""

    object_type = git(repo, "cat-file", "-t", f"refs/tags/{tag}")
    if object_type == "tag":
        return "annotated"
    if object_type == "commit":
        return "lightweight"
    raise LedgerError(f"tag {tag!r} points to unsupported object type {object_type!r}")


def tag_date(repo: Path, tag: str) -> str:
    """Return ``tag`` creation time in strict ISO-8601 form."""

    return git(
        repo,
        "for-each-ref",
        "--format=%(creatordate:iso-strict)",
        f"refs/tags/{tag}",
    )


def parse_commits(repo: Path, older: str, newer: str) -> list[dict[str, str]]:
    """Collect deterministic commit evidence for ``older..newer``."""

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
    """Collect rename-aware changed-path evidence for a release range."""

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
    """Build a release endpoint from a semantic-version tag."""

    sha = resolve_commit(repo, f"refs/tags/{tag}")
    return {
        "ref": tag,
        "tag": tag,
        "sha": sha,
        "version": version.render(),
        "tagKind": tag_kind(repo, tag),
        "tagObjectSha": git(repo, "rev-parse", f"refs/tags/{tag}"),
        "createdAt": tag_date(repo, tag),
    }


def github_api_json(
    api_host: str,
    endpoint: str,
    description: str,
    timeout_seconds: int,
    *,
    paginate: bool = False,
) -> Any:
    """Read JSON from one authenticated GitHub API GET or fail closed."""

    command = [
        "gh",
        "api",
        "--hostname",
        api_host,
        "--method",
        "GET",
        "--header",
        "Accept: application/vnd.github+json",
        endpoint,
    ]
    if paginate:
        command.extend(("--paginate", "--slurp"))
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
        )
    except subprocess.TimeoutExpired as error:
        raise LedgerError(
            f"GitHub {description} timed out after {timeout_seconds} seconds"
        ) from error
    except OSError as error:
        raise LedgerError(f"could not execute gh for {description}: {error}") from error
    if result.returncode != 0:
        detail = (
            result.stderr.strip()
            or result.stdout.strip()
            or "unknown GitHub API failure"
        )
        raise LedgerError(f"GitHub {description} failed: {detail}")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as error:
        raise LedgerError(f"GitHub {description} returned malformed JSON") from error


def require_object(payload: Any, description: str) -> dict[str, Any]:
    """Require an API payload to be one JSON object."""

    if not isinstance(payload, dict):
        raise LedgerError(f"GitHub {description} did not return an object")
    return payload


def require_sha(value: Any, description: str) -> str:
    """Require one exact lowercase full Git object SHA."""

    if not isinstance(value, str) or SHA_RE.fullmatch(value) is None:
        raise LedgerError(f"GitHub {description} omitted a full commit/object SHA")
    return value


def require_bool(value: Any, description: str) -> bool:
    """Require a JSON boolean without accepting Python's integer subtyping."""

    if type(value) is not bool:
        raise LedgerError(f"GitHub {description} omitted a boolean")
    return value


def require_positive_int(value: Any, description: str) -> int:
    """Require a positive JSON integer without accepting booleans."""

    if type(value) is not int or value <= 0:
        raise LedgerError(f"GitHub {description} omitted a positive integer")
    return value


def require_nonempty_string(value: Any, description: str) -> str:
    """Require a nonempty JSON string."""

    if not isinstance(value, str) or not value:
        raise LedgerError(f"GitHub {description} omitted a nonempty string")
    return value


def require_rfc3339(value: Any, description: str) -> str:
    """Require one timezone-aware RFC3339 timestamp."""

    if not isinstance(value, str) or RFC3339_RE.fullmatch(value) is None:
        raise LedgerError(f"GitHub {description} omitted an RFC3339 timestamp")
    try:
        parsed = datetime.fromisoformat(
            value.removesuffix("Z") + ("+00:00" if value.endswith("Z") else "")
        )
    except ValueError as error:
        raise LedgerError(
            f"GitHub {description} returned an invalid timestamp"
        ) from error
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise LedgerError(
            f"GitHub {description} returned a timestamp without a timezone"
        )
    return value


def require_https_url(
    value: Any,
    description: str,
    *,
    expected_host: str,
    expected_path: str | None = None,
    expected_path_prefix: str | None = None,
) -> str:
    """Require an HTTPS URL bound to the selected GitHub host and repository path."""

    if not isinstance(value, str):
        raise LedgerError(f"GitHub {description} omitted an HTTPS URL")
    parsed = urlparse(value)
    try:
        port = parsed.port
    except ValueError as error:
        raise LedgerError(f"GitHub {description} returned an invalid URL") from error
    if (
        parsed.scheme != "https"
        or parsed.hostname is None
        or parsed.hostname.casefold() != expected_host.casefold()
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
        or parsed.query
        or parsed.fragment
    ):
        raise LedgerError(
            f"GitHub {description} returned a URL outside {expected_host!r}"
        )
    decoded_path = unquote(parsed.path)
    if (
        expected_path is not None
        and decoded_path.casefold() != expected_path.casefold()
    ):
        raise LedgerError(
            f"GitHub {description} returned a URL for the wrong repository"
        )
    if expected_path_prefix is not None and not decoded_path.casefold().startswith(
        expected_path_prefix.casefold()
    ):
        raise LedgerError(
            f"GitHub {description} returned a URL for the wrong repository"
        )
    return value


def github_repository_identity(
    repository: str, api_host: str, timeout_seconds: int
) -> dict[str, Any]:
    """Bind API host, canonical repository identity, and draft visibility."""

    payload = require_object(
        github_api_json(
            api_host,
            f"repos/{repository}",
            f"repository lookup for {repository!r}",
            timeout_seconds,
        ),
        f"repository lookup for {repository!r}",
    )
    full_name = require_nonempty_string(
        payload.get("full_name"), "repository full_name"
    )
    if re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", full_name) is None:
        raise LedgerError("GitHub repository lookup returned an invalid canonical name")
    repository_id = require_positive_int(payload.get("id"), "repository id")
    node_id = require_nonempty_string(payload.get("node_id"), "repository node_id")
    visibility = payload.get("visibility")
    if visibility not in ("public", "private", "internal"):
        raise LedgerError("GitHub repository lookup omitted a valid visibility")
    url = require_https_url(
        payload.get("html_url"),
        "repository html_url",
        expected_host=api_host,
        expected_path=f"/{full_name}",
    )
    permissions = payload.get("permissions")
    if permissions is None:
        draft_visibility = "unknown"
        viewer_can_push = None
    elif isinstance(permissions, dict):
        viewer_can_push = require_bool(
            permissions.get("push"), "repository permissions.push"
        )
        draft_visibility = "full" if viewer_can_push else "published-only"
    else:
        raise LedgerError("GitHub repository permissions had the wrong type")
    return {
        "provider": "github",
        "apiHost": api_host,
        "requestedName": repository,
        "repositoryId": repository_id,
        "nodeId": node_id,
        "fullName": full_name,
        "visibility": visibility,
        "url": url,
        "viewerCanPush": viewer_can_push,
        "draftVisibility": draft_visibility,
        "collectedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    }


def validate_github_release(
    release: Any, repository_identity: dict[str, Any]
) -> dict[str, Any]:
    """Validate and normalize one release-list entry."""

    item = require_object(release, "release-list entry")
    tag = require_nonempty_string(item.get("tag_name"), "release tag_name")
    release_id = require_positive_int(item.get("id"), f"release {tag!r} id")
    draft = require_bool(item.get("draft"), f"release {tag!r} draft")
    prerelease = require_bool(item.get("prerelease"), f"release {tag!r} prerelease")
    immutable = require_bool(item.get("immutable"), f"release {tag!r} immutable")
    name = item.get("name")
    if name is not None and not isinstance(name, str):
        raise LedgerError(f"GitHub release {tag!r} name had the wrong type")
    target_commitish = require_nonempty_string(
        item.get("target_commitish"), f"release {tag!r} target_commitish"
    )
    published_at = item.get("published_at")
    if draft:
        if published_at is not None:
            raise LedgerError(
                f"GitHub draft release {tag!r} had a publication timestamp"
            )
    else:
        published_at = require_rfc3339(published_at, f"release {tag!r} published_at")
    full_name = repository_identity["fullName"]
    url = require_https_url(
        item.get("html_url"),
        f"release {tag!r} html_url",
        expected_host=repository_identity["apiHost"],
        expected_path_prefix=f"/{full_name}/releases/",
    )
    state = "draft" if draft else "prerelease" if prerelease else "published"
    return {
        "provider": "github",
        "state": state,
        "tag": tag,
        "releaseId": release_id,
        "name": name,
        "draft": draft,
        "prerelease": prerelease,
        "immutable": immutable,
        "reportedTargetCommitish": target_commitish,
        "publishedAt": published_at,
        "url": url,
    }


def github_release_publications(
    repository_identity: dict[str, Any], timeout_seconds: int
) -> dict[str, dict[str, Any]]:
    """List all visible releases once, retaining honest draft-visibility semantics."""

    repository = repository_identity["requestedName"]
    api_host = repository_identity["apiHost"]
    payload = github_api_json(
        api_host,
        f"repos/{repository}/releases?per_page=100",
        f"paginated release listing for {repository!r}",
        timeout_seconds,
        paginate=True,
    )
    if not isinstance(payload, list) or any(
        not isinstance(page, list) for page in payload
    ):
        raise LedgerError("GitHub paginated release listing had the wrong shape")
    releases: dict[str, dict[str, Any]] = {}
    observed_draft = False
    for page in payload:
        for raw_release in page:
            release = validate_github_release(raw_release, repository_identity)
            tag = release["tag"]
            if tag in releases:
                raise LedgerError(
                    f"GitHub release listing returned duplicate tag {tag!r}"
                )
            releases[tag] = release
            observed_draft = observed_draft or release["draft"]
    if observed_draft:
        if repository_identity["draftVisibility"] == "published-only":
            raise LedgerError(
                "GitHub release listing returned a draft despite permissions.push=false"
            )
        repository_identity["draftVisibility"] = "full"
    return releases


def publication_for_tag(
    tag: str,
    releases: dict[str, dict[str, Any]],
    repository_identity: dict[str, Any],
) -> dict[str, Any]:
    """Return publication state without claiming hidden drafts are absent."""

    if tag in releases:
        return releases[tag]
    draft_visibility = repository_identity["draftVisibility"]
    state = "absent" if draft_visibility == "full" else "not-published"
    return {
        "provider": "github",
        "state": state,
        "tag": tag,
        "draftVisibility": draft_visibility,
    }


def github_tag_identity(
    repository_identity: dict[str, Any],
    tag: str,
    expected_commit_sha: str,
    expected_tag_kind: str,
    expected_root_object_sha: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    """Resolve and peel a remote lightweight or annotated tag to the local commit."""

    repository = repository_identity["requestedName"]
    api_host = repository_identity["apiHost"]
    description = f"tag ref lookup for {tag!r}"
    ref = require_object(
        github_api_json(
            api_host,
            f"repos/{repository}/git/ref/tags/{quote(tag, safe='')}",
            description,
            timeout_seconds,
        ),
        description,
    )
    if ref.get("ref") != f"refs/tags/{tag}":
        raise LedgerError(f"GitHub tag ref lookup for {tag!r} returned the wrong ref")
    target = require_object(ref.get("object"), f"tag ref {tag!r} object")
    object_type = target.get("type")
    object_sha = require_sha(target.get("sha"), f"tag ref {tag!r}")
    root_type = object_type
    root_sha = object_sha
    expected_root_type = "tag" if expected_tag_kind == "annotated" else "commit"
    if root_type != expected_root_type or root_sha != expected_root_object_sha:
        raise LedgerError(
            f"GitHub tag ref {tag!r} object identity differs from the local tag object"
        )
    tag_objects: list[str] = []
    seen: set[str] = set()
    while object_type == "tag":
        if object_sha in seen or len(tag_objects) >= MAX_TAG_PEEL_DEPTH:
            raise LedgerError(
                f"GitHub annotated tag chain for {tag!r} is cyclic or too deep"
            )
        seen.add(object_sha)
        tag_objects.append(object_sha)
        annotated_description = f"annotated tag object {object_sha!r} for {tag!r}"
        annotated = require_object(
            github_api_json(
                api_host,
                f"repos/{repository}/git/tags/{object_sha}",
                annotated_description,
                timeout_seconds,
            ),
            annotated_description,
        )
        if require_sha(annotated.get("sha"), annotated_description) != object_sha:
            raise LedgerError(
                f"GitHub annotated tag lookup for {tag!r} returned the wrong object"
            )
        annotated_name = require_nonempty_string(
            annotated.get("tag"), f"annotated tag {object_sha!r} name"
        )
        if len(tag_objects) == 1 and annotated_name != tag:
            raise LedgerError(
                f"GitHub annotated tag object for {tag!r} reported name {annotated_name!r}"
            )
        target = require_object(
            annotated.get("object"), f"annotated tag {object_sha!r} target"
        )
        object_type = target.get("type")
        object_sha = require_sha(
            target.get("sha"), f"annotated tag {object_sha!r} target"
        )
    if object_type != "commit":
        raise LedgerError(
            f"GitHub tag {tag!r} resolved to unsupported object type {object_type!r}"
        )
    if object_sha != expected_commit_sha:
        raise LedgerError(
            f"GitHub tag {tag!r} resolves to {object_sha}, not local {expected_commit_sha}"
        )
    return {
        "provider": "github",
        "apiHost": api_host,
        "repositoryId": repository_identity["repositoryId"],
        "ref": f"refs/tags/{tag}",
        "rootObjectType": root_type,
        "rootObjectSha": root_sha,
        "tagObjectShas": tag_objects,
        "commitSha": object_sha,
    }


def github_commit_identity(
    repository_identity: dict[str, Any], sha: str, timeout_seconds: int
) -> dict[str, Any]:
    """Prove that an untagged audit target belongs to the bound GitHub repository."""

    repository = repository_identity["requestedName"]
    api_host = repository_identity["apiHost"]
    description = f"commit lookup for {sha!r}"
    payload = require_object(
        github_api_json(
            api_host,
            f"repos/{repository}/git/commits/{sha}",
            description,
            timeout_seconds,
        ),
        description,
    )
    remote_sha = require_sha(payload.get("sha"), description)
    if remote_sha != sha:
        raise LedgerError(
            f"GitHub commit lookup returned {remote_sha}, not local {sha}"
        )
    return {
        "provider": "github",
        "apiHost": api_host,
        "repositoryId": repository_identity["repositoryId"],
        "commitSha": remote_sha,
    }


def collect(args: argparse.Namespace) -> dict[str, Any]:
    """Collect adjacent release endpoints and range evidence for ``args``."""

    repo = Path(args.repo).expanduser().resolve()
    if git(repo, "rev-parse", "--is-inside-work-tree") != "true":
        raise LedgerError(f"not a Git worktree: {repo}")

    start_sha = resolve_commit(repo, args.from_ref)
    target_sha = resolve_commit(repo, args.to_ref)
    for option, ref, sha in (
        ("--from", args.from_ref, start_sha),
        ("--to", args.to_ref, target_sha),
    ):
        explicit_tag = explicitly_referenced_tag(repo, ref, sha)
        if explicit_tag is not None and Version.parse(explicit_tag) is None:
            raise LedgerError(
                f"{option} explicitly references tag {explicit_tag!r}, which is not a valid "
                "semantic-version tag"
            )
    if not is_ancestor(repo, start_sha, target_sha):
        raise LedgerError(f"{args.from_ref!r} is not an ancestor of {args.to_ref!r}")

    required_fixes: list[dict[str, Any]] = []
    for required_ref in args.required_fixes:
        required_sha = resolve_commit(repo, required_ref)
        if not is_ancestor(repo, required_sha, target_sha):
            raise LedgerError(
                f"required fix {required_ref!r} ({required_sha}) is not an ancestor of "
                f"audit target {args.to_ref!r} ({target_sha})"
            )
        required_fixes.append({"ref": required_ref, "sha": required_sha})

    start_version, start_tag = version_and_tag_for_start(repo, args.from_ref, start_sha)
    endpoints: list[dict[str, Any]] = [
        {
            "ref": args.from_ref,
            "tag": start_tag,
            "sha": start_sha,
            "version": start_version.render(),
            "tagKind": tag_kind(repo, start_tag),
            "tagObjectSha": git(repo, "rev-parse", f"refs/tags/{start_tag}"),
            "createdAt": tag_date(repo, start_tag),
        }
    ]

    candidates: list[tuple[Version, str, str]] = []
    explicit_target_tag = explicitly_referenced_tag(repo, args.to_ref, target_sha)
    for tag in git(repo, "tag", "--merged", target_sha).splitlines():
        version = Version.parse(tag)
        if version is None:
            continue
        tag_sha = resolve_commit(repo, f"refs/tags/{tag}")
        if not is_ancestor(repo, start_sha, tag_sha) or tag_sha == start_sha:
            continue
        explicitly_targeted = tag == explicit_target_tag and tag_sha == target_sha
        precedence = version.compare_precedence(start_version)
        if precedence < 0:
            raise LedgerError(
                "semantic-version precedence regresses along commit ancestry: "
                f"{tag!r} follows {start_tag!r}"
            )
        if (
            version.prerelease
            and not args.include_prereleases
            and not explicitly_targeted
        ):
            continue
        candidates.append((version, tag, tag_sha))

    def compare_candidates(
        left: tuple[Version, str, str], right: tuple[Version, str, str]
    ) -> int:
        precedence = left[0].compare_precedence(right[0])
        if precedence != 0:
            return precedence
        if left[2] == right[2]:
            return (left[1] > right[1]) - (left[1] < right[1])
        if is_ancestor(repo, left[2], right[2]):
            return -1
        if is_ancestor(repo, right[2], left[2]):
            return 1
        raise LedgerError(
            "equal-precedence semantic-version tags are incomparable by commit ancestry: "
            f"{left[1]!r} and {right[1]!r}"
        )

    candidates.sort(key=cmp_to_key(compare_candidates))
    endpoints.extend(
        endpoint_for_tag(repo, tag, version) for version, tag, _sha in candidates
    )

    if all(endpoint["sha"] != target_sha for endpoint in endpoints):
        endpoints.append(
            {
                "ref": args.to_ref,
                "tag": None,
                "sha": target_sha,
                "version": None,
                "tagKind": None,
                "createdAt": git(repo, "show", "-s", "--format=%cI", target_sha),
            }
        )

    publication_source = None
    target_remote_commit = None
    if args.github_repository:
        publication_source = github_repository_identity(
            args.github_repository,
            args.github_host,
            args.github_timeout_seconds,
        )
        releases = github_release_publications(
            publication_source, args.github_timeout_seconds
        )
        for endpoint in endpoints:
            tag = endpoint["tag"]
            if isinstance(tag, str):
                endpoint["remoteTag"] = github_tag_identity(
                    publication_source,
                    tag,
                    endpoint["sha"],
                    endpoint["tagKind"],
                    endpoint["tagObjectSha"],
                    args.github_timeout_seconds,
                )
                endpoint["publication"] = publication_for_tag(
                    tag, releases, publication_source
                )
            else:
                endpoint["remoteCommit"] = github_commit_identity(
                    publication_source,
                    endpoint["sha"],
                    args.github_timeout_seconds,
                )
                endpoint["publication"] = {
                    "provider": "github",
                    "state": "unreleased-commit",
                    "tag": None,
                }
        target_remote_commit = github_commit_identity(
            publication_source, target_sha, args.github_timeout_seconds
        )
        for required_fix in required_fixes:
            required_fix["remoteCommit"] = github_commit_identity(
                publication_source,
                required_fix["sha"],
                args.github_timeout_seconds,
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

    if explicit_target_tag is not None:
        explicit_version = Version.parse(explicit_target_tag)
        assert explicit_version is not None
        target: dict[str, Any] = {
            "kind": "tag",
            "requestedRef": args.to_ref,
            "tag": explicit_target_tag,
            "version": explicit_version.render(),
            "sha": target_sha,
        }
        matching_endpoint = next(
            endpoint for endpoint in endpoints if endpoint["tag"] == explicit_target_tag
        )
        if "publication" in matching_endpoint:
            target["publication"] = matching_endpoint["publication"]
        if "remoteTag" in matching_endpoint:
            target["remoteTag"] = matching_endpoint["remoteTag"]
    else:
        target = {
            "kind": "commit",
            "requestedRef": args.to_ref,
            "tag": None,
            "version": None,
            "sha": target_sha,
        }
    if target_remote_commit is not None:
        target["remoteCommit"] = target_remote_commit

    ledger = {
        "schemaVersion": 3,
        "repository": str(repo),
        "start": endpoints[0],
        "requiredFixes": required_fixes,
        "target": target,
        "releaseEndpoints": endpoints,
        "ranges": ranges,
    }
    if publication_source is not None:
        ledger["publicationSource"] = publication_source
    return ledger


def parse_args(argv: list[str]) -> argparse.Namespace:
    """Parse collector command-line arguments."""

    parser = argparse.ArgumentParser(
        description="Collect adjacent semantic-version tag ranges and their exact Git evidence."
    )
    parser.add_argument(
        "--repo", required=True, help="Upstream dependency Git worktree"
    )
    parser.add_argument(
        "--from", dest="from_ref", required=True, help="Current dependency ref"
    )
    parser.add_argument(
        "--to", dest="to_ref", required=True, help="Candidate dependency ref"
    )
    parser.add_argument(
        "--required-fix",
        dest="required_fixes",
        action="append",
        default=[],
        metavar="REF",
        help="Required upstream fix ref that must be an ancestor of the audit target; repeatable",
    )
    parser.add_argument(
        "--include-prereleases",
        action="store_true",
        help="Include prerelease semantic-version tags between the endpoints",
    )
    parser.add_argument(
        "--github-repository",
        help=(
            "Optional OWNER/REPO queried read-only with gh; binds remote tags, canonical "
            "repository identity, and visible release state"
        ),
    )
    parser.add_argument(
        "--github-host",
        default="github.com",
        help="GitHub API hostname to bind and pass explicitly to gh (default: github.com)",
    )
    parser.add_argument(
        "--github-timeout-seconds",
        type=int,
        default=GITHUB_API_TIMEOUT_SECONDS,
        help=f"Timeout for each GitHub API query (default: {GITHUB_API_TIMEOUT_SECONDS})",
    )
    parser.add_argument(
        "--output", default="-", help="Output JSON path, or - for stdout"
    )
    args = parser.parse_args(argv)
    if args.github_repository and not re.fullmatch(
        r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.github_repository
    ):
        parser.error("--github-repository must use OWNER/REPO form")
    if (
        not re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?", args.github_host)
        or ".." in args.github_host
    ):
        parser.error("--github-host must be a hostname without scheme, path, or port")
    if not 1 <= args.github_timeout_seconds <= 300:
        parser.error("--github-timeout-seconds must be between 1 and 300")
    if not args.github_repository and args.github_host != "github.com":
        parser.error("--github-host requires --github-repository")
    return args


def main(argv: list[str]) -> int:
    """Write the ledger atomically and return a process exit status."""

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
                raise LedgerError(
                    f"refusing to overwrite output path: {output}"
                ) from error
        return 0
    except (LedgerError, OSError) as error:
        print(f"collect-release-ledger: error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
