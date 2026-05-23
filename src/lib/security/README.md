<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security helpers

`src/lib/security` is for reusable redaction, secret-pattern, credential-hash, and credential-filter helpers.

Suggested homes:

```text
credential-filter.ts
credential-hash.ts
redact.ts
secret-patterns.ts
```

Credential storage belongs under `src/lib/credentials/**`; security helpers should not own persistence or user prompts.
