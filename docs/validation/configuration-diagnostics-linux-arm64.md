<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Configuration Diagnostics on Linux ARM64

The [issue #12472](https://github.com/NVIDIA/NemoClaw/issues/12472) qualification covers document paths, source positions, safe syntax diagnostics, explicit YAML tags, and generated conditional bounds.
The implementation is commit `d6c7a11d61a7b13d5698624911c284a0422d535c`, qualified with bundle `0.1.0-dev.f156a075cdeb2de7`.
Tests ran on Linux ARM64 on 2026-09-29 (America/Vancouver), with Rust 1.98.1 and OpenTofu 1.12.6.

## Reproduced Failures

All five initial [configuration diagnostic regressions](../../crates/nemoclaw-sdk/tests/config_diagnostics.rs) failed before implementation.
Errors used internal schema paths, omitted expected types and source positions, treated empty input as a generic root-type failure, and accepted an explicitly binary-tagged deployment name after decoding it.
A separate [reference generator regression](../../crates/nemoclaw-build/tests/schema.rs) failed because the Memory section omitted its conditional bounds.

## Checked Behavior

Schema diagnostics now identify fields such as `spec.services.qwen.memory.kvCacheGiB` and array elements such as `spec.sandboxes[1].agent.inference.routes`.
They report the trusted constraint without echoing rejected values.
Valid names in declared application collections identify the affected definition; invalid names and arbitrary map keys remain hidden.
Source positions use one-based lines and character columns, including flow-style JSON with preceding multibyte characters.

The parser reports fixed syntax and duplicate-key reasons with positions and no source snippets.
Empty or comment-only input has a distinct error.
All explicit tags are rejected, including core scalar and collection tags, while quoted and block strings containing tag text retain their values.
The generated reference now includes the presence-conditioned `kvCacheGiB` and `gpuMemoryGiB` bounds from the existing schema rules.
The accepted numeric bounds did not change.

All seven focused parser diagnostic tests passed, together with the schema, defaulting, privacy, and reference-generator checks.
Workspace checks passed: `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace --no-fail-fast -- --test-threads=4` (951 passed, zero failed, 134 ignored).
Ignored tests require explicit selection and are not counted as workspace passes.

The final checksum-verified bundle passed 52 manual CLI checks: 13 invalid inputs in both text and JSON, each through plan and apply.
The cases covered KV-cache bounds, malformed routes, empty and comment-only stdin, duplicate keys, indentation, explicit scalar and collection tags, unknown and missing fields, and multiple documents.
Every case returned exit code 1 with the expected field, constraint, or syntax reason and applicable position.
No private sentinel value or rejected unknown property appeared in stdout or stderr.
No deployment state directory was created, and all apply failures reported that no runtime resources changed.

## Qualification Limits

These checks concern local parsing and output; no live deployment is needed to reject the invalid documents.
They do not establish image, service, or runtime compatibility.
Later semantic validation, such as reference resolution, retains its existing diagnostics and may lack source positions.
The reference generator renders presence-conditioned scalar bounds; other conditional schema shapes still depend on their owning field descriptions.
