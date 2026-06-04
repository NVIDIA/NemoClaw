---
name: blackwall-verify
description: Use to verify a BLACK_WALL Decision Receipt cryptographically — proving offline that BLACK_WALL signed off on a specific (request, response) pair, without trusting any server. Read when the user asks to verify a receipt, when an audit log entry references a receipt id, or when assembling proof-of-safety evidence.
homepage: https://blackwalltier.com
---

<!--
SPDX-FileCopyrightText: Copyright (c) 2026 BlueTier Operations LLC
SPDX-License-Identifier: Apache-2.0
-->

# BLACK_WALL Receipt Verification

Every successful BLACK_WALL forecast response includes a `receipt` envelope with an Ed25519 signature over canonical SHA-256 hashes of the request body and the response body. The public key is published at a stable URL; anyone with the (request, response) pair and the public key can verify offline that BLACK_WALL signed off on that exact decision.

## Verification methods

### 1. Stateless verify endpoint (HTTPS, no auth)

`POST https://blackwalltier.com/api/v1/receipts/verify`

Body:

```json
{
  "envelope": { /* the receipt object */ },
  "request_body": { /* the exact JSON sent to /api/v1/forecast */ },
  "response_body": { /* the exact JSON returned by /api/v1/forecast, minus the receipt */ }
}
```

Returns `{ valid: boolean, reason: string }`. Use this when the agent has no local crypto library or simply wants the simplest path.

### 2. Offline verification (no server)

1. Fetch the published public keys (cache this — the URL is stable):
   `GET https://blackwalltier.com/.well-known/blackwall-signing-keys.json`
2. Pick the entry whose `key_id` matches `receipt.key_id`.
3. Canonicalize the request body and response body (JCS-lite — stable key ordering, no extra whitespace).
4. SHA-256 each canonical form. Compare with `receipt.request_hash` and `receipt.response_hash`.
5. Verify `receipt.signature` (base64url) over `request_hash + response_hash` with the public key.

Tiny verifier (Node 18+, no deps):

```js
import { createPublicKey, verify, createHash } from 'node:crypto';

function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}
const sha256 = (s) => 'sha256:' + createHash('sha256').update(s).digest('hex');
const b64urlToBuf = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

export async function verifyReceipt({ envelope, request_body, response_body, publicKeyB64url }) {
  if (sha256(canonical(request_body)) !== envelope.request_hash) return { valid: false, reason: 'request_hash mismatch' };
  if (sha256(canonical(response_body)) !== envelope.response_hash) return { valid: false, reason: 'response_hash mismatch' };
  const pub = createPublicKey({
    key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), b64urlToBuf(publicKeyB64url)]),
    format: 'der', type: 'spki',
  });
  const sig = b64urlToBuf(envelope.signature);
  const msg = Buffer.from(envelope.request_hash + envelope.response_hash);
  return { valid: verify(null, msg, pub, sig), reason: 'ok' };
}
```

(Production verifiers should use the standard library's Ed25519 SPKI encoding rather than the inline prefix above; the snippet keeps it short for the inline demo.)

## When to use which

| Situation | Method |
|---|---|
| Quick check from inside an agent that has no crypto setup | Hosted verify endpoint |
| Audit pipeline, you don't trust the BLACK_WALL servers | Offline (no server) |
| Long-lived compliance archive | Offline + store the signing-keys.json snapshot alongside the receipt |

## Output

When asked to verify a receipt, return:

- `valid: true` / `valid: false`
- the `reason` (e.g. "ok", "request_hash mismatch")
- which verification method was used
- the `receipt.id` and `receipt.issued_at`
