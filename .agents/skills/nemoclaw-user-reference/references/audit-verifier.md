<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# NemoClaw Audit Verifier: TypeScript API for Tamper-Evident Audit Chain

The audit verifier reads and validates the tamper-evident audit chain written by the Python orchestrator (`nemoclaw-blueprint/orchestrator/audit.py`).
It provides hash chain verification and query APIs for the TypeScript plugin.

## How It Works

The Python audit module writes SHA-256 hash-chained JSONL entries to `/var/log/nemoclaw/audit.jsonl`.
Each entry contains a `hash` field computed from the canonical JSON representation of the entry (without the `hash` field itself).
Each entry's `prev_hash` links to the previous entry's `hash`, forming a chain starting from `"genesis"`.

The TypeScript verifier reads these entries and recomputes the hashes using the same canonical JSON serialization (sorted keys, compact separators) to confirm the chain is intact.

## API

The verifier exports the following functions and types from `nemoclaw/src/security/audit-verifier.ts`.

### `verifyChain(path: string): VerifyResult`

Verify the integrity of an audit chain file.
Returns `{ valid: true, entries: N }` if the chain is intact.
Returns `{ valid: false, entries: N, error: "..." }` if tampering is detected, with the number of valid entries before the break.
Returns `{ valid: true, entries: 0 }` for empty or nonexistent files.

```typescript
import { verifyChain } from "./security/audit-verifier.js";

const result = verifyChain("/var/log/nemoclaw/audit.jsonl");
if (!result.valid) {
  console.error(`Chain broken after ${result.entries} entries: ${result.error}`);
}
```

### `exportEntries(path: string, since: number, limit?: number): AuditEntry[]`

Export audit entries where `timestamp >= since` (Unix epoch seconds), up to `limit`.
Skips malformed lines.
Returns an empty array for nonexistent files.

```typescript
import { exportEntries } from "./security/audit-verifier.js";

// Get entries from the last hour
const oneHourAgo = Date.now() / 1000 - 3600;
const recent = exportEntries("/var/log/nemoclaw/audit.jsonl", oneHourAgo);
```

### `tailEntries(path: string, n?: number): AuditEntry[]`

Return the last `n` entries from an audit file.
Defaults to 50 when `n` is omitted.
Skips malformed lines.

```typescript
import { tailEntries } from "./security/audit-verifier.js";

const last10 = tailEntries("/var/log/nemoclaw/audit.jsonl", 10);
```

### `AuditEntry`

```typescript
interface AuditEntry {
  readonly timestamp: number;
  readonly prev_hash: string;
  readonly event: unknown;
  readonly hash: string;
}
```

### `VerifyResult`

```typescript
interface VerifyResult {
  readonly valid: boolean;
  readonly entries: number;
  readonly error?: string;
}
```

## Next Steps

- See [Audit Logging](docs/security/audit-logging.md) for how the Python orchestrator writes and protects the audit chain.
- See NemoClaw Architecture: Plugin, Blueprint, and Sandbox Structure (see the `nemoclaw-user-reference` skill) for how the TypeScript plugin and Python blueprint interact.
