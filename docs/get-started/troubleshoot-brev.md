---
title:
  page: "Troubleshoot NemoClaw on Brev"
  nav: "Troubleshoot Brev"
description:
  main: "Solutions for common issues when running NemoClaw on a Brev deployment, including blocked skills, read-only configuration, and dashboard connectivity."
  agent: "Helps users diagnose and fix common NemoClaw issues on Brev deployments. Use when a user reports blocked skills, permission errors, read-only config, dashboard unreachable, or skill installation failures on Brev."
keywords: ["nemoclaw brev troubleshoot", "openclaw skills blocked", "openclaw.json read-only", "nemoclaw dashboard unreachable", "brev deployment issues"]
topics: ["generative_ai", "ai_agents"]
tags: ["brev", "troubleshooting", "openclaw", "skills", "nemoclaw"]
content:
  type: reference
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Troubleshoot NemoClaw on Brev

This page covers common issues when running NemoClaw on a Brev deployment and how to resolve them.

For general NemoClaw troubleshooting, see [Troubleshooting](../reference/troubleshooting.md).
For Brev setup instructions, see [Get Started with NemoClaw on Brev (Web UI)](brev-web-ui-quickstart.md).

## Most Skills Are Blocked

**Symptom.**
The Skills page in the OpenClaw gateway dashboard shows 48 or more skills with a `blocked` status.
Only three skills show as ready: `healthcheck`, `skill-creator`, and `weather`.

**Cause.**
The Brev deployment runs NemoClaw on a Linux (GCP) instance.
Many bundled OpenClaw skills require binaries or operating system features that are not present in the default Brev environment.
Skills that require macOS-only binaries (such as `memo`, `remindctl`, or `grizzly`) are blocked because the sandbox runs Linux.
Skills that require additional CLIs (such as `gh` for the GitHub skill) are blocked because those binaries are not pre-installed.
Skills that require API credentials (such as a Notion API key or Discord bot token) are blocked until those credentials are configured.

**What works by default.**
The following skills are available immediately after deploying NemoClaw on Brev:

| Skill | What it does |
|---|---|
| `healthcheck` | Security audits, firewall hardening, and risk posture checks |
| `skill-creator` | Create, edit, and audit custom agent skills |
| `weather` | Current weather and forecasts via wttr.in or Open-Meteo |

**What you can enable.**
Skills that require Linux-compatible CLIs can be unblocked by installing the required binary.
The following table lists the most useful skills and their requirements:

| Skill | Requirement | How to install |
|---|---|---|
| `github` | `gh` CLI | See [Install GitHub CLI](#install-github-cli) |
| `discord` | Discord bot token | Add token to OpenClaw config |
| `notion` | `NOTION_API_KEY` environment variable | Set the variable in your shell |
| `brave-search` | Brave Search API key | Configure during `nemoclaw onboard` |

Skills that require macOS-only binaries (`apple-notes`, `apple-reminders`, `bear-notes`, and similar) cannot be enabled on Brev because the sandbox runs Linux.

### Install GitHub CLI

To enable the `github` skill, install the `gh` CLI on the Brev host (not inside the sandbox):

```console
$ sudo apt-get update
$ sudo apt-get install -y gh
$ gh auth login
```

After authenticating, restart the NemoClaw sandbox for the skill to become available.

## Cannot Modify openclaw.json

**Symptom.**
Running `openclaw config set` or asking the agent to update its configuration returns a permission error:

```text
EACCES: permission denied, open '/sandbox/.openclaw/openclaw.json'
```

**Cause.**
The `openclaw.json` file is owned by root and mounted read-only inside the sandbox.
This is intentional -- NemoClaw's security model prevents the agent from modifying its own configuration to protect against prompt injection attacks that could alter security settings.

**Workaround.**
To modify `openclaw.json`, edit it from the Brev host machine (outside the sandbox):

1. Connect to your Brev instance using SSH or the Brev CLI.

```console
$ brev shell <instance-name>
```

2. Copy the config file to a writable location.

```console
$ sudo cp /sandbox/.openclaw/openclaw.json ~/openclaw-backup.json
$ sudo cp /sandbox/.openclaw/openclaw.json ~/openclaw.json
$ sudo chown $USER ~/openclaw.json
```

3. Edit the file with your changes.

```console
$ nano ~/openclaw.json
```

4. Copy the modified file back and restore permissions.

```console
$ sudo cp ~/openclaw.json /sandbox/.openclaw/openclaw.json
$ sudo chown root:root /sandbox/.openclaw/openclaw.json
$ sudo chmod 444 /sandbox/.openclaw/openclaw.json
```

5. Restart the NemoClaw sandbox to apply the changes.

```console
$ nemoclaw <name> stop
$ nemoclaw <name> start
```

:::{warning}
Modifying `openclaw.json` directly bypasses NemoClaw's guided configuration.
Review your changes carefully before restarting the sandbox.
Back up the original file before making any edits.
:::

## OpenClaw Dashboard Is Unreachable

**Symptom.**
After leaving NemoClaw running for an extended period (such as overnight), the OpenClaw dashboard returns `ERR_CONNECTION_RESET` or does not load in the browser.
The agent may still respond on messaging channels such as Telegram or Slack.

**Cause.**
The OpenShell network proxy that handles the dashboard connection can lose connectivity after extended uptime.
This is a known issue with the Brev deployment.

**Fix.**
Re-run the NemoClaw onboard command to restore dashboard connectivity:

```console
$ nemoclaw <name> onboard
```

This restores the gateway connection without deleting your sandbox or losing workspace files.

:::{note}
Your workspace files (`SOUL.md`, `USER.md`, `MEMORY.md`) are preserved during onboard.
See [Backup and Restore](../workspace/backup-restore.md) for instructions on backing up workspace files before running onboard.
:::

## Skill Install Buttons Do Not Work

**Symptom.**
Clicking **Install** on a skill in the OpenClaw dashboard shows no response or returns an error.

**Cause.**
The sandbox filesystem is read-only for most paths.
The `npm install -g` and `apt install` commands that skill installation depends on cannot write to their target directories inside the sandbox.

**Workaround.**
Install skill dependencies from the Brev host machine before launching the sandbox.
Connect to your Brev instance via SSH and install the required binary listed in the skill's **Missing** field on the Skills page.

For example, to install the `gh` CLI required by the `github` skill:

```console
$ sudo apt-get update && sudo apt-get install -y gh
```

After installing the dependency, restart the sandbox:

```console
$ nemoclaw <name> stop
$ nemoclaw <name> start
```

Return to the Skills page to confirm the skill status has changed from `blocked` to `ready`.

## Next Steps

- [Get Started with NemoClaw on Brev (Web UI)](brev-web-ui-quickstart.md)
- [Security Best Practices](../security/best-practices.md)
- [Troubleshooting](../reference/troubleshooting.md)
- [Workspace Files](../workspace/workspace-files.md)
