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

Distinguish a client capability limit from a repository access denial.
A missing tool operation or an explicit integration-scope limitation does not establish the user's repository permissions.
For that case, a read-only check through another already configured, authenticated client may establish access to the same repository.
Verify the actor and required permission before resuming an authorized operation through that client.
After an inconclusive write, reconcile external state before any retry under the owning publication procedure.

Stop the affected operation on an authentication failure, repository permission denial, SSO requirement, or rejected SSH authentication.
Ask the user to correct that access problem. If the error does not distinguish client scope from repository denial, stop and report the ambiguity.
Do not try other identities or endpoints to overcome a repository denial.
Continue independent authorized work that does not require the failed access.

Git transport and GitHub API access are separate capabilities. A working API client does not establish SSH push permission.
Use SSH for Git operations on `github.com`. Do not request API login to repair an SSH Git operation.

Do not try to bypass an access error. Do not:

- edit credentials, tokens, or SSH config
- generate new tokens or SSH keys
- rewrite remotes to bypass permissions
- force-push or bypass branch protections or required checks.

Before reporting a command, error, or tool output, redact credentials, tokens, authentication
headers, credential-bearing URLs, credential paths, and other sensitive output.
For a blocking access failure, report the redacted failure and required user action. Wait before repeating the affected operation.

This rule applies only to access errors.
Handle merge conflicts, stale branches, dirty worktrees, and rebase conflicts in the related workflow.
Ask the user when a resolution can change behavior, contributor intent, or a design decision.
