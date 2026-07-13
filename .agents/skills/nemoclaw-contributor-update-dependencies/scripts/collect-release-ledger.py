#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""Collect deterministic adjacent-release Git evidence for a dependency upgrade."""

from __future__ import annotations

import argparse
import json
import os
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
GIT_COMMAND_TIMEOUT_SECONDS = 120
MAX_TAG_PEEL_DEPTH = 32


class LedgerError(RuntimeError):
    """Raised when the requested release range cannot be proven."""


@dataclass(frozen=True)
class GitCommandResult:
    """Captured output from one bounded, hermetic Git command."""

    returncode: int
    stdout: str
    stderr: str


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


def trusted_git_environment() -> dict[str, str]:
    """Return an environment that cannot redirect or extend the selected repository."""

    environment = {
        key: value for key, value in os.environ.items() if not key.startswith("GIT_")
    }
    environment.update(
        {
            "GIT_ATTR_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_NO_LAZY_FETCH": "1",
            "GIT_NO_REPLACE_OBJECTS": "1",
            "GIT_PAGER": "cat",
            "GIT_TERMINAL_PROMPT": "0",
            "LC_ALL": "C",
        }
    )
    return environment


def run_git(
    repo: Path | None,
    *args: str,
    allow_failure: bool = False,
    input_text: str | None = None,
) -> GitCommandResult:
    """Run one bounded Git command without ambient repository or helper controls."""

    command = [
        "git",
        "--no-pager",
        "-c",
        "log.showSignature=false",
        "-c",
        "core.commitGraph=false",
        "-c",
        "core.fsmonitor=false",
    ]
    if repo is not None:
        command.extend(("-C", str(repo)))
    command.extend(args)
    try:
        result = subprocess.run(
            command,
            check=False,
            capture_output=True,
            input=input_text,
            text=True,
            env=trusted_git_environment(),
            timeout=GIT_COMMAND_TIMEOUT_SECONDS,
        )
    except subprocess.TimeoutExpired as error:
        raise LedgerError(
            f"git {' '.join(args)} timed out after {GIT_COMMAND_TIMEOUT_SECONDS} seconds"
        ) from error
    except OSError as error:
        raise LedgerError(f"could not execute git {' '.join(args)}: {error}") from error
    captured = GitCommandResult(
        returncode=result.returncode,
        stdout=result.stdout.rstrip("\n"),
        stderr=result.stderr.rstrip("\n"),
    )
    if captured.returncode != 0 and not allow_failure:
        detail = (
            captured.stderr.strip() or captured.stdout.strip() or "unknown Git failure"
        )
        raise LedgerError(f"git {' '.join(args)} failed: {detail}")
    return captured


def git(repo: Path, *args: str, allow_failure: bool = False) -> str:
    """Run bounded, hermetic Git in ``repo`` and return stdout."""

    return run_git(repo, *args, allow_failure=allow_failure).stdout


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

    result = run_git(
        repo,
        "merge-base",
        "--is-ancestor",
        older,
        newer,
        allow_failure=True,
    )
    if result.returncode not in (0, 1):
        detail = (
            result.stderr.strip()
            or result.stdout.strip()
            or "unknown merge-base failure"
        )
        raise LedgerError(f"could not compare {older} and {newer}: {detail}")
    return result.returncode == 0


def absolute_git_path(repo: Path, relative_path: str) -> Path:
    """Resolve one repository-owned Git path without ambient path overrides."""

    configured = Path(git(repo, "rev-parse", "--git-path", relative_path))
    return (
        configured.resolve()
        if configured.is_absolute()
        else (repo / configured).resolve()
    )


def require_safe_repository_configuration(repo: Path) -> None:
    """Reject repository configuration that can weaken or extend evidence collection."""

    unsafe = run_git(
        repo,
        "config",
        "--show-scope",
        "--show-origin",
        "--name-only",
        "--get-regexp",
        r"^(include(if)?\.|fsck\.)",
        allow_failure=True,
    )
    if unsafe.returncode not in (0, 1):
        detail = unsafe.stderr.strip() or "unknown Git config failure"
        raise LedgerError(
            f"could not inspect repository safety configuration: {detail}"
        )
    if unsafe.returncode == 0:
        entries = ", ".join(line for line in unsafe.stdout.splitlines() if line)
        raise LedgerError(
            "the upstream worktree has repository configuration that can extend config "
            f"or weaken fsck ({entries}); use a clean clone without include.* or fsck.* settings"
        )


def require_complete_local_history(repo: Path) -> None:
    """Reject shallow or promisor history before resolving release evidence."""

    partial_clone = run_git(
        repo,
        "config",
        "--get-all",
        "extensions.partialClone",
        allow_failure=True,
    )
    if partial_clone.returncode not in (0, 1):
        detail = partial_clone.stderr.strip() or "unknown Git config failure"
        raise LedgerError(f"could not inspect extensions.partialClone: {detail}")
    if partial_clone.returncode == 0:
        values = partial_clone.stdout.splitlines() or [""]
        rendered = ", ".join(repr(value) for value in values)
        raise LedgerError(
            "the upstream worktree configures extensions.partialClone "
            f"({rendered}); use a non-promisor clone with a complete object closure"
        )

    partial_filter_keys = run_git(
        repo,
        "config",
        "--name-only",
        "--get-regexp",
        r"^remote\..*\.partialclonefilter$",
        allow_failure=True,
    )
    if partial_filter_keys.returncode not in (0, 1):
        detail = partial_filter_keys.stderr.strip() or "unknown Git config failure"
        raise LedgerError(f"could not inspect remote partial-clone filters: {detail}")
    if partial_filter_keys.returncode == 0:
        keys = ", ".join(sorted(set(partial_filter_keys.stdout.splitlines())))
        raise LedgerError(
            "the upstream worktree configures remote partial-clone filters "
            f"({keys}); use a non-promisor clone with a complete object closure"
        )

    promisor_keys = run_git(
        repo,
        "config",
        "--name-only",
        "--get-regexp",
        r"^remote\..*\.promisor$",
        allow_failure=True,
    )
    if promisor_keys.returncode not in (0, 1):
        detail = promisor_keys.stderr.strip() or "unknown Git config failure"
        raise LedgerError(f"could not inspect remote promisor settings: {detail}")
    for key in sorted(set(promisor_keys.stdout.splitlines())):
        configured = run_git(repo, "config", "--get-all", key, allow_failure=True)
        if configured.returncode != 0:
            detail = (
                configured.stderr.strip() or "setting disappeared during collection"
            )
            raise LedgerError(f"could not inspect {key}: {detail}")
        values = configured.stdout.splitlines() or [""]
        for value in values:
            normalized = value.strip().casefold()
            if normalized in {"0", "false", "no", "off"}:
                continue
            state = (
                "enabled" if normalized in {"", "1", "true", "yes", "on"} else "invalid"
            )
            raise LedgerError(
                f"the upstream worktree has {state} promisor setting {key}={value!r}; "
                "use a non-promisor clone with a complete object closure"
            )

    shallow = git(repo, "rev-parse", "--is-shallow-repository")
    if shallow != "false":
        if shallow == "true":
            raise LedgerError(
                "the upstream worktree is shallow; fetch complete history before collection"
            )
        raise LedgerError(
            f"could not determine whether the upstream worktree is shallow: {shallow!r}"
        )

    for relative_path, description in (
        ("objects/info/alternates", "alternate object database"),
        ("objects/info/http-alternates", "HTTP alternate object database"),
    ):
        configured_path = absolute_git_path(repo, relative_path)
        if configured_path.exists():
            raise LedgerError(
                f"the upstream worktree contains an {description} at {configured_path}; "
                "use a self-contained clone"
            )

    object_directory = absolute_git_path(repo, "objects")
    promisor_packs = sorted((object_directory / "pack").glob("*.promisor"))
    if promisor_packs:
        raise LedgerError(
            "the upstream worktree contains residual promisor pack markers: "
            + ", ".join(str(path) for path in promisor_packs)
        )


def require_unmodified_local_history(repo: Path) -> None:
    """Reject local mechanisms that can rewrite commit ancestry."""

    replace_refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/replace")
    if replace_refs:
        raise LedgerError(
            "the upstream worktree contains refs/replace history overrides; remove them "
            "before collection"
        )
    graft_path = absolute_git_path(repo, "info/grafts")
    if graft_path.exists():
        raise LedgerError(
            f"the upstream worktree contains a grafts file at {graft_path}; remove it "
            "before collection"
        )


def require_local_commit_object(repo: Path, sha: str, description: str) -> None:
    """Require a commit object without allowing a partial clone to fetch it lazily."""

    result = run_git(
        repo,
        "cat-file",
        "--batch-check=%(objectname) %(objecttype)",
        allow_failure=True,
        input_text=f"{sha}\n",
    )
    if result.returncode != 0:
        detail = (
            result.stderr.strip() or result.stdout.strip() or "unknown cat-file failure"
        )
        raise LedgerError(f"could not inspect {description} commit {sha}: {detail}")
    identity = result.stdout.strip()
    if identity == f"{sha} commit":
        return
    if identity == f"{sha} missing":
        raise LedgerError(
            f"{description} commit {sha} is absent from the local object database; "
            "fetch complete refs and commit history before collection"
        )
    raise LedgerError(
        f"{description} object {sha} is not a local commit object: {identity!r}"
    )


def require_complete_reachable_objects(
    repo: Path, target_sha: str, tag_object_shas: list[str]
) -> None:
    """Prove the target graph and every in-range tag object are present locally."""

    traversal = run_git(
        repo,
        "rev-list",
        "--objects",
        "--missing=print",
        target_sha,
        allow_failure=True,
    )
    if traversal.returncode != 0:
        detail = (
            traversal.stderr.strip()
            or traversal.stdout.strip()
            or "unknown traversal failure"
        )
        raise LedgerError(f"could not prove the reachable object closure: {detail}")
    missing = [line for line in traversal.stdout.splitlines() if line.startswith("?")]
    if missing:
        raise LedgerError(
            "the upstream worktree has missing objects in the target closure: "
            + ", ".join(missing[:10])
        )

    for tag_object_sha in sorted(set(tag_object_shas)):
        inspected = run_git(
            repo,
            "cat-file",
            "--batch-check=%(objectname) %(objecttype)",
            allow_failure=True,
            input_text=f"{tag_object_sha}\n",
        )
        identity = inspected.stdout.strip()
        if inspected.returncode != 0 or identity not in {
            f"{tag_object_sha} commit",
            f"{tag_object_sha} tag",
        }:
            detail = inspected.stderr.strip() or identity or "missing object"
            raise LedgerError(
                f"could not prove in-range tag object {tag_object_sha}: {detail}"
            )

    integrity = run_git(
        repo,
        "-c",
        f"fsck.skipList={os.devnull}",
        "fsck",
        "--full",
        "--strict",
        "--no-dangling",
        "--no-reflogs",
        target_sha,
        *sorted(set(tag_object_shas)),
        allow_failure=True,
    )
    if integrity.returncode != 0:
        detail = (
            integrity.stderr.strip()
            or integrity.stdout.strip()
            or "unknown fsck failure"
        )
        raise LedgerError(
            f"the reachable object closure failed integrity checks: {detail}"
        )


def require_valid_target_ref(ref: str) -> None:
    """Require one complete branch ref suitable for authoritative target binding."""

    if not ref.startswith("refs/heads/"):
        raise LedgerError(
            "--github-target-ref must be a complete refs/heads/... branch ref"
        )
    result = run_git(None, "check-ref-format", ref, allow_failure=True)
    if result.returncode != 0:
        raise LedgerError(f"--github-target-ref is not a valid Git ref: {ref!r}")


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

    raw = git(
        repo,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--name-status",
        "--find-renames",
        older,
        newer,
    )
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
        or parsed.params
        or parsed.query
        or parsed.fragment
    ):
        raise LedgerError(
            f"GitHub {description} returned a URL outside {expected_host!r}"
        )
    decoded_path = unquote(parsed.path)
    if "\\" in decoded_path or any(
        component in {".", ".."} for component in decoded_path.split("/")
    ):
        raise LedgerError(f"GitHub {description} returned a non-canonical URL path")
    if expected_path is not None and decoded_path != expected_path:
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
    if full_name.casefold() != repository.casefold():
        raise LedgerError(
            f"GitHub canonical repository {full_name!r} differs from requested "
            f"{repository!r}; rerun with the canonical --github-repository value"
        )
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
        expected_path=f"/{full_name}/releases/tag/{tag}",
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

    repository = repository_identity["fullName"]
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


def github_tag_identity_from_root(
    repository_identity: dict[str, Any],
    tag: str,
    root_type: Any,
    root_sha: Any,
    timeout_seconds: int,
) -> dict[str, Any]:
    """Peel one inventoried remote tag ref to its exact commit."""

    repository = repository_identity["fullName"]
    api_host = repository_identity["apiHost"]
    if root_type not in ("commit", "tag"):
        raise LedgerError(
            f"GitHub tag ref {tag!r} had unsupported object type {root_type!r}"
        )
    object_type = root_type
    object_sha = require_sha(root_sha, f"tag ref {tag!r}")
    exact_root_sha = object_sha
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
    return {
        "provider": "github",
        "apiHost": api_host,
        "repositoryId": repository_identity["repositoryId"],
        "ref": f"refs/tags/{tag}",
        "rootObjectType": root_type,
        "rootObjectSha": exact_root_sha,
        "tagObjectShas": tag_objects,
        "commitSha": object_sha,
    }


def github_semver_tag_inventory(
    repository_identity: dict[str, Any], timeout_seconds: int
) -> dict[str, dict[str, Any]]:
    """Inventory and peel every remote semantic-version tag ref."""

    repository = repository_identity["fullName"]
    api_host = repository_identity["apiHost"]
    description = f"paginated tag-ref inventory for {repository!r}"
    payload = github_api_json(
        api_host,
        f"repos/{repository}/git/matching-refs/tags/?per_page=100",
        description,
        timeout_seconds,
        paginate=True,
    )
    if not isinstance(payload, list) or any(
        not isinstance(page, list) for page in payload
    ):
        raise LedgerError("GitHub paginated tag-ref inventory had the wrong shape")
    inventory: dict[str, dict[str, Any]] = {}
    for page in payload:
        for raw_ref in page:
            ref = require_object(raw_ref, "tag-ref inventory entry")
            full_ref = require_nonempty_string(ref.get("ref"), "tag-ref inventory ref")
            if not full_ref.startswith("refs/tags/"):
                raise LedgerError(
                    f"GitHub tag-ref inventory returned non-tag ref {full_ref!r}"
                )
            tag = full_ref.removeprefix("refs/tags/")
            if Version.parse(tag) is None:
                continue
            if tag in inventory:
                raise LedgerError(
                    f"GitHub tag-ref inventory returned duplicate tag {tag!r}"
                )
            target = require_object(ref.get("object"), f"tag ref {tag!r} object")
            inventory[tag] = github_tag_identity_from_root(
                repository_identity,
                tag,
                target.get("type"),
                target.get("sha"),
                timeout_seconds,
            )
    return inventory


def verify_remote_tag_inventory(
    repo: Path,
    inventory: dict[str, dict[str, Any]],
    start_sha: str,
    target_sha: str,
) -> None:
    """Require every remote SemVer tag in the audit ancestry to exist exactly locally."""

    def require_exact_local_tag(tag: str, remote: dict[str, Any]) -> None:
        local_root_sha = git(
            repo,
            "rev-parse",
            "--verify",
            f"refs/tags/{tag}",
            allow_failure=True,
        )
        if not local_root_sha:
            raise LedgerError(
                f"remote semantic-version tag {tag!r} lies in the audit range but is "
                "missing from the local checkout; fetch all remote tags and rerun"
            )
        local_kind = tag_kind(repo, tag)
        local_root_type = "tag" if local_kind == "annotated" else "commit"
        if (
            remote["rootObjectType"] != local_root_type
            or remote["rootObjectSha"] != local_root_sha
        ):
            raise LedgerError(
                f"remote semantic-version tag {tag!r} root object differs from the local tag"
            )
        local_commit_sha = resolve_commit(repo, f"refs/tags/{tag}")
        if remote["commitSha"] != local_commit_sha:
            raise LedgerError(
                f"remote semantic-version tag {tag!r} peels to {remote['commitSha']}, "
                f"not local {local_commit_sha}"
            )

    for tag, remote in sorted(inventory.items()):
        commit_sha = remote["commitSha"]
        require_local_commit_object(repo, commit_sha, f"remote tag {tag!r}")
        if not is_ancestor(repo, start_sha, commit_sha) or not is_ancestor(
            repo, commit_sha, target_sha
        ):
            continue
        require_exact_local_tag(tag, remote)

    for tag in git(repo, "tag", "--merged", target_sha).splitlines():
        if Version.parse(tag) is None:
            continue
        local_commit_sha = resolve_commit(repo, f"refs/tags/{tag}")
        if not is_ancestor(repo, start_sha, local_commit_sha):
            continue
        remote = inventory.get(tag)
        if remote is None:
            raise LedgerError(
                f"local semantic-version tag {tag!r} lies in the audit range but is absent "
                "from the bound GitHub repository"
            )
        require_exact_local_tag(tag, remote)


def github_target_ref_identity(
    repository_identity: dict[str, Any],
    target_ref: str,
    expected_commit_sha: str,
    timeout_seconds: int,
) -> dict[str, Any]:
    """Bind an untagged target to one exact advertised branch ref."""

    repository = repository_identity["fullName"]
    api_host = repository_identity["apiHost"]
    short_ref = target_ref.removeprefix("refs/")
    description = f"target ref lookup for {target_ref!r}"
    payload = require_object(
        github_api_json(
            api_host,
            f"repos/{repository}/git/ref/{quote(short_ref, safe='/')}",
            description,
            timeout_seconds,
        ),
        description,
    )
    if payload.get("ref") != target_ref:
        raise LedgerError(
            f"GitHub target ref lookup returned the wrong ref for {target_ref!r}"
        )
    target = require_object(payload.get("object"), f"target ref {target_ref!r} object")
    if target.get("type") != "commit":
        raise LedgerError(
            f"GitHub target ref {target_ref!r} had unsupported object type "
            f"{target.get('type')!r}"
        )
    remote_sha = require_sha(target.get("sha"), f"target ref {target_ref!r}")
    if remote_sha != expected_commit_sha:
        raise LedgerError(
            f"GitHub target ref {target_ref!r} resolves to {remote_sha}, not audit target "
            f"{expected_commit_sha}"
        )
    return {
        "provider": "github",
        "apiHost": api_host,
        "repositoryId": repository_identity["repositoryId"],
        "ref": target_ref,
        "commitSha": remote_sha,
    }


def collect(args: argparse.Namespace) -> dict[str, Any]:
    """Collect adjacent release endpoints and range evidence for ``args``."""

    repo = Path(args.repo).expanduser().resolve()
    if git(repo, "rev-parse", "--is-inside-work-tree") != "true":
        raise LedgerError(f"not a Git worktree: {repo}")
    repo = Path(git(repo, "rev-parse", "--show-toplevel")).resolve()
    require_safe_repository_configuration(repo)
    require_unmodified_local_history(repo)
    require_complete_local_history(repo)

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
    in_range_tag_object_shas: list[str] = []
    explicit_target_tag = explicitly_referenced_tag(repo, args.to_ref, target_sha)
    for tag in git(repo, "tag", "--merged", target_sha).splitlines():
        version = Version.parse(tag)
        if version is None:
            continue
        tag_sha = resolve_commit(repo, f"refs/tags/{tag}")
        if not is_ancestor(repo, start_sha, tag_sha):
            continue
        in_range_tag_object_shas.append(git(repo, "rev-parse", f"refs/tags/{tag}"))
        if tag_sha == start_sha:
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

    require_complete_reachable_objects(repo, target_sha, in_range_tag_object_shas)

    if explicit_target_tag is None and args.github_repository:
        if not args.github_target_ref:
            raise LedgerError(
                "an untagged GitHub audit target requires --github-target-ref "
                "refs/heads/<branch>"
            )
        require_valid_target_ref(args.github_target_ref)
    elif explicit_target_tag is not None and args.github_target_ref:
        raise LedgerError(
            "--github-target-ref is only valid when --to is an untagged commit or branch"
        )

    publication_source = None
    remote_tag_inventory = None
    target_remote_ref = None
    if args.github_repository:
        publication_source = github_repository_identity(
            args.github_repository,
            args.github_host,
            args.github_timeout_seconds,
        )
        if explicit_target_tag is None:
            assert args.github_target_ref is not None
            target_remote_ref = github_target_ref_identity(
                publication_source,
                args.github_target_ref,
                target_sha,
                args.github_timeout_seconds,
            )
        remote_tag_inventory = github_semver_tag_inventory(
            publication_source, args.github_timeout_seconds
        )
        verify_remote_tag_inventory(repo, remote_tag_inventory, start_sha, target_sha)
        releases = github_release_publications(
            publication_source, args.github_timeout_seconds
        )
        for endpoint in endpoints:
            tag = endpoint["tag"]
            if isinstance(tag, str):
                remote_tag = remote_tag_inventory.get(tag)
                if remote_tag is None:
                    raise LedgerError(
                        f"local release endpoint tag {tag!r} is absent from the bound "
                        "GitHub repository"
                    )
                expected_root_type = (
                    "tag" if endpoint["tagKind"] == "annotated" else "commit"
                )
                if (
                    remote_tag["rootObjectType"] != expected_root_type
                    or remote_tag["rootObjectSha"] != endpoint["tagObjectSha"]
                    or remote_tag["commitSha"] != endpoint["sha"]
                ):
                    raise LedgerError(
                        f"GitHub release endpoint tag {tag!r} differs from the local tag "
                        "object or peeled commit"
                    )
                endpoint["remoteTag"] = remote_tag
                endpoint["publication"] = publication_for_tag(
                    tag, releases, publication_source
                )
            else:
                assert target_remote_ref is not None
                endpoint["remoteRef"] = target_remote_ref
                endpoint["publication"] = {
                    "provider": "github",
                    "state": "unreleased-commit",
                    "tag": None,
                }

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
                    "--no-ext-diff",
                    "--no-textconv",
                    "--shortstat",
                    older["sha"],
                    newer["sha"],
                ),
            }
        )

    remote_verified_at = None
    if publication_source is not None:
        assert remote_tag_inventory is not None
        rechecked_inventory = github_semver_tag_inventory(
            publication_source, args.github_timeout_seconds
        )
        if rechecked_inventory != remote_tag_inventory:
            raise LedgerError(
                "GitHub semantic-version tag refs changed during collection; rerun "
                "against one stable remote snapshot"
            )
        rechecked_releases = github_release_publications(
            publication_source, args.github_timeout_seconds
        )
        if rechecked_releases != releases:
            raise LedgerError(
                "GitHub release publications changed during collection; rerun against "
                "one stable remote snapshot"
            )
        if target_remote_ref is not None:
            rechecked_target_ref = github_target_ref_identity(
                publication_source,
                target_remote_ref["ref"],
                target_sha,
                args.github_timeout_seconds,
            )
            if rechecked_target_ref != target_remote_ref:
                raise LedgerError(
                    "GitHub target ref identity changed during collection; rerun against "
                    "one stable remote snapshot"
                )
        rechecked_repository = github_repository_identity(
            args.github_repository,
            args.github_host,
            args.github_timeout_seconds,
        )
        stable_repository_fields = (
            "provider",
            "apiHost",
            "repositoryId",
            "nodeId",
            "fullName",
            "visibility",
            "url",
            "viewerCanPush",
        )
        changed_fields = [
            field
            for field in stable_repository_fields
            if rechecked_repository[field] != publication_source[field]
        ]
        if changed_fields:
            raise LedgerError(
                "GitHub repository identity or permissions changed during collection: "
                + ", ".join(changed_fields)
            )
        remote_verified_at = rechecked_repository["collectedAt"]
        publication_source["verifiedAt"] = remote_verified_at

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
    if target_remote_ref is not None:
        target["remoteRef"] = target_remote_ref

    ledger = {
        "schemaVersion": 5,
        "repository": str(repo),
        "start": endpoints[0],
        "requiredFixes": required_fixes,
        "target": target,
        "releaseEndpoints": endpoints,
        "ranges": ranges,
    }
    if publication_source is not None:
        ledger["publicationSource"] = publication_source
    if remote_tag_inventory is not None:
        ledger["remoteTagInventory"] = {
            "provider": "github",
            "apiHost": publication_source["apiHost"],
            "repositoryId": publication_source["repositoryId"],
            "verifiedAt": remote_verified_at,
            "count": len(remote_tag_inventory),
            "tags": [remote_tag_inventory[tag] for tag in sorted(remote_tag_inventory)],
        }
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
        choices=("github.com",),
        help="Trusted GitHub API hostname to bind explicitly to gh (github.com only)",
    )
    parser.add_argument(
        "--github-target-ref",
        help=(
            "Required advertised refs/heads/... ref for an untagged GitHub target; the "
            "remote ref must resolve exactly to --to"
        ),
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
    if not 1 <= args.github_timeout_seconds <= 300:
        parser.error("--github-timeout-seconds must be between 1 and 300")
    if args.github_target_ref and not args.github_repository:
        parser.error("--github-target-ref requires --github-repository")
    if args.github_target_ref and not args.github_target_ref.startswith("refs/heads/"):
        parser.error("--github-target-ref must be a complete refs/heads/... branch ref")
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
