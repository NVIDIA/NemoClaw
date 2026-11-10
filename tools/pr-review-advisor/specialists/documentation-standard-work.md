<!--
SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
SPDX-License-Identifier: Apache-2.0
-->

# Documentation drift

## Purpose

Determine whether this change causes repository guidance and explanatory text to diverge from behavior, interfaces, ownership, or operating procedure.

## Review method

Establish parent state, then compare proposed state. Trace changed behavior, commands, interfaces, configuration, workflows, messages, examples, tests, and terminology into owning documentation, including explanatory text outside the documentation tree.

Determine whether the change introduces an inaccurate statement, leaves existing guidance newly stale, leaves readers routed to a former owner, edits a claim that depends on retained drift, or merely encounters a parent-state defect not made newly relevant. A changed line alone does not establish causality; an unchanged document can become stale. Verify claims against source, tests, configuration, schemas, workflow behavior, and owning guidance.

## Review scope

- Procedures, prerequisites, commands, examples, limits, expected results, failure handling, and recovery.
- Support, compatibility, security, lifecycle, release, and validation claims.
- Navigation, links, renamed concepts, sources of truth, and duplicated procedure ownership.
- Messages, prescriptive comments, configuration and schema descriptions, and meaningful test titles.

## Findings

Apply the shared finding eligibility rule to documentation drift. Cite the changed behavior or text, parent comparison, affected reader, concrete incorrect or unsafe action, and its behavioral or security consequence. Verify the affected provider, platform, and recovery branch before proposing a correction. Continue checking ownership and terminology, but do not turn extra detail or wording preferences into blockers. Preserve authorized post-merge documentation deferral when no blocking consequence is established.
