<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Use Configured GitHub Access and Stop on Access Errors

Use this rule in each workflow that runs `git`, `ssh`, or `gh` commands.

For a GitHub operation, use the GitHub tool that the user configured for the current agent.
A configured tool can be an agent-provided GitHub tool, a configured GitHub MCP tool, or an
installed and authenticated GitHub CLI (`gh`).
Use the method that the owning workflow requires when it names one.

If no configured tool can perform the required GitHub operation, stop and ask the user to configure
GitHub access for the current environment.
Do not install or configure GitHub access by default.
Do not use unauthenticated `curl`, another HTTP client, web search, or a different remote endpoint as
a fallback.
Do not ask the user to put a credential in chat, a prompt, a tracked file, or command arguments.
The presence of a configured GitHub tool does not authorize a GitHub write.

Stop if a Git or GitHub command has an access error. Access errors include authentication, authorization, credentials, SSO, token scope, SSH keys, remote access, and push permissions.
Ask the user to correct the access problem.

Do not try to bypass an access error. Do not:

- switch remote protocols or remotes
- edit credentials, tokens, or SSH config
- generate new tokens or SSH keys
- rewrite remotes to bypass permissions
- force-push or bypass branch protections or required checks.

Before placing a command, error, or tool output in a report or other model-visible context, redact
credentials, tokens, authentication headers, credential-bearing URLs, credential paths, and other
sensitive output. Report only the redacted command and error. Tell the user which action is
necessary. Then, wait.

This rule applies only to access errors.
Handle merge conflicts, stale branches, dirty worktrees, and rebase conflicts in the related workflow.
Ask the user when a resolution can change behavior, contributor intent, or a design decision.
