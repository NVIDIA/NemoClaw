<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# NVIDIA DORI Setup

Use this guide only when the user explicitly asks to install or configure NVIDIA DORI.
Before inspecting or installing private components, ask the user to confirm that they can access `gitlab-master.nvidia.com`.
If the user does not confirm access, stop this setup and use the checked-in [documentation style contract](STYLE.md).
Access confirmation does not approve installation or host configuration.

Use these internal sources for the current installation and registration instructions:

- [NVIDIA Skill Library](https://gitlab-master.nvidia.com/tech-docs/skill-library) contains documentation-focused Agent Skills and guidance for installing them with DORI and other supported hosts.
- [NVIDIA Template Library](https://gitlab-master.nvidia.com/tech-docs/template-library) contains reusable documentation templates and guidance for installing its template skills with DORI.

## Inspect the Environment

1. Check for a complete DORI MCP setup tool set.
   - The tool set is complete only when the current agent exposes `dori_handle` or `dori_route`,
     plus `dori_collections` and `dori_refresh`.
   - If a routing tool is available but either collection tool is unavailable, report the partial
     tool set. Do not invoke an unavailable tool, use the CLI, or reconfigure the host. Follow
     [Handle Failed or Partial Setup](#handle-failed-or-partial-setup).
   - With the complete tool set, do not reconfigure the host. Verify the collection against the
     [canonical Skill Library source](AGENTS.md#verify-the-skill-library-source).
   - If the Skill Library is missing, identify it as the only missing component and continue to [Confirm Changes](#confirm-changes).
2. When no DORI routing tool is available, inspect the command-line interface (CLI).
   - Run `command -v dori`.
   - If the CLI exists, run `dori collections list --json`.
   - Treat the Skill Library as installed only when it matches the
     [canonical source identity](AGENTS.md#verify-the-skill-library-source).
3. Identify the host from explicit runtime context.
   Do not infer the host from the model name or repository files.
4. Run `dori setup auto --dry-run` as a cross-check when the CLI exists.
   - If auto-detection conflicts with the explicit host, use the explicit host.
   - If no explicit host exists and auto-detection is uncertain, ask which host is running.

Use the following host commands:

| Explicit Host | Setup Command |
|---|---|
| Codex CLI or Desktop | `dori setup codex` |
| Cursor | `dori setup cursor --scope user` |
| Claude Code | `dori setup claude-code --scope user` |
| Claude Desktop | `dori setup claude` |
| VS Code with GitHub Copilot | `dori setup vscode --scope user` |
| Kiro | `dori setup kiro` |
| Google Antigravity | `dori setup antigravity` |

Keep the listed `--scope user` option.
Project or combined scope requires separate repository-owner authorization because it can create a repository MCP configuration file.

## Confirm Changes

Report each missing component.
Before an installation or host configuration change, ask:

> DORI setup is incomplete: `<missing-components>`.
> Do you want me to install or configure these components in your user environment?

Continue only after explicit approval.
The user's private-source access confirmation does not approve these changes.
If the user declines, use the [documentation style contract](STYLE.md).

## Install Missing Components

When no DORI routing tool is available and `dori` is missing, require an existing `uv` command.

- If `uv` is missing, stop and direct the user to the [internal DORI installation guide](https://gitlab-master.nvidia.com/tech-docs/dori/-/blob/main/docs/get-started/install.md).
  Do not download or execute an installer script.
- If `uv` exists, run:

  ```bash
  uv tool install --python 3.14+freethreaded 'dori==0.9.0' \
    --index-url https://gitlab-master.nvidia.com/api/v4/projects/226768/packages/pypi/simple
  ```

When no DORI routing tool is available and the Skill Library is missing, run:

```bash
DORI_GITLAB_HOST=gitlab-master.nvidia.com \
  dori install gitlab:tech-docs/skill-library --all --yes
```

When the complete DORI MCP setup tool set is available but the Skill Library is missing:

1. Run `dori_collections(action="install", source="https://gitlab-master.nvidia.com/tech-docs/skill-library")`.
2. Run `dori_refresh`.
3. Verify the source with `dori_collections(action="list")`.

Do not depend on a shell-visible CLI or reconfigure the host on the DORI MCP path.

## Configure and Validate the Host

Complete this section only when no DORI routing tool is available.
After the CLI becomes available, run `dori setup auto --dry-run` if it did not run during inspection.
If auto-detection conflicts with the explicit host, use the explicit host.
If no explicit host exists and auto-detection is uncertain, ask which host is running.
After approval, run the setup command for the resolved host.
Then perform the following checks:

1. Run the selected command with `--validate`.
2. Run `dori doctor health --json`.
3. Require a passing host validation and `"ok": true` health.

Follow the activation action that DORI reports.
The action can require an application restart, a new session, a window reload, or enabling the MCP server.

Until the current agent exposes the complete DORI MCP setup tool set, continue the original task with the [documentation style contract](STYLE.md).

## Handle Failed or Partial Setup

If the DORI MCP setup tool set is partial, or if the DORI installation, Skill Library installation
or verification, host setup or validation, or health check fails:

1. Report the unavailable tools or the failed operation and its error without exposing credentials.
2. Stop setup. Make no additional DORI or host-configuration changes, and do not retry in the same
   task.
3. Direct the user to the
   [internal DORI installation guide](https://gitlab-master.nvidia.com/tech-docs/dori/-/blob/main/docs/get-started/install.md)
   or the appropriate DORI owner for recovery.
4. Continue the original documentation task with the [documentation style contract](STYLE.md).

## Protect Credentials and Repository State

- Never search for, request, print, copy, export, or embed a token, password, cookie, SSH key, or credential-bearing URL.
- Let `uv`, Git, and DORI use credentials that the user already configured.
  If access is denied or authentication is missing, stop and refer to the internal DORI installation guide.
- Do not create repository-scoped identity or authorization files.
  Confirm private-source access only for an explicit setup request.
- Do not bypass approval controls for writes outside the repository.
- Do not create or commit project-scoped DORI state or MCP configuration without separate repository-owner authorization.
