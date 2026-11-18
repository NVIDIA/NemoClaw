<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# V1 consumer compatibility fixtures

`config_export_compatibility.rs` is a Cargo example that `test/support/v1-parse-consumer.ts` copies into a checkout of the v1 revision pinned by `src/lib/domain/config/v1alpha1-checked-revision.ts`. It calls `nemoclaw_sdk::config::Document::parse`, which runs v1's schema and semantic validation, and writes the parsed document as JSON. A rejected export exits nonzero and the helper throws with the rejection message.

The check is parse-only. v1 accepts any nonempty `harness.kind`, so tests assert the Fabric adapter ID and the other shape facts on the parsed document themselves. The tests that run the consumer need `NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY=1`, a Rust toolchain, and the pinned revision in the local Git object store.

`pending-gemini.yaml` preserves a proposed configuration for one OpenClaw Gemini route. It contains a credential reference, not a key value. Gemini config export rejects this unsupported provider before writing YAML. The pinned v1 revision rejects `provider: google` because the provider schema permits only `openai` and `anthropic`. V1 Gemini work should use this file without rewriting it and replace the rejection result with parser, planner, apply, and deployment evidence under accepted scope.

One helper instance reuses its checkout and Cargo build across inputs and removes them in `dispose()`. Every parse still gets fresh input and output paths, including after a rejected export. Nothing is retained between test runs.
