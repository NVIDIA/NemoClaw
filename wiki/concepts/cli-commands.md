---
title: CLI Commands
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-reference-commands]
tags: [cli, commands, reference]
---

# CLI Commands

## Host Commands (`nemoclaw`)

| Command | Description |
|---|---|
| `nemoclaw onboard` | Interactive setup wizard: gateway, providers, sandbox |
| `nemoclaw list` | List all registered sandboxes |
| `nemoclaw <name> connect` | Open interactive shell inside sandbox |
| `nemoclaw <name> status` | Show sandbox state, health, active inference |
| `nemoclaw <name> logs [--follow]` | Stream sandbox logs |
| `nemoclaw <name> dashboard` | Print dashboard URL(s) |
| `nemoclaw <name> backup [--label <name>]` | Full sandbox backup with metadata |
| `nemoclaw <name> restore [<backup-id>]` | Restore from backup |
| `nemoclaw <name> repair-main` | Repair main agent routing/state |
| `nemoclaw <name> destroy` | Stop and delete sandbox (permanent!) |
| `nemoclaw <name> policy-add` | Add policy preset |
| `nemoclaw <name> policy-list` | List presets and applied policies |
| `nemoclaw deploy <instance-name>` | Deploy to remote GPU via Brev |
| `nemoclaw start` | Start auxiliary services (bridges, tunnel) |
| `nemoclaw stop` | Stop auxiliary services |
| `nemoclaw <name> discord-probe` | Diagnose Discord connectivity |
| `nemoclaw uninstall` | Full removal |

## OpenShell Commands (Host)

| Command | Purpose |
|---|---|
| `openshell term` | TUI for monitoring and egress approvals |
| `openshell sandbox list` | List all sandboxes |
| `openshell sandbox connect <name>` | Shell into sandbox |
| `openshell sandbox download <name> <path>` | Download files |
| `openshell sandbox upload <name> <src> <dest>` | Upload files |
| `openshell sandbox exec <name> <cmd>` | Execute command |
| `openshell inference set --provider <id> --model <name>` | Switch inference |
| `openshell inference get` | Check active provider/model |
| `openshell policy set <file>` | Apply policy dynamically |
| `openshell gateway start --name nemoclaw` | Start gateway |

## In-Sandbox Commands

| Command | Purpose |
|---|---|
| `/nemoclaw status` | In-chat status check |
| `openclaw tui` | Interactive chat TUI |
| `openclaw agent --agent main --local -m <msg>` | Send message to agent |
| `openclaw agents add <id>` | Create [sub-agent](sub-agents.md) |

## See Also

- [Installation](installation.md) — Install and onboard flow
- [Inference Routing](inference-routing.md) — Provider switching
- [Network Policy](network-policy.md) — Policy management commands
