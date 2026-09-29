<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Credential Redaction on Linux ARM64

The fix for [issue #12467](https://github.com/NVIDIA/NemoClaw/issues/12467) passed subprocess and bundled CLI fixtures on Linux ARM64 on 2026-09-29.
The implementation is `09f1032d34`.
The verified bundle is `0.1.0-dev.cd6226d7d290f34a`, built with Rust 1.98.1 and OpenTofu 1.12.6.
The CLI used an isolated OpenShell gRPC fixture and temporary state directories.
No Docker workloads or inference services were started, and no agent replies were requested.

## Observed Behavior

The [SDK regressions](../../crates/nemoclaw-sdk/src/process.rs) first failed on nested replacement markers, overlapping credential suffixes, and character-position disclosure from short values.
A further regression reproduced nesting inside an existing `[redacted]` marker before the final correction.
All 17 focused process tests passed with the fix.
They cover raw stderr, JSON diagnostics, successful execution with short credentials, suppressed detailed progress, Unicode values, and overlapping or colliding credentials.

The [CLI regression](../../crates/nemoclaw-e2e/tests/deployment.rs) first reproduced garbled diagnostics and progress with the previous bundle, `0.1.0-dev.cca4191d33fb0e85`.
Against the final bundle, it observed these results:

| Operation | Result |
|---|---|
| Initial apply with a one-character credential | Succeeded |
| Injected configuration failure with short credentials, in text and JSON | Exited with status 1 and the same fixed withholding diagnostic |
| Injected failure with a longer credential matching the failure code and another matching the marker text | Masked the code once, preserved the runtime-state explanation, and omitted native exception text |
| Corrected retry with a short credential | Succeeded with the original sandbox identity and no repeated creation effects |
| Destroy with a short credential | Succeeded and removed the fixture sandbox |

All 40 explicitly selected deployment and [Fabric lifecycle fixtures](../../crates/nemoclaw-e2e/tests/fabric_deployment.rs) passed against the final bundle, including the CLI regression above.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace` (927 passed, zero failed, 126 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.
Documentation validation passed with zero errors and one Fern warning.

## Qualification Limits

These results cover diagnostic handling and lifecycle recovery through deterministic subprocess, SDK, provider, and bundled CLI fixtures.
They do not establish native gateway, GPU inference, agent-response, Podman, or other-platform behavior.
The [diagnostic disclosure policy](../security.md#diagnostic-disclosure) describes the protected values and the loss of child details when any value is short.
The exact-value filter remains a backstop; encoded or transformed credentials still require prevention at the diagnostic source.
