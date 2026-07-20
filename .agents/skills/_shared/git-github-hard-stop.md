<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stop for Git and GitHub Access Errors

Use this rule in each workflow that runs `git`, `ssh`, or `gh` commands.

Stop if a Git or GitHub command has an access error. Access errors include authentication, authorization, credentials, SSO, token scope, SSH keys, remote access, and push permissions.
Ask the user to correct the access problem.

Do not try to bypass an access error. Do not:

- switch remote protocols or remotes
- edit credentials, tokens, or SSH config
- generate new tokens or SSH keys
- rewrite remotes to bypass permissions
- force-push or bypass branch protections or required checks.

Report the command and the error. Tell the user which action is necessary. Then, wait.

This rule applies only to access errors.
Handle merge conflicts, stale branches, dirty worktrees, and rebase conflicts in the related workflow.
Ask the user when a resolution can change behavior, contributor intent, or a design decision.
