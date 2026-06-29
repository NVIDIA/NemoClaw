<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Git and GitHub Access Hard Stop

Use this guardrail from any workflow that runs `git`, `ssh`, or `gh` commands.

If a Git/GitHub command fails because of authentication, authorization, missing credentials, SSO, token scope, SSH key setup, remote access, or push permissions, stop and ask the user to resolve access.

Do **not** work around access failures by:

- switching remote protocols or remotes;
- editing credentials, tokens, or SSH config;
- generating new tokens or SSH keys;
- rewriting remotes to bypass permissions;
- force-pushing or bypassing branch protections/required checks.

Report the exact command, the relevant error output, and the next action needed from the user, then wait.

This hard stop is for access/authentication/authorization problems only. Normal Git workflow problems such as merge conflicts, stale branches, dirty worktrees, or mechanical rebase conflicts should be handled by the relevant workflow. Stop for user guidance only when conflict resolution would change behavior, alter contributor intent, or require a design decision.
