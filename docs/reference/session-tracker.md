---
title:
  page: "NemoClaw Session Tracker — Detect Multi-Step Exfiltration Attacks"
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

# NemoClaw Session Tracker — Detect Multi-Step Exfiltration Attacks

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
A trifecta indicates a possible exfiltration chain — read a secret, get instructions from an attacker, and send the secret out.

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
The tracker drops events beyond the 100th, but continues to update the capability set.
The cap is sized so that 100 events consume roughly 10 KB of memory per session (each event ~100 bytes), keeping per-session overhead predictable in long-running processes.

The tracker holds sessions in memory only.
All tracking state is lost when the host process restarts.
This is an acceptable trade-off for ephemeral sandbox sessions, where the threat window is bounded by the container lifetime.

## API

The module exports the following from `nemoclaw/src/security/session-tracker.ts`.

### `SessionStore`

Class that tracks capability events per agent session.

```typescript
import { SessionStore, Capability } from "./security/session-tracker.js";

// Optional: receive a callback when trifecta is first detected.
const store = new SessionStore((sessionId) => {
  console.warn(`[NemoClaw] trifecta detected for session ${sessionId}`);
});
store.record("session-1", Capability.ReadSensitive, "cat", "/etc/passwd");
store.record("session-1", Capability.HasEgress, "curl", "https://example.com");
```

#### `constructor(onTrifecta?: (sessionId: string) => void)`

Create a store.
Pass an optional `onTrifecta` callback to receive a notification the first time a session accumulates all three capability classes.
Use the callback to log a warning, emit a metric, or terminate the session.

#### `record(sessionId: string, cap: Capability, tool: string, detail: string): void`

Record a capability event against a session.
The method silently ignores empty `sessionId` values.
If the new event completes a trifecta and an `onTrifecta` callback was provided, the callback fires once for this session.

#### `clear(): void`

Remove all sessions and release all tracked state.
Call this when the host session ends to prevent unbounded memory growth in long-running processes.

#### `getCapabilities(sessionId: string): Record<string, boolean> | null`

Return the capability map for a session.
Returns `null` if the session does not exist or `sessionId` is empty.

#### `hasTrifecta(sessionId: string): boolean`

Return `true` if the session has all three capability classes.

#### `listSessions(): SessionSummary[]`

Return summaries of all active sessions.

#### `getExposure(sessionId: string): SessionExposure | null`

Return detailed exposure data for a session.
Returns `null` if the session does not exist or `sessionId` is empty.

The exposure object categorizes events into three lists.

- `sensitiveFilesAccessed` contains deduplicated file paths from `read_sensitive` events.
- `externalUrlsContacted` contains deduplicated URLs from `ingested_untrusted` events.
- `egressAttempts` contains every `has_egress` event as `tool` when `detail` is empty, or `tool + " " + detail` otherwise.
  The tracker does not deduplicate egress attempts.

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

- Review the injection scanner (`nemoclaw/src/security/injection-scanner.ts`, pending PR #870) to understand how NemoClaw detects prompt injection in agent tool calls.
- See the audit chain (`nemoclaw/src/security/audit-chain.ts`, pending PR #892) for tamper-evident logging of all policy decisions.
