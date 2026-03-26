---
title:
  page: "Session Tracker — Behavioral Trifecta Detection"
  nav: "Session Tracker"
description: "Reference for the behavioral session tracker that detects multi-step exfiltration attacks by tracking three capability classes per agent session."
keywords: ["nemoclaw session tracker", "trifecta detection", "behavioral tracking", "exfiltration detection"]
topics: ["generative_ai", "ai_agents"]
tags: ["openclaw", "openshell", "security", "session", "trifecta"]
content:
  type: reference
  difficulty: intermediate
  audience: ["developer", "engineer"]
status: published
---

<!--
  SPDX-FileCopyrightText: Copyright (c) 2025-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
  SPDX-License-Identifier: Apache-2.0
-->

# Session Tracker

The session tracker module detects multi-step exfiltration attacks by tracking three capability classes per agent session.

Per-action policy gates evaluate each tool call in isolation.
An agent that reads a secret, ingests untrusted input, and opens an outbound connection across separate actions can bypass per-action checks.
The session tracker aggregates these capabilities over the lifetime of a session and raises the risk level when the combination is dangerous.

## Trifecta Detection

The tracker monitors three capability classes.

| Capability | Enum value | What it means |
|---|---|---|
| Read sensitive | `read_sensitive` | The agent accessed a sensitive file or secret |
| Ingested untrusted | `ingested_untrusted` | The agent consumed input from an external or untrusted source |
| Has egress | `has_egress` | The agent made or attempted an outbound network connection |

When all three capabilities appear in a single session, the session has a "trifecta."
A trifecta indicates a possible exfiltration chain: read a secret, get instructions from an attacker, and send the secret out.

## Risk Levels

The tracker classifies each session into one of three risk levels.

| Level | Condition |
|---|---|
| `clean` | No capabilities recorded |
| `elevated` | One or two capabilities recorded |
| `critical` | All three capabilities recorded (trifecta) |

## Event Storage

Each call to `record()` creates a `CapabilityEvent` with a capability, tool name, detail string, and timestamp.
The tracker stores up to 100 events per session.
Events beyond the 100th are dropped, but the capability set continues to update.

## API

The module exports the following from `nemoclaw/src/security/session-tracker.ts`.

### `SessionStore`

Class that tracks capability events per agent session.

```typescript
import { SessionStore, Capability } from "./security/session-tracker.js";

const store = new SessionStore();
store.record("session-1", Capability.ReadSensitive, "cat", "/etc/passwd");
store.record("session-1", Capability.HasEgress, "curl", "https://example.com");
```

#### `record(sessionId: string, cap: Capability, tool: string, detail: string): void`

Record a capability event against a session.
Empty `sessionId` values are silently ignored.

#### `getCapabilities(sessionId: string): Record<string, boolean> | null`

Return the capability map for a session.
Returns `null` if the session does not exist or `sessionId` is empty.

#### `hasTrifecta(sessionId: string): boolean`

Return `true` if the session has all three capability classes.

#### `listSessions(): SessionSummary[]`

Return summaries of all active sessions.

#### `getExposure(sessionId: string): SessionExposure | null`

Return detailed exposure data for a session.
Returns `null` if the session does not exist.

The exposure object categorizes events into three lists.

- `sensitiveFilesAccessed` contains deduplicated file paths from `read_sensitive` events.
- `externalUrlsContacted` contains deduplicated URLs from `ingested_untrusted` events.
- `egressAttempts` contains every `has_egress` event formatted as `tool + " " + detail`, without deduplication.

### `Capability`

Enum with three members.

```typescript
enum Capability {
  ReadSensitive = "read_sensitive",
  IngestedUntrusted = "ingested_untrusted",
  HasEgress = "has_egress",
}
```

### `CapabilityEvent`

```typescript
interface CapabilityEvent {
  readonly capability: Capability;
  readonly tool: string;
  readonly detail: string;
  readonly time: string;
}
```

### `SessionSummary`

```typescript
interface SessionSummary {
  readonly sessionId: string;
  readonly capabilities: Record<string, boolean>;
  readonly trifecta: boolean;
  readonly riskLevel: RiskLevel;
  readonly eventCount: number;
}
```

### `SessionExposure`

```typescript
interface SessionExposure {
  readonly sessionId: string;
  readonly capabilities: Record<string, boolean>;
  readonly trifecta: boolean;
  readonly riskLevel: RiskLevel;
  readonly events: readonly CapabilityEvent[];
  readonly sensitiveFilesAccessed: readonly string[];
  readonly externalUrlsContacted: readonly string[];
  readonly egressAttempts: readonly string[];
}
```

### `RiskLevel`

```typescript
type RiskLevel = "clean" | "elevated" | "critical";
```

## Next Steps

- Review the injection scanner in {doc}`/reference/injection-scanner` to understand how NemoClaw detects prompt injection in agent tool calls.
- See the audit chain in {doc}`/reference/audit-chain` for tamper-evident logging of all policy decisions.
