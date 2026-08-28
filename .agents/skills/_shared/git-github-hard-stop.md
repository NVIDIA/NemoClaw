<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Stop for Git and GitHub Access Errors

Use this rule for GitHub operations and workflows that run `git`, `ssh`, or `gh`.

Use an agent-provided GitHub tool, a configured GitHub MCP tool, or authenticated `gh`.
Use the method that the owning workflow requires.

If no configured tool can perform the required GitHub operation, stop and ask the user to configure
GitHub access for the current environment.
Do not install or configure GitHub access.
Do not fall back to unauthenticated HTTP, web search, or a different endpoint.
Do not request a credential in chat, a prompt, a tracked file, or command arguments.
Configured access does not authorize a GitHub write.

Stop if a Git or GitHub command has an access error. Access errors include authentication, authorization, credentials, SSO, token scope, SSH keys, remote access, and push permissions.
Ask the user to correct the access problem.

Do not try to bypass an access error. Do not:

- edit credentials, tokens, or SSH config
- generate new tokens or SSH keys
- rewrite remotes to bypass permissions
- force-push or bypass branch protections or required checks.

Before reporting a command, error, or tool output, redact credentials, tokens, authentication
headers, credential-bearing URLs, credential paths, and other sensitive output.
Report the redacted failure, state the required user action, and wait.

This rule applies only to access errors.
Handle merge conflicts, stale branches, dirty worktrees, and rebase conflicts in the related workflow.
Ask the user when a resolution can change behavior, contributor intent, or a design decision.
