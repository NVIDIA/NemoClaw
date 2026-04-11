---
title: Dashboard
category: entity
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-monitoring]
tags: [ui, monitoring, dashboard]
---

# Dashboard

Web-based UI for interacting with the sandboxed [OpenClaw](openclaw.md) agent.
Accessible at `http://127.0.0.1:18789/` by default.

## Access

```bash
nemoclaw <name> dashboard    # Print dashboard URL(s)
```

## WSL2 Notes

On WSL2, NemoClaw prints a `VS Code/WSL` dashboard URL using the WSL host IP
and a one-time OpenClaw gateway token. Use that URL exactly as printed —
replacing it with `localhost` can fail. If the dashboard shows
`origin not allowed`, use the printed direct WSL host IP URL.

## See Also

- [CLI Commands](../concepts/cli-commands.md) — `dashboard` command
- [Sandbox](sandbox.md) — Container serving the dashboard
