<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# V1 Guide Restructure Evidence

The documentation base was `codex/v1-docs` at `9df19249f45f5cdbe82bf94f32300575ceacd0cf`. Operational changes were compared with and adapted from `origin/v1` at `86b8d94273a76a696e06b300dc29f7035b163667`, particularly its `docs/`, `versions.json`, `examples/openclaw.yaml`, and the linked Fabric adapter contract. The earlier first-deployment tutorial and its prerequisite correction were preserved from commits `fa563d55ce85439637ea3ef4175df2adab119710` and `0a2dd19c2272f079280af2f34beb4fa124a9e8d9`.

The user-facing container page extracts the image inputs, readiness, and credential cautions from `origin/v1:docs/design/container-contract.md`; that source is a design decision and a contract, not evidence of live qualification. The moved design and contributor pages preserve the source text, with relative links repaired for their new paths. `fern/pages.json` lists only reader-facing pages. The generated `docs/reference/configuration.md` and JSON Schema were left at this documentation checkout's revision because this checkout's SDK schema differs from the inspected v1 implementation. To work with v1's newer map-shaped configuration, use a matching v1 source checkout, not this checkout's generated reference.

## Checks and limits

- From the repository root: `git diff --check`, exit 0 (no output).
- From the repository root: `CARGO_BUILD_JOBS=4 cargo run --locked -p nemoclaw-build -- fern check`, exit 0, zero errors and one warning; output retained in `/tmp/docrelay-fern-done.log` for this working session. The Fern warning is the unauthenticated missing-redirects check, not a successful network check.
- No live gateway, image, endpoint, agent reply, or Kubernetes deployment was run for this restructure. Changes adapted from `origin/v1` are source-grounded; they are not demonstrated behavior of the older documentation checkout. The source revision's missing files are linked to immutable upstream paths where applicable. No independent Evaluator verdict on this restructure has been obtained yet.
