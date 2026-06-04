<!--
SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
SPDX-License-Identifier: Apache-2.0
-->

# blackwall-guard — BLACK_WALL Preflight Guardrail

A pre-action risk gate for OpenClaw agents. It hooks `before_tool_call` and runs a
risk forecast **before any tool executes** — so a sandboxed agent is checked at the
moment of action, not after.

## What it does

- On every tool call, calls BLACK_WALL `forecast()` and receives a verdict: **GO**, **CAUTION**, or **STOP**, plus a risk score and named red-flags.
- In **enforce** mode: **STOP** blocks the call before it runs; **CAUTION** also blocks by default — NemoClaw's `before_tool_call` contract has no interactive approval surface, so a CAUTION verdict is blocked with its red-flag detail in the block reason rather than prompting. This is configurable via `cautionAction` (set `allow` to let CAUTION through).
- In **observe** mode: logs the verdict but never blocks (safe to trial).
- Every decision is returned with an **Ed25519-signed receipt** that verifies **offline** against the published key — a tamper-evident audit trail of what the agent was about to do and why it was allowed or blocked.

This is defense-in-depth: it catches dangerous actions a compromised, mistaken, or
prompt-injected agent might attempt — destructive commands, irreversible writes,
data exfiltration, fund movement — independent of the model's own judgment.

## Enable & configure

Disabled by default. Enable it for an agent and provide an API key:

| Config | Env | Meaning |
|---|---|---|
| `apiKey` | `BLACKWALL_API_KEY` | BLACK_WALL API key (get one at https://blackwalltier.com) |
| `baseUrl` | — | API base URL (default `https://blackwalltier.com`) |
| `mode` | — | `observe` (default) or `enforce` |
| `cautionAction` | — | what a CAUTION verdict does in enforce mode: `approve` (default) → **block** with red-flag detail / `block` → **block** / `allow` → permit. (No approval prompt on NemoClaw — see above.) |
| `failClosed` | — | if the gate is unreachable, block instead of allowing unscored. Recommended `true` for sandboxed/security-positioned deployments. |
| `forecastTimeoutMs` | — | per-call forecast timeout (ms) |

> **Sandboxed runtimes (e.g. NVIDIA NemoClaw):** the agent process may run with a
> scrubbed environment, so `BLACKWALL_API_KEY` can be empty even when a login shell
> sees it. The plugin also resolves the key from a file — `$BLACKWALL_API_KEY_FILE`,
> `$OPENCLAW_HOME/.openclaw/blackwall.key`, or `$HOME/.openclaw/blackwall.key` — so you
> can deliver it as a file the agent can read.

## Verifying a receipt

Each receipt is signed over canonical hashes of the request and response. Anyone can
re-hash the bodies and verify the Ed25519 signature against the published key at
`/.well-known/blackwall-signing-keys.json` — no trust in any server required.

## Skills

- `blackwall-policy` — guidance for tuning enforce/observe and the gate policy.
- `blackwall-verify` — how to independently verify a decision receipt.

## License

Contributed under this repository's license.
