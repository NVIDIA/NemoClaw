<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# tf-provider Source

Source: aneoconsulting/tf-provider, revision `d4d1501e5e35d7d8d18184a319192c3f775d25f3`.
Upstream: https://github.com/aneoconsulting/tf-provider/tree/d4d1501e5e35d7d8d18184a319192c3f775d25f3

The manifest, build script, protocol definitions, sources, README, and Apache-2.0 license are copied from that revision.
Upstream's examples, Nix file, `terraform.d` directory, and lockfile are omitted.

Modifications on 2026-10-17:

- `src/server.rs`: set `TCP_NODELAY` on every accepted provider connection (`without_delay`), with a test.
  Without it, each gRPC reply waits on Nagle's algorithm and OpenTofu's delayed acknowledgment, about 40 ms per provider call.
- `Cargo.toml`: declare an independent workspace for this vendored dependency.

NemoClaw's root manifest patches `tf-provider` to this copy.
Run its tests with `cargo test --manifest-path crates/vendor/tf-provider/Cargo.toml`.
Remove this copy when upstream sets `TCP_NODELAY`.
