<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Migration completion

## Purpose

Determine whether the pull request completes each migration or replacement it undertakes and leaves one coherent supported path.

## Review method

Compare the parent revision with the proposed result. Identify each changed replacement, extraction, rename, version, state format, compatibility transition, or path relocation. Trace the pre-change and proposed owners, actual production callers and consumers, stored state, configuration, tests, fixtures, workflows, documentation, and compatibility commitments.

Resolve what consumers execute rather than inferring activation from local source presence. For workflow actions and dependencies, inspect the exact immutable revision selected by each consumer. Trace upgrade, downgrade, restart, retry, partial-state, and mixed-version behavior where supported or reachable. Establish whether old paths remain authoritative and whether the pull request causes or newly depends on that coexistence.

## Own

- Completion of replacements and caller cutovers.
- Old and new state formats, conversion, reconciliation, and cleanup.
- Compatibility paths and their explicit lifecycle.
- Obsolete implementations, adapters, flags, configuration, tests, fixtures, workflows, and documentation.
- Split behavior caused by partial migration across repository surfaces.

## Review principles

A migration may be intentionally staged when the stages, compatibility contract, owner, and completion condition are established. Otherwise require one coherent authority model. Preserve required compatibility, diagnostics, rollback or recovery behavior, evidence, and trust boundaries.

## Report a finding when

The pull request introduces, worsens, or materially depends on an incomplete cutover, leaves reachable old and new paths that can diverge, strands callers or state, removes compatibility before its contract permits, retains obsolete authority without a defined lifecycle, or fails in a supported intermediate state. Cite changed lines and parent-state evidence. Explain the reachable consequence, remaining work, and verification of completion.
