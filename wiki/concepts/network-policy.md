---
title: Network Policy
category: concept
created: 2026-04-11
updated: 2026-04-11
sources: [readme, docs-network-policy]
tags: [security, policy, network, egress]
---

# Network Policy

The sandbox starts with a deny-by-default network policy that controls egress.
Only explicitly listed endpoints are reachable. Defined in declarative YAML
and enforced by [OpenShell](../entities/openshell.md).

## Default Baseline Policy

File: `nemoclaw-blueprint/policies/openclaw-sandbox.yaml`

### Allowed Endpoint Groups

| Group | Hosts | Ports |
|---|---|---|
| `claude_code` | api.anthropic.com, statsig.anthropic.com, sentry.io | 443 |
| `nvidia` | integrate.api.nvidia.com, inference-api.nvidia.com | 443 |
| `github` | github.com, api.github.com | 443 |
| `clawhub` | clawhub.com | 443 |
| `openclaw_api` | openclaw.ai | 443 |
| `openclaw_docs` | docs.openclaw.ai | 443 |
| `npm_registry` | registry.npmjs.org | 443 |
| `telegram` | api.telegram.org | 443 |

## Modification Methods

| Method | How | Persistence |
|---|---|---|
| **Static** | Edit `openclaw-sandbox.yaml`, re-run `nemoclaw onboard` | Persists across restarts |
| **Dynamic** | `openshell policy set <file>` on running sandbox | Session only |

## Operator Approval Flow

1. Agent requests unlisted host
2. OpenShell blocks the request
3. TUI (`openshell term`) surfaces: host, port, binary, HTTP details
4. Operator approves or denies in real-time
5. Approved endpoints persist for current session only

## See Also

- [Policy Presets](policy-presets.md) — Pre-built templates for common integrations
- [Sandbox Hardening](sandbox-hardening.md) — Full security layer stack
- [Sandbox](../entities/sandbox.md) — Container where policy is enforced
