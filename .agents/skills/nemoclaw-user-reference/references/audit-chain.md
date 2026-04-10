<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
# NemoClaw Audit Chain — Tamper-Evident Hash-Chained Audit Log

The audit chain module writes tamper-evident log entries in JSONL format.

Each entry includes a SHA-256 hash of the previous entry, forming a hash chain that makes any modification or reordering detectable.

## How Hash Chaining Works

Every audit entry contains two hash fields.

1. **`entry_hash`** is the SHA-256 digest of all other fields in the entry (seq, chain_id, prev_hash, type, time, data).
   The logger computes this by JSON-serializing those fields and hashing the result.
2. **`prev_hash`** is the `entry_hash` of the immediately preceding entry.
   The first entry in a chain has an empty `prev_hash`.

To verify integrity, a reader recomputes each `entry_hash` from the stored fields and confirms that each `prev_hash` matches the preceding entry.
If any entry has been modified, deleted, or reordered, the hashes will not match.

The `chain_id` is a random 24-character hex string generated when the logger creates a new file.
It remains constant across all entries in a single chain.
It persists when the logger resumes from an existing file.

## Entry Structure

Each line in the audit file is a JSON object with the following fields.

| Field | Type | Description |
|---|---|---|
| `seq` | number | Monotonically increasing sequence number, starting at 1 |
| `chain_id` | string | Random hex identifier for this chain instance |
| `prev_hash` | string | `entry_hash` of the previous entry, or empty string for the first entry |
| `entry_hash` | string | SHA-256 digest of the payload, formatted as `sha256:<64 hex chars>` |
| `type` | string | Event type label (for example, `"tool.call"` or `"policy.decision"`) |
| `time` | string | ISO 8601 timestamp in UTC |
| `data` | unknown | Arbitrary JSON-serializable payload |

Example entry:

```json
{
  "seq": 1,
  "chain_id": "a1b2c3d4e5f6a1b2c3d4e5f6",
  "prev_hash": "",
  "entry_hash": "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
  "type": "tool.call",
  "time": "2026-03-25T12:00:00.000Z",
  "data": { "action": "file_write", "target": "/tmp/output.txt" }
}
```

## API

The module exports the following from `nemoclaw/src/security/audit-chain.ts`.

### `AuditLogger`

Class that manages an append-only hash-chained audit file.

```typescript
import { AuditLogger } from "./security/audit-chain.js";

const logger = new AuditLogger("/path/to/audit.jsonl");
logger.log("tool.call", { action: "file_write", target: "/tmp/out.txt" });
```

The constructor creates parent directories if they do not exist.
If the file already contains entries, the logger resumes the chain from the last entry.

#### `log(type: string, data: unknown): void`

Append a new entry to the audit file.
The `type` parameter is a non-empty string label for the event.
The `data` parameter is any JSON-serializable value.

### `verifyChain(path: string): VerifyResult`

Verify the integrity of an audit chain file.
Returns a `VerifyResult` indicating whether all hashes are correct, all `prev_hash` links are intact, sequence numbers are contiguous (1, 2, 3, ...), and all entries share the same `chain_id`.

```typescript
import { verifyChain } from "./security/audit-chain.js";

const result = verifyChain("/path/to/audit.jsonl");
if (!result.valid) {
  console.error("Chain tampered:", result.error);
}
```

Returns `{ valid: true, entries: 0 }` for empty or nonexistent files.

### `exportEntries(path: string, since: number, limit?: number): AuditEntry[]`

Read entries with `seq >= since`, up to `limit`.
When `limit` is omitted or zero, all matching entries are returned.

Malformed lines are silently skipped.

### `tailEntries(path: string, n?: number): AuditEntry[]`

Return the last `n` entries from the audit file.
Defaults to 50 when `n` is omitted or non-positive.

Malformed lines are silently skipped.

### `AuditEntry`

```typescript
interface AuditEntry {
  readonly seq: number;
  readonly chain_id: string;
  readonly prev_hash: string;
  readonly entry_hash: string;
  readonly type: string;
  readonly time: string;
  readonly data: unknown;
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

- See {doc}`/reference/architecture` for how security modules integrate into the NemoClaw plugin.
