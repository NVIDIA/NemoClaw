<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# V1 consumer compatibility fixtures

`pending-gemini.yaml` preserves a proposed configuration for one OpenClaw Gemini route. It contains a credential reference, not a key value. Gemini config export rejects this unsupported provider before writing YAML.

The V1 consumer pinned by `src/lib/domain/config/v1alpha1-runtime-defaults.ts` rejects `provider: google` because the provider schema permits only `openai` and `anthropic`. V1 Gemini work should use this file without rewriting it and replace the rejection result with parser, planner, apply, and deployment evidence under accepted scope. Existing exports keep their pinned V1 consumer checks.

The defaults compatibility suite uses `createPinnedV1Consumer()` to reuse one pinned checkout and Cargo build across its inputs. It disposes that workspace in `afterAll`. Every validation still runs the Rust consumer and native adapters with fresh input and output paths, including after a rejected export. Other callers use `validateConfigExportWithPinnedV1()` for a single validation with immediate workspace cleanup. Neither path retains builds between test runs.
