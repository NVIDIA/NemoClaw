<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Messaging suites

Telegram, Discord, and Slack bridge behavior.

Messaging always touches a policy preset OR `onboard.ts` — it is never
purely in the messaging module (§5.5 of the hotspot analysis). That
architectural entanglement means messaging suites benefit from running
against both fresh-onboard **and** post-rebuild scenario variants.

## Planned (from UAT/NV QA hotspot analysis)

| Suite | Originating bug class | Migrating from |
|---|---|---|
| `providers/` | Telegram + Discord provider / placeholder / L7-proxy chain with fake tokens. | `test-messaging-providers.sh` |
| `token-rotation/` | Rotating a messaging token triggers sandbox rebuild (UAT #1903). | `test-token-rotation.sh` |
| `telegram-injection/` | Shell command injection via Telegram bridge (PR #119 regression). | `test-telegram-injection.sh` (currently unwired) |
| `discord-facade/` | Local Discord facade emulates Discord Gateway+REST (PR #3293). | **NEW** — landed upstream during scenario-matrix development; not yet reflected in the matrix |

Coverage gap explicitly called out by the hotspot analysis: no
messaging × rebuild × policy fixture today. The UAT #1952 (Telegram policy
lost on rebuild) bug literally proves this is a live hole.
