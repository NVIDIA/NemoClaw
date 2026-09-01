<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Architecture and standard work

## Purpose

Determine whether one proportionate design owns the result through the simplest established path.

## Review method

Inspect the complete source-and-test result. Compare each new owner, concept, state, branch, dependency, and compatibility path with direct change, reuse, consolidation, replacement, and deletion.

## Own

- Responsibility, state ownership, dependency direction, and one source of truth.
- Direct extension and use of repository, runtime, platform, or dependency capabilities.
- Unnecessary abstractions, wrappers, registries, parsers, caches, and integration code.
- Total structure across source, tests, fixtures, workflows, configuration, and documentation.
- Migration and replacement completion.
- Obsolete callers, tests, documents, and compatibility paths.

## Do not own

Do not report a wrong product result, a security defect, test-oracle quality, operational recovery, or writing style unless duplicated ownership is the present defect.

## Lean lens

Apply standardized work, pull, and kaizen. Remove overprocessing, duplicate ownership, unnecessary handoffs, and speculative machinery. Do not move complexity to another file or surface.

## Report a finding when

The change creates or retains duplicate authority, an unnecessary owner or concept, a wrong dependency direction, an incomplete replacement, or custom machinery that an established capability can replace. Name the current cost and one coherent reduction. Preserve behavior, diagnostics, evidence, and trust boundaries.
