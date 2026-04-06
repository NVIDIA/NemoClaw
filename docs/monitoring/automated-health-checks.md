---
title:
  page: "Automated Health Checks for NemoClaw Services"
  nav: "Automated Health Checks"
description:
  main: "Run automated health checks across all NemoClaw services and receive alerts when failures are detected."
  agent: "Runs automated health checks across all NemoClaw services and receives alerts when failures are detected. Use when setting up monitoring for always-on assistants."
keywords: ["nemoclaw health check", "nemoclaw monitoring", "service alerting"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "monitoring", "health-check", "nemoclaw"]
content:
  type: how_to
  difficulty: technical_beginner
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Automated Health Checks

The `scripts/health-check.sh` script probes all critical NemoClaw services and reports their status. It can run interactively, on a timer, or in CI, and optionally sends alerts when failures are detected.

## What It Checks

| Check | What it probes | How |
|-------|---------------|-----|
| **docker** | Docker daemon responsiveness | `docker info` |
| **gateway** | OpenShell gateway health | `openshell status` |
| **sandbox** | Sandbox readiness | `openshell sandbox get <name>` |
| **ssh** | SSH tunnel to sandbox | `ssh openshell-<name> 'echo ok'` |
| **inference** | Inference endpoint (LiteLLM, Ollama, vLLM/NIM, NVIDIA cloud) | `curl` health endpoints, `openshell provider list` |
| **dashboard** | Port forward to sandbox dashboard | `curl http://127.0.0.1:<port>/` |
| **bridge** | Telegram bridge process | PID file liveness check |
| **agent** | In-sandbox OpenClaw agent | `openclaw doctor` via SSH |

## Usage

Run all checks and print colored status:

```console
$ ./scripts/health-check.sh
```

Check a specific sandbox:

```console
$ ./scripts/health-check.sh --sandbox my-assistant
```

Skip checks that are not relevant to your setup:

```console
$ ./scripts/health-check.sh --skip bridge,agent
```

### Output Modes

**Pretty (default):** Colored terminal output with pass/fail indicators.

```console
$ ./scripts/health-check.sh

NemoClaw Health Check  (2026-04-06 08:15:00)
Sandbox: my-assistant  Gateway: nemoclaw

  ✓ docker: Docker daemon running
  ✓ gateway: Gateway 'nemoclaw' connected
  ✓ sandbox: Sandbox 'my-assistant' ready
  ✓ ssh: SSH tunnel to sandbox healthy
  ✓ inference: LiteLLM (port 4000)
  ✓ dashboard: Dashboard on port 18789
  ✓ bridge: Telegram bridge running (PID 12345)
  ✓ agent: openclaw doctor: passed (exit 0)

  All 8 checks passed (0 skipped)
```

**JSON:** Machine-readable output for scripting and dashboards.

```console
$ ./scripts/health-check.sh --json
```

**Quiet:** Exit code only (0 = all healthy, 1 = failures).

```console
$ ./scripts/health-check.sh --quiet && echo "healthy" || echo "unhealthy"
```

## Alerting

Send a Telegram message when one or more checks fail:

```console
$ export TELEGRAM_BOT_TOKEN="your-bot-token"
$ export TELEGRAM_CHAT_ID="your-chat-id"
$ ./scripts/health-check.sh --alert telegram
```

When all checks pass, no alert is sent (silent success). This makes the script safe to run frequently on a timer without notification fatigue.

## Running on a Schedule

### macOS (launchd)

Create `~/Library/LaunchAgents/com.nemoclaw.health-check.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.nemoclaw.health-check</string>
    <key>ProgramArguments</key>
    <array>
        <string>/path/to/NemoClaw/scripts/health-check.sh</string>
        <string>--sandbox</string>
        <string>my-assistant</string>
        <string>--alert</string>
        <string>telegram</string>
    </array>
    <key>StartInterval</key>
    <integer>600</integer>
    <key>StandardOutPath</key>
    <string>/tmp/nemoclaw-health-check.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/nemoclaw-health-check.log</string>
</dict>
</plist>
```

Load the agent:

```console
$ launchctl load ~/Library/LaunchAgents/com.nemoclaw.health-check.plist
```

### Linux (cron)

```console
$ crontab -e
# Check every 10 minutes, alert on failure
*/10 * * * * /path/to/NemoClaw/scripts/health-check.sh --sandbox my-assistant --alert telegram --quiet 2>&1 >> /tmp/nemoclaw-health-check.log
```

### Linux (systemd timer)

Create a service and timer unit for more robust scheduling. See the systemd documentation for details.

## HTML Status Page

Generate a self-contained HTML dashboard from the health check results:

```console
$ ./scripts/health-check-html.sh --sandbox my-assistant --open
```

The page auto-refreshes every 60 seconds. Pair with a scheduler to keep it up to date:

```console
$ watch -n 60 ./scripts/health-check-html.sh --sandbox my-assistant
```

The generated file is written to `/tmp/nemoclaw-status.html` by default, or specify `--output /path/to/file`.

## Telegram /status Command

If you are running the Telegram bridge (`scripts/telegram-bridge.js`), send `/status` to the bot to get a health report directly in Telegram. This runs the same checks as the CLI script.

## Configuration

| Flag | Description | Default |
|------|-------------|---------|
| `--sandbox <name>` | Sandbox to check | `$NEMOCLAW_SANDBOX_NAME` or `my-assistant` |
| `--gateway <name>` | Gateway name | `$NEMOCLAW_GATEWAY_NAME` or `nemoclaw` |
| `--port <number>` | Dashboard port | `$DASHBOARD_PORT` or `18789` |
| `--alert <method>` | Alert method (`telegram`) | *(none — print only)* |
| `--skip <checks>` | Comma-separated checks to skip | *(none)* |
| `--json` | JSON output | *(off)* |
| `--quiet` / `-q` | Exit code only | *(off)* |

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | All checks passed |
| `1` | One or more checks failed |
| `2` | Script error (bad arguments, missing dependencies) |

## Related Topics

- [Monitor Sandbox Activity](monitor-sandbox-activity.md) for manual inspection and debugging.
- [Recovery After Reboot](../recovery-after-reboot.md) to restore services after a host restart.
- [Troubleshooting](../reference/troubleshooting.md) for common issues and resolution steps.
