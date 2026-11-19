<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# V1 consumer compatibility fixtures

`config_export_compatibility.rs` is a Cargo example that `test/support/v1-parse-consumer.ts` copies into a checkout of the v1 revision pinned by `src/lib/domain/config/v1alpha1-checked-revision.ts`. It calls `nemoclaw_sdk::config::Document::parse`, which runs v1's schema and semantic validation, and writes the parsed document as JSON. A rejected export exits nonzero and the helper throws with the rejection message.

The check is parse-only. v1 accepts any nonempty `harness.kind`, so tests compare each exported adapter ID with the kind v1's own example for that agent declares at the pinned revision, and assert the other shape facts on the parsed document themselves. The tests that run the consumer need `NEMOCLAW_RUN_V1_CONFIG_COMPATIBILITY=1`, a Rust toolchain, `protoc` on `PATH`, and the pinned revision in the local Git object store.
The pinned SDK build runs `protoc`. CI installs protoc 36.2, the version pinned in v1's `versions.json`, and adds its `bin` directory to `PATH`. The consumer passes `PATH` to Cargo but not `PROTOC`.

`pending-gemini.yaml` preserves a proposed configuration for one OpenClaw Gemini route, in the current export shape. It contains a credential reference, not a key value. Gemini config export rejects this unsupported provider before writing YAML. The pinned v1 revision rejects the file at `spec.inferenceProviders.hosted-gemini-api.provider`, and the same file with `provider: openai` parses, so the provider is the only reason for the rejection. Keep the file in the current export shape so that check stays meaningful. V1 Gemini work should replace the rejection result with parser, planner, apply, and deployment evidence under accepted scope.

One helper instance reuses its checkout and Cargo build across inputs and removes them in `dispose()`. With `NEMOCLAW_V1_CONSUMER_CACHE_DIR` set, as CI sets it, every helper shares one checkout per revision and one Cargo target directory under that directory, so the SDK builds once per job; `dispose()` then leaves the directory in place. Every parse still gets fresh input and output paths, including after a rejected export. Nothing is retained between test runs.
