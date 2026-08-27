<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Blueprint Contribution Guide

This file owns contribution rules for `nemoclaw-blueprint/`.

When the managed sandbox image changes, update `digest` and `components.sandbox.image` in
`blueprint.yaml` with the same immutable SHA-256 digest. Release tooling must update both fields
together. `test/onboarding/validate-blueprint.test.ts` rejects mutable tags and mismatched digests.

Follow the root [agent instructions](../AGENTS.md) and
[contributor journey](../CONTRIBUTING.md) for repository-wide requirements.
