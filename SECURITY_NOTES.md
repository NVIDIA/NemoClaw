<!-- SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved. -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Security Notes

## Upstream vulnerability snapshot

This note records a review snapshot for OpenClaw@2026.4.11 transitive
dependencies (Lark SDK `@larksuiteoapi/node-sdk` and Discord `axios`/`tar`
deps).

**Mitigation:** The tightened baseline sandbox policy blocks direct access to
Lark and Discord endpoints by default.

**Action:** Revisit when OpenClaw ships `axios`/`tar` dependency bumps.
