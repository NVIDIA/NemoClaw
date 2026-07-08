<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Local state durability

State modules own persisted NemoClaw files and must fail closed when durable state is missing,
malformed, or from an unsupported schema version.

The rebuild transaction store publishes a fully synced candidate from the destination directory.
Initial publication uses a same-directory hard link for atomic create-only semantics; update
publication uses rename. A copy fallback is intentionally excluded because it cannot retain the
same no-replace guarantee for competing creators. An unexpected cross-device error is therefore an
invariant failure, not a recoverable publication mode.

Transaction filenames are deterministic SHA-256 hashes of validated sandbox names. The hash is a
stable traversal-safe key, not a confidentiality boundary; transaction contents and names remain
protected by the `0700` state directory and `0600` record mode. Backup receipt timestamps preserve
the product's filename-safe dashed format and are validated by a bijective conversion to canonical
UTC ISO time.

After publication, the store calls `fsync` on the containing directory. Common Linux filesystems
use this to persist the directory entry, but exact guarantees remain filesystem and device
specific. On macOS, Node.js does not expose `F_FULLFSYNC`; strict persistence through sudden power
loss is unsupported and best-effort until Node exposes that primitive or NemoClaw adopts a native
adapter. Atomic visibility and fail-closed validation still apply on macOS.

Mutation reentrancy is limited to nested calls in one process. Independent processes always
contend on the per-sandbox filesystem lifecycle lock before revision validation and publication.
