---
name: blackwall-policy
description: Use to explain what BLACK_WALL is gating in this session, why a tool call was blocked or flagged, or what the agent's safety envelope looks like right now. Read when a tool returns a "BLACK_WALL blocked" error, when the user asks "why was that blocked?", or when summarizing the agent's current guardrail posture.
homepage: https://blackwalltier.com
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
SPDX-License-Identifier: Apache-2.0
-->

# BLACK_WALL Policy

This skill explains the BLACK_WALL preflight guardrail running over the agent's tool calls.

## What BLACK_WALL does

BLACK_WALL is a pre-action risk gate. Before every tool the agent tries to call, the `nemoclaw-blackwall-guard` plugin hooks into `before_tool_call`, sends the tool name + parameters to the BLACK_WALL forecast API, and receives a verdict in 4–8 seconds:

| Verdict | What the plugin does |
|---|---|
| `GO` (low risk) | The tool runs normally. |
| `CAUTION` (medium risk) | In `enforce` mode, the call is **blocked** by default (this runtime has no interactive approval surface), and the block reason carries the named red flags so a human can re-decide out of band. Set `cautionAction: "allow"` to let CAUTION calls proceed. In `observe` mode, the call is logged and proceeds. |
| `STOP` (high risk + irreversible) | In `enforce` mode, the tool is **blocked**. The plugin returns `{ block: true, blockReason }`. The agent sees a `failureResult` with the reason. |

Each verdict comes with a cryptographic **Decision Receipt** (Ed25519-signed) that can be verified offline against the published public key at <https://blackwalltier.com/.well-known/blackwall-signing-keys.json>. See the `/blackwall-verify` skill for offline verification.

## Why a tool got blocked or flagged

When you see `BLACK_WALL blocked tool "<name>" (risk N/100): <FLAG_CODES>`, the codes are from BLACK_WALL's named failure-mode taxonomy. Common ones:

- `SQL_NO_WHERE` — destructive SQL without a WHERE clause
- `IRREVERSIBLE_NO_BACKUP` — no rollback path
- `INTENT_MISMATCH` — the proposed action differs materially from the user's stated intent
- `PROMPT_INJECTION_LIKELY` — the inputs contain instructions the agent likely didn't author
- `RECIPIENT_UNVERIFIED` — sending to an address that wasn't confirmed
- `AMOUNT_OUT_OF_BAND` — money/quantity outside the normal range
- `CROSS_ENVIRONMENT` — production target with staging context (or vice versa)

The full catalog: <https://blackwalltier.com/failure-modes>

## What to tell the user

- If a tool was BLOCKED: surface the block reason. Do not retry the same call without changing the parameters or escalating to the user.
- If a CAUTION call was blocked: surface the reason and the named red flags; the human decides whether to proceed (e.g. by re-running with `cautionAction: "allow"` or adjusting the action). Do not silently retry the same call.
- If observe mode is on and you see a high risk_score, mention it: "This was scored as risky but allowed because the guardrail is in observe mode."

## Modes

- `observe` (default) — every call is scored and logged; nothing is blocked. Drop-in safe.
- `enforce` — STOP blocks; CAUTION blocks by default (with the red flags in the reason), or proceeds if `cautionAction: "allow"`.

The current mode lives in env var `BLACKWALL_MODE`.

## Output

When asked to summarize the guardrail posture, return:

- current mode (`observe` / `enforce`)
- the most recent `forecast_id` if available
- whether the last call was GO / CAUTION / STOP
- where to verify the receipt (<https://blackwalltier.com/api/v1/receipts/verify>)
