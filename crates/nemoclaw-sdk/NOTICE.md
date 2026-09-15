<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# SDK Policy Attribution

MiaAI Lab's [single-Spark recipe](https://github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark/tree/d03809008834124e80223c3482f2ddb59577a48f) informed NemoClaw's memory and serving policies.
The upstream recipe is copyright 2026 MiaAI Lab and licensed AGPL-3.0-or-later.

- `files/memwatch.sh` informed the available/free-memory thresholds and free-memory gate in `src/hardware/mod.rs`.
  NemoClaw uses one combined pressure counter and a latched stop; upstream uses two counters and stops a Docker container.
- `start.sh` informed host-reserve checks in `src/hardware/capacity.rs`, defaults in `src/config/constraints.rs`, and serving-budget rounding in `src/backends/vllm.rs`.

These Rust implementations remain Apache-2.0; this credit identifies the source of their operational policy.
The SDK does not embed the recipe scripts.
