#!/usr/bin/env python3
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
"""Add NemoClaw's exact reviewed-action hook to pinned Hermes v0.19.0."""

from __future__ import annotations

import argparse
import hashlib
from pathlib import Path

HERMES_SEMVER = "0.19.0"
HERMES_APPROVAL_SHA256 = "f35c78aa0b56c82cafe0242bb886c4f9679bf55219776a105131dceba2ce9672"

IMPORT_ANCHOR = "from tools.interrupt import is_interrupted\n"
IMPORT_PATCH = (
    IMPORT_ANCHOR
    + "from tools.nemoclaw_unattended_approval import reviewed_unattended_action_decision\n"
)
CONTEXT_ANCHOR = '''    # Skip isolated container backends for both checks. Docker stops skipping
    # once host paths are bind-mounted into the sandbox.
    if _should_skip_container_guards(env_type, has_host_access=has_host_access):
        return {"approved": True, "message": None}
'''
CONTEXT_PATCH = '''    # NemoClaw recognizes one exact, root-owned read-only action before
    # Hermes' isolated-container fast path so it cannot use a broader backend.
    reviewed_action = reviewed_unattended_action_decision(
        command, _get_session_platform()
    )
    reviewed_context = (
        reviewed_action == "allow"
        and env_type == "local"
        and not has_host_access
        and not env_var_enabled("HERMES_CRON_SESSION")
        and _is_gateway_approval_context()
    )
    if reviewed_action is not None and not reviewed_context:
        return {
            "approved": False,
            "message": (
                "BLOCKED: reviewed unattended action is limited to a non-cron "
                "API gateway request on the local backend without host access."
            ),
        }

    # Skip isolated container backends for both checks. Docker stops skipping
    # once host paths are bind-mounted into the sandbox.
    if _should_skip_container_guards(env_type, has_host_access=has_host_access):
        return {"approved": True, "message": None}
'''
GUARD_ANCHOR = '''    deny_pattern = _match_user_deny_rule(command)
    if deny_pattern is not None:
        logger.warning("User deny rule %r blocked command: %s",
                       deny_pattern, command[:200])
        return _user_deny_block_result(deny_pattern)

    # --yolo or approvals.mode=off: bypass all approval prompts.
'''
GUARD_PATCH = '''    deny_pattern = _match_user_deny_rule(command)
    if deny_pattern is not None:
        logger.warning("User deny rule %r blocked command: %s",
                       deny_pattern, command[:200])
        return _user_deny_block_result(deny_pattern)

    # The backend and gateway checks above already bound this exact action.
    # Hardline, sudo, and user deny guards retain precedence before approval.
    if reviewed_context:
        return {"approved": True, "message": None}

    # --yolo or approvals.mode=off: bypass all approval prompts.
'''


def patch_file(path: Path, hermes_semver: str) -> None:
    if hermes_semver != HERMES_SEMVER:
        raise SystemExit(
            f"ERROR: unattended approval patch supports Hermes {HERMES_SEMVER}, got {hermes_semver}"
        )
    source_bytes = path.read_bytes()
    actual_hash = hashlib.sha256(source_bytes).hexdigest()
    if actual_hash != HERMES_APPROVAL_SHA256:
        raise SystemExit(
            "ERROR: Hermes approval source identity changed; review the unattended action hook "
            "before updating HERMES_APPROVAL_SHA256 "
            f"(expected {HERMES_APPROVAL_SHA256}; got {actual_hash})"
        )
    source = source_bytes.decode("utf-8")
    for label, old, new in (
        ("import", IMPORT_ANCHOR, IMPORT_PATCH),
        ("context", CONTEXT_ANCHOR, CONTEXT_PATCH),
        ("guard", GUARD_ANCHOR, GUARD_PATCH),
    ):
        if source.count(old) != 1 or source.count(new) != 0:
            raise SystemExit(f"ERROR: Hermes approval {label} source shape changed")
        source = source.replace(old, new)
    path.write_text(source, encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("path")
    parser.add_argument("--hermes-semver", required=True)
    args = parser.parse_args()
    patch_file(Path(args.path), args.hermes_semver)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
